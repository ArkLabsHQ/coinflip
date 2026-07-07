import { Router, Request, Response } from 'express'
import type { AppDeps } from './deps.js'
import { loadEmulatorConfig } from './emulator.js'
import { newGameProtocolVersion, type V4State } from './trustless-game-v4.js'
import { issueChallenge, verifyChallenge } from './restore-auth.js'
import { RateLimiter } from './rate-limit.js'

// ── Restore-endpoint plumbing ────────────────────────────────────────────────

/** A 32-byte x-only (64 hex) or 33-byte compressed (66 hex) schnorr pubkey. */
const PUBKEY_RE = /^(?:[0-9a-f]{64}|0[23][0-9a-f]{64})$/

/** Per-IP and per-pubkey fixed-window limiters for the restore routes. Defaults
 *  are overridable via env for ops tuning. PER-PROCESS only (single house). */
const restoreIpLimiter = new RateLimiter({
  limit: parseInt(process.env.RESTORE_RATE_IP_PER_MIN || '30', 10),
  windowMs: 60_000,
})
const restorePubkeyLimiter = new RateLimiter({
  limit: parseInt(process.env.RESTORE_RATE_PUBKEY_PER_MIN || '10', 10),
  windowMs: 60_000,
})

/** Best-effort client IP for rate-limit keying. No `trust proxy` is configured,
 *  so behind a reverse proxy this is the proxy's address — adequate for the
 *  single-process house; revisit if deployed behind a shared proxy at scale. */
function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

/** A single restored game (history). Secrets are TERMINAL-GATED exactly like
 *  /details; `playerSecretHex` is never included here (it's client-only while
 *  pending, and the summary intentionally omits preimages). */
interface GameSummary {
  gameId: string
  tier: number
  status: string
  winner: string | null
  payoutAmount: number | null
  rakeAmount: number
  createdAt: string
  resolvedAt: string | null
  protocolVersion: string
}

/** Self-refund reclaim hint for a PENDING v4 game — enough for the client to
 *  drive the refund/forfeit path it ALONE can complete. NEVER carries the
 *  player secret (NULL server-side while pending) or any take-the-pot path. */
interface V4ReclaimHint {
  gameId: string
  contractVersion: 'v4'
  potOutpoint: { txid: string | null; vout: number; value: number | null }
  covenant: V4State['covenant'] | null
  forfeitClaimableAt: number | null
  forfeitEmulatorUrl: string | null
  /** Always null — the player secret is client-only for non-terminal games. */
  playerSecretHex: null
}

export function createPublicRoutes(deps: AppDeps): Router {
  const router = Router()

  // GET /api/network — the network this server is pinned to (from its
  // ARK_SERVER_URL env, surfaced via the Ark server's /v1/info). The client
  // follows this; the server itself never switches networks at runtime.
  //
  // Also reports the arkade-script emulator URL the client must use for
  // forfeit-tx submission, when the emulator is configured. The browser
  // POSTs the forfeit PSBT directly to this URL (the emulator validates
  // the covenant + co-signs + forwards to arkd). Null when the server
  // wasn't started with EMULATOR_URL or the probe failed — clients then
  // fall back to the CSV playerPenalty path.
  router.get('/api/network', async (_req: Request, res: Response) => {
    const emu = await loadEmulatorConfig()
    res.json({
      network: deps.arkInfo.network,
      emulator: emu
        ? { url: emu.publicUrl, signerPubkey: emu.signerPubkeyHex, version: emu.version }
        : null,
      /**
       * Game protocol the client should drive — always 'v4' (joint pot, the
       * /api/v4 flow). Kept so the client can gate its play routing.
       */
      protocolVersion: newGameProtocolVersion(),
    })
  })

  // GET /api/tiers — available bet tiers and house readiness
  router.get('/api/tiers', async (_req: Request, res: Response) => {
    try {
      const tiersStr = (await deps.repos.config.get('tiers')) || '[1000,5000,10000,50000]'
      const tiers: number[] = JSON.parse(tiersStr)
      const minBalance = parseInt((await deps.repos.config.get('min_house_balance')) || '100000', 10)
      const balance = await deps.wallet.getBalance()
      const available = balance.available

      const maxAvailable = tiers.reduce((max, t) => (t <= available ? Math.max(max, t) : max), 0)

      // Publish the rake policy so the trustless client can verify the rake
      // output on the winner-claim it co-signs.
      const rakeType = (await deps.repos.config.get('rake_type')) || 'percentage'
      const rakeValue = parseInt((await deps.repos.config.get('rake_value')) || '2', 10)

      res.json({
        tiers,
        maxAvailable,
        // The house's actual spendable balance — the ceiling on a single payout,
        // so the client can size variable-odds bets (a 6× bet escrows ~5× the
        // stake). Distinct from maxAvailable, which is the largest playable tier.
        houseBankroll: available,
        // Dust limit + variable-odds house edge so the client can size the SAFE
        // end of the odds slider: a high-win bet makes the house stake tiny, and
        // below dust the server rejects it. The client mirrors computeHouseStake.
        dust: Number(deps.arkInfo.dust ?? 546n),
        oddsEdgeBps: parseInt((await deps.repos.config.get('variable_odds_edge_bps')) || '300', 10),
        houseReady: available >= minBalance,
        rakeType,
        rakeValue,
      })
    } catch (err) {
      console.error('Tiers error:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/game/:id — get game status
  router.get('/api/game/:id', async (req: Request, res: Response) => {
    const game = await deps.repos.games.get(String(req.params.id))
    if (!game) {
      res.status(404).json({ error: 'Game not found' })
      return
    }
    const isResolved = game.status === 'resolved'
    res.json({
      id: game.id,
      tier: game.tier,
      // Only reveal player choice after resolution to prevent information leakage
      playerChoice: isResolved ? game.player_choice : undefined,
      winner: game.winner,
      rakeAmount: game.rake_amount,
      payoutAmount: game.payout_amount,
      status: game.status,
      createdAt: game.created_at,
      resolvedAt: game.resolved_at,
    })
  })

  // GET /api/game/:id/details — full game details (txids, preimages, params)
  //   ?playerPubkey=<hex> — must match the game's playerPubkey to authorize.
  //
  // Preimages are only returned once the game is in a terminal state
  // (`resolved` or `expired`), so a live game's player secret never leaks
  // mid-flight (matters even though the owning player POSTed it — a leaked
  // /commit response could otherwise be replayed against the in-flight hash).
  // The on-chain reveal makes both secrets public knowledge at terminal time
  // anyway (condition witness on v2, reveal packets on v3).
  router.get('/api/game/:id/details', async (req: Request, res: Response) => {
    const game = await deps.repos.games.get(String(req.params.id))
    if (!game) {
      res.status(404).json({ error: 'Game not found' })
      return
    }
    const wantPubkey = String(req.query.playerPubkey || '').trim().toLowerCase()
    if (!wantPubkey || wantPubkey !== game.player_pubkey.toLowerCase()) {
      // Pubkey mismatch is treated as 404 (not 403) to avoid leaking
      // game-existence information to anyone scanning game IDs. Log the
      // mismatch server-side so an operator debugging a legitimate user's
      // "Game not found" can see whether the row actually exists.
      console.warn(
        `[details] gameId=${game.id} pubkey mismatch — request='${wantPubkey || '(empty)'}', ` +
        `expected='${game.player_pubkey.toLowerCase()}'`,
      )
      res.status(404).json({ error: 'Game not found' })
      return
    }
    const terminal = game.status === 'resolved' || game.status === 'expired'
    // Parse the trustless state JSON for txids / contract params / odds.
    let state: Record<string, unknown> = {}
    try { state = JSON.parse(game.house_vtxos_json || '{}') } catch { /* malformed → empty */ }
    const houseEscrow = (state.houseEscrow as { txid?: string; vout?: number; value?: number } | undefined) ?? undefined
    const playerEscrow = (state.playerEscrow as { txid?: string; vout?: number; value?: number } | undefined) ?? undefined
    const arkadeForfeit = (state.arkadeForfeit as { houseStake?: number; playerStake?: number; emulatorPubkeyHex?: string; exitDelay?: number } | undefined) ?? undefined
    res.json({
      id: game.id,
      tier: game.tier,
      status: game.status,
      winner: game.winner,
      payoutAmount: game.payout_amount,
      rakeAmount: game.rake_amount,
      createdAt: game.created_at,
      resolvedAt: game.resolved_at,
      // Contract parameters
      contractVersion: (state.contractVersion as string | undefined) ?? 'v2',
      playerHash: game.player_hash,
      playerChoice: terminal ? game.player_choice : undefined,
      finalExpiration: state.finalExpiration ?? null,
      setupExpiration: state.setupExpiration ?? null,
      // Variable odds (undefined for the 50/50 coin)
      oddsN: state.oddsN ?? null,
      oddsTarget: state.oddsTarget ?? null,
      oddsLo: state.oddsLo ?? null,
      // Arkade-script forfeit pin (stakes, emu pubkey, exit delay)
      houseStake: arkadeForfeit?.houseStake ?? null,
      playerStake: arkadeForfeit?.playerStake ?? null,
      emulatorPubkey: arkadeForfeit?.emulatorPubkeyHex ?? null,
      exitDelay: arkadeForfeit?.exitDelay ?? null,
      // Outpoints (escrows, sweep, refund)
      houseEscrow: houseEscrow && houseEscrow.txid ? houseEscrow : null,
      playerEscrow: playerEscrow && playerEscrow.txid ? playerEscrow : null,
      resolveTxid: (state.resolveTxid as string | undefined) ?? null,
      houseRefundTxid: (state.houseRefundTxid as string | undefined) ?? null,
      // Preimages (terminal state only — both are public knowledge on-chain by then).
      houseSecret: terminal ? game.house_secret_hex : null,
      playerSecret: terminal ? game.player_secret_hex : null,
    })
  })

  // GET /api/games/challenge?playerPubkey=<hex> — issue a signature-proof nonce
  // for the restore flow. The client schnorr-signs sha256(utf8(nonce)) and
  // presents (nonce, sig) to GET /api/games. Stateless: the nonce's MAC binds it
  // to (pubkey, time), so the server stores nothing. Rate-limited per IP.
  router.get('/api/games/challenge', async (req: Request, res: Response) => {
    if (!restoreIpLimiter.allow(`challenge:${clientIp(req)}`, Date.now())) {
      res.status(429).set('Retry-After', '60').json({ error: 'Too many requests' })
      return
    }
    const playerPubkey = String(req.query.playerPubkey || '').trim().toLowerCase()
    if (!PUBKEY_RE.test(playerPubkey)) {
      res.status(400).json({ error: 'Invalid or missing playerPubkey (expect 32-byte x-only or 33-byte compressed hex)' })
      return
    }
    res.json({ nonce: issueChallenge(playerPubkey, Date.now()) })
  })

  // GET /api/games?playerPubkey=&nonce=&sig=&limit=&offset=&status= — restore a
  // player's games. Auth: verifyChallenge (the caller proves it holds the key for
  // playerPubkey) BEFORE any DB read; 401 on failure. Rate-limited per IP AND per
  // pubkey. Returns history summaries + (for PENDING v4 games) self-refund reclaim
  // hints. Secrets are TERMINAL-GATED like /details; playerSecretHex is always
  // null (client-only while pending — the server never holds the take-the-pot key).
  router.get('/api/games', async (req: Request, res: Response) => {
    const now = Date.now()
    const ip = clientIp(req)
    if (!restoreIpLimiter.allow(`games:${ip}`, now)) {
      res.status(429).set('Retry-After', '60').json({ error: 'Too many requests' })
      return
    }
    const playerPubkey = String(req.query.playerPubkey || '').trim().toLowerCase()
    const nonce = String(req.query.nonce || '')
    const sig = String(req.query.sig || '')
    if (!PUBKEY_RE.test(playerPubkey)) {
      res.status(400).json({ error: 'Invalid or missing playerPubkey' })
      return
    }
    // Per-pubkey limit too, so one key can't exhaust the per-IP budget across a
    // proxy. Keyed on the validated pubkey; checked before the (cheap) verify.
    if (!restorePubkeyLimiter.allow(`games:${playerPubkey}`, now)) {
      res.status(429).set('Retry-After', '60').json({ error: 'Too many requests' })
      return
    }
    if (!verifyChallenge(playerPubkey, nonce, sig, now)) {
      res.status(401).json({ error: 'Invalid or expired challenge signature' })
      return
    }

    // Optional paging/filter — listForPlayer hard-caps the limit internally.
    const limit = req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : undefined
    const offset = req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : undefined
    const status = req.query.status !== undefined ? String(req.query.status) : undefined

    const rows = await deps.repos.games.listForPlayer(playerPubkey, {
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      status,
    })

    const emu = await loadEmulatorConfig()
    const games: GameSummary[] = []
    const reclaimHints: V4ReclaimHint[] = []
    for (const game of rows) {
      let state: Record<string, unknown> = {}
      try { state = JSON.parse(game.house_vtxos_json || '{}') } catch { /* malformed → empty */ }
      const protocolVersion =
        (state.protocolVersion as string | undefined) ??
        (state.contractVersion as string | undefined) ??
        'v2'
      games.push({
        gameId: game.id,
        tier: game.tier,
        status: game.status,
        winner: game.winner,
        payoutAmount: game.payout_amount,
        rakeAmount: game.rake_amount,
        createdAt: game.created_at,
        resolvedAt: game.resolved_at,
        protocolVersion,
      })

      // Reclaim hint: PENDING v4 games only. v3/v2 are history-only — the server
      // doesn't hold the client-funded escrow outpoint needed to build a refund,
      // and a terminal game needs no reclaim. NEVER includes the player secret.
      if (game.status === 'pending' && protocolVersion === 'v4') {
        const v4 = state as unknown as V4State
        const covenant = v4.covenant ?? null
        reclaimHints.push({
          gameId: game.id,
          contractVersion: 'v4',
          potOutpoint: { txid: v4.cofundTxid ?? null, vout: 0, value: v4.pot ?? null },
          covenant,
          forfeitClaimableAt: covenant?.finalExpiration ?? null,
          forfeitEmulatorUrl: emu?.publicUrl ?? null,
          playerSecretHex: null,
        })
      }
    }

    res.json({ games, reclaimHints })
  })

  return router
}
