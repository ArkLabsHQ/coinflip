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
 *
 * Fixed behavior asserted here:
 *   - settle paths pass EXPLICIT SettleParams whose inputs exclude every
 *     reserved outpoint (and never an empty outputs list — arkd rejects that).
 *   - the pool split runs the SDK send UNDER the /play selection mutex and
 *     defers while any outpoint reservation is live (its recipient-sized
 *     self-send can't be constrained); liability-only reservations don't block.
 *   - admin POST /api/wallet/send mirrors the SDK's own `_sendImpl` selection
 *     (same candidate set: getVtxos({withRecoverable:false}) minus
 *     pendingRecoveryOutpoints(); same selector: selectVirtualCoins to
 *     max(amount, dust)) with reserved outpoints removed, and passes the picks
 *     as sendBitcoin({selectedVtxos}). Every coin it hands to arkd is one the
 *     SDK's blind path could have picked itself — minus the reserved ones —
 *     so arkd accepts them identically. Free-set shortfall is a clean 400
 *     (no spend); force:true keeps the blind operator hatch.
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

describe('P0 #53 — admin POST /api/wallet/send spends only un-reserved coins', () => {
  afterEach(() => {
    reservations.release('p0-53-send')
  })

  /**
   * Wallet mock for the send path. The handler mirrors `_sendImpl`'s candidate
   * set (getVtxos({withRecoverable:false}) minus pendingRecoveryOutpoints())
   * before removing reserved outpoints, so the mock exposes both reads plus the
   * dust floor the selection target uses.
   */
  function sendApp(vtxos: any[], sendCalls: any[], pendingRecovery: string[] = []) {
    const deps = {
      wallet: {
        dustAmount: 330n,
        getBalance: async () => ({ available: vtxos.reduce((s: number, v: any) => s + v.value, 0) }),
        getVtxos: async () => vtxos,
        pendingRecoveryOutpoints: async () => new Set(pendingRecovery),
        sendBitcoin: async (params: any) => {
          sendCalls.push(params)
          return 'txid-send'
        },
      },
    } as any
    const app = express()
    app.use(express.json())
    app.use(createAdminRoutes(deps))
    return app
  }

  it('selects the FREE coin as an explicit selectedVtxos, never the reserved one', async () => {
    const reservedCoin = coin('33'.repeat(32), 0, 60_000)
    const freeCoin = coin('44'.repeat(32), 1, 40_000)
    // Small liability: the coarse liability guard passes — only the outpoint
    // exclusion can keep the reserved coin out of the spend.
    reservations.reserve('p0-53-send', [`${reservedCoin.txid}:0`], 2_000)
    const sendCalls: any[] = []
    const app = sendApp([reservedCoin, freeCoin], sendCalls)

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000 })

    expect(res.status).toBe(200)
    expect(res.body.txid).toBe('txid-send')
    expect(sendCalls).toHaveLength(1)
    // Pre-fix this was a blind sendBitcoin({address, amount}) — the SDK's
    // internal selection could pick the reserved coin (the P0 residual).
    expect(sendCalls[0].selectedVtxos).toBeDefined()
    expect(outpoints(sendCalls[0].selectedVtxos)).toEqual([`${freeCoin.txid}:1`])
    expect(sendCalls[0].address).toBe(HOUSE_ADDRESS)
    expect(sendCalls[0].amount).toBe(1000)
  })

  it('keeps the SDK selector order (near-expiry first) on the free set', async () => {
    const later = coin('55'.repeat(32), 0, 50_000)
    const sooner = { ...coin('66'.repeat(32), 1, 40_000), virtualStatus: { state: 'settled', batchExpiry: FUTURE_EXPIRY - 3600_000 } }
    const sendCalls: any[] = []
    const app = sendApp([later, sooner], sendCalls)

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000 })

    expect(res.status).toBe(200)
    // selectVirtualCoins sorts batchExpiry ascending — the sooner-expiring coin
    // wins even though the later one is larger (same pick _sendImpl makes).
    expect(outpoints(sendCalls[0].selectedVtxos)).toEqual([`${sooner.txid}:1`])
  })

  it('400s cleanly (no spend) when every coin is pinned to a live game', async () => {
    // The admin-api regtest state: ONE bankroll coin, pinned by a pending v4
    // game whose liability is far below the balance — the liability guard alone
    // would let the send through and the blind SDK selection would spend the
    // pinned coin, breaking the game's co-fund.
    const reservedCoin = coin('77'.repeat(32), 2, 50_000)
    reservations.reserve('p0-53-send', [`${reservedCoin.txid}:2`], 2_000)
    const sendCalls: any[] = []
    const app = sendApp([reservedCoin], sendCalls)

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000 })

    expect(res.status).toBe(400)
    expect(res.body.freeSpendable).toBe(0)
    expect(res.body.error).toContain('force')
    expect(sendCalls).toHaveLength(0)
  })

  it('never selects a pending-recovery coin (the coin arkd would reject)', async () => {
    const stuck = coin('88'.repeat(32), 0, 80_000)
    const clean = coin('99'.repeat(32), 1, 30_000)
    const sendCalls: any[] = []
    const app = sendApp([stuck, clean], sendCalls, [`${stuck.txid}:0`])

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000 })

    expect(res.status).toBe(200)
    // The stuck coin is larger and un-reserved, but _sendImpl drops
    // pendingRecoveryOutpoints() from its candidate set — so do we. Selecting
    // it was prior-attempt C's failure: arkd rejects the spend at submit.
    expect(outpoints(sendCalls[0].selectedVtxos)).toEqual([`${clean.txid}:1`])

    // With ONLY the stuck coin left, the send is a clean 400 — not a doomed submit.
    const sendCalls2: any[] = []
    const app2 = sendApp([stuck], sendCalls2, [`${stuck.txid}:0`])
    const res2 = await request(app2).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000 })
    expect(res2.status).toBe(400)
    expect(sendCalls2).toHaveLength(0)
  })

  it('targets max(amount, dust) like _sendImpl — a sub-dust send needs dust-worth of coins', async () => {
    const tiny = coin('aa'.repeat(32), 3, 200) // below the 330 dust floor
    const sendCalls: any[] = []
    const app = sendApp([tiny], sendCalls)

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 100 })

    expect(res.status).toBe(400)
    expect(sendCalls).toHaveLength(0)
  })

  it('force:true keeps the blind operator hatch (no selectedVtxos)', async () => {
    const reservedCoin = coin('bb'.repeat(32), 4, 50_000)
    reservations.reserve('p0-53-send', [`${reservedCoin.txid}:4`], 2_000)
    const sendCalls: any[] = []
    const app = sendApp([reservedCoin], sendCalls)

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000, force: true })

    expect(res.status).toBe(200)
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0].selectedVtxos).toBeUndefined()
  })
})

export {}
