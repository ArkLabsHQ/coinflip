import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  logDiag,
  getDiagEntries,
  clearDiag,
  formatDiagnostics,
  installGlobalDiagnostics,
  DIAG_CAP,
} from './diagnosticsLog'

beforeEach(() => {
  localStorage.clear()
  clearDiag()
})

describe('logDiag / getDiagEntries', () => {
  it('appends entries oldest-first with level, tag, msg + a timestamp', () => {
    logDiag('error', 'settle', 'boom')
    logDiag('info', 'flip', 'ok')
    const e = getDiagEntries()
    expect(e).toHaveLength(2)
    expect(e[0]).toMatchObject({ level: 'error', tag: 'settle', msg: 'boom' })
    expect(e[1]).toMatchObject({ level: 'info', tag: 'flip', msg: 'ok' })
    expect(typeof e[0].t).toBe('number')
  })

  it('trims to the last DIAG_CAP entries', () => {
    for (let i = 0; i < DIAG_CAP + 25; i++) logDiag('info', 't', `m${i}`)
    const e = getDiagEntries()
    expect(e).toHaveLength(DIAG_CAP)
    expect(e[0].msg).toBe('m25') // oldest 25 dropped
    expect(e[e.length - 1].msg).toBe(`m${DIAG_CAP + 24}`)
  })

  it('truncates an oversized message so one dump cannot blow the buffer/quota', () => {
    logDiag('error', 't', 'x'.repeat(5000))
    expect(getDiagEntries()[0].msg.length).toBe(2000)
  })

  it('getDiagEntries returns a copy — a caller cannot mutate the buffer', () => {
    logDiag('info', 't', 'a')
    getDiagEntries().push({ t: 0, level: 'info', tag: 'x', msg: 'y' })
    expect(getDiagEntries()).toHaveLength(1)
  })
})

describe('persistence', () => {
  it('mirrors to localStorage and reloads on a fresh import', async () => {
    logDiag('error', 'settle', 'persisted!')
    expect(localStorage.getItem('coinflip_diag')).toContain('persisted!')

    vi.resetModules()
    const fresh = await import('./diagnosticsLog')
    expect(fresh.getDiagEntries().some((e) => e.msg === 'persisted!')).toBe(true)
  })

  it('clearDiag empties both the buffer and the mirror', () => {
    logDiag('info', 't', 'a')
    clearDiag()
    expect(getDiagEntries()).toEqual([])
    expect(JSON.parse(localStorage.getItem('coinflip_diag') || '[]')).toEqual([])
  })
})

describe('formatDiagnostics', () => {
  it('renders a header + entries as shareable text', () => {
    logDiag('error', 'settle', 'INVALID_VTXO_SCRIPT (10)')
    const out = formatDiagnostics({ version: '0.8.0', network: 'mutinynet' })
    expect(out).toContain('=== coinflip diagnostics ===')
    expect(out).toContain('version: 0.8.0')
    expect(out).toContain('network: mutinynet')
    expect(out).toMatch(/ERROR settle: INVALID_VTXO_SCRIPT \(10\)/)
  })
})

describe('installGlobalDiagnostics', () => {
  it('captures window error + unhandledrejection (and is idempotent)', () => {
    installGlobalDiagnostics()
    installGlobalDiagnostics() // a second call must NOT double-register the handlers

    window.dispatchEvent(new ErrorEvent('error', { message: 'kaboom' }))
    // jsdom may lack the PromiseRejectionEvent constructor — synthesize the shape.
    const rej = new Event('unhandledrejection') as Event & { reason?: unknown }
    rej.reason = new Error('rejected!')
    window.dispatchEvent(rej)

    const msgs = getDiagEntries().map((e) => e.msg)
    expect(msgs.filter((m) => m === 'kaboom')).toHaveLength(1) // once, not twice
    expect(msgs).toContain('rejected!')
  })
})
