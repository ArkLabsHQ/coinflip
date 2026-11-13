import { Router, type Response } from 'express'
import { PoolError, type PoolService } from './service.js'

async function respond(res: Response, work: () => Promise<unknown>, accepted = false): Promise<void> {
  try { res.status(accepted ? 202 : 200).json(await work()) }
  catch (error) { res.status(error instanceof PoolError ? error.status : 503)
    .json({ error: error instanceof Error ? error.message : 'Pool service is unavailable' }) }
}

export function createPoolRoutes(pool: PoolService): Router {
  const router = Router()
  router.get('/api/pool', (_req, res) => { void respond(res, () => pool.publicState()) })
  router.post('/api/pool/prepare', (req, res) => { void respond(res, () => pool.prepare(req.body)) })
  router.post('/api/pool/submit', (req, res) => { void respond(res, () => pool.submit(req.body), true) })
  router.get('/api/pool/operations/:id', (req, res) => { void respond(res, () => pool.operation(String(req.params.id))) })
  router.post('/api/pool/operations/:id/reveal', (req, res) => {
    void respond(res, () => pool.reveal(String(req.params.id), req.body?.playerSecretHex), true)
  })
  return router
}

export function createPoolAdminRoutes(pool: PoolService): Router {
  const router = Router()
  router.get('/api/admin/pool', (_req, res) => { void respond(res, () => pool.publicState()) })
  router.get('/api/admin/pool/operations/:id', (req, res) => { void respond(res, () => pool.operation(String(req.params.id))) })
  router.put('/api/admin/pool/policy', (req, res) => { void respond(res, () => pool.setPolicy(req.body)) })
  router.get('/api/admin/pool/position', (_req, res) => { void respond(res, () => pool.operatorPosition()) })
  router.post('/api/admin/pool/fees', (req, res) => { void respond(res, () => pool.operatorAction({
    operationId: req.body?.operationId, expectedHead: req.body?.expectedHead, command: { kind: 'sweepFees' },
  }), true) })
  router.post('/api/admin/pool/redeem', (req, res) => { void respond(res, () => pool.operatorAction({
    operationId: req.body?.operationId, expectedHead: req.body?.expectedHead, memberOutpoint: req.body?.memberOutpoint,
    command: { kind: 'redeem', burnShares: req.body?.burnShares, minSats: req.body?.minSats },
  }), true) })
  router.post('/api/admin/pool/bootstrap', (req, res) => { void respond(res, () => pool.bootstrap(req.body)) })
  return router
}
