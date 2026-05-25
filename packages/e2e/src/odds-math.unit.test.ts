/**
 * Deterministic unit tests for the variable-odds house-stake math (no regtest).
 * computeHouseStake decides how much the house escrows so payouts reflect the
 * odds with a fixed house edge — money math, so pin it down exactly.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { computeHouseStake } = require('arkade-coinflip-server/dist/trustless-game.js')

describe('computeHouseStake (variable-odds house stake with edge)', () => {
  it('fair (0 edge): house stakes playerStake·(n−target)/target', () => {
    expect(computeHouseStake(1000, 6, 1, 0)).toBe(5000) // 1-in-6 → 6x: stake 1000, win 6000
    expect(computeHouseStake(1000, 6, 3, 0)).toBe(1000) // 3-in-6 → 2x
    expect(computeHouseStake(1000, 2, 1, 0)).toBe(1000) // 1-in-2 → matches the symmetric coin
    expect(computeHouseStake(1000, 6, 5, 0)).toBe(200) // 5-in-6 → 1.2x
  })

  it('a house edge shaves the house stake (shorter-than-fair payout)', () => {
    expect(computeHouseStake(1000, 6, 1, 300)).toBe(4850) // 3% off 5000
    expect(computeHouseStake(1000, 6, 2, 300)).toBe(1940) // 3% off 2000
    // The edge always reduces vs. fair.
    expect(computeHouseStake(1000, 6, 1, 300)).toBeLessThan(computeHouseStake(1000, 6, 1, 0))
  })

  it('floors to an integer (no fractional sats)', () => {
    // 1000·1·9700 / (3·10000) = 323.33… → 323
    expect(computeHouseStake(1000, 4, 3, 300)).toBe(323)
    expect(Number.isInteger(computeHouseStake(777, 6, 1, 250))).toBe(true)
  })

  it('scales linearly with the player stake', () => {
    expect(computeHouseStake(5000, 6, 1, 300)).toBe(5 * computeHouseStake(1000, 6, 1, 300))
  })
})
