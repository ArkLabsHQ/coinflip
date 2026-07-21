import { Router, Request, Response } from 'express'
import path from 'path'
import { isVtxoExpiringSoon } from '@arkade-os/sdk'
import type { AppDeps } from '../deps.js'
import { houseVtxoCache, reservations, ensureHouseVtxoPool } from '../vtxo-pool.js'
import { buildReservationSafeSettleParams } from '../game-engine.js'
import { makeSettlementHandler } from '../settlement-events.js'
import {
  collapsedTtlRead,
  timeoutReject,
  ADMIN_WALLET_READ_TTL_MS,
  ADMIN_WALLET_READ_TIMEOUT_MS,
} from './cached-wallet-reads.js'

/** Same buffer the game-engine uses to treat a VTXO as "expiring soon". */
const VTXO_EXPIRING_BUFFER_MS = 30 * 60_000

/** How long the settle endpoint waits before returning "in progress". */
const SETTLE_TIMEOUT_MS = 60_000

/** Resolve to the promise's value, or `{ timedOut: true }` after `ms`. */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return Promise.race([
    p.then((value) => ({ timedOut: false as const, value })),
    new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
  ])
}

export function createAdminRoutes(deps: AppDeps): Router {
  const router = Router()

  // The dashboard polls these wallet reads on a short interval. Each underlying
  // SDK read forces a full re-sync of the house's VTXO history, so without
  // collapsing concurrent polls + a short snapshot they pile up and the page
  // "loads forever" (see cached-wallet-reads.ts). VTXO reads reuse the pool
  // snapshot (houseVtxoCache, kept warm by pool maintenance); all are timeout-
  // bounded so a stalled sync returns an error instead of hanging the request.
  const readBalance = collapsedTtlRead(
    () => deps.wallet.getBalance(),
    ADMIN_WALLET_READ_TTL_MS,
    ADMIN_WALLET_READ_TIMEOUT_MS,
    'getBalance',
  )
  const readHistory = collapsedTtlRead(
    () => deps.wallet.getTransactionHistory(),
    ADMIN_WALLET_READ_TTL_MS,
    ADMIN_WALLET_READ_TIMEOUT_MS,
    'getTransactionHistory',
  )
  const readVtxos = () => timeoutReject(houseVtxoCache.get(deps), ADMIN_WALLET_READ_TIMEOUT_MS, 'getVtxos')

  // GET / — serve dashboard
  router.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'))
  })

  // GET /amount-validate.js — the dashboard's shared amount classifier
  // (single source of truth with the unit test). Served as a classic script.
  router.get('/amount-validate.js', (_req: Request, res: Response) => {
    res.type('application/javascript')
    res.sendFile(path.join(__dirname, 'amount-validate.js'))
  })

  // GET /api/status — balance, game counts, profit
  router.get('/api/status', async (_req: Request, res: Response) => {
    try {
      const [stats, balance, pubkeyBytes] = await Promise.all([
        deps.repos.games.stats(),
        readBalance(),
        deps.identity.compressedPublicKey(),
      ])
      res.json({
        balance,
        pubkey: Buffer.from(pubkeyBytes).toString('hex'),
        ...stats,
      })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/config — current configuration
  router.get('/api/config', async (_req: Request, res: Response) => {
    const config = await deps.repos.config.all()
    res.json({
      rakeType: config.rake_type || 'percentage',
      rakeValue: parseInt(config.rake_value || '2', 10),
      tiers: JSON.parse(config.tiers || '[1000,5000,10000,50000]'),
      minHouseBalance: parseInt(config.min_house_balance || '100000', 10),
      oddsEdgeBps: parseInt(config.variable_odds_edge_bps || '300', 10),
    })
  })

  // POST /api/config — update configuration
  router.post('/api/config', async (req: Request, res: Response) => {
    const { rakeType, rakeValue, tiers, minHouseBalance, oddsEdgeBps } = req.body

    if (rakeType !== undefined) {
      if (rakeType !== 'percentage' && rakeType !== 'flat') {
        res.status(400).json({ error: 'rakeType must be "percentage" or "flat"' })
        return
      }
      await deps.repos.config.set('rake_type', rakeType)
    }

    if (rakeValue !== undefined) {
      const val = parseInt(rakeValue, 10)
      if (isNaN(val) || val < 0) {
        res.status(400).json({ error: 'rakeValue must be a non-negative number' })
        return
      }
      await deps.repos.config.set('rake_value', String(val))
    }

    if (tiers !== undefined) {
      if (!Array.isArray(tiers) || tiers.some((t: unknown) => typeof t !== 'number' || t <= 0)) {
        res.status(400).json({ error: 'tiers must be an array of positive numbers' })
        return
      }
      await deps.repos.config.set('tiers', JSON.stringify(tiers))
    }

    if (minHouseBalance !== undefined) {
      const val = parseInt(minHouseBalance, 10)
      if (isNaN(val) || val < 0) {
        res.status(400).json({ error: 'minHouseBalance must be a non-negative number' })
        return
      }
      await deps.repos.config.set('min_house_balance', String(val))
    }

    if (oddsEdgeBps !== undefined) {
      const val = parseInt(oddsEdgeBps, 10)
      // basis points of house edge baked into variable-odds stakes; must stay
      // below 100% (10000bps) since computeHouseStake scales by (10000 - edge).
      if (isNaN(val) || val < 0 || val >= 10000) {
        res.status(400).json({ error: 'oddsEdgeBps must be between 0 and 9999 (basis points)' })
        return
      }
      await deps.repos.config.set('variable_odds_edge_bps', String(val))
    }

    const config = await deps.repos.config.all()
    res.json({
      rakeType: config.rake_type,
      rakeValue: parseInt(config.rake_value || '2', 10),
      tiers: JSON.parse(config.tiers || '[]'),
      minHouseBalance: parseInt(config.min_house_balance || '100000', 10),
      oddsEdgeBps: parseInt(config.variable_odds_edge_bps || '300', 10),
    })
  })

  // GET /api/games — paginated game history
  router.get('/api/games', async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit || '50')), 100)
    const offset = parseInt(String(req.query.offset || '0'))
    const status = req.query.status ? String(req.query.status) : undefined

    const games = await deps.repos.games.list({ limit, offset, status })
    res.json(games.map((g) => ({
      id: g.id,
      tier: g.tier,
      playerChoice: g.player_choice,
      winner: g.winner,
      rakeAmount: g.rake_amount,
      payoutAmount: g.payout_amount,
      status: g.status,
      createdAt: g.created_at,
      resolvedAt: g.resolved_at,
    })))
  })

  // POST /api/games/expire-pending — release stranded pending games on demand.
  // Pending games already auto-expire after 5 min (startExpiryTimer), which frees the
  // per-player cap and the VTXO reservations. This is the admin override to clear them
  // immediately — e.g. to unblock a player stuck at the cap — instead of waiting for the
  // timer. `olderThanMinutes` (default 0) expires every ELIGIBLE pending game at/over that
  // age; pass a higher value to spare just-created ones. Fund-safe: expirePending SKIPS
  // co-funded games (isCofundedGame) — only pre-cofund abandoned games (no on-chain pot)
  // are expired, so freeing their reservation strands nothing. Co-funded games keep their
  // live pot and are refunded/settled by the v4 reconcilers (reconcileV4Refunds /
  // reconcileV4StageTwo), NEVER expired here.
  router.post('/api/games/expire-pending', async (req: Request, res: Response) => {
    const raw = (req.body ?? {}).olderThanMinutes
    const olderThanMinutes = raw === undefined ? 0 : Number(raw)
    if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
      res.status(400).json({ error: 'olderThanMinutes must be a non-negative number' })
      return
    }
    try {
      const { expired, rows } = await deps.repos.games.expirePending(olderThanMinutes)
      for (const g of rows) reservations.release(g.id)
      res.json({ expired, ids: rows.map((g) => g.id) })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // GET /api/wallet — addresses, balance, VTXOs
  router.get('/api/wallet', async (_req: Request, res: Response) => {
    try {
      const [address, boardingAddress, balance, pubkeyBytes, vtxos] = await Promise.all([
        deps.wallet.getAddress(),
        deps.wallet.getBoardingAddress(),
        readBalance(),
        deps.identity.compressedPublicKey(),
        readVtxos(),
      ])
      res.json({
        address,
        boardingAddress,
        balance,
        pubkey: Buffer.from(pubkeyBytes).toString('hex'),
        vtxoCount: vtxos.length,
      })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/wallet/key — reveal the house private key for backup/restore.
  // The house key is stored plaintext in SQLite (see the boot warning); this
  // endpoint lives on the admin port, which production must protect (e.g.
  // Traefik basic auth). Without it the operator has no way to back the key up.
  router.get('/api/wallet/key', async (_req: Request, res: Response) => {
    try {
      const row = await deps.repos.houseWallet.get()
      if (!row) {
        res.status(404).json({ error: 'House wallet not initialized' })
        return
      }
      res.json({ privateKeyHex: row.private_key_hex, publicKeyHex: row.public_key_hex })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/wallet/history — house wallet transaction history (Ark + boarding combined)
  router.get('/api/wallet/history', async (_req: Request, res: Response) => {
    try {
      const history = await readHistory()
      res.json(history.map((tx) => ({
        txid: tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid,
        type: tx.type,
        amount: tx.amount,
        settled: tx.settled,
        createdAt: tx.createdAt,
        isBoarding: !!tx.key.boardingTxid && !tx.key.arkTxid,
      })))
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/vtxos — house VTXOs with value, expiry, and which game (if any)
  // currently reserves each one (cross-referenced against the in-memory ledger).
  router.get('/api/vtxos', async (_req: Request, res: Response) => {
    try {
      const vtxos = await readVtxos()
      const outpointToGame = new Map<string, string>()
      for (const r of reservations.snapshot()) {
        for (const op of r.outpoints) outpointToGame.set(op, r.gameId)
      }
      res.json(
        vtxos.map((v) => ({
          txid: v.txid,
          vout: v.vout,
          value: v.value,
          batchExpiry: v.virtualStatus?.batchExpiry ?? null,
          expiringSoon: isVtxoExpiringSoon(v, VTXO_EXPIRING_BUFFER_MS),
          reservedBy: outpointToGame.get(`${v.txid}:${v.vout}`) ?? null,
        })),
      )
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/reservations — the in-flight reservation ledger (which VTXOs +
  // liability are committed to which pending games) plus the rolled-up totals.
  router.get('/api/reservations', (_req: Request, res: Response) => {
    res.json({
      activeGames: reservations.activeGames(),
      totalLiability: reservations.totalLiability(),
      reservations: reservations.snapshot(),
    })
  })

  // POST /api/wallet/send — move house funds out to an address (Ark or on-chain;
  // sendBitcoin routes by address type). Guards against draining funds reserved
  // for in-flight games unless { force: true } is passed.
  // NOTE(P0 #53 follow-up): admin send is outpoint-blind (liability-guarded but may pick a reserved coin). Operator-discretion; force bypasses. Deferred — server-side reserved-exclusion tripped 3 distinct regtest failures.
  router.post('/api/wallet/send', async (req: Request, res: Response) => {
    try {
      const { address, force } = req.body
      const amount = parseInt(String(req.body.amount), 10)
      if (typeof address !== 'string' || !address.trim()) {
        res.status(400).json({ error: 'address is required' })
        return
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: 'amount must be a positive number of sats' })
        return
      }
      const balance = await deps.wallet.getBalance()
      const liability = reservations.totalLiability()
      const withdrawable = Math.max(0, balance.available - liability)
      if (amount > withdrawable && !force) {
        res.status(400).json({
          error: `Amount ${amount} exceeds withdrawable ${withdrawable} (available ${balance.available} − reserved liability ${liability}). Pass force:true to override.`,
          available: balance.available,
          liability,
          withdrawable,
        })
        return
      }
      const txid = await deps.wallet.sendBitcoin({ address: address.trim(), amount })
      res.json({ txid })
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) })
    }
  })

  // POST /api/wallet/settle — join a settlement round to renew (re-anchor)
  // expiring VTXOs and confirm boarding deposits into Ark. settle() blocks until
  // a batch round forms, which can be slow (or never, if there's nothing to
  // settle), so we bound it: past SETTLE_TIMEOUT_MS we return 202 and let it
  // finish in the background rather than hanging the HTTP request.
  router.post('/api/wallet/settle', async (_req: Request, res: Response) => {
    try {
      // Explicit reservation-filtered params (P0 #53): the SDK's no-arg
      // gathering would pull VTXOs committed to in-flight games. Same math
      // otherwise; null = nothing eligible → same error the SDK would throw.
      const params = await buildReservationSafeSettleParams(deps)
      if (!params) throw new Error('No inputs found')
      const settlePromise = deps.wallet.settle(params, makeSettlementHandler('admin'))
      // Ensure a late rejection (after we've already responded) can't surface as
      // an unhandled rejection and crash the process.
      settlePromise.catch((e) =>
        console.warn('[admin] background settle failed:', e instanceof Error ? e.message : e),
      )
      const outcome = await withTimeout(settlePromise, SETTLE_TIMEOUT_MS)
      if (outcome.timedOut) {
        res.status(202).json({
          status: 'in_progress',
          message:
            'Settlement is taking longer than expected (waiting for a batch round). It will continue in the background — refresh balances shortly.',
        })
        return
      }
      const balance = await deps.wallet.getBalance()
      res.json({ txid: outcome.value ?? null, balance })
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) })
    }
  })

  // POST /api/wallet/fragment — split large house VTXOs into `pieceSize`-sized
  // pieces so concurrent games can each reserve their own (redistribute the
  // pool). Defaults mirror the background pool maintenance.
  router.post('/api/wallet/fragment', async (req: Request, res: Response) => {
    try {
      const pieceSize = parseInt(String(req.body.pieceSize ?? 50000), 10)
      const targetCount =
        req.body.targetCount !== undefined ? parseInt(String(req.body.targetCount), 10) : undefined
      if (!Number.isFinite(pieceSize) || pieceSize <= 0) {
        res.status(400).json({ error: 'pieceSize must be a positive number of sats' })
        return
      }
      if (targetCount !== undefined && (!Number.isFinite(targetCount) || targetCount <= 0)) {
        res.status(400).json({ error: 'targetCount must be a positive number' })
        return
      }
      const created = await ensureHouseVtxoPool(deps, { targetCount, pieceSize })
      const vtxos = await deps.wallet.getVtxos()
      res.json({ created, vtxoCount: vtxos.length })
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) })
    }
  })

  return router
}
