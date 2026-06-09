import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyToClipboard } from './clipboard'

/**
 * Regression: navigator.clipboard.writeText only exists in a secure context
 * (HTTPS or localhost). Served to a phone over plain HTTP on a LAN IP it's
 * undefined, so copyToClipboard must fall back to document.execCommand. These
 * tests drive both branches by toggling the secure-context globals.
 */
describe('copyToClipboard', () => {
  const origClipboard = (navigator as any).clipboard
  const origExec = (document as any).execCommand

  beforeEach(() => {
    // jsdom doesn't implement execCommand; provide a spy returning success.
    (document as any).execCommand = vi.fn(() => true)
  })
  afterEach(() => {
    (navigator as any).clipboard = origClipboard
    ;(document as any).execCommand = origExec
    vi.restoreAllMocks()
  })

  function setSecureContext(secure: boolean) {
    Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true })
  }

  it('returns false for empty text without touching any API', async () => {
    const writeText = vi.fn()
    ;(navigator as any).clipboard = { writeText }
    setSecureContext(true)
    expect(await copyToClipboard('')).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('uses the modern clipboard API in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    ;(navigator as any).clipboard = { writeText }
    setSecureContext(true)
    expect(await copyToClipboard('tark1q...')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('tark1q...')
    expect(document.execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand in a NON-secure context (the LAN-IP bug)', async () => {
    // No navigator.clipboard at all (how non-secure contexts present it).
    (navigator as any).clipboard = undefined
    setSecureContext(false)
    expect(await copyToClipboard('bcrt1p...')).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back to execCommand when the modern API throws mid-write', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowed'))
    ;(navigator as any).clipboard = { writeText }
    setSecureContext(true)
    expect(await copyToClipboard('x')).toBe(true)
    expect(writeText).toHaveBeenCalled()
    expect(document.execCommand).toHaveBeenCalledWith('copy')
  })

  it('returns false (not throw) when both paths fail', async () => {
    (navigator as any).clipboard = undefined
    setSecureContext(false)
    ;(document as any).execCommand = vi.fn(() => { throw new Error('blocked') })
    expect(await copyToClipboard('x')).toBe(false)
  })
})
