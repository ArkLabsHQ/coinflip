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
  SPLIT_MAX_INPUTS_PER_PIECE, outpointKey, HouseVtxoCache, freeHouseVtxos, freeStakeTotal, spendableTotal,
} = require('arkade-coinflip-server/dist/vtxo-pool.js')

// 7 days: a HEALTHY house coin must now sit outside renewal's 72h horizon,
// because the splitter defers to renewal inside it (splittableHouseVtxos).
const FUTURE_EXPIRY = Date.now() + 7 * 24 * 3600_000
const HOUSE_ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()
const DUST = 330

const coin = (txid: string, vout: number, value: number) => ({
  txid, vout, value,
  isSpent: false, isSwept: false, isUnrolled: false, isPreconfirmed: false, spentBy: '', commitmentTxIds: [], script: '5120', expiresAt: (FUTURE_EXPIRY) === undefined ? undefined : new Date(FUTURE_EXPIRY),
  status: { confirmed: false },
  createdAt: new Date(Date.now() - 60_000),
})
const hex64 = (n: number, f = 'a') => String(n).padStart(64, f)

describe('pickSplitInputs', () => {
  it('leaves a larger share-bearing coin untouched when selecting plain split inputs', () => {
    const token = { ...coin(hex64(9), 0, 500_000), assets: [{ assetId: '11'.repeat(32) + '0000', amount: 1n }] }
    const plain = coin(hex64(8), 0, 40_000)
    expect(pickSplitInputs([token, plain], 25_000, DUST).inputs).toEqual([plain])
    expect(pickSplitInputs([token], 25_000, DUST)).toEqual({ inputs: [], kind: 'none' })
  })
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
        send: async (params: any) => {
          seq++
          const txid = String(seq).padStart(2, '0').repeat(32).slice(0, 64)
          const spentKeys = new Set(params.selectedVtxos.map((v: any) => `${v.txid}:${v.vout}`))
          const inSum = params.selectedVtxos.reduce((t: number, v: any) => t + v.value, 0)
          pool = pool.filter((c: any) => !spentKeys.has(`${c.txid}:${c.vout}`))
          pool.push(coin(txid, 0, params.recipients[0].amount))
          if (inSum - params.recipients[0].amount > 0) pool.push(coin(txid, 1, inSum - params.recipients[0].amount))
          return txid
        },
      },
    }
  })

  afterEach(() => {
    for (const r of reservations.snapshot()) reservations.release(r.gameId)
    houseVtxoCache.invalidate()
  })

  it('never submits a share-bearing wallet coin as a plain Bitcoin split input', async () => {
    const token = { ...coin(hex64(9), 0, 500_000), assets: [{ assetId: '11'.repeat(32) + '0100', amount: 1000n }] }
    const plain = coin(hex64(8), 0, 40_000)
    pool = [token, plain]
    const send = jest.spyOn(deps.wallet, 'send')
    expect((await ensureHouseVtxoPool(deps, { piecesPerRun: 1, pieceSize: 5000 })).created).toBe(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ selectedVtxos: [plain] }))
    expect(pool).toContain(token)
    send.mockClear()
    pool = [token]
    expect((await ensureHouseVtxoPool(deps, { piecesPerRun: 1, pieceSize: 5000 })).created).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('does not count asset carriers as game capacity or free house funds', () => {
    const token = { ...coin(hex64(9), 0, 500_000), assets: [{ assetId: '11'.repeat(32) + '0100', amount: 1000n }] }
    const plain = coin(hex64(8), 0, 40_000)
    expect(freeHouseVtxos([token, plain])).toEqual([plain])
    expect(freeStakeTotal([token, plain])).toBe(plain.value)
    expect(spendableTotal([token, plain])).toBe(plain.value)
  })

  it('drops coins the indexer reports spent even while the wallet store still lists them', async () => {
    const cofunded = coin(hex64(7), 0, 5_000), live = coin(hex64(6), 0, 5_000)
    const indexerGetVtxos = jest.fn().mockResolvedValue({ vtxos: [{ ...cofunded, spentBy: 'bb'.repeat(32) }, live] })
    const localDeps = { wallet: { getVtxos: async () => [cofunded, live], indexerProvider: { getVtxos: indexerGetVtxos } } }
    expect(await new HouseVtxoCache(60_000).refresh(localDeps)).toEqual([live])
    expect(indexerGetVtxos).toHaveBeenCalledWith({ outpoints: [{ txid: cofunded.txid, vout: 0 }, { txid: live.txid, vout: 0 }] })
  })

  it('keeps the wallet list when the indexer spend check fails', async () => {
    const live = coin(hex64(6), 0, 5_000)
    const localDeps = { wallet: { getVtxos: async () => [live], indexerProvider: { getVtxos: async () => { throw new Error('indexer down') } } } }
    expect(await new HouseVtxoCache(60_000).refresh(localDeps)).toEqual([live])
  })

  it('evicts newly identified asset carriers on refresh and never serves them from the warm cache', async () => {
    const plain = coin(hex64(8), 0, 40_000)
    const identified = { ...plain, assets: [{ assetId: '11'.repeat(32) + '0100', amount: 1000n }] }
    const fetch = jest.fn().mockResolvedValueOnce([plain]).mockResolvedValue([identified])
    const cache = new HouseVtxoCache(60_000)
    const localDeps = { wallet: { getVtxos: fetch } }
    expect(await cache.get(localDeps)).toEqual([plain])
    expect(await cache.refresh(localDeps)).toEqual([])
    expect(await cache.get(localDeps)).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
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
    const realSend = deps.wallet.send
    deps.wallet.send = async (params: any) => {
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

/**
 * The splitter must not spend coins renewal is about to settle.
 *
 * `freeHouseVtxos` filters on a 30-minute horizon (right for /play, whose games
 * last minutes); renewal treats anything within 72h as due. That 71.5-hour gap
 * let the splitter mint pieces from near-expiry parents — and pieces inherit
 * their parent's batch expiry, so renewal immediately settled them, undoing
 * shaping the split had just paid a transaction each for. OBSERVED:
 *
 *   19:14:12 [house pool] minted 13 piece(s) — 32/64 free
 *   19:14:49 [renewal]    32 needing renewal (buffer 72h) -> settling all 32
 *   19:18:00 [house pool] minted 16 piece(s) — 17/64 free      (all over again)
 *
 * The same tick read "nearest batch expiry ~1h", so this is not only wasted
 * fees: the splitter was minting from coins an hour off being swept.
 */
describe('the splitter defers to renewal inside its horizon', () => {
  const { splittableHouseVtxos } = require('arkade-coinflip-server/dist/vtxo-pool.js')
  const HOURS = 3600_000
  const withExpiry = (txid: string, value: number, msFromNow: number) => ({
    ...coin(txid, 0, value),
    isSpent: false, isSwept: false, isUnrolled: false, isPreconfirmed: false, spentBy: '', commitmentTxIds: [], script: '5120', expiresAt: (Date.now() + msFromNow) === undefined ? undefined : new Date(Date.now() + msFromNow),
  })

  afterEach(() => {
    for (const r of reservations.snapshot()) reservations.release(r.gameId)
    houseVtxoCache.invalidate()
  })

  it('excludes coins inside the 72h renewal window, keeps those outside', () => {
    const due = withExpiry(hex64(1), 100_000, 1 * HOURS)      // renewal's problem
    const healthy = withExpiry(hex64(2), 100_000, 152 * HOURS) // the post-renewal steady state
    const out = splittableHouseVtxos([due, healthy])
    expect(out.map((v: any) => v.txid)).toEqual([healthy.txid])
  })

  it('still excludes reserved coins, like the /play free set does', () => {
    const healthy = withExpiry(hex64(3), 100_000, 152 * HOURS)
    reservations.reserve('g1', [`${healthy.txid}:0`], 0)
    expect(splittableHouseVtxos([healthy])).toEqual([])
  })

  it('splits fresh short-lived coins using the advertised bounded horizon', async () => {
    let pool: any[] = [withExpiry(hex64(6), 500_000, 8192_000)]
    let n = 0
    const localDeps = {
      arkInfo: { dust: BigInt(DUST), vtxoTreeExpiry: 8192n },
      repos: { config: { get: async () => '[330,1000,5000,10000,50000]' } },
      wallet: {
        getVtxos: async () => pool,
        getAddress: async () => HOUSE_ADDRESS,
        send: async (params: any) => {
          n++
          const txid = String(n).padStart(2, '0').repeat(32).slice(0, 64)
          const spent = new Set(params.selectedVtxos.map((v: any) => `${v.txid}:${v.vout}`))
          const inSum = params.selectedVtxos.reduce((t: number, v: any) => t + v.value, 0)
          pool = pool.filter((c: any) => !spent.has(`${c.txid}:${c.vout}`))
          pool.push(withExpiry(txid, params.recipients[0].amount, 8192_000))
          if (inSum - params.recipients[0].amount > 0) {
            pool.push({ ...withExpiry(txid, inSum - params.recipients[0].amount, 8192_000), vout: 1 })
          }
          return txid
        },
      },
    } as any

    const r = await ensureHouseVtxoPool(localDeps, { piecesPerRun: 3, pieceSize: 5_000 })
    expect(r.created).toBe(3)
  })

  it('uses the clear coins and leaves the near-expiry ones to renewal', () => {
    const due = withExpiry(hex64(7), 100_000, 1 * HOURS)
    const clear = withExpiry(hex64(8), 100_000, 152 * HOURS)
    // Both present -> only the clear one is offered.
    expect(splittableHouseVtxos([due, clear]).map((v: any) => v.txid)).toEqual([clear.txid])
    expect(splittableHouseVtxos([due])).toEqual([])
  })

  it('waits for renewal instead of shaping only near-expiry short-lived coins', async () => {
    const send = jest.fn()
    const deps = { arkInfo: { dust: BigInt(DUST), vtxoTreeExpiry: 8192n },
      wallet: { getVtxos: async () => [withExpiry(hex64(9), 500_000, 3600_000)], getAddress: async () => HOUSE_ADDRESS, send } } as any
    expect((await ensureHouseVtxoPool(deps, { pieceSize: 5000 })).created).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('splits normally once the pool is clear of the horizon', async () => {
    let pool: any[] = [withExpiry(hex64(5), 500_000, 152 * HOURS)]
    let n = 0
    const localDeps = {
      arkInfo: { dust: BigInt(DUST) },
      repos: { config: { get: async () => '[330,1000,5000,10000,50000]' } },
      wallet: {
        getVtxos: async () => pool,
        getAddress: async () => HOUSE_ADDRESS,
        send: async (params: any) => {
          n++
          const txid = String(n).padStart(2, '0').repeat(32).slice(0, 64)
          const spent = new Set(params.selectedVtxos.map((v: any) => `${v.txid}:${v.vout}`))
          const inSum = params.selectedVtxos.reduce((t: number, v: any) => t + v.value, 0)
          pool = pool.filter((c: any) => !spent.has(`${c.txid}:${c.vout}`))
          pool.push(withExpiry(txid, params.recipients[0].amount, 152 * HOURS))
          if (inSum - params.recipients[0].amount > 0) {
            pool.push({ ...withExpiry(txid, inSum - params.recipients[0].amount, 152 * HOURS), vout: 1 })
          }
          return txid
        },
      },
    } as any

    const r = await ensureHouseVtxoPool(localDeps, { piecesPerRun: 3, pieceSize: 5_000 })
    expect(r.created).toBe(3)
  })
})
