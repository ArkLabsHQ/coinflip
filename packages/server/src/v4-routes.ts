/**
 * v4 joint-pot HTTP routes — thin express wrappers over the trustless-game-v4
 * handlers. Mounted alongside the v3 routes; the v4 game flow is:
 *
 *   POST /api/v4/play                       → reserve house VTXO + covenant params
 *   POST /api/v4/game/:id/cofund            → co-fund round 1 (server signs house)
 *   POST /api/v4/game/:id/cofund-finalize   → co-fund round 2 (finalize → pot VTXO)
 *   POST /api/v4/game/:id/reveal            → settle the pot to the winner
 *
 * The handlers carry all the protocol logic + validation; routes only parse the
 * body, surface required-field errors, and map handler errors to status codes.
 */

import { Router, Request, Response } from 'express'
import {
  handleV4Play,
  handleV4Cofund,
  handleV4CofundFinalize,
  handleV4Reveal,
  handleV4CooperativeExit,
  type V4PlayRequest,
  type V4CofundRequest,
  type V4CofundFinalizeRequest,
  type V4RevealRequest,
  type V4CooperativeExitRequest,
} from './trustless-game-v4.js'
import { HouseBusyError, BetExceedsCapacityError } from './vtxo-pool.js'
import type { AppDeps } from './deps.js'

/** Map a handler error to an HTTP status + send it. */
function sendError(res: Response, err: unknown, logLabel: string): void {
  const message = err instanceof Error ? err.message : 'Unknown error'
  if (err instanceof BetExceedsCapacityError) {
    res.status(400).json({ error: message })
  } else if (err instanceof HouseBusyError) {
    res.status(503).set('Retry-After', '3').json({ error: message })
  } else if (message.includes('Too many pending')) {
    res.status(429).json({ error: message })
  } else if (message.includes('not found') || message.includes('Not a v4 game')) {
    res.status(404).json({ error: message })
  } else if (
    message.includes('Invalid tier') ||
    message.includes('Invalid odds') ||
    message.includes('sub-dust') ||
    message.includes('does not match') ||
    message.includes('not pending') ||
    message.includes('already') ||
    message.includes('not co-funded') ||
    message.includes('not submitted') ||
    message.includes('must have') ||
    message.includes('cooperative-exit')
  ) {
    res.status(400).json({ error: message })
  } else {
    console.error(`${logLabel} error:`, err)
    res.status(500).json({ error: message })
  }
}

export function createV4Routes(deps: AppDeps): Router {
  const router = Router()

  // POST /api/v4/play — reserve a house stake VTXO + return the covenant params.
  router.post('/api/v4/play', async (req: Request, res: Response) => {
    try {
      const body = req.body as V4PlayRequest
      if (!body.tier || !body.playerPubkey || !body.playerHash || !body.playerPayoutAddress || !body.playerChangeAddress) {
        res.status(400).json({ error: 'Missing required fields: tier, playerPubkey, playerHash, playerPayoutAddress, playerChangeAddress' })
        return
      }
      res.json(await handleV4Play(body, deps))
    } catch (err) {
      sendError(res, err, 'v4/play')
    }
  })

  // POST /api/v4/game/:id/cofund — co-fund round 1.
  router.post('/api/v4/game/:id/cofund', async (req: Request, res: Response) => {
    try {
      const body = req.body as V4CofundRequest
      if (!body.arkTx || !Array.isArray(body.checkpoints)) {
        res.status(400).json({ error: 'Missing required fields: arkTx, checkpoints' })
        return
      }
      res.json(await handleV4Cofund(String(req.params.id), body, deps))
    } catch (err) {
      sendError(res, err, 'v4/cofund')
    }
  })

  // POST /api/v4/game/:id/cofund-finalize — co-fund round 2.
  router.post('/api/v4/game/:id/cofund-finalize', async (req: Request, res: Response) => {
    try {
      const body = req.body as V4CofundFinalizeRequest
      if (!Array.isArray(body.playerCheckpoints) || body.playerCheckpoints.length === 0) {
        res.status(400).json({ error: 'Missing required field: playerCheckpoints' })
        return
      }
      res.json(await handleV4CofundFinalize(String(req.params.id), body, deps))
    } catch (err) {
      sendError(res, err, 'v4/cofund-finalize')
    }
  })

  // POST /api/v4/game/:id/reveal — settle the pot to the winner.
  router.post('/api/v4/game/:id/reveal', async (req: Request, res: Response) => {
    try {
      const body = req.body as V4RevealRequest
      if (!body.playerSecretHex) {
        res.status(400).json({ error: 'Missing required field: playerSecretHex' })
        return
      }
      res.json(await handleV4Reveal(String(req.params.id), body, deps))
    } catch (err) {
      sendError(res, err, 'v4/reveal')
    }
  })

  // POST /api/v4/game/:id/cooperative-exit — house co-signs the client's leaf-7
  // on-chain split-back (emulator-free recovery). Client sends its player-signed
  // exit PSBT + the unrolled pot outpoint; house returns the co-signed PSBT.
  router.post('/api/v4/game/:id/cooperative-exit', async (req: Request, res: Response) => {
    try {
      const body = req.body as V4CooperativeExitRequest
      if (!body.exitTxPsbt || !body.potOnchain?.txid || typeof body.feeSats !== 'number') {
        res.status(400).json({ error: 'Missing required fields: exitTxPsbt, potOnchain{txid,vout,value}, feeSats' })
        return
      }
      res.json(await handleV4CooperativeExit(String(req.params.id), body, deps))
    } catch (err) {
      sendError(res, err, 'v4/cooperative-exit')
    }
  })

  return router
}
