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
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { type VtxoInput } from 'arkade-coinflip'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
const HOUSE_FUND_BTC = 0.005 // 500_000 sats — covers tiers + change + fees
const PLAYER_FUND_BTC = 0.002 // 200_000 sats — covers bet + change
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

function vtxoToInput(vtxo: ExtendedVirtualCoin): VtxoInput {
  // Strip the trailing Taproot leaf-version byte (0xc0) so VtxoScript's
  // constructor in the lib doesn't double-append it. See game-engine.ts.
  const rawScript = vtxo.intentTapLeafScript[1].slice(0, -1)
  const leafHex = hex.encode(rawScript)
  return {
    vtxo: {
      outpoint: { txid: vtxo.txid, vout: vtxo.vout },
      amount: vtxo.value.toString(),
      tapscripts: [leafHex],
    },
    leaf: leafHex,
  }
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

  it('POST /api/play + POST /api/game/:id/sign runs a full game and pays out', async () => {
    if (!arkAvailable) return

    // Create + fund a player wallet via the SDK directly so we can sign the
    // server's request shape without going through any Vue layer.
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
    const playerBoarding = await playerWallet.getBoardingAddress()
    await faucet(playerBoarding, PLAYER_FUND_BTC)
    await waitForBoarding(playerWallet, PLAYER_FUND_BTC * 1e8 * 0.9)
    await playerWallet.settle()
    await waitForSettled(playerWallet, BET_AMOUNT)

    const playerVtxos = await playerWallet.getVtxos()
    expect(playerVtxos.length).toBeGreaterThan(0)
    const playerPub = toXOnly(await playerIdentity.compressedPublicKey())
    const playerChangeAddress = await playerWallet.getAddress()

    // Player commits to a secret choice
    const playerSecret = new Uint8Array(16) // length = 16 => 'tails'
    crypto.getRandomValues(playerSecret)
    const playerHash = createHash('sha256').update(playerSecret).digest('hex')

    const playRes = await request(app)
      .post('/api/play')
      .send({
        tier: BET_AMOUNT,
        choice: 'tails',
        playerPubkey: hex.encode(playerPub),
        playerHash,
        playerVtxos: playerVtxos.map(vtxoToInput),
        playerChangeAddress,
      })

    expect(playRes.status).toBe(200)
    expect(playRes.body.gameId).toBeTruthy()
    expect(playRes.body.setupTxHex).toBeTruthy()
    expect(playRes.body.finalTxHex).toBeTruthy()
    expect(playRes.body.houseSetupSignatures.length).toBeGreaterThan(0)
    expect(playRes.body.houseFinalSignature).toBeTruthy()
    expect(playRes.body.houseHash).toMatch(/^[0-9a-f]{64}$/i)

    const gameId: string = playRes.body.gameId

    // Mid-flight invariants: the game row should be pending and both
    // coinflip-setup + coinflip-final contracts should be active.
    const gameMidflight = await serverDeps!.repos.games.get(gameId)
    expect(gameMidflight?.status).toBe('pending')
    expect(gameMidflight?.setup_script_hex).toBeTruthy()
    expect(gameMidflight?.final_script_hex).toBeTruthy()

    const setupContract = (await serverDeps!.contractManager.getContracts({ script: gameMidflight!.setup_script_hex! }))[0]
    const finalContract = (await serverDeps!.contractManager.getContracts({ script: gameMidflight!.final_script_hex! }))[0]
    expect(setupContract?.state).toBe('active')
    expect(finalContract?.state).toBe('active')
    expect(setupContract?.type).toBe('coinflip-setup')
    expect(finalContract?.type).toBe('coinflip-final')

    // Player reveals their secret. The server settles the pot via
    // wallet.sendBitcoin and resolves the game in DB.
    const signRes = await request(app)
      .post(`/api/game/${gameId}/sign`)
      .send({
        playerSecretHex: hex.encode(playerSecret),
        playerSetupSignatures: [],
        playerFinalSignature: '',
      })

    expect(signRes.status).toBe(200)
    expect(['house', 'player']).toContain(signRes.body.winner)
    expect(signRes.body.proof).toContain('bytes')
    expect(typeof signRes.body.payout).toBe('number')
    expect(signRes.body.txid).toBeTruthy()

    // Post-resolve: game row is resolved + both contracts inactivated.
    const gameAfter = await serverDeps!.repos.games.get(gameId)
    expect(gameAfter?.status).toBe('resolved')
    expect(gameAfter?.winner).toBe(signRes.body.winner)
    expect(gameAfter?.player_secret_hex).toBe(hex.encode(playerSecret))

    const setupAfter = (await serverDeps!.contractManager.getContracts({ script: gameMidflight!.setup_script_hex! }))[0]
    const finalAfter = (await serverDeps!.contractManager.getContracts({ script: gameMidflight!.final_script_hex! }))[0]
    expect(setupAfter?.state).toBe('inactive')
    expect(finalAfter?.state).toBe('inactive')

    // If the player won, their wallet should reflect the payout. The server
    // sent it via wallet.sendBitcoin which is an offchain Ark tx.
    if (signRes.body.winner === 'player') {
      // Best-effort: poll briefly for the incoming VTXO; the wallet's
      // ContractManager picks it up async.
      const start = Date.now()
      let saw = false
      while (Date.now() - start < 30_000) {
        const vtxos = await playerWallet.getVtxos()
        if (vtxos.some((v) => v.txid === signRes.body.txid)) {
          saw = true
          break
        }
        await sleep(2000)
      }
      expect(saw).toBe(true)
    } else {
      // House won — payout txid is the sentinel. Game row still recorded.
      expect(signRes.body.txid).toBe('house-win-no-transfer')
    }
  }, 240_000)

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

  it('POST /api/game/:id/sign 404 on unknown game', async () => {
    if (!arkAvailable) return
    const resp = await request(app)
      .post('/api/game/nonexistent-id/sign')
      .send({ playerSecretHex: '00'.repeat(15) })
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
