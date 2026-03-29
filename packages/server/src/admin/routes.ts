import { Router, Request, Response } from 'express'
import path from 'path'
import { getAllConfig, setConfig, getGames, getGameStats } from '../db'
import { getHouseAddress, getHouseBoardingAddress, getHouseBalance, getHousePubkeyHex, getHouseVtxos } from '../house-wallet'

const router = Router()

// GET / — serve dashboard
router.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'))
})

// GET /api/status — balance, game counts, profit
router.get('/api/status', async (_req: Request, res: Response) => {
  try {
    const stats = getGameStats()
    const balance = await getHouseBalance()
    const pubkey = await getHousePubkeyHex()
    res.json({
      balance,
      pubkey,
      ...stats,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/config — current configuration
router.get('/api/config', (_req: Request, res: Response) => {
  const config = getAllConfig()
  res.json({
    rakeType: config.rake_type || 'percentage',
    rakeValue: parseInt(config.rake_value || '2', 10),
    tiers: JSON.parse(config.tiers || '[1000,5000,10000,50000]'),
    minHouseBalance: parseInt(config.min_house_balance || '100000', 10),
  })
})

// POST /api/config — update configuration
router.post('/api/config', (req: Request, res: Response) => {
  const { rakeType, rakeValue, tiers, minHouseBalance } = req.body

  if (rakeType !== undefined) {
    if (rakeType !== 'percentage' && rakeType !== 'flat') {
      res.status(400).json({ error: 'rakeType must be "percentage" or "flat"' })
      return
    }
    setConfig('rake_type', rakeType)
  }

  if (rakeValue !== undefined) {
    const val = parseInt(rakeValue, 10)
    if (isNaN(val) || val < 0) {
      res.status(400).json({ error: 'rakeValue must be a non-negative number' })
      return
    }
    setConfig('rake_value', String(val))
  }

  if (tiers !== undefined) {
    if (!Array.isArray(tiers) || tiers.some((t: unknown) => typeof t !== 'number' || t <= 0)) {
      res.status(400).json({ error: 'tiers must be an array of positive numbers' })
      return
    }
    setConfig('tiers', JSON.stringify(tiers))
  }

  if (minHouseBalance !== undefined) {
    const val = parseInt(minHouseBalance, 10)
    if (isNaN(val) || val < 0) {
      res.status(400).json({ error: 'minHouseBalance must be a non-negative number' })
      return
    }
    setConfig('min_house_balance', String(val))
  }

  const config = getAllConfig()
  res.json({
    rakeType: config.rake_type,
    rakeValue: parseInt(config.rake_value || '2', 10),
    tiers: JSON.parse(config.tiers || '[]'),
    minHouseBalance: parseInt(config.min_house_balance || '100000', 10),
  })
})

// GET /api/games — paginated game history
router.get('/api/games', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || '50')), 100)
  const offset = parseInt(String(req.query.offset || '0'))
  const status = req.query.status ? String(req.query.status) : undefined

  const games = getGames({ limit, offset, status })
  res.json(games.map(g => ({
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

// GET /api/wallet — addresses, balance, VTXOs
router.get('/api/wallet', async (_req: Request, res: Response) => {
  try {
    const [address, boardingAddress, balance, pubkey, vtxos] = await Promise.all([
      getHouseAddress(),
      getHouseBoardingAddress(),
      getHouseBalance(),
      getHousePubkeyHex(),
      getHouseVtxos(),
    ])
    res.json({
      address,
      boardingAddress,
      balance,
      pubkey,
      vtxoCount: vtxos.length,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export default router
