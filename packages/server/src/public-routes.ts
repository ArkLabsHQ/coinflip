import { Router, Request, Response } from 'express'
import { handlePlay, handleSign, PlayRequest, SignRequest } from './game-engine.js'
import { HouseBusyError } from './vtxo-pool.js'
import type { AppDeps } from './deps.js'

export function createPublicRoutes(deps: AppDeps): Router {
  const router = Router()

  // GET /api/tiers — available bet tiers and house readiness
  router.get('/api/tiers', async (_req: Request, res: Response) => {
    try {
      const tiersStr = (await deps.repos.config.get('tiers')) || '[1000,5000,10000,50000]'
      const tiers: number[] = JSON.parse(tiersStr)
      const minBalance = parseInt((await deps.repos.config.get('min_house_balance')) || '100000', 10)
      const balance = await deps.wallet.getBalance()
      const available = balance.available

      const maxAvailable = tiers.reduce((max, t) => (t <= available ? Math.max(max, t) : max), 0)

      res.json({
        tiers,
        maxAvailable,
        houseReady: available >= minBalance,
      })
    } catch (err) {
      console.error('Tiers error:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /api/play — create a new game against the house
  router.post('/api/play', async (req: Request, res: Response) => {
    try {
      const body = req.body as PlayRequest
      if (!body.tier || !body.choice || !body.playerPubkey || !body.playerHash) {
        res.status(400).json({ error: 'Missing required fields: tier, choice, playerPubkey, playerHash' })
        return
      }
      if (body.choice !== 'heads' && body.choice !== 'tails') {
        res.status(400).json({ error: 'choice must be "heads" or "tails"' })
        return
      }

      const result = await handlePlay(body, deps)
      res.json(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (err instanceof HouseBusyError) {
        // Retry-able: the house is at capacity for concurrent games.
        res.status(503).set('Retry-After', '3').json({ error: message })
      } else if (message.includes('Too many pending')) {
        res.status(429).json({ error: message })
      } else if (message.includes('insufficient') || message.includes('Invalid tier')) {
        res.status(400).json({ error: message })
      } else {
        console.error('Play error:', err)
        res.status(500).json({ error: message })
      }
    }
  })

  // POST /api/game/:id/sign — player signs and resolves the game
  router.post('/api/game/:id/sign', async (req: Request, res: Response) => {
    try {
      const gameId = String(req.params.id)
      const body = req.body as SignRequest
      if (!body.playerSecretHex) {
        res.status(400).json({ error: 'Missing required field: playerSecretHex' })
        return
      }

      const result = await handleSign(gameId, body, deps)
      res.json(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
      } else if (message.includes('not pending') || message.includes('does not match')) {
        res.status(400).json({ error: message })
      } else {
        console.error('Sign error:', err)
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
