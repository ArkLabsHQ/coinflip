/* Local dev runner: boot the coinflip server against arkade-regtest, fund the
 * house wallet, and serve the public API on :3001. Not part of the build. */
const os = require('os')
const fs = require('fs')
const path = require('path')
const express = require('express')
const cors = require('cors')

process.env.ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
process.env.ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'coinflip-regtest-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function faucet(address, amountBtc) {
  // The denigiri/master arkade-regtest stack dropped nigiri's HTTP `/faucet`
  // (esplora no longer exposes it), so the old `fetch(${ESPLORA}/faucet)` 404s
  // and house funding fails on startup. Fund through the Node orchestrator's
  // bitcoin-core faucet instead — the same path the e2e helpers use. execFileSync
  // with an argument array (no shell) keeps the address/amount free of any
  // interpolation surface.
  const { execFileSync } = require('child_process')
  const script = path.resolve(__dirname, '../../arkade-regtest/regtest.mjs')
  execFileSync('node', [script, 'faucet', address, String(amountBtc), '--confirm'],
    { stdio: ['ignore', 'pipe', 'pipe'] })
}

async function waitFor(wallet, kind, min, timeoutMs = 120000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const b = await wallet.getBalance()
    const cur = kind === 'boarding' ? b.boarding.total : b.settled
    if (cur >= min) return
    await sleep(2000)
  }
  throw new Error(`timeout waiting for ${kind} >= ${min}`)
}

async function settleWithRetry(wallet, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { await wallet.settle(); return } catch (e) {
      console.warn(`settle attempt ${i + 1} failed: ${e.message || e}`)
      if (i === tries - 1) throw e
      await sleep(5000)
    }
  }
}

;(async () => {
  console.log('DATA_DIR:', process.env.DATA_DIR)
  const srv = require('./dist/index.js')
  const deps = await srv.bootstrapDeps({ walletSettlementConfig: false })

  const boarding = await deps.wallet.getBoardingAddress()
  console.log('house boarding:', boarding)
  const bal = await deps.wallet.getBalance()
  console.log('house balance:', JSON.stringify(bal))
  if (bal.settled < 100000) {
    console.log('funding house...')
    await faucet(boarding, 0.02) // 2,000,000 sats
    await waitFor(deps.wallet, 'boarding', 1800000)
    await settleWithRetry(deps.wallet)
    await waitFor(deps.wallet, 'settled', 1000000)
  }
  const after = await deps.wallet.getBalance()
  console.log('house settled:', after.settled)

  const app = express()
  app.use(cors())
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.use(srv.createPublicRoutes(deps))
  const PUBLIC_PORT = parseInt(process.env.DEV_PUBLIC_PORT || '3001', 10)
  const ADMIN_PORT = parseInt(process.env.DEV_ADMIN_PORT || '3002', 10)
  app.listen(PUBLIC_PORT, () => console.log(`PUBLIC API ON :${PUBLIC_PORT} (regtest, house funded)`))

  // Admin dashboard + API (matches production's separate admin port).
  const admin = express()
  admin.use(express.json())
  admin.use(srv.createAdminRoutes(deps))
  admin.listen(ADMIN_PORT, process.env.DEV_ADMIN_HOST || '127.0.0.1', () => console.log(`ADMIN ON :${ADMIN_PORT} (regtest, house funded)`))
})().catch((e) => { console.error('dev-regtest fatal:', e); process.exit(1) })
