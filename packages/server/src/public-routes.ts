import { Router, Request, Response } from 'express'
import { getConfig } from './db'
import { getHouseBalanceSats } from './house-wallet'
import { handlePlay, handleSign, PlayRequest, SignRequest } from './game-engine'
import { getGame as dbGetGame } from './db'

const router = Router()

// GET /api/tiers — available bet tiers and house readiness
router.get('/api/tiers', async (_req: Request, res: Response) => {
  try {
    const tiersStr = getConfig('tiers') || '[1000,5000,10000,50000]'
    const tiers: number[] = JSON.parse(tiersStr)
    const minBalance = parseInt(getConfig('min_house_balance') || '100000', 10)
    const available = await getHouseBalanceSats()

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

    const result = await handlePlay(body)
    res.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (message.includes('Too many pending')) {
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

    const result = await handleSign(gameId, body)
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
router.get('/api/game/:id', (req: Request, res: Response) => {
  const game = dbGetGame(String(req.params.id))
  if (!game) {
    res.status(404).json({ error: 'Game not found' })
    return
  }
  res.json({
    id: game.id,
    tier: game.tier,
    playerChoice: game.player_choice,
    winner: game.winner,
    rakeAmount: game.rake_amount,
    payoutAmount: game.payout_amount,
    status: game.status,
    createdAt: game.created_at,
    resolvedAt: game.resolved_at,
  })
})

export default router
