/**
 * Admin GET /api/recovery unit tests (mocked deps, no regtest).
 *
 * Context: a swept VTXO is NOT lost — while it remains unspent it is
 * recoverable (`isRecoverable = swept && spendable`), reclaimed by settling it
 * back in a batch. The dashboard used to render only available/settled/
 * preconfirmed/boarding, so swept-but-reclaimable value was invisible and an
 * expiry could look identical to "the money is gone". This endpoint surfaces
 * the SDK's own recovery numbers.
 *
 * The load-bearing property is that it OBSERVES ONLY: `getRecoverableBalance`
 * and `getExpiringVtxos` read, while `recoverVtxos`/`renewVtxos` move money.
 * The second test fails loudly if anyone ever makes this endpoint "helpfully"
 * auto-recover.
 */
export {}

import express from 'express'
import request from 'supertest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require('arkade-coinflip-server')

const BALANCE = {
  boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
  settled: 0,
  preconfirmed: 0,
  available: 0,
  recoverable: 950_000,
  pendingRecovery: 25_000,
  total: 975_000,
  assets: [],
}

function makeDeps() {
  const calls = { recoverVtxos: 0, renewVtxos: 0 }
  const vtxoManager = {
    getRecoverableBalance: async () => ({
      recoverable: 950_000n,
      subdust: 330n,
      includesSubdust: true,
      vtxoCount: 3,
    }),
    getExpiringVtxos: async () => [
      {
        txid: 'ab'.repeat(32),
        vout: 0,
        value: 500_000,
        virtualStatus: { state: 'settled', batchExpiry: '2026-07-30T00:00:00Z' },
      },
    ],
    // Mutating counterparts — must never be invoked by a diagnostic.
    recoverVtxos: async () => { calls.recoverVtxos++; return 'txid' },
    renewVtxos: async () => { calls.renewVtxos++; return 'txid' },
  }
  return {
    calls,
    deps: {
      wallet: {
        getBalance: async () => BALANCE,
        getTransactionHistory: async () => [],
        getVtxoManager: async () => vtxoManager,
      },
      identity: { compressedPublicKey: async () => new Uint8Array(33) },
      repos: {
        games: { list: async () => [], stats: async () => ({}) },
        config: { all: async () => ({}) },
      },
    },
  }
}

describe('admin GET /api/recovery', () => {
  let app: express.Express
  let calls: { recoverVtxos: number; renewVtxos: number }

  beforeAll(() => {
    const m = makeDeps()
    calls = m.calls
    app = express()
    app.use(express.json())
    app.use(server.createAdminRoutes(m.deps))
  })

  it('surfaces the recoverable balance the plain balance view hides', async () => {
    const res = await request(app).get('/api/recovery').expect(200)
    expect(res.body.recoverable).toMatchObject({
      sats: 950_000,
      subdust: 330,
      includesSubdust: true,
      vtxoCount: 3,
    })
    // The full SDK balance, including the two fields the dashboard dropped.
    expect(res.body.balance.recoverable).toBe(950_000)
    expect(res.body.balance.pendingRecovery).toBe(25_000)
  })

  it('NEVER invokes the mutating recovery/renewal paths', async () => {
    await request(app).get('/api/recovery').expect(200)
    expect(calls.recoverVtxos).toBe(0)
    expect(calls.renewVtxos).toBe(0)
  })

  it('reports expiring VTXOs with their batch expiry', async () => {
    const res = await request(app).get('/api/recovery').expect(200)
    expect(res.body.expiringSoon).toHaveLength(1)
    expect(res.body.expiringSoon[0]).toMatchObject({
      vout: 0,
      value: 500_000,
      batchExpiry: '2026-07-30T00:00:00Z',
    })
  })

  it('serializes bigint amounts without throwing', async () => {
    // getRecoverableBalance returns bigints; JSON.stringify would throw on a
    // raw bigint, so the route must convert. A 200 with numeric fields proves it.
    const res = await request(app).get('/api/recovery').expect(200)
    expect(typeof res.body.recoverable.sats).toBe('number')
    expect(typeof res.body.recoverable.subdust).toBe('number')
  })
})
