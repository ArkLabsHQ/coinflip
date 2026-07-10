/**
 * Coinflip House Mode server.
 *
 * Two ports:
 * - PUBLIC_PORT (3001): Player-facing game API
 * - ADMIN_PORT (3002): Admin dashboard + config API (internal only)
 */

// Polyfill EventSource for Node.js (Ark SDK's ContractWatcher uses SSE)
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { EventSource: NodeEventSource } = require('eventsource')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).EventSource = NodeEventSource

import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { getSqlExecutor, initDb, closeDb } from './db.js'
import { makeRepos } from './repositories/index.js'
import { initHouseWallet } from './house-wallet.js'
import { startExpiryTimer, startRenewalTimer } from './game-engine.js'
import { rebuildReservations, startPoolMaintenance } from './vtxo-pool.js'
import { createPublicRoutes } from './public-routes.js'
import { createV4Routes } from './v4-routes.js'
import { startV4RefundTimer } from './trustless-game-v4.js'
import { createAdminRoutes } from './admin/routes.js'
import type { AppDeps } from './deps.js'

// Re-exports for in-process consumers (tests / embedded use). Keeping these
// in the main entry rather than a separate `bootstrap.ts` so a test can do
//   `const { bootstrapDeps, createPublicRoutes } = require('arkade-coinflip-server')`
// and drive everything from one import without auto-starting the listener.
export { getSqlExecutor, initDb } from './db.js'
export { makeRepos } from './repositories/index.js'
export { initHouseWallet } from './house-wallet.js'
export { startExpiryTimer, startRenewalTimer, shouldRenew } from './game-engine.js'
export {
  handleV4Play,
  handleV4Cofund,
  handleV4CofundFinalize,
  handleV4Reveal,
  broadcastV4Refund,
  reconcileV4Refunds,
  settleV4StageTwo,
  reconcileV4StageTwo,
  newGameProtocolVersion,
  type V4PlayRequest,
  type V4PlayResult,
  type V4CovenantParams,
  type V4State,
  type V4CofundRequest,
  type V4CofundResult,
  type V4CofundFinalizeRequest,
  type V4CofundFinalizeResult,
  type V4RevealRequest,
  type V4RevealResult,
} from './trustless-game-v4.js'
export { rebuildReservations, startPoolMaintenance, ensureHouseVtxoPool } from './vtxo-pool.js'
export { createPublicRoutes } from './public-routes.js'
export { createV4Routes } from './v4-routes.js'
export { createAdminRoutes } from './admin/routes.js'
export type { AppDeps } from './deps.js'

const PUBLIC_PORT = parseInt(process.env.PUBLIC_PORT || '3001', 10)
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '3002', 10)

/**
 * Build the full AppDeps cycle without starting any HTTP listeners.
 * Equivalent to what `main()` does up to (but not including) the express
 * `.listen()` calls. Useful for tests that hit routes via supertest.
 */
export interface BootstrapOptions {
  /** Forwarded to `initHouseWallet` — see `InitHouseWalletOptions`. */
  walletSettlementConfig?: false | object
}

export async function bootstrapDeps(options: BootstrapOptions = {}): Promise<AppDeps> {
  await initDb()
  const repos = makeRepos(getSqlExecutor())
  // Keep the SDK's auto-renewal poll-loop OFF (settlementConfig:false). NB: the
  // installed SDK's `runPeriodicSettle` is now gated (returns early unless VTXOs
  // are near-expiry or boarding needs confirming) and fee-aware, so the old
  // "~30s INTENT_INSUFFICIENT_FEE churn" no longer describes it. We still drive
  // renewal ourselves via the gated `startRenewalTimer` so it stays coupled to
  // `/play`'s 30-min selection buffer — the SDK's 3-day default vtxoThreshold +
  // a background loop `/play` can't observe could let it race a not-yet-renewed
  // VTXO. Callers (tests) may override.
  const { wallet, identity, arkInfo } = await initHouseWallet(repos, {
    settlementConfig: options.walletSettlementConfig ?? false,
  })
  const deps: AppDeps = { repos, wallet, identity, arkInfo }
  // Best-effort: attach the wallet's ContractManager so trustless settlement can
  // track each escrow and react to its on-chain spend eagerly. A failure here is
  // non-fatal — the 120s failsafe reconcile resolves games regardless.
  try {
    deps.contractManager = await wallet.getContractManager()
  } catch (err) {
    console.warn('[contract] getContractManager failed; continuing without eager contract watch:', err instanceof Error ? err.message : err)
  }
  return deps
}

async function main() {
  console.log('Bootstrapping server dependencies...')
  const deps = await bootstrapDeps()

  // Probe the arkade-script emulator early so the boot log shows whether
  // new games will use the 5-leaf escrow or fall back to the 4-leaf CSV
  // path. loadEmulatorConfig is cache-backed, so this is the only network
  // hit per process lifetime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  await (await import('./emulator.js')).loadEmulatorConfig()

  // Rebuild VTXO reservations from any pending games that survived a restart,
  // then keep a healthy pool of distinct house VTXOs for concurrent play.
  await rebuildReservations(deps)

  startPoolMaintenance(deps)

  // Start game expiry timer
  startExpiryTimer(deps)

  // v4: refund (split the pot back) any co-funded joint-pot game whose player
  // never revealed, once past cancelDelay — the house's protection against the
  // never-reveal griefing vector, pre-empting the player's forfeit.
  startV4RefundTimer(deps)

  // Renew expiring VTXOs + confirm boarding deposits on a long cadence (only when
  // there's something to do — the same gate the SDK's own poll-loop applies).
  startRenewalTimer(deps)

  // Public API server
  const publicApp = express()
  publicApp.use(cors())
  publicApp.use(express.json())

  publicApp.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  publicApp.use(createPublicRoutes(deps))
  publicApp.use(createV4Routes(deps))

  // Single-image mode: when CLIENT_DIR is set (the bundled image), the public
  // port also serves the built Vue client + an SPA fallback, so the player gets
  // the app and the /api on one origin — no separate nginx. Mounted AFTER the
  // API routes so /api and /health win; the fallback skips them so an unknown
  // API path still 404s instead of returning index.html.
  const clientDir = process.env.CLIENT_DIR
  if (clientDir && fs.existsSync(clientDir)) {
    publicApp.use(express.static(clientDir))
    publicApp.use((req, res, next) => {
      if (req.method !== 'GET') return next()
      if (req.path.startsWith('/api') || req.path === '/health') return next()
      res.sendFile(path.join(clientDir, 'index.html'))
    })
    console.log(`Serving bundled client from ${clientDir}`)
  }

  publicApp.listen(PUBLIC_PORT, () => {
    console.log(`Public API (+ client when CLIENT_DIR set) listening on port ${PUBLIC_PORT}`)
  })

  // Admin API server
  const adminApp = express()
  adminApp.use(express.json())

  adminApp.use(createAdminRoutes(deps))

  const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1'
  adminApp.listen(ADMIN_PORT, ADMIN_HOST, () => {
    console.log(`Admin dashboard listening on ${ADMIN_HOST}:${ADMIN_PORT}`)
  })

  // Graceful shutdown: `docker stop` (SIGTERM) and Ctrl-C (SIGINT) checkpoint the
  // WAL into coinflip.db so the persisted volume is left fully merged, not a main
  // file plus an un-applied -wal sidecar.
  const shutdown = (sig: string) => {
    console.log(`Received ${sig} — closing database and exiting.`)
    try { closeDb() } catch (err) { console.error('closeDb failed:', err) }
    process.exit(0)
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

// Only auto-start when this file is the process entrypoint. Importing the
// module (e.g. from tests) gets the re-exports without spinning up Express.
if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start server:', err)
    process.exit(1)
  })
}
