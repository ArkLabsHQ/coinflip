import { Router, Request, Response } from 'express'
import {
  handleTrustlessPlay,
  handleTrustlessCommit,
  handleTrustlessRefund,
  handleTrustlessForfeit,
  type TrustlessPlayRequest,
  type TrustlessCommitRequest,
  type TrustlessRefundRequest,
  type TrustlessForfeitRequest,
} from './trustless-game.js'
import { HouseBusyError, BetExceedsCapacityError } from './vtxo-pool.js'
import type { AppDeps } from './deps.js'
import { loadEmulatorConfig } from './emulator.js'
import { newGameEscrowVersion } from './trustless-game.js'
import { newGameProtocolVersion } from './trustless-game-v4.js'

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
       * Escrow contract version this server mints NEW games with. Lets the
       * client pick the matching playerHash format BEFORE calling /play —
       * v2 = raw bytes (variable length), v3 = `[digit] ‖ salt` from
       * `commitDigit(d, n)`. The server echoes the version back on /play
       * for verification.
       */
      escrowVersion: newGameEscrowVersion(),
      /**
       * Game protocol the client should drive — 'v3' (per-party escrow, the
       * default) or 'v4' (joint pot, the /api/v4 flow). Opt-in via the server's
       * PROTOCOL_VERSION env; the client routes to playV4Game when this is 'v4'.
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

  // POST /api/play — start a trustless game: the house escrows its stake and
  // returns the shared escrow address for the player to fund.
  router.post('/api/play', async (req: Request, res: Response) => {
    try {
      const body = req.body as TrustlessPlayRequest
      if (!body.tier || !body.playerPubkey || !body.playerHash || !body.playerChangeAddress) {
        res.status(400).json({ error: 'Missing required fields: tier, playerPubkey, playerHash, playerChangeAddress' })
        return
      }
      const result = await handleTrustlessPlay(body, deps)
      res.json(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (err instanceof BetExceedsCapacityError) {
        res.status(400).json({ error: message })
      } else if (err instanceof HouseBusyError) {
        res.status(503).set('Retry-After', '3').json({ error: message })
      } else if (message.includes('Too many pending')) {
        res.status(429).json({ error: message })
      } else if (message.includes('insufficient') || message.includes('Invalid tier') || message.includes('covering')) {
        res.status(400).json({ error: message })
      } else {
        console.error('Play error:', err)
        res.status(500).json({ error: message })
      }
    }
  })

  // POST /api/game/:id/commit — player reveals its secret + escrow outpoint;
  // the server resolves and (house win) sweeps, or returns the playerWin sweep
  // PSBT for the client to sign + submit.
  router.post('/api/game/:id/commit', async (req: Request, res: Response) => {
    try {
      const body = req.body as TrustlessCommitRequest
      if (!body.playerSecretHex || !body.playerEscrow?.txid) {
        res.status(400).json({ error: 'Missing required fields: playerSecretHex, playerEscrow' })
        return
      }
      const result = await handleTrustlessCommit(String(req.params.id), body, deps)
      res.json(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
      } else if (message.includes('not pending') || message.includes('does not match')) {
        res.status(400).json({ error: message })
      } else {
        console.error('Commit error:', err)
        res.status(500).json({ error: message })
      }
    }
  })

  // POST /api/game/:id/refund — build the player's escrow-refund PSBT so the
  // player can reclaim a stalled game trustlessly. The server only assembles
  // the unsigned tx (refund leaf is player+server, CLTV-locked, pays the
  // player's own address); the client verifies, signs, and submits after the
  // timelock. Clients should fetch this right after escrowing and keep it.
  router.post('/api/game/:id/refund', async (req: Request, res: Response) => {
    try {
      const body = req.body as TrustlessRefundRequest
      if (!body.playerEscrow?.txid) {
        res.status(400).json({ error: 'Missing required field: playerEscrow' })
        return
      }
      const result = await handleTrustlessRefund(String(req.params.id), body, deps)
      res.json(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
      } else if (message.includes('resolved') || message.includes('no player change')) {
        res.status(400).json({ error: message })
      } else {
        console.error('Refund error:', err)
        res.status(500).json({ error: message })
      }
    }
  })

  // POST /api/game/:id/forfeit — build the unsigned arkade-script forfeit-
  // claim tx for a game minted with the 5-leaf escrow (EMULATOR_URL was set
  // at /play time). The playerForfeit leaf is CLTVMultisigTapscript wrapping
  // an arkade-script covenant — execution bucket, no unilateral exit needed.
  // Rejected for legacy games (no arkade-script pin); those use /penalty.
  router.post('/api/game/:id/forfeit', async (req: Request, res: Response) => {
    try {
      const body = req.body as TrustlessForfeitRequest
      if (!body.playerEscrow?.txid) {
        res.status(400).json({ error: 'Missing required field: playerEscrow' })
        return
      }
      const result = await handleTrustlessForfeit(String(req.params.id), body, deps)
      res.json(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
      } else if (
        message.includes('resolved') ||
        message.includes('no player change') ||
        message.includes('no recorded house escrow') ||
        message.includes('without arkade-script forfeit')
      ) {
        res.status(400).json({ error: message })
      } else {
        console.error('Forfeit error:', err)
        res.status(500).json({ error: message })
      }
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

  return router
}
