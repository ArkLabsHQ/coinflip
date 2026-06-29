/**
 * Unit tests for the in-memory fixed-window RateLimiter used by the restore
 * routes. Time is injected (allow(key, nowMs)) so the over-limit boundary and
 * the window roll-over are deterministic — no real clock, no sleeps. No regtest.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { RateLimiter } = require('arkade-coinflip-server/dist/rate-limit.js')

describe('RateLimiter', () => {
  it('allows up to `limit` hits per window, then rejects', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 })
    const t = 10_000 // mid-window
    expect(rl.allow('k', t)).toBe(true)
    expect(rl.allow('k', t)).toBe(true)
    expect(rl.allow('k', t)).toBe(true)
    expect(rl.allow('k', t)).toBe(false) // 4th in the same window
    expect(rl.allow('k', t + 50)).toBe(false) // still the same window
  })

  it('resets when the window rolls over', () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1000 })
    expect(rl.allow('k', 1000)).toBe(true)
    expect(rl.allow('k', 1500)).toBe(true)
    expect(rl.allow('k', 1999)).toBe(false) // window [1000,2000) exhausted
    expect(rl.allow('k', 2000)).toBe(true) // next window opens
    expect(rl.allow('k', 2500)).toBe(true)
    expect(rl.allow('k', 2600)).toBe(false)
  })

  it('tracks keys independently', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 })
    expect(rl.allow('a', 0)).toBe(true)
    expect(rl.allow('b', 0)).toBe(true) // different key, own budget
    expect(rl.allow('a', 0)).toBe(false)
    expect(rl.allow('b', 0)).toBe(false)
  })

  it('prunes stale keys once their window has passed', () => {
    const rl = new RateLimiter({ limit: 5, windowMs: 1000 })
    // Fill three distinct keys in window 0.
    rl.allow('a', 0)
    rl.allow('b', 0)
    rl.allow('c', 0)
    expect(rl.size).toBe(3)
    // A hit in a LATER window triggers the prune of the window-0 entries; only
    // the new key remains.
    rl.allow('d', 5000)
    expect(rl.size).toBe(1)
  })

  it('rejects non-positive construction params', () => {
    expect(() => new RateLimiter({ limit: 0, windowMs: 1000 })).toThrow()
    expect(() => new RateLimiter({ limit: 5, windowMs: 0 })).toThrow()
    expect(() => new RateLimiter({ limit: -1, windowMs: 1000 })).toThrow()
  })
})

export {}
