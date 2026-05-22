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
import { contractHandlers } from '@arkade-os/sdk'
import { registerCoinflipContracts } from 'arkade-coinflip'
import { getSqlExecutor, initDb } from './db.js'
import { makeRepos } from './repositories/index.js'
import { initHouseWallet } from './house-wallet.js'
import { attachContractEventHandler, initContractManager } from './contract-manager.js'
import { startExpiryTimer } from './game-engine.js'
import { rebuildReservations, startPoolMaintenance } from './vtxo-pool.js'
import { createPublicRoutes } from './public-routes.js'
import { createAdminRoutes } from './admin/routes.js'
import type { AppDeps } from './deps.js'

// Re-exports for in-process consumers (tests / embedded use). Keeping these
// in the main entry rather than a separate `bootstrap.ts` so a test can do
//   `const { bootstrapDeps, createPublicRoutes } = require('arkade-coinflip-server')`
// and drive everything from one import without auto-starting the listener.
export { getSqlExecutor, initDb } from './db.js'
export { makeRepos } from './repositories/index.js'
export { initHouseWallet } from './house-wallet.js'
export { attachContractEventHandler, initContractManager } from './contract-manager.js'
export { startExpiryTimer } from './game-engine.js'
export {
  handleTrustlessPlay,
  handleTrustlessCommit,
  type TrustlessPlayRequest,
  type TrustlessPlayResult,
  type TrustlessCommitRequest,
  type TrustlessCommitResult,
  type Outpoint,
} from './trustless-game.js'
export { rebuildReservations, startPoolMaintenance, ensureHouseVtxoPool } from './vtxo-pool.js'
export { createPublicRoutes } from './public-routes.js'
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
  // Register against the server's own SDK registry. The lib has its own
  // @arkade-os/sdk copy with a separate `contractHandlers` singleton — if we
  // omitted this argument the lib would register into its own copy and the
  // server's ContractManager.createContract would later fail with
  // "No handler registered for contract type 'coinflip-setup'".
  registerCoinflipContracts(contractHandlers)
  await initDb()
  const repos = makeRepos(getSqlExecutor())
  const { wallet, identity, arkInfo } = await initHouseWallet(repos, {
    settlementConfig: options.walletSettlementConfig,
  })
  const contractManager = await initContractManager(wallet, { repos })
  const deps: AppDeps = { repos, wallet, identity, arkInfo, contractManager }
  attachContractEventHandler(deps)
  return deps
}

async function main() {
  console.log('Bootstrapping server dependencies...')
  const deps = await bootstrapDeps()

  // Rebuild VTXO reservations from any pending games that survived a restart,
  // then keep a healthy pool of distinct house VTXOs for concurrent play.
  await rebuildReservations(deps)
  startPoolMaintenance(deps)

  // Start game expiry timer
  startExpiryTimer(deps)

  // Public API server
  const publicApp = express()
  publicApp.use(cors())
  publicApp.use(express.json())

  publicApp.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  publicApp.use(createPublicRoutes(deps))

  publicApp.listen(PUBLIC_PORT, () => {
    console.log(`Public API listening on port ${PUBLIC_PORT}`)
  })

  // Admin API server
  const adminApp = express()
  adminApp.use(express.json())

  adminApp.use(createAdminRoutes(deps))

  const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1'
  adminApp.listen(ADMIN_PORT, ADMIN_HOST, () => {
    console.log(`Admin dashboard listening on ${ADMIN_HOST}:${ADMIN_PORT}`)
  })
}

// Only auto-start when this file is the process entrypoint. Importing the
// module (e.g. from tests) gets the re-exports without spinning up Express.
if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start server:', err)
    process.exit(1)
  })
}
