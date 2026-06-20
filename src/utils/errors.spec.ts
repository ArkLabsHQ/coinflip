import { describe, it, expect } from 'vitest'
import { getErrorMessage } from './errors'

// ---------------------------------------------------------------------------
// getErrorMessage — the one idiom this codebase reaches for in every catch:
// "show the Error's message, but degrade gracefully for whatever else got
// thrown" (strings, numbers, null, plain objects — JS lets you throw anything).
// It was hand-inlined ~13 times as `e instanceof Error ? e.message : ...` with
// two subtly different tails (`String(e)` vs bare `e`); centralising it makes
// the policy uniform and the call sites readable.
// ---------------------------------------------------------------------------

describe('getErrorMessage', () => {
  it('returns the message of a real Error', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('returns the message of an Error subclass', () => {
    class HttpError extends Error {}
    expect(getErrorMessage(new HttpError('404 not found'))).toBe('404 not found')
  })

  it('stringifies a thrown string', () => {
    expect(getErrorMessage('plain string failure')).toBe('plain string failure')
  })

  it('stringifies a thrown number', () => {
    expect(getErrorMessage(503)).toBe('503')
  })

  it('renders null and undefined without throwing', () => {
    expect(getErrorMessage(null)).toBe('null')
    expect(getErrorMessage(undefined)).toBe('undefined')
  })

  it('stringifies a non-Error object (no message leakage of [object Object] surprises)', () => {
    expect(getErrorMessage({ code: 1 })).toBe('[object Object]')
  })
})
