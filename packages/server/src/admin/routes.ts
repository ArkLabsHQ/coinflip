import { Router, Request, Response } from 'express'
import path from 'path'
import type { AppDeps } from '../deps.js'

export function createAdminRoutes(deps: AppDeps): Router {
  const router = Router()

  // GET / — serve dashboard
  router.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'))
  })

  // GET /api/status — balance, game counts, profit
  router.get('/api/status', async (_req: Request, res: Response) => {
    try {
      const [stats, balance, pubkeyBytes] = await Promise.all([
        deps.repos.games.stats(),
        deps.wallet.getBalance(),
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
    })
  })

  // POST /api/config — update configuration
  router.post('/api/config', async (req: Request, res: Response) => {
    const { rakeType, rakeValue, tiers, minHouseBalance } = req.body

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

    const config = await deps.repos.config.all()
    res.json({
      rakeType: config.rake_type,
      rakeValue: parseInt(config.rake_value || '2', 10),
      tiers: JSON.parse(config.tiers || '[]'),
      minHouseBalance: parseInt(config.min_house_balance || '100000', 10),
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

  // GET /api/wallet — addresses, balance, VTXOs
  router.get('/api/wallet', async (_req: Request, res: Response) => {
    try {
      const [address, boardingAddress, balance, pubkeyBytes, vtxos] = await Promise.all([
        deps.wallet.getAddress(),
        deps.wallet.getBoardingAddress(),
        deps.wallet.getBalance(),
        deps.identity.compressedPublicKey(),
        deps.wallet.getVtxos(),
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

  return router
}
