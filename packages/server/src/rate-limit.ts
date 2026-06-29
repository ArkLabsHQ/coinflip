/**
 * In-memory fixed-window rate limiter.
 *
 * A counter per (key, window) where the window is `floor(now / windowMs)`. The
 * first `limit` hits in a window are allowed; the rest are rejected until the
 * window rolls over. Old windows are pruned lazily (and on a cheap periodic
 * sweep) so the map doesn't grow without bound.
 *
 * SCOPE: this is PER-PROCESS, not distributed. The coinflip house runs as a
 * single process, so a single in-memory limiter is the whole picture; if the
 * server is ever horizontally scaled this must move to a shared store (Redis,
 * etc.) or each replica will enforce the limit independently.
 *
 * Fixed-window (not sliding/token-bucket) is deliberate: it's the simplest thing
 * that bounds abuse of the restore endpoints, needs no new deps, and a burst at
 * a window boundary is harmless for read-only, signature-gated routes.
 */

export interface RateLimiterOptions {
  /** Max hits allowed per window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
}

export class RateLimiter {
  private readonly limit: number
  private readonly windowMs: number
  /** key -> { window index, count within that window } */
  private readonly hits = new Map<string, { window: number; count: number }>()
  private lastPrune = 0

  constructor(opts: RateLimiterOptions) {
    if (!(opts.limit > 0) || !(opts.windowMs > 0)) {
      throw new Error('RateLimiter: limit and windowMs must be positive')
    }
    this.limit = opts.limit
    this.windowMs = opts.windowMs
  }

  /**
   * Record a hit for `key` at `nowMs` and report whether it's within the limit.
   * Returns true if allowed, false if the key has already used its quota for the
   * current window.
   */
  allow(key: string, nowMs: number): boolean {
    const window = Math.floor(nowMs / this.windowMs)
    this.maybePrune(window)
    const entry = this.hits.get(key)
    if (!entry || entry.window !== window) {
      // New key, or a stale entry from a previous window — reset to this window.
      this.hits.set(key, { window, count: 1 })
      return true
    }
    if (entry.count >= this.limit) return false
    entry.count += 1
    return true
  }

  /** Drop entries whose window has passed. Runs at most once per window to keep
   *  `allow` O(1) amortized. */
  private maybePrune(currentWindow: number): void {
    if (currentWindow === this.lastPrune) return
    this.lastPrune = currentWindow
    for (const [key, entry] of this.hits) {
      if (entry.window < currentWindow) this.hits.delete(key)
    }
  }

  /** Test seam: number of tracked keys. */
  get size(): number {
    return this.hits.size
  }
}
