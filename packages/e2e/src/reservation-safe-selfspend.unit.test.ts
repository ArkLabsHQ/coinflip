/**
 * P0 #53 reproducers: reservation-blind house self-spends. The house reserves
 * specific VTXOs for in-flight co-fund games (vtxo-pool `reservations`), but
 * several house self-spend paths ignored the ledger and could spend a coin
 * already committed to a LIVE game — arkd then rejects the game's co-fund with
 * VTXO_ALREADY_SPENT, breaking the player's game:
 *
 *   - renewSettle / admin POST /api/wallet/settle: `settle(undefined)` lets the
 *     SDK gather ALL eligible VTXOs, including reserved ones.
 *   - ensureHouseVtxoPool (split) / admin POST /api/wallet/fragment:
 *     `wallet.send(...)` sizes from free coins but the SDK picks the actual
 *     inputs from ALL coins.
 *   - admin POST /api/wallet/send: `sendBitcoin` selects inputs internally.
 *
 * Fixed behavior asserted here:
 *   - settle paths pass EXPLICIT SettleParams whose inputs exclude every
 *     reserved outpoint (and never an empty outputs list — arkd rejects that).
 *   - the pool split refuses to run while any outpoint reservation is live
 *     (send()'s selection cannot be constrained), but liability-only
 *     reservations (no pinned outpoints) don't block it.
 *   - admin send passes an explicit reservation-filtered `selectedVtxos` set;
 *     without force it refuses (400) when free coins can't cover the amount;
 *     force:true keeps the blind escape hatch (operator accepts the risk).
 *
 * Imports the BUILT server (dist) directly, like the sibling unit tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import express from 'express'
import request from 'supertest'
import { ArkAddress } from '@arkade-os/sdk'
const { renewSettle } = require('arkade-coinflip-server/dist/game-engine.js')
const { ensureHouseVtxoPool, reservations, houseVtxoCache } = require('arkade-coinflip-server/dist/vtxo-pool.js')
const { createAdminRoutes } = require('arkade-coinflip-server/dist/admin/routes.js')

const FUTURE_EXPIRY = Date.now() + 24 * 3600_000
/** A structurally valid Ark address (the settle builder decodes it for the output script). */
const HOUSE_ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()

/** A healthy settled house VTXO, far from expiry. */
const coin = (txid: string, vout: number, value: number) => ({
  txid,
  vout,
  value,
  virtualStatus: { state: 'settled', batchExpiry: FUTURE_EXPIRY },
  status: { confirmed: false },
  createdAt: new Date(Date.now() - 60_000),
})
const outpoints = (coins: Array<{ txid: string; vout: number }>) => coins.map((c) => `${c.txid}:${c.vout}`)

/** Wallet mock for the settle paths (zero intent fees → net amounts are exact). */
function mockSettleWallet(vtxos: any[], settleCalls: any[][]) {
  return {
    dustAmount: 330n,
    arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }) },
    getBoardingUtxos: async () => [],
    getVtxos: async () => vtxos,
    getAddress: async () => HOUSE_ADDRESS,
    getBalance: async () => ({ available: vtxos.reduce((s: number, v: any) => s + v.value, 0), boarding: { total: 0 } }),
    settle: async (...args: any[]) => {
      settleCalls.push(args)
      return 'txid-settle'
    },
  }
}

describe('P0 #53 — renewSettle must not gather reserved house VTXOs', () => {
  afterEach(() => {
    reservations.release('p0-53-renew')
  })

  it('settles with EXPLICIT params that exclude reserved outpoints (not blind settle(undefined))', async () => {
    const reservedCoin = coin('aa'.repeat(32), 0, 50_000)
    const freeCoin = coin('bb'.repeat(32), 1, 40_000)
    reservations.reserve('p0-53-renew', [`${reservedCoin.txid}:0`], 100_000)
    const settleCalls: any[][] = []
    const deps = { wallet: mockSettleWallet([reservedCoin, freeCoin], settleCalls) } as any

    const ok = await renewSettle(deps)

    expect(ok).toBe(true)
    expect(settleCalls).toHaveLength(1)
    const params = settleCalls[0][0]
    // Pre-fix this was undefined — the SDK's no-arg settle() gathers ALL
    // eligible VTXOs, including the one reserved for a live game.
    expect(params).toBeDefined()
    expect(outpoints(params.inputs)).toEqual([`${freeCoin.txid}:1`])
    // Never an empty outputs list (arkd: "proof does not contain outputs");
    // single self-output for the net amount, like the SDK's own gathering.
    expect(params.outputs).toHaveLength(1)
    expect(params.outputs[0].address).toBe(HOUSE_ADDRESS)
    expect(params.outputs[0].amount).toBe(40_000n) // zero-fee mock: the free coin's value, no reserved value
    // The per-phase settlement event handler is still wired in.
    expect(typeof settleCalls[0][1]).toBe('function')
  })

  it('is a graceful no-op (no settle round) when every eligible VTXO is reserved', async () => {
    const reservedCoin = coin('cc'.repeat(32), 2, 60_000)
    reservations.reserve('p0-53-renew', [`${reservedCoin.txid}:2`], 120_000)
    const settleCalls: any[][] = []
    const deps = { wallet: mockSettleWallet([reservedCoin], settleCalls) } as any

    await expect(renewSettle(deps)).resolves.toBe(false)
    expect(settleCalls).toHaveLength(0)
  })
})

describe('P0 #53 — ensureHouseVtxoPool split must not fire while outpoints are reserved', () => {
  afterEach(() => {
    reservations.release('p0-53-split')
    houseVtxoCache.invalidate()
  })

  function splitDeps(vtxos: any[], sendCalls: any[][]) {
    return {
      wallet: {
        getVtxos: async () => vtxos,
        getAddress: async () => HOUSE_ADDRESS,
        send: async (...recipients: any[]) => {
          sendCalls.push(recipients)
          return 'txid-split'
        },
      },
    } as any
  }

  it('refuses to split while any outpoint reservation is live (send() picks its own inputs)', async () => {
    houseVtxoCache.invalidate()
    // The reservation pins an outpoint the pool's own free-set may not even
    // contain — the guard must fire regardless, because the SDK's send()
    // selects inputs internally from ALL spendable coins.
    reservations.reserve('p0-53-split', [`${'dd'.repeat(32)}:0`], 50_000)
    const sendCalls: any[][] = []
    const deps = splitDeps([coin('ee'.repeat(32), 0, 200_000)], sendCalls)

    const created = await ensureHouseVtxoPool(deps, { pieceSize: 50_000 })

    expect(created).toBe(0)
    // Pre-fix: send fired and could spend the reserved coin.
    expect(sendCalls).toHaveLength(0)
  })

  it('splits again once the reservation is released', async () => {
    houseVtxoCache.invalidate()
    const sendCalls: any[][] = []
    const deps = splitDeps([coin('ff'.repeat(32), 0, 200_000)], sendCalls)

    const created = await ensureHouseVtxoPool(deps, { pieceSize: 50_000 })

    expect(created).toBe(3) // floor(200k / 50k) − 1 headroom piece
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]).toHaveLength(3)
    expect(sendCalls[0].every((r: any) => r.address === HOUSE_ADDRESS && r.amount === 50_000)).toBe(true)
  })

  it('liability-only reservations (no pinned outpoints) do not block the split', async () => {
    houseVtxoCache.invalidate()
    // Post-cofund v4 / v3 games reserve liability with NO outpoints — those can
    // run for many minutes and must not starve pool maintenance.
    reservations.reserve('p0-53-split', [], 50_000)
    const sendCalls: any[][] = []
    const deps = splitDeps([coin('99'.repeat(32), 0, 200_000)], sendCalls)

    const created = await ensureHouseVtxoPool(deps, { pieceSize: 50_000 })

    expect(created).toBe(3)
    expect(sendCalls).toHaveLength(1)
  })
})

describe('P0 #53 — admin POST /api/wallet/settle excludes reserved outpoints', () => {
  afterEach(() => {
    reservations.release('p0-53-admin')
  })

  it('passes explicit reservation-filtered params to wallet.settle', async () => {
    const reservedCoin = coin('11'.repeat(32), 0, 70_000)
    const freeCoin = coin('22'.repeat(32), 3, 30_000)
    reservations.reserve('p0-53-admin', [`${reservedCoin.txid}:0`], 140_000)
    const settleCalls: any[][] = []
    const deps = { wallet: mockSettleWallet([reservedCoin, freeCoin], settleCalls) } as any
    const app = express()
    app.use(express.json())
    app.use(createAdminRoutes(deps))

    const res = await request(app).post('/api/wallet/settle').send({})

    expect(res.status).toBe(200)
    expect(settleCalls).toHaveLength(1)
    const params = settleCalls[0][0]
    // Pre-fix: settle(undefined) — same reservation-blind gathering as renewal.
    expect(params).toBeDefined()
    expect(outpoints(params.inputs)).toEqual([`${freeCoin.txid}:3`])
    expect(params.outputs).toHaveLength(1)
  })
})

describe('P0 #53 — admin POST /api/wallet/send selects only free (unreserved) VTXOs', () => {
  afterEach(() => {
    reservations.release('p0-53-send')
    houseVtxoCache.invalidate()
  })

  function sendDeps(vtxos: any[], sendBitcoinCalls: any[]) {
    return {
      wallet: {
        getVtxos: async () => vtxos,
        getBalance: async () => ({ available: vtxos.reduce((s: number, v: any) => s + v.value, 0), boarding: { total: 0 } }),
        sendBitcoin: async (params: any) => {
          sendBitcoinCalls.push(params)
          return 'txid-send'
        },
      },
    } as any
  }

  function mount(deps: any) {
    const app = express()
    app.use(express.json())
    app.use(createAdminRoutes(deps))
    return app
  }

  it('passes an explicit selectedVtxos set that excludes reserved outpoints', async () => {
    houseVtxoCache.invalidate()
    const reservedCoin = coin('33'.repeat(32), 0, 50_000)
    const freeCoin = coin('44'.repeat(32), 1, 50_000)
    // Liability 0 keeps the (separate, liability-based) withdrawable check out
    // of the way — this test pins the coin-selection contract only.
    reservations.reserve('p0-53-send', [`${reservedCoin.txid}:0`], 0)
    const calls: any[] = []
    const app = mount(sendDeps([reservedCoin, freeCoin], calls))

    const res = await request(app).post('/api/wallet/send').send({ address: 'tark1qdestination', amount: 30_000 })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    // Pre-fix: no selectedVtxos → the SDK selects internally from ALL coins
    // (near-expiry first) and can spend the reserved one.
    expect(calls[0].selectedVtxos).toBeDefined()
    expect(outpoints(calls[0].selectedVtxos)).toEqual([`${freeCoin.txid}:1`])
  })

  it('refuses (400, no spend) when free coins cannot cover the amount and force is not set', async () => {
    houseVtxoCache.invalidate()
    const reservedCoin = coin('55'.repeat(32), 0, 80_000)
    const freeCoin = coin('66'.repeat(32), 1, 20_000)
    reservations.reserve('p0-53-send', [`${reservedCoin.txid}:0`], 0)
    const calls: any[] = []
    const app = mount(sendDeps([reservedCoin, freeCoin], calls))

    const res = await request(app).post('/api/wallet/send').send({ address: 'tark1qdestination', amount: 60_000 })

    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('force:true keeps the blind escape hatch (documented residual: may spend reserved coins)', async () => {
    houseVtxoCache.invalidate()
    const reservedCoin = coin('77'.repeat(32), 0, 80_000)
    const freeCoin = coin('88'.repeat(32), 1, 20_000)
    reservations.reserve('p0-53-send', [`${reservedCoin.txid}:0`], 0)
    const calls: any[] = []
    const app = mount(sendDeps([reservedCoin, freeCoin], calls))

    const res = await request(app).post('/api/wallet/send').send({ address: 'tark1qdestination', amount: 60_000, force: true })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].selectedVtxos).toBeUndefined()
  })

  it('still sends coins expiring within the escrow buffer (near-expiry ≠ unsendable)', async () => {
    houseVtxoCache.invalidate()
    // The 30-min buffer exists so an ESCROWED coin outlives its game — a send
    // spends the coin now. On default regtest (17-min batch expiry) every coin
    // sits inside the buffer, so filtering by it would make admin send refuse
    // everything. Unreserved near-expiry coins must stay sendable.
    const nearExpiry = {
      ...coin('ab'.repeat(32), 0, 50_000),
      virtualStatus: { state: 'settled', batchExpiry: Date.now() + 10 * 60_000 }, // 10 min out
    }
    const calls: any[] = []
    const app = mount(sendDeps([nearExpiry], calls))

    const res = await request(app).post('/api/wallet/send').send({ address: 'tark1qdestination', amount: 30_000 })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(outpoints(calls[0].selectedVtxos)).toEqual([`${nearExpiry.txid}:0`])
  })
})

export {}
