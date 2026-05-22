import { Router, Request, Response } from 'express'
import {
  handleTrustlessPlay,
  handleTrustlessCommit,
  type TrustlessPlayRequest,
  type TrustlessCommitRequest,
} from './trustless-game.js'
import { HouseBusyError } from './vtxo-pool.js'
import type { AppDeps } from './deps.js'

export function createPublicRoutes(deps: AppDeps): Router {
  const router = Router()

  // GET /api/network — the network this server is pinned to (from its
  // ARK_SERVER_URL env, surfaced via the Ark server's /v1/info). The client
  // follows this; the server itself never switches networks at runtime.
  router.get('/api/network', (_req: Request, res: Response) => {
    res.json({ network: deps.arkInfo.network })
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
      if (err instanceof HouseBusyError) {
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

  return router
}
