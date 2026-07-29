import { describe, it, expect } from 'vitest'
import { winPctOf, roundWinPct, formatWinPct, nearestRungByWinPct, type Rung } from './rungSnap'

// Strictly decreasing win chance, like the real coin ladder: 50 / 25 / 12.5 / 6.25.
const LADDER: Rung[] = [
  { n: 2, lo: 0, target: 1 },
  { n: 4, lo: 0, target: 1 },
  { n: 8, lo: 0, target: 1 },
  { n: 16, lo: 0, target: 1 },
]

describe('winPctOf', () => {
  it('is the win band over the range, as a percentage', () => {
    expect(winPctOf({ n: 2, lo: 0, target: 1 })).toBe(50)
    expect(winPctOf({ n: 37, lo: 25, target: 37 })).toBeCloseTo(32.4324, 3)
  })
})

describe('roundWinPct', () => {
  it('gives whole numbers at 10 and above, one decimal below', () => {
    expect(roundWinPct(32.4324)).toBe(32)
    expect(roundWinPct(10)).toBe(10)
    expect(roundWinPct(4.53)).toBe(4.5)
    expect(roundWinPct(2.7027)).toBe(2.7)
  })
})

describe('formatWinPct', () => {
  it('formats using the same rounding rule', () => {
    expect(formatWinPct({ n: 2, lo: 0, target: 1 })).toBe('50%')
    expect(formatWinPct({ n: 100, lo: 0, target: 12 })).toBe('12%')
    expect(formatWinPct({ n: 1000, lo: 0, target: 45 })).toBe('4.5%')
  })
})

describe('nearestRungByWinPct', () => {
  it('returns the exact rung when the percentage lands on one', () => {
    expect(nearestRungByWinPct(LADDER, 0, 3, 25)).toBe(1)
  })

  it('returns the nearest rung when the percentage falls between two', () => {
    expect(nearestRungByWinPct(LADDER, 0, 3, 30)).toBe(1) // 30 is nearer 25 than 50
    expect(nearestRungByWinPct(LADDER, 0, 3, 45)).toBe(0) // 45 is nearer 50 than 25
  })

  it('prefers the SAFER rung on an exact tie', () => {
    // 37.5 is equidistant from 50 (index 0) and 25 (index 1).
    expect(nearestRungByWinPct(LADDER, 0, 3, 37.5)).toBe(0)
  })

  it('clamps to the WINDOW ends, not the ladder ends', () => {
    // 99% is off the top of the ladder, but index 0 is outside the window.
    expect(nearestRungByWinPct(LADDER, 1, 3, 99)).toBe(1)
    // 0% is off the bottom, but index 3 is outside the window.
    expect(nearestRungByWinPct(LADDER, 0, 2, 0)).toBe(2)
  })

  it('tolerates a window wider than the ladder', () => {
    expect(nearestRungByWinPct(LADDER, -5, 99, 99)).toBe(0)
    expect(nearestRungByWinPct(LADDER, -5, 99, 0)).toBe(3)
  })

  it('returns loIndex when the window is empty', () => {
    expect(nearestRungByWinPct(LADDER, 2, 1, 50)).toBe(2)
  })

  it('returns 0 for an empty ladder rather than throwing', () => {
    expect(nearestRungByWinPct([], 0, 0, 50)).toBe(0)
  })
})
