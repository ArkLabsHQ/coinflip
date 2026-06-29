import { describe, it, expect } from 'vitest'
import { isPermanentReclaimError, hasExhaustedReclaim, MAX_RECLAIM_ATTEMPTS } from './reclaimBackoff'

describe('isPermanentReclaimError', () => {
  it('flags a witness-utxo script mismatch (stale/wrong escrow) as permanent', () => {
    expect(
      isPermanentReclaimError(
        'INVALID_PSBT_INPUT (5): witness utxo script mismatch: expected 5120f874c24e…, got 5120eca20eb4…',
      ),
    ).toBe(true)
  })

  it('flags a bare INVALID_PSBT_INPUT as permanent', () => {
    expect(isPermanentReclaimError('INVALID_PSBT_INPUT (5): bad input')).toBe(true)
  })

  it('treats CLTV-timing / lock races as NOT permanent (keep retrying)', () => {
    expect(isPermanentReclaimError('FORFEIT_CLOSURE_LOCKED: is locked')).toBe(false)
    expect(isPermanentReclaimError("Not reclaimable yet — the timelock lifts at …")).toBe(false)
  })

  it('treats transient network errors as NOT permanent', () => {
    expect(isPermanentReclaimError('fetch failed')).toBe(false)
    expect(isPermanentReclaimError('400 Bad Request')).toBe(false)
  })
})

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
