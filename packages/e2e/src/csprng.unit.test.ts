/**
 * Deterministic unit tests for CSPRNG-based uniform integer selection (no regtest).
 *
 * The house's coin side and the variable-odds digit are revealed at settlement.
 * Deriving them from `Math.random()` — a non-crypto PRNG whose state is
 * recoverable from observed outputs — would let a player predict and match the
 * next house pick. These tests pin that `randomUniformInt` (the version-neutral
 * selector relocated into game-math) stays in range, covers the full [0, n)
 * span, and never touches `Math.random`.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUniformInt } = require('arkade-coinflip/dist/game-math.js')

describe('randomUniformInt (CSPRNG uniform in [0, n))', () => {
  it('returns 0 for n === 1', () => {
    expect(randomUniformInt(1)).toBe(0)
  })

  it('rejects non-positive / non-integer n', () => {
    expect(() => randomUniformInt(0)).toThrow()
    expect(() => randomUniformInt(-3)).toThrow()
    expect(() => randomUniformInt(2.5)).toThrow()
  })

  it('stays within [0, n) and eventually covers every value', () => {
    for (const n of [2, 6, 37, 256, 257]) {
      const seen = new Set<number>()
      for (let i = 0; i < n * 40; i++) {
        const r = randomUniformInt(n)
        expect(r).toBeGreaterThanOrEqual(0)
        expect(r).toBeLessThan(n)
        expect(Number.isInteger(r)).toBe(true)
        seen.add(r)
      }
      expect(seen.size).toBe(n) // full coverage over many draws
    }
  })

  it('never calls Math.random', () => {
    const spy = jest.spyOn(Math, 'random')
    try {
      for (let i = 0; i < 100; i++) randomUniformInt(6)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('is roughly uniform (chi-square sanity, not a strict statistical test)', () => {
    const n = 6, draws = 6000
    const counts = new Array(n).fill(0)
    for (let i = 0; i < draws; i++) counts[randomUniformInt(n)]++
    const expected = draws / n
    // Each bucket within ±25% of expected — loose enough to (almost) never flake,
    // tight enough to catch a stuck/biased generator.
    for (const c of counts) {
      expect(c).toBeGreaterThan(expected * 0.75)
      expect(c).toBeLessThan(expected * 1.25)
    }
  })
})

export {}
