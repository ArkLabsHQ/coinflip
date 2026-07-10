import { describe, it, expect, vi } from 'vitest'
import { withTimeout, TimeoutError, TIMEOUTS } from './withTimeout'

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'x')).resolves.toBe(42)
  })

  it('propagates a rejection from the wrapped promise (not a timeout)', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
  })

  it('rejects with a TimeoutError once ms elapses on a hung promise', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<number>(() => {}) // never settles
      const p = withTimeout(never, 5000, 'load activity')
      const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError)
      await vi.advanceTimersByTimeAsync(5000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('the timeout message names the label + whole seconds', async () => {
    vi.useFakeTimers()
    try {
      const p = withTimeout(new Promise<number>(() => {}), 3000, 'settle')
      const assertion = expect(p).rejects.toThrow(/settle timed out after 3s/)
      await vi.advanceTimersByTimeAsync(3000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire the timeout when the promise resolves first (timer cleared)', async () => {
    vi.useFakeTimers()
    try {
      await expect(withTimeout(Promise.resolve('ok'), 10_000, 'x')).resolves.toBe('ok')
      // Advancing past the ceiling must not produce an unhandled TimeoutError.
      await vi.advanceTimersByTimeAsync(20_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exposes sane default ceilings (settle the most generous)', () => {
    expect(TIMEOUTS.settle).toBeGreaterThanOrEqual(TIMEOUTS.api)
    expect(TIMEOUTS.api).toBeGreaterThan(0)
    expect(TIMEOUTS.emulator).toBeGreaterThan(0)
  })
})
