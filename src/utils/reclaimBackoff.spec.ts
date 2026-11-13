import { describe, it, expect } from 'vitest'
import { hasExhaustedReclaim, MAX_RECLAIM_ATTEMPTS } from './reclaimBackoff'

describe('hasExhaustedReclaim', () => {
  it('is false below the cap (incl. undefined / fresh stash)', () => {
    expect(hasExhaustedReclaim(undefined)).toBe(false)
    expect(hasExhaustedReclaim(0)).toBe(false)
    expect(hasExhaustedReclaim(MAX_RECLAIM_ATTEMPTS - 1)).toBe(false)
  })

  it('is true at/above the cap', () => {
    expect(hasExhaustedReclaim(MAX_RECLAIM_ATTEMPTS)).toBe(true)
    expect(hasExhaustedReclaim(MAX_RECLAIM_ATTEMPTS + 5)).toBe(true)
  })

  it('uses a small positive bound so the noise dies quickly', () => {
    expect(MAX_RECLAIM_ATTEMPTS).toBeGreaterThan(0)
    expect(MAX_RECLAIM_ATTEMPTS).toBeLessThanOrEqual(5)
  })
})
