import { describe, it, expect } from 'vitest'
import { isCltvMatured } from './cltv'

// ---------------------------------------------------------------------------
// isCltvMatured — has chain time reached an absolute CLTV (unix seconds)?
//
// This guards SECURITY-CRITICAL recovery paths: a refund or forfeit may only be
// submitted once its CLTV lock has opened. The two failure modes this centralises
// against are (1) forgetting the `chainTime === null` guard (we don't know the
// chain tip yet ⇒ NOT matured, never "assume ready"), and (2) an off-by-one at
// the boundary. The lock opens AT the value (>=), matching Bitcoin's CLTV
// semantics, so a tip exactly equal to the CLTV is mature.
// ---------------------------------------------------------------------------

describe('isCltvMatured', () => {
  it('is false when chain time is unknown (null) — never assume maturity without a tip', () => {
    expect(isCltvMatured(null, 1000)).toBe(false)
  })

  it('is false before the lock opens', () => {
    expect(isCltvMatured(999, 1000)).toBe(false)
  })

  it('is true exactly at the lock (>= semantics, no off-by-one)', () => {
    expect(isCltvMatured(1000, 1000)).toBe(true)
  })

  it('is true after the lock opens', () => {
    expect(isCltvMatured(1001, 1000)).toBe(true)
  })

  it('treats a zero chain tip as a real value, not as "unknown"', () => {
    expect(isCltvMatured(0, 0)).toBe(true)
    expect(isCltvMatured(0, 1)).toBe(false)
  })
})
