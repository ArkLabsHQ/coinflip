/**
 * The house pool split must survive arkd's indexing race.
 *
 * Each split iteration spends the PREVIOUS iteration's change — a freshly
 * preconfirmed VTXO. arkd sometimes has not registered it yet when the next
 * `submitTx` names it as an input and answers `VTXO_NOT_FOUND (30): some vtxos
 * not found`. That used to abort the whole run: seen in CI, the run minted ONE
 * piece, lost the second to the race, and stopped with 2 free coins — the first
 * two /play calls then pinned both and every later game died with
 * "per-bet cap is 0 sat (25% of 0 sat free)".
 *
 * Asserted here: a transient failure costs a re-read and a retry, not the run;
 * the retry budget is per-RUN so a wedged arkd still stops quickly; and a
 * non-transient refusal still stops immediately (retrying a real rejection just
 * burns time, and a timed-out send may have landed).
 *
 * Imports the BUILT server (dist) directly, like the sibling unit tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { ArkAddress } from '@arkade-os/sdk'
const {
  ensureHouseVtxoPool, reservations, houseVtxoCache, isTransientSplitFailure,
} = require('arkade-coinflip-server/dist/vtxo-pool.js')

const FUTURE_EXPIRY = Date.now() + 24 * 3600_000
const HOUSE_ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()

const coin = (txid: string, vout: number, value: number) => ({
  txid,
  vout,
  value,
  virtualStatus: { state: 'settled', batchExpiry: FUTURE_EXPIRY },
  status: { confirmed: false },
  createdAt: new Date(Date.now() - 60_000),
})

/**
 * A wallet that behaves like the real chain: every successful send CONSUMES its
 * input and mints the change, so iteration N+1 spends iteration N's change —
 * which is exactly the coin the race is about. `failOn` lists the 1-based send
 * attempts that reject, and with what.
 */
function chainingSplitDeps(start: any[], failOn: Map<number, Error>) {
  let vtxos = [...start]
  let seq = 0
  const attempts: string[][] = []
  const deps = {
    arkInfo: { dust: 330n },
    repos: { config: { get: async () => '[330,1000,5000,10000,50000]' } },
    wallet: {
      getVtxos: async () => vtxos,
      getAddress: async () => HOUSE_ADDRESS,
      sendBitcoin: async (params: any) => {
        seq++
        attempts.push(params.selectedVtxos.map((v: any) => `${v.txid}:${v.vout}`))
        const boom = failOn.get(seq)
        if (boom) throw boom
        const spent = new Set(params.selectedVtxos.map((v: any) => `${v.txid}:${v.vout}`))
        const inSum = params.selectedVtxos.reduce((s: number, v: any) => s + v.value, 0)
        const txid = String(seq).padStart(2, '0').repeat(32).slice(0, 64)
        vtxos = vtxos.filter((v) => !spent.has(`${v.txid}:${v.vout}`))
        vtxos.push(coin(txid, 0, params.amount))
        if (inSum - params.amount > 0) vtxos.push(coin(txid, 1, inSum - params.amount))
        return txid
      },
    },
  } as any
  return { deps, attempts, sends: () => seq, pool: () => vtxos }
}

const notFound = () => new Error('VTXO_NOT_FOUND (30): some vtxos not found')

describe('house pool split — arkd indexing race', () => {
  beforeEach(() => {
    houseVtxoCache.invalidate()
    reservations.release('__house_pool_split__')
  })
  afterEach(() => {
    houseVtxoCache.invalidate()
    reservations.release('__house_pool_split__')
  })

  it('retries a transient VTXO_NOT_FOUND and keeps minting instead of stopping the run', async () => {
    // Fails the 2nd send — the one that first spends a just-minted change coin,
    // which is precisely where CI lost the run.
    const { deps, sends } = chainingSplitDeps([coin('aa'.repeat(32), 0, 495_000)], new Map([[2, notFound()]]))

    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 4, pieceSize: 5_000 })

    // Pre-fix this was 1: the run aborted on the failed send.
    expect(r.created).toBe(4)
    expect(sends()).toBe(5) // 4 successful + the one that raced
  })

  it('spends the retry budget per RUN, so a wedged arkd stops the run quickly', async () => {
    const failAlways = new Map(Array.from({ length: 50 }, (_, i) => [i + 1, notFound()]))
    const { deps, sends } = chainingSplitDeps([coin('bb'.repeat(32), 0, 495_000)], failAlways)

    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 16, pieceSize: 5_000 })

    expect(r.created).toBe(0)
    // The first attempt plus SPLIT_TRANSIENT_RETRIES (3) — NOT piecesPerRun × retries.
    expect(sends()).toBe(4)
    expect(r.reason).toMatch(/VTXO_NOT_FOUND/)
  })

  it('still stops immediately on a refusal a retry cannot clear', async () => {
    const { deps, sends } = chainingSplitDeps(
      [coin('cc'.repeat(32), 0, 495_000)],
      new Map([[2, new Error('INVALID_SIGNATURE (7): bad witness')]]),
    )

    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 8, pieceSize: 5_000 })

    expect(r.created).toBe(1)
    expect(sends()).toBe(2)
  })

  it('classifies only the indexing race as transient', () => {
    expect(isTransientSplitFailure(notFound())).toBe(true)
    expect(isTransientSplitFailure(new Error('vtxos not found'))).toBe(true)
    // A timed-out send may still have landed — retrying it risks minting twice.
    expect(isTransientSplitFailure(new Error('house pool split send timed out'))).toBe(false)
    expect(isTransientSplitFailure(new Error('VTXO_ALREADY_SPENT (6)'))).toBe(false)
    expect(isTransientSplitFailure(new Error('insufficient funds'))).toBe(false)
  })

  it('leaves no pin behind after a run that ends on the race', async () => {
    const failAlways = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, notFound()]))
    const only = coin('dd'.repeat(32), 0, 495_000)
    const { deps } = chainingSplitDeps([only], failAlways)

    await ensureHouseVtxoPool(deps, { piecesPerRun: 4, pieceSize: 5_000 })

    expect(reservations.isReserved(`${only.txid}:0`)).toBe(false)
  })
})
