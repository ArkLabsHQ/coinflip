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
import { initDb } from './db'
import { getHouseWalletInstance, initHouseWallet } from './house-wallet'
import { initContractManager } from './contract-manager'
import { startExpiryTimer } from './game-engine'
import publicRoutes from './public-routes'
import adminRoutes from './admin/routes'

const PUBLIC_PORT = parseInt(process.env.PUBLIC_PORT || '3001', 10)
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '3002', 10)

async function main() {
  // Register coinflip-setup and coinflip-final with the SDK contract registry
  // so they can be resolved via contractHandlers / ContractManager / arkcontract=.
  registerCoinflipContracts()

  // Initialize database and house wallet
  console.log('Initializing database...')
  await initDb()

  console.log('Initializing house wallet...')
  await initHouseWallet()

  console.log('Initializing contract manager...')
  await initContractManager(getHouseWalletInstance())

  // Start game expiry timer
  startExpiryTimer()

  // Public API server
  const publicApp = express()
  publicApp.use(cors())
  publicApp.use(express.json())

  publicApp.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  publicApp.use(publicRoutes)

  publicApp.listen(PUBLIC_PORT, () => {
    console.log(`Public API listening on port ${PUBLIC_PORT}`)
  })

  // Admin API server
  const adminApp = express()
  adminApp.use(express.json())

  adminApp.use(adminRoutes)

  const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1'
  adminApp.listen(ADMIN_PORT, ADMIN_HOST, () => {
    console.log(`Admin dashboard listening on ${ADMIN_HOST}:${ADMIN_PORT}`)
  })
}

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
