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
import { registerCoinflipContracts } from 'arkade-coinflip'
import { getSqlExecutor, initDb } from './db.js'
import { makeRepos } from './repositories/index.js'
import { initHouseWallet } from './house-wallet.js'
import { attachContractEventHandler, initContractManager } from './contract-manager.js'
import { startExpiryTimer } from './game-engine.js'
import { createPublicRoutes } from './public-routes.js'
import { createAdminRoutes } from './admin/routes.js'
import type { AppDeps } from './deps.js'

const PUBLIC_PORT = parseInt(process.env.PUBLIC_PORT || '3001', 10)
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '3002', 10)

async function main() {
  // 1. Register coinflip-setup and coinflip-final with the SDK contract registry
  //    so they can be resolved via contractHandlers / ContractManager / arkcontract=.
  registerCoinflipContracts()

  // 2. Bootstrap SQLite and the typed repositories that wrap it.
  console.log('Initializing database...')
  await initDb()
  const repos = makeRepos(getSqlExecutor())

  // 3. House wallet — depends on the houseWallet + config repos.
  console.log('Initializing house wallet...')
  const { wallet, identity, arkInfo } = await initHouseWallet(repos)

  // 4. ContractManager — depends on the live Wallet + repos for reconciliation.
  console.log('Initializing contract manager...')
  const contractManager = await initContractManager(wallet, { repos })

  // 5. Assemble the AppDeps bundle and attach the event subscriber now that
  //    every field is populated.
  const deps: AppDeps = { repos, wallet, identity, arkInfo, contractManager }
  attachContractEventHandler(deps)

  // 6. Start game expiry timer
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

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
