/**
 * Deterministic unit tests for the variable-odds house-stake math (no regtest).
 * computeHouseStake(playerStake, n, target, lo, edgeBps) decides how much the
 * house escrows so payouts reflect the odds (range [lo, target) over n, win
 * prob (target-lo)/n) with a fixed house edge — money math, so pin it exactly.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { computeHouseStake } = require('arkade-coinflip-server/dist/house-economics.js')
// The formula is single-sourced in the lib; the server re-exports it and the
// browser client imports the same crypto-free subpath. Pin that they agree.
const { computeHouseStake: libComputeHouseStake } = require('arkade-coinflip/dist/stake-math.js')

describe('computeHouseStake (variable-odds house stake with edge)', () => {
  it('fair (0 edge): house stakes playerStake·(n−win)/win, win = target−lo', () => {
    expect(computeHouseStake(1000, 6, 1, 0, 0)).toBe(5000) // [0,1) 1-in-6 → 6x
    expect(computeHouseStake(1000, 6, 3, 0, 0)).toBe(1000) // [0,3) 3-in-6 → 2x
    expect(computeHouseStake(1000, 2, 1, 0, 0)).toBe(1000) // [0,1)/2 → matches the coin
    expect(computeHouseStake(1000, 6, 5, 0, 0)).toBe(200) // [0,5) 5-in-6 → 1.2x
  })

  it('depends only on the range SIZE (lo shifts, win size fixed)', () => {
    // [0,3), [2,5), [3,6) all have win size 3 → identical house stake.
    expect(computeHouseStake(1000, 6, 5, 2, 0)).toBe(1000) // "roll 2-4"
    expect(computeHouseStake(1000, 6, 6, 3, 0)).toBe(1000) // "roll 4+" ([3,6))
    // Size-1 ranges → 6x regardless of position.
    expect(computeHouseStake(1000, 6, 1, 0, 0)).toBe(5000) // "roll a 1"
    expect(computeHouseStake(1000, 6, 6, 5, 0)).toBe(5000) // "exactly a 6" ([5,6))
  })

  it('a house edge shaves the house stake (shorter-than-fair payout)', () => {
    expect(computeHouseStake(1000, 6, 1, 0, 300)).toBe(4850) // 3% off 5000
    expect(computeHouseStake(1000, 6, 2, 0, 300)).toBe(1940) // 3% off 2000
    expect(computeHouseStake(1000, 6, 1, 0, 300)).toBeLessThan(computeHouseStake(1000, 6, 1, 0, 0))
  })

  it('floors to an integer + scales linearly with the player stake', () => {
    expect(computeHouseStake(1000, 4, 3, 0, 300)).toBe(323) // 1000·1·9700/(3·10000)=323.3→323
    expect(Number.isInteger(computeHouseStake(777, 6, 1, 0, 250))).toBe(true)
    expect(computeHouseStake(5000, 6, 1, 0, 300)).toBe(5 * computeHouseStake(1000, 6, 1, 0, 300))
  })
})

describe('computeHouseStake single-source (lib subpath == server re-export)', () => {
  it('agree byte-for-byte across a grid of ranges, stakes, and edges', () => {
    for (const stake of [1000, 777, 5000, 12345]) {
      for (const n of [2, 4, 6, 100]) {
        for (let lo = 0; lo < n; lo++) {
          for (let target = lo + 1; target <= n; target++) {
            for (const edge of [0, 250, 300]) {
              expect(libComputeHouseStake(stake, n, target, lo, edge)).toBe(
                computeHouseStake(stake, n, target, lo, edge),
              )
            }
          }
        }
      }
    }
  })
})

export {}
