/**
 * Deterministic unit tests for computeGameRoll — the display roll the /details
 * endpoint echoes for a terminal v3/v4 game. Reveals are `[digit] || salt`
 * (packets.encodeReveal), so byte 0 is the digit; roll = (dHouse + dPlayer) mod n,
 * or null when a secret is missing/malformed or a digit is out of [0, n) (the
 * cheat-penalty path). No regtest. Mirrors handleV4Reveal's computation.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
export {} // module scope: avoid TS2451 cross-file const redeclare under CI's fresh ts-jest compile
const { computeGameRoll } = require('arkade-coinflip-server/dist/trustless-game-v4.js')

/** `[digit] || salt` reveal as hex; salt is irrelevant to the roll, so keep it short. */
const reveal = (digit: number, salt = 'aabb') => digit.toString(16).padStart(2, '0') + salt

describe('computeGameRoll (terminal v3/v4 display roll)', () => {
  it('coin (n defaults to 2): (dHouse + dPlayer) mod 2', () => {
    expect(computeGameRoll(reveal(1), reveal(1), null)).toBe(0) // (1+1)%2
    expect(computeGameRoll(reveal(0), reveal(1), null)).toBe(1) // (0+1)%2
    expect(computeGameRoll(reveal(1), reveal(0), 2)).toBe(1) // explicit n=2
    expect(computeGameRoll(reveal(0), reveal(0), 2)).toBe(0)
  })

  it('variable odds: (dHouse + dPlayer) mod n', () => {
    expect(computeGameRoll(reveal(55), reveal(30), 100)).toBe(85) // (55+30)%100
    expect(computeGameRoll(reveal(70), reveal(70), 100)).toBe(40) // wraps: 140%100
  })

  it('null when a secret is missing (pre-terminal / not stored)', () => {
    expect(computeGameRoll(null, reveal(1), 2)).toBeNull()
    expect(computeGameRoll(reveal(1), null, 2)).toBeNull()
    expect(computeGameRoll(null, null, 2)).toBeNull()
  })

  it('null when a digit is out of [0, n) (cheat-penalty decided the winner)', () => {
    expect(computeGameRoll(reveal(5), reveal(1), 2)).toBeNull() // house digit 5 ≥ n=2
    expect(computeGameRoll(reveal(1), reveal(9), 2)).toBeNull() // player digit 9 ≥ n=2
  })

  it('null on malformed hex (never throws)', () => {
    expect(computeGameRoll('nothex', 'nothex', 2)).toBeNull()
  })
})
