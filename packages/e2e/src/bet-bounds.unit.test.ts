/**
 * Bet-envelope bounds. The house stake, not the bet, is what's constrained:
 * dust <= houseStake(amount, odds) <= capacity. Because houseStake is strictly
 * increasing in both the amount and the ladder position, the amount bounds
 * invert in closed form and the feasible ladder steps form a contiguous window.
 *
 * The boundary tests are the point: an off-by-one in amountMax silently hides
 * the maximum bet from every player.
 */
export {}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeHouseStake, amountBoundsForOdds, feasibleOddsWindow, betRails } = require('arkade-coinflip')

const EDGE = 300      // 3% house edge
const DUST = 330
const RAIL_MIN = 331  // dust + 1
const RAIL_MAX = 50_000

// win = 50 of n = 100 -> houseStake(A) = floor(A * 0.97)
const HALF: { n: number; target: number; lo: number } = { n: 100, target: 100, lo: 50 }

// Strictly decreasing win rate: 50% -> 25% -> 10%
const LADDER = [
  { n: 100, target: 100, lo: 50 },
  { n: 100, target: 100, lo: 75 },
  { n: 100, target: 100, lo: 90 },
]

describe('amountBoundsForOdds', () => {
  it('min is the smallest amount whose house stake clears dust', () => {
    const b = amountBoundsForOdds(HALF, {
      edgeBps: EDGE, dust: DUST, capacity: 10_000, railMin: RAIL_MIN, railMax: RAIL_MAX,
    })
    expect(b.min).toBe(341)
    expect(computeHouseStake(b.min, HALF.n, HALF.target, HALF.lo, EDGE)).toBeGreaterThanOrEqual(DUST)
    expect(computeHouseStake(b.min - 1, HALF.n, HALF.target, HALF.lo, EDGE)).toBeLessThan(DUST)
  })

  it('max is the LARGEST amount that still fits capacity (exact boundary)', () => {
    const b = amountBoundsForOdds(HALF, {
      edgeBps: EDGE, dust: DUST, capacity: 10_000, railMin: RAIL_MIN, railMax: RAIL_MAX,
    })
    expect(b.max).toBe(10_310)
    expect(computeHouseStake(b.max, HALF.n, HALF.target, HALF.lo, EDGE)).toBeLessThanOrEqual(10_000)
    expect(computeHouseStake(b.max + 1, HALF.n, HALF.target, HALF.lo, EDGE)).toBeGreaterThan(10_000)
  })

  it('clamps to the configured rails', () => {
    const b = amountBoundsForOdds(HALF, {
      edgeBps: EDGE, dust: DUST, capacity: 100_000_000, railMin: RAIL_MIN, railMax: RAIL_MAX,
    })
    expect(b.max).toBe(RAIL_MAX)
    expect(b.feasible).toBe(true)
  })

  it('reports infeasible when capacity cannot cover even the minimum', () => {
    const b = amountBoundsForOdds(HALF, {
      edgeBps: EDGE, dust: DUST, capacity: 100, railMin: RAIL_MIN, railMax: RAIL_MAX,
    })
    expect(b.feasible).toBe(false)
  })

  it('is infeasible when the house stakes nothing (win === n)', () => {
    const b = amountBoundsForOdds({ n: 100, target: 100, lo: 0 }, {
      edgeBps: EDGE, dust: DUST, capacity: 10_000, railMin: RAIL_MIN, railMax: RAIL_MAX,
    })
    expect(b.feasible).toBe(false)
  })

  it('reserves topUpHeadroom at the capacity ceiling, not at the rails', () => {
    // The client's displayed amount is not the amount /play caps on: the wallet
    // folds a sub-dust change (<= dust) into the stake afterwards. Reserving dust
    // means the WORST-case bet (max + dust) still fits capacity.
    const b = amountBoundsForOdds(HALF, {
      edgeBps: EDGE, dust: DUST, capacity: 10_000, railMin: RAIL_MIN, railMax: RAIL_MAX,
      topUpHeadroom: DUST,
    })
    expect(b.max).toBe(10_310 - DUST)
    expect(computeHouseStake(b.max + DUST, HALF.n, HALF.target, HALF.lo, EDGE)).toBeLessThanOrEqual(10_000)
    // The rail ceiling is NOT reduced — /play range-checks the bare amount,
    // which the top-up never grows.
    const railed = amountBoundsForOdds(HALF, {
      edgeBps: EDGE, dust: DUST, capacity: 100_000_000, railMin: RAIL_MIN, railMax: RAIL_MAX,
      topUpHeadroom: DUST,
    })
    expect(railed.max).toBe(RAIL_MAX)
  })

  it('reports a rung the headroom makes unplayable as infeasible, not inverted', () => {
    // capacity 340 -> unclamped max 351, min 341: a 10-sat window that a 330-sat
    // headroom eats entirely. That must surface through `feasible` (the path
    // PlayView already disables the bet on), never as a min > max range.
    const b = amountBoundsForOdds(HALF, {
      edgeBps: EDGE, dust: DUST, capacity: 340, railMin: RAIL_MIN, railMax: RAIL_MAX,
      topUpHeadroom: DUST,
    })
    expect(b.min).toBeGreaterThan(b.max)
    expect(b.feasible).toBe(false)
  })

  it('stays inside Number.MAX_SAFE_INTEGER at a 1 BTC bankroll', () => {
    const b = amountBoundsForOdds(HALF, {
      edgeBps: EDGE, dust: DUST, capacity: 100_000_000, railMin: RAIL_MIN, railMax: 100_000_000,
    })
    expect(Number.isSafeInteger(b.max)).toBe(true)
  })
})

describe('betRails', () => {
  it('floors strictly above dust and ceilings at the largest tier', () => {
    // min(tiers) === dust === 330, so the floor must be 331, not 330.
    expect(betRails([330, 1000, 5000, 10000, 50000], DUST)).toEqual({ railMin: 331, railMax: 50_000 })
  })

  it('keeps a configured floor that is already above dust', () => {
    expect(betRails([1000, 50000], DUST)).toEqual({ railMin: 1000, railMax: 50_000 })
  })
})

describe('feasibleOddsWindow', () => {
  it('returns the contiguous window of playable steps', () => {
    // stakes at amount 1000: 970, 2910, 8730 -> capacity 5000 cuts the last
    const w = feasibleOddsWindow(1000, LADDER, { edgeBps: EDGE, dust: DUST, capacity: 5000 })
    expect(w).toEqual({ loIndex: 0, hiIndex: 1 })
  })

  it('excludes low steps whose stake is sub-dust', () => {
    // stakes at amount 100: 97, 291, 873 -> only the last clears dust
    const w = feasibleOddsWindow(100, LADDER, { edgeBps: EDGE, dust: DUST, capacity: 5000 })
    expect(w).toEqual({ loIndex: 2, hiIndex: 2 })
  })

  it('returns null when no step is playable', () => {
    expect(feasibleOddsWindow(1, LADDER, { edgeBps: EDGE, dust: DUST, capacity: 5000 })).toBeNull()
  })

  it('house stake increases monotonically along the ladder', () => {
    const stakes = LADDER.map((b) => computeHouseStake(1000, b.n, b.target, b.lo, EDGE))
    for (let i = 1; i < stakes.length; i++) expect(stakes[i]).toBeGreaterThan(stakes[i - 1])
  })
})

describe('slider convergence (amountBoundsForOdds + feasibleOddsWindow)', () => {
  /**
   * Mirrors PlayView.vue's two mutual-clamping watchers exactly: clamp the
   * ladder index into the amount's feasible window, then clamp the amount
   * into that (possibly new) step's bounds. If the two helpers are genuine
   * inverses of the same dust<=stake<=capacity predicate, one pass is a
   * fixed point. Vue's runaway-update guard that would catch a drift here is
   * DEV-ONLY (absent in production), so this pins the invariant directly
   * instead of relying on it.
   */
  function clampOnce(
    amount: number,
    index: number,
    ladder: { n: number; target: number; lo: number }[],
    opts: {
      edgeBps: number; dust: number; capacity: number; railMin: number; railMax: number
      topUpHeadroom?: number
    },
  ): { amount: number; index: number } {
    const w = feasibleOddsWindow(amount, ladder, opts)
    let i = index
    if (w) {
      if (i < w.loIndex) i = w.loIndex
      else if (i > w.hiIndex) i = w.hiIndex
    }
    const b = amountBoundsForOdds(ladder[i], opts)
    let a = amount
    if (b.feasible) {
      if (a < b.min) a = b.min
      else if (a > b.max) a = b.max
    }
    return { amount: a, index: i }
  }

  const SMALL_LADDER = [
    { n: 6, target: 6, lo: 3 }, // 50%
    { n: 6, target: 6, lo: 5 }, // ~17%
  ]
  const SINGLE_STEP_LADDER = [{ n: 1000, target: 1000, lo: 990 }] // 1%
  const LADDERS = [LADDER, SMALL_LADDER, SINGLE_STEP_LADDER]
  const CAPACITIES = [0, 1, 100, 5_000, 10_000, 1_000_000]
  const AMOUNTS = [1, 100, RAIL_MIN, 1000, 10_000, 100_000]
  const START_INDICES = [0, 1]
  // With a headroom the amount clamp pulls BELOW what feasibleOddsWindow (which
  // knows nothing about it) admitted, so re-running the index clamp on the new
  // amount is the step that could ping-pong. It doesn't — the clamped amount is
  // still inside [dust, capacity] for that step — but the watchers are mutually
  // triggering in production, so pin it rather than argue it.
  const TOPUPS = [0, DUST]

  it('clamping the index then the amount is a fixed point after one pass, across a grid of amounts/ladders/capacities/headrooms', () => {
    const base = { edgeBps: EDGE, dust: DUST, railMin: RAIL_MIN, railMax: RAIL_MAX }
    for (const ladder of LADDERS) {
      for (const capacity of CAPACITIES) {
        for (const topUpHeadroom of TOPUPS) {
          const opts = { ...base, capacity, topUpHeadroom }
          for (const amount of AMOUNTS) {
            for (const rawIndex of START_INDICES) {
              const index = Math.min(rawIndex, ladder.length - 1)
              const once = clampOnce(amount, index, ladder, opts)
              const twice = clampOnce(once.amount, once.index, ladder, opts)
              expect(twice).toEqual(once)
            }
          }
        }
      }
    }
  })
})
