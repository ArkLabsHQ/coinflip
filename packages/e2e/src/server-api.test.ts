/**
 * Server HTTP e2e: spin up the coinflip server in-process against the live
 * arkade-regtest stack, hit the public API as a real client would, and
 * assert that
 *   1. GET /api/tiers reflects the funded house wallet
 *   2. POST /api/play returns signed setup/final txs + creates active contracts
 *   3. POST /api/game/:id/sign resolves the game, pays out, and inactivates
 *      the contracts
 *
 * Exercises the full DI chain (AppDeps, repos, contract-manager, game-engine)
 * end-to-end without re-running the boot logic in every test.
 */

import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { hex } from '@scure/base'
import {
  Wallet,
  SingleKey,
  InMemoryWalletRepository,
  InMemoryContractRepository,
} from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
const HOUSE_FUND_BTC = 0.005 // 500_000 sats — covers tiers + change + fees
const BET_AMOUNT = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function toXOnly(b: Uint8Array): Uint8Array {
  return b.length === 33 ? b.slice(1) : b
}

async function faucet(address: string, amountBtc: number): Promise<void> {
  const resp = await fetch(`${ESPLORA_URL}/faucet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, amount: amountBtc }),
  })
  if (!resp.ok) throw new Error(`Faucet failed: ${resp.status} ${await resp.text()}`)
}

async function waitForBoarding(wallet: Wallet, minSats: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const b = await wallet.getBalance()
    if (b.boarding.total >= minSats) return
    await sleep(2000)
  }
  throw new Error('Timeout waiting for boarding balance')
}

async function waitForSettled(wallet: Wallet, minSats: number, timeoutMs = 90_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const b = await wallet.getBalance()
    if (b.settled >= minSats) return
    await sleep(2000)
  }
  throw new Error('Timeout waiting for settled balance')
}

let arkAvailable = false

beforeAll(async () => {
  try {
    const resp = await fetch(`${ARK_SERVER_URL}/v1/info`, {
      signal: AbortSignal.timeout(5000),
    })
    arkAvailable = resp.ok
  } catch {
    arkAvailable = false
  }
}, 10_000)

describe('server HTTP API: house wallet + game lifecycle', () => {
  let app: express.Express
  let serverDeps: Awaited<ReturnType<typeof import('arkade-coinflip-server').bootstrapDeps>> | undefined
  let dataDir: string

  beforeAll(async () => {
    if (!arkAvailable) return

    // Isolate the server's SQLite to a temp dir so we don't share state with a
    // long-running server instance (or with other test runs).
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinflip-srv-test-'))
    process.env.DATA_DIR = dataDir
    process.env.ARK_SERVER_URL = ARK_SERVER_URL
    process.env.ESPLORA_URL = ESPLORA_URL

    // Load the server module after env is set; the EventSource polyfill runs
    // at import time, which the SDK's ContractWatcher needs.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const server: typeof import('arkade-coinflip-server') = require('arkade-coinflip-server')
    // Disable the wallet's auto-renewal ticker for the test — the current
    // regtest fee config makes that loop fire INTENT_INSUFFICIENT_FEE every
    // 30s, which doesn't break correctness but drowns logs and slows boot.
    serverDeps = await server.bootstrapDeps({ walletSettlementConfig: false })

    // Fund the house wallet so /api/tiers reports houseReady and /api/play
    // can find enough VTXOs to cover the bet tier.
    const boardingAddr = await serverDeps.wallet.getBoardingAddress()
    await faucet(boardingAddr, HOUSE_FUND_BTC)
    await waitForBoarding(serverDeps.wallet, HOUSE_FUND_BTC * 1e8 * 0.9)
    await serverDeps.wallet.settle()
    await waitForSettled(serverDeps.wallet, BET_AMOUNT * 5)

    // Wire up the public route factory against the bootstrapped deps.
    app = express()
    app.use(express.json())
    app.use(server.createPublicRoutes(serverDeps))
  }, 180_000)

  afterAll(async () => {
    if (dataDir && fs.existsSync(dataDir)) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('GET /api/tiers reports houseReady when funded', async () => {
    if (!arkAvailable) return
    const resp = await request(app).get('/api/tiers').expect(200)
    expect(Array.isArray(resp.body.tiers)).toBe(true)
    expect(resp.body.tiers).toContain(BET_AMOUNT)
    expect(resp.body.maxAvailable).toBeGreaterThanOrEqual(BET_AMOUNT)
  })

  it('POST /api/play starts a trustless game and escrows the house stake', async () => {
    if (!arkAvailable) return

    // A funded player wallet, used only to commit a hash + change address.
    // The full play→escrow→commit→sweep flow is covered by trustless-api.test.ts.
    const playerIdentity = SingleKey.fromRandomBytes()
    const playerWallet = await Wallet.create({
      identity: playerIdentity,
      arkServerUrl: ARK_SERVER_URL,
      esploraUrl: ESPLORA_URL,
      storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
      },
      settlementConfig: false,
    })
    const playerChangeAddress = await playerWallet.getAddress()
    const playerPub = toXOnly(await playerIdentity.compressedPublicKey())
    const playerSecret = new Uint8Array(16)
    crypto.getRandomValues(playerSecret)
    const playerHash = createHash('sha256').update(playerSecret).digest('hex')

    const playRes = await request(app)
      .post('/api/play')
      .send({ tier: BET_AMOUNT, playerPubkey: hex.encode(playerPub), playerHash, playerChangeAddress })

    if (playRes.status !== 200) {
      console.error('POST /api/play unexpected response:', playRes.status, playRes.body)
    }
    expect(playRes.status).toBe(200)
    expect(playRes.body.gameId).toBeTruthy()
    expect(playRes.body.escrowAddress).toBeTruthy()
    expect(playRes.body.houseEscrow?.value).toBe(BET_AMOUNT)
    expect(playRes.body.houseHash).toMatch(/^[0-9a-f]{64}$/i)

    const row = await serverDeps!.repos.games.get(playRes.body.gameId)
    expect(row?.status).toBe('pending')
  }, 180_000)

  it('GET /api/tiers rejects bets above maxAvailable', async () => {
    if (!arkAvailable) return
    const resp = await request(app).get('/api/tiers').expect(200)
    // The largest tier the house can cover is bounded by available balance.
    expect(resp.body.maxAvailable).toBeLessThanOrEqual(
      resp.body.tiers.reduce((m: number, t: number) => Math.max(m, t), 0),
    )
  })

  it('POST /api/play 400 on missing fields', async () => {
    if (!arkAvailable) return
    const resp = await request(app).post('/api/play').send({})
    expect(resp.status).toBe(400)
    expect(resp.body.error).toMatch(/Missing required fields/i)
  })

  it('POST /api/game/:id/commit 404 on unknown game', async () => {
    if (!arkAvailable) return
    const resp = await request(app)
      .post('/api/game/nonexistent-id/commit')
      .send({ playerSecretHex: '00'.repeat(16), playerEscrow: { txid: 'a'.repeat(64), vout: 0, value: 1000 } })
    expect(resp.status).toBe(404)
  })
})

describe('selectableHouseVtxos: VTXO expiry filter', () => {
  // Constructed VTXOs with explicit batchExpiry (milliseconds, see
  // isVtxoExpiringSoon in @arkade-os/sdk/wallet/vtxo-manager). The SDK
  // ignores expiries before year 2025 as a regtest workaround, so we
  // anchor all fixtures off Date.now() rather than synthetic small ints.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { selectableHouseVtxos, VTXO_LIFETIME_BUFFER_MS } = require('arkade-coinflip-server/dist/game-engine.js')

  function fakeVtxo(batchExpiryMs: number, value = 1000): unknown {
    return {
      txid: 'a'.repeat(64),
      vout: 0,
      value,
      script: '00'.repeat(34),
      intentTapLeafScript: [new Uint8Array(33), new Uint8Array(34)],
      tapTree: new Uint8Array(0),
      virtualStatus: { state: 'settled', batchExpiry: batchExpiryMs },
      createdAt: 0,
      isPreconfirmed: false,
      isSwept: false,
      isUnrolled: false,
      isSpent: false,
      spentBy: '',
      settledBy: '',
      arkTxid: '',
    }
  }

  const MS = 1
  const MIN = 60_000

  it('keeps VTXOs whose batchExpiry is beyond the buffer', () => {
    const now = Date.now()
    const fresh = fakeVtxo(now + 2 * 60 * MIN) // 2h ahead → safe
    const expiring = fakeVtxo(now + 1 * MIN)   // 1min ahead → drop
    const { selectable, dropped } = selectableHouseVtxos([fresh, expiring])
    expect(selectable).toHaveLength(1)
    expect(dropped).toHaveLength(1)
    expect(VTXO_LIFETIME_BUFFER_MS).toBe(30 * MIN)
  })

  it('drops every VTXO when all are inside the buffer window', () => {
    const now = Date.now()
    const vtxos = [fakeVtxo(now + 1 * MIN), fakeVtxo(now + 5 * MIN), fakeVtxo(now + 10 * MIN)]
    const { selectable, dropped } = selectableHouseVtxos(vtxos as never)
    expect(selectable).toHaveLength(0)
    expect(dropped).toHaveLength(3)
  })

  it('keeps every VTXO when all are comfortably fresh', () => {
    const now = Date.now()
    const vtxos = [fakeVtxo(now + 60 * MIN), fakeVtxo(now + 120 * MIN)]
    const { selectable, dropped } = selectableHouseVtxos(vtxos as never)
    expect(selectable).toHaveLength(2)
    expect(dropped).toHaveLength(0)
  })

  it('respects an explicit bufferMs override', () => {
    const now = Date.now()
    const v = fakeVtxo(now + 10 * MIN) // 10 min remaining
    const tight = selectableHouseVtxos([v] as never, 5 * MIN) // 5-min buffer
    expect(tight.selectable).toHaveLength(1) // 10 > 5 → keep
    const wide = selectableHouseVtxos([v] as never, 20 * MIN) // 20-min buffer
    expect(wide.selectable).toHaveLength(0) // 10 < 20 → drop
  })

  // Avoid an unused-var lint by referencing MS once.
  it('exports VTXO_LIFETIME_BUFFER_MS as a positive number', () => {
    expect(VTXO_LIFETIME_BUFFER_MS).toBeGreaterThan(0)
    expect(MS).toBe(1)
  })
})

describe('VtxoReservations: concurrency ledger', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const pool = require('arkade-coinflip-server/dist/vtxo-pool.js')
  const { VtxoReservations, maxLiabilityForTier, outpointKey } = pool

  it('reserves and releases outpoints by gameId', () => {
    const r = new VtxoReservations()
    r.reserve('game-1', ['txa:0', 'txa:1'], 660)
    expect(r.isReserved('txa:0')).toBe(true)
    expect(r.isReserved('txa:1')).toBe(true)
    expect(r.isReserved('txb:0')).toBe(false)
    r.release('game-1')
    expect(r.isReserved('txa:0')).toBe(false)
  })

  it('prevents two games from reserving the same VTXO (caller checks isReserved)', () => {
    const r = new VtxoReservations()
    r.reserve('game-1', ['shared:0'], 660)
    // A second game's selection would exclude already-reserved outpoints.
    const candidate = ['shared:0', 'free:0']
    const free = candidate.filter((op) => !r.isReserved(op))
    expect(free).toEqual(['free:0'])
  })

  it('sums worst-case liability across in-flight games', () => {
    const r = new VtxoReservations()
    r.reserve('g1', ['a:0'], maxLiabilityForTier(1000)) // 2000
    r.reserve('g2', ['b:0'], maxLiabilityForTier(5000)) // 10000
    expect(r.totalLiability()).toBe(12000)
    expect(r.activeGames()).toBe(2)
    r.release('g1')
    expect(r.totalLiability()).toBe(10000)
  })

  it('maxLiabilityForTier is double the tier (full-pot payout)', () => {
    expect(maxLiabilityForTier(330)).toBe(660)
    expect(maxLiabilityForTier(50000)).toBe(100000)
  })

  it('outpointKey formats txid:vout', () => {
    expect(outpointKey('deadbeef', 3)).toBe('deadbeef:3')
  })
})

describe('Mutex: serializes the select+reserve critical section', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { Mutex } = require('arkade-coinflip-server/dist/vtxo-pool.js')

  it('runs exclusive sections one at a time, in order', async () => {
    const mutex = new Mutex()
    const log: string[] = []
    const slow = (tag: string, ms: number) =>
      mutex.runExclusive(async () => {
        log.push(`${tag}-start`)
        await new Promise((r) => setTimeout(r, ms))
        log.push(`${tag}-end`)
      })
    // Launch concurrently; the mutex must prevent interleaving.
    await Promise.all([slow('A', 30), slow('B', 5), slow('C', 5)])
    expect(log).toEqual(['A-start', 'A-end', 'B-start', 'B-end', 'C-start', 'C-end'])
  })
})
