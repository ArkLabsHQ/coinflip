import { describe, it, expect } from 'vitest'
import { getErrorMessage, friendlyError } from './errors'

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

// ---------------------------------------------------------------------------
// friendlyError — rewrite the handful of raw arkd errors that are scary and
// meaningless to a player into a plain-English explanation. Everything else
// passes through verbatim; the full raw text always survives in the diagnostics
// log regardless (diagnosticsLog.ts).
// ---------------------------------------------------------------------------

describe('friendlyError', () => {
  it('explains INVALID_VTXO_SCRIPT as auto-recovering / no action needed', () => {
    const raw =
      'INVALID_VTXO_SCRIPT (10): invalid vtxo script: fc961d763cca9abc73d4b88efcb8f5e7ff92dc55e9aa553d since 2026-06-21T00:00:00Z'
    const out = friendlyError(raw)
    expect(out).not.toBe(raw)
    expect(out).toMatch(/automatically|no action/i)
  })

  it('matches the lowercase "invalid vtxo script" phrasing too', () => {
    expect(friendlyError('rebuild failed: invalid vtxo script for input 0')).toMatch(/no action/i)
  })

  it('passes an unrecognized message through unchanged', () => {
    expect(friendlyError('some other error')).toBe('some other error')
  })
})
