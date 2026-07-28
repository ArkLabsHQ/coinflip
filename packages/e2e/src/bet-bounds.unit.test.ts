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
