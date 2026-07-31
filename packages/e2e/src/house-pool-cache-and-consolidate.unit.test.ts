/**
 * Two regressions this branch fixes, both in code shipped in v0.15.0.
 *
 * 1. THE SPLITTER STARVED THE SHARED SNAPSHOT. It refreshed and invalidated
 *    `houseVtxoCache` once per piece, and /play and /api/tiers read that same
 *    cache — so they joined its in-flight full sync and then found it dropped.
 *    MEASURED in production mid-run: `v4/play total=4984ms wallet:getVtxos=4974`
 *    (the whole request; `select+reserve=0`, so not lock contention) and
 *    /api/tiers at a 4,355ms median against the 89ms it had been. The splitter
 *    now reads privately and publishes once.
 *
 * 2. THE LADDER COULD STRAND ITSELF. Filling the smallest rung first is a
 *    one-way door without consolidation. OBSERVED in production: a run left 32
 *    free coins of 5,000 (160,000 sat) and then reported "no free coin can fund
 *    a 5000-sat piece" on every later tick — the ladder wanted a 25,000 piece,
 *    no single coin could fund one, and the anti-churn rule correctly refused to
 *    spend a 5,000 to remake a 5,000. The bankroll was fine; the SHAPE was
 *    wrong, and nothing could reshape it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { ArkAddress } from '@arkade-os/sdk'
const {
  ensureHouseVtxoPool, reservations, houseVtxoCache, pickSplitInputs,
  SPLIT_MAX_INPUTS_PER_PIECE, outpointKey,
} = require('arkade-coinflip-server/dist/vtxo-pool.js')

const FUTURE_EXPIRY = Date.now() + 24 * 3600_000
const HOUSE_ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()
const DUST = 330

const coin = (txid: string, vout: number, value: number) => ({
  txid, vout, value,
  virtualStatus: { state: 'settled', batchExpiry: FUTURE_EXPIRY },
  status: { confirmed: false },
  createdAt: new Date(Date.now() - 60_000),
})
const hex64 = (n: number, f = 'a') => String(n).padStart(64, f)

describe('pickSplitInputs', () => {
  it('peels one coin when a single one is big enough', () => {
    const free = [coin(hex64(1), 0, 40_000), coin(hex64(2), 0, 5_000)]
    const r = pickSplitInputs(free, 25_000, DUST)
    expect(r.kind).toBe('peel')
    expect(r.inputs).toHaveLength(1)
    expect(r.inputs[0].value).toBe(40_000)   // largest first
  })

  // The stranding fix.
  it('consolidates several small coins when no single one can fund the rung', () => {
    // The production shape: everything is 5,000 and the ladder wants 25,000.
    const free = Array.from({ length: 32 }, (_v, i) => coin(hex64(i), 0, 5_000))
    const r = pickSplitInputs(free, 25_000, DUST)
    expect(r.kind).toBe('consolidate')
    // 25,000 + 330 dust needs six 5,000s, not five.
    expect(r.inputs).toHaveLength(6)
    expect(r.inputs.reduce((t: number, v: any) => t + v.value, 0)).toBeGreaterThanOrEqual(25_000 + DUST)
  })

  it('never peels a coin equal to the amount — anti-churn still holds', () => {
    const free = [coin(hex64(1), 0, 5_000)]
    const r = pickSplitInputs(free, 5_000, DUST)
    // One 5,000 cannot make a 5,000 (no dust-safe change) and cannot be
    // consolidated with anything, so nothing is chosen.
    expect(r.kind).toBe('none')
    expect(r.inputs).toEqual([])
  })

  it('respects the input cap so one piece cannot sweep the pool', () => {
    const free = Array.from({ length: 40 }, (_v, i) => coin(hex64(i), 0, 1_000))
    const r = pickSplitInputs(free, 39_000, DUST, SPLIT_MAX_INPUTS_PER_PIECE)
    // 39,330 would need 40 coins; the cap stops it short, so it declines.
    expect(r.inputs.length).toBeLessThanOrEqual(SPLIT_MAX_INPUTS_PER_PIECE)
    expect(r.kind).toBe('none')
  })

  it('declines when the whole free set cannot cover the amount', () => {
    const free = [coin(hex64(1), 0, 1_000), coin(hex64(2), 0, 2_000)]
    expect(pickSplitInputs(free, 25_000, DUST).kind).toBe('none')
  })
})

describe('the splitter does not churn the shared snapshot', () => {
  let pool: any[]
  let seq: number
  let deps: any

  beforeEach(() => {
    houseVtxoCache.invalidate()
    for (const r of reservations.snapshot()) reservations.release(r.gameId)
    seq = 0
    pool = [coin(hex64(1, 'e'), 0, 500_000)]
    deps = {
      arkInfo: { dust: BigInt(DUST) },
      repos: { config: { get: async () => '[330,1000,5000,10000,50000]' } },
      wallet: {
        getVtxos: async () => pool,
        getAddress: async () => HOUSE_ADDRESS,
        sendBitcoin: async (params: any) => {
          seq++
          const txid = String(seq).padStart(2, '0').repeat(32).slice(0, 64)
          const spentKeys = new Set(params.selectedVtxos.map((v: any) => `${v.txid}:${v.vout}`))
          const inSum = params.selectedVtxos.reduce((t: number, v: any) => t + v.value, 0)
          pool = pool.filter((c: any) => !spentKeys.has(`${c.txid}:${c.vout}`))
          pool.push(coin(txid, 0, params.amount))
          if (inSum - params.amount > 0) pool.push(coin(txid, 1, inSum - params.amount))
          return txid
        },
      },
    }
  })

  afterEach(() => {
    for (const r of reservations.snapshot()) reservations.release(r.gameId)
    houseVtxoCache.invalidate()
  })

  /**
   * The headline: one publish per RUN. Previously this was one per piece, which
   * is what made /play pay for the splitter's syncs.
   */
  it('invalidates the shared cache once for the whole run, not once per piece', async () => {
    const spy = jest.spyOn(houseVtxoCache, 'invalidate')
    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 5, pieceSize: 5_000 })

    expect(r.created).toBe(5)
    // Pre-fix: 5. Now: one publish at the end.
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  /**
   * The other half of why that is safe: /play reads a snapshot that still lists
   * the coins this run has spent, so those coins must stay PINNED for the whole
   * run rather than being unpinned after each piece.
   */
  it('keeps every already-spent coin reserved for the rest of the run', async () => {
    const seenReservedDuringSend: boolean[] = []
    let firstSpent = ''
    const realSend = deps.wallet.sendBitcoin
    deps.wallet.sendBitcoin = async (params: any) => {
      if (firstSpent) seenReservedDuringSend.push(reservations.isReserved(firstSpent))
      const out = await realSend(params)
      if (!firstSpent) {
        const v = params.selectedVtxos[0]
        firstSpent = outpointKey(v.txid, v.vout)
      }
      return out
    }

    await ensureHouseVtxoPool(deps, { piecesPerRun: 4, pieceSize: 5_000 })

    // Pieces 2..4 all ran while piece 1's coin was still pinned.
    expect(seenReservedDuringSend.length).toBeGreaterThanOrEqual(3)
    expect(seenReservedDuringSend.every(Boolean)).toBe(true)
    // ...and nothing is left pinned once the run is over.
    expect(reservations.isReserved(firstSpent)).toBe(false)
  })

  it('leaves no pins behind when the run ends on a refusal', async () => {
    pool = [coin(hex64(2, 'e'), 0, 5_000)] // cannot fund a 5,000 piece
    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 4, pieceSize: 5_000 })
    expect(r.created).toBe(0)
    expect(reservations.snapshot()).toEqual([])
  })
})
