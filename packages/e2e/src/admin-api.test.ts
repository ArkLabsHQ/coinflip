/**
 * Admin HTTP API e2e: boots the server deps against arkade-regtest, mounts the
 * admin router, funds the house, and exercises the operator endpoints added for
 * the expanded admin dashboard:
 *   - GET  /api/vtxos        — house VTXOs + which game reserves each
 *   - GET  /api/reservations — in-flight reservation ledger + totals
 *   - POST /api/wallet/send  — move funds out (with reserved-liability guard)
 *   - POST /api/wallet/settle    — renew VTXOs / confirm boarding
 *   - POST /api/wallet/fragment  — split the pool into uniform pieces
 *
 * The reserved-VTXO→game mapping is the headline feature, so it's proven two
 * ways: a deterministic ledger reservation, and a real handleTrustlessPlay.
 */

import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { hex } from '@scure/base'
import { SingleKey, Wallet, InMemoryWalletRepository, InMemoryContractRepository } from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
const HOUSE_FUND_BTC = 0.005
const BET = 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)

async function faucet(address: string, amountBtc: number): Promise<void> {
  const r = await fetch(`${ESPLORA_URL}/faucet`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, amount: amountBtc }),
  })
  if (!r.ok) throw new Error(`Faucet failed: ${r.status} ${await r.text()}`)
}

async function waitForBoarding(w: Wallet, min: number, t = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < t) {
    if ((await w.getBalance()).boarding.total >= min) return
    await sleep(2000)
  }
  throw new Error('Timeout waiting for boarding balance')
}
async function waitForSettled(w: Wallet, min: number, t = 90_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < t) {
    if ((await w.getBalance()).settled >= min) return
    await sleep(2000)
  }
  throw new Error('Timeout waiting for settled balance')
}

let arkAvailable = false
beforeAll(async () => {
  try {
    arkAvailable = (await fetch(`${ARK_SERVER_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok
  } catch { arkAvailable = false }
}, 10_000)

describe('admin HTTP API: operator endpoints', () => {
  let app: express.Express
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deps: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any
  let dataDir: string

  beforeAll(async () => {
    if (!arkAvailable) return
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinflip-admin-test-'))
    process.env.DATA_DIR = dataDir
    process.env.ARK_SERVER_URL = ARK_SERVER_URL
    process.env.ESPLORA_URL = ESPLORA_URL

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    server = require('arkade-coinflip-server')
    // Same dist module instance the admin router uses, so reservations made here
    // are visible to the endpoints.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pool = require('arkade-coinflip-server/dist/vtxo-pool.js')
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })

    await faucet(await deps.wallet.getBoardingAddress(), HOUSE_FUND_BTC)
    await waitForBoarding(deps.wallet, HOUSE_FUND_BTC * 1e8 * 0.9)
    await deps.wallet.settle()
    await waitForSettled(deps.wallet, BET * 5)

    app = express()
    app.use(express.json())
    app.use(server.createAdminRoutes(deps))
  }, 180_000)

  afterAll(() => {
    if (dataDir && fs.existsSync(dataDir)) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('GET /api/status returns balance + pubkey', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const res = await request(app).get('/api/status').expect(200)
    expect(res.body.balance).toBeDefined()
    expect(typeof res.body.pubkey).toBe('string')
  })

  it('GET /api/vtxos lists funded house VTXOs (unreserved by default)', async () => {
    if (!arkAvailable) return
    const res = await request(app).get('/api/vtxos').expect(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThanOrEqual(1)
    const v = res.body[0]
    expect(typeof v.txid).toBe('string')
    expect(typeof v.value).toBe('number')
    expect(v).toHaveProperty('reservedBy')
    expect(res.body.every((x: { reservedBy: string | null }) => x.reservedBy === null)).toBe(true)
  })

  it('GET /api/reservations is empty before any game', async () => {
    if (!arkAvailable) return
    const res = await request(app).get('/api/reservations').expect(200)
    expect(res.body.activeGames).toBe(0)
    expect(res.body.totalLiability).toBe(0)
    expect(res.body.reservations).toEqual([])
  })

  it('maps a reserved VTXO to its game in /api/vtxos and /api/reservations', async () => {
    if (!arkAvailable) return
    const vtxos = await deps.wallet.getVtxos()
    const v = vtxos[0]
    const op = pool.outpointKey(v.txid, v.vout)
    pool.reservations.reserve('test-game-xyz', [op], 4242)
    try {
      const vres = await request(app).get('/api/vtxos').expect(200)
      const match = vres.body.find((x: { txid: string; vout: number }) => x.txid === v.txid && x.vout === v.vout)
      expect(match.reservedBy).toBe('test-game-xyz')

      const rres = await request(app).get('/api/reservations').expect(200)
      expect(rres.body.activeGames).toBe(1)
      expect(rres.body.totalLiability).toBe(4242)
      expect(rres.body.reservations[0]).toMatchObject({ gameId: 'test-game-xyz', liability: 4242 })
      expect(rres.body.reservations[0].outpoints).toContain(op)
    } finally {
      pool.reservations.release('test-game-xyz')
    }
    const after = await request(app).get('/api/reservations').expect(200)
    expect(after.body.activeGames).toBe(0)
  })

  it('a real trustless play shows up in the reservation ledger', async () => {
    if (!arkAvailable) return
    const id = SingleKey.fromRandomBytes()
    const w = await Wallet.create({
      identity: id, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    const secret = Buffer.from(new Uint8Array(16)); crypto.getRandomValues(secret)
    const play = await server.handleTrustlessPlay({
      tier: BET,
      playerPubkey: hex.encode(toXOnly(await id.compressedPublicKey())),
      playerHash: createHash('sha256').update(secret).digest('hex'),
      playerChangeAddress: await w.getAddress(),
    }, deps)

    const res = await request(app).get('/api/reservations').expect(200)
    expect(res.body.activeGames).toBeGreaterThanOrEqual(1)
    expect(res.body.totalLiability).toBeGreaterThanOrEqual(BET)
    expect(res.body.reservations.some((r: { gameId: string }) => r.gameId === play.gameId)).toBe(true)
  }, 120_000)

  it('POST /api/wallet/send validates input and guards reserved liability', async () => {
    if (!arkAvailable) return
    await request(app).post('/api/wallet/send').send({ amount: 1000 }).expect(400) // no address
    await request(app).post('/api/wallet/send').send({ address: 'x', amount: 0 }).expect(400) // bad amount

    // Way more than the house holds, no force → blocked with a withdrawable hint.
    const over = await request(app).post('/api/wallet/send')
      .send({ address: await deps.wallet.getAddress(), amount: 9_999_999_999 }).expect(400)
    expect(over.body).toHaveProperty('withdrawable')
  })

  it('POST /api/wallet/send moves a small amount out (returns txid)', async () => {
    if (!arkAvailable) return
    const res = await request(app).post('/api/wallet/send')
      .send({ address: await deps.wallet.getAddress(), amount: BET }).expect(200)
    expect(typeof res.body.txid).toBe('string')
    expect(res.body.txid.length).toBeGreaterThan(0)
  }, 60_000)

  it('POST /api/wallet/fragment splits the pool into pieces', async () => {
    if (!arkAvailable) return
    const res = await request(app).post('/api/wallet/fragment')
      .send({ targetCount: 6, pieceSize: BET * 2 }).expect(200)
    expect(res.body).toHaveProperty('created')
    expect(typeof res.body.vtxoCount).toBe('number')
    expect(res.body.created).toBeGreaterThanOrEqual(0)
  }, 60_000)

  it('POST /api/wallet/settle is wired and never hangs the request', async () => {
    if (!arkAvailable) return
    const res = await request(app).post('/api/wallet/settle')
    // settle() can block until a batch round forms (or error on regtest). The
    // endpoint bounds it: 200 (done), 202 (still running in background), or 500
    // (error) — but it must always return promptly, never hang.
    expect([200, 202, 500]).toContain(res.status)
    expect(typeof res.body).toBe('object')
  }, 90_000)
})
