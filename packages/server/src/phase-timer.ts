/**
 * Phase timing for request handlers.
 *
 * The flip's cost was only ever visible from the OUTSIDE — a browser HAR showed
 * `/api/v4/play` taking seconds, but not which of its legs. Narrowing it meant
 * reading the handler and reasoning about which `await` looked expensive, which
 * is how a wrong attribution slips in: the `/api/tiers` fix turned out to
 * account for the whole of an improvement that had been credited partly to a
 * second change, and only a measurement showed it.
 *
 * So this makes the breakdown a fact the server reports rather than something
 * inferred later. It is deliberately tiny: a monotonic clock, a list of
 * (label, ms) marks, and one log line.
 */

/** Only emit the per-phase line when a request is slow enough to care about. */
export const PHASE_LOG_THRESHOLD_MS = Number(process.env.PHASE_LOG_THRESHOLD_MS || 750)

/** Set PHASE_TIMING=off to silence the breakdown entirely. */
const ENABLED = (process.env.PHASE_TIMING || 'on').toLowerCase() !== 'off'

export interface PhaseTimer {
  /** Close the current phase and open `label`. */
  mark(label: string): void
  /** Time an awaited step as its own phase, preserving its result and errors. */
  step<T>(label: string, fn: () => Promise<T>): Promise<T>
  /** Total elapsed so far, ms. */
  elapsed(): number
  /** "total=3451ms play=2980 select=310 …", slowest phase first. */
  summary(): string
  /**
   * Log the breakdown if the request was slow (or `force`). Returns the total so
   * callers can attach it to their own logging.
   */
  done(force?: boolean): number
}

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

/**
 * Start timing. `tag` prefixes the log line, e.g. "v4/play".
 *
 * Phases are closed implicitly: each `mark`/`step` ends the previous one, so a
 * handler never has to pair start/stop calls and cannot leak an unclosed phase
 * down an early-return or throw path.
 */
export function startPhaseTimer(tag: string, context = ''): PhaseTimer {
  const t0 = now()
  let last = t0
  let open: string | null = null
  const marks: Array<[string, number]> = []

  const close = () => {
    if (open !== null) {
      const t = now()
      marks.push([open, t - last])
      last = t
    }
  }

  const timer: PhaseTimer = {
    mark(label: string) {
      close()
      open = label
      if (open !== null && marks.length === 0) last = now()
    },
    async step<T>(label: string, fn: () => Promise<T>): Promise<T> {
      timer.mark(label)
      try {
        return await fn()
      } finally {
        close()
        open = null
      }
    },
    elapsed: () => now() - t0,
    summary() {
      close()
      open = null
      const total = now() - t0
      const parts = [...marks]
        .sort((a, b) => b[1] - a[1])
        .map(([l, ms]) => `${l}=${ms.toFixed(0)}`)
      return `total=${total.toFixed(0)}ms ${parts.join(' ')}`
    },
    done(force = false) {
      const total = now() - t0
      if (ENABLED && (force || total >= PHASE_LOG_THRESHOLD_MS)) {
        console.log(`[timing] ${tag}${context ? ' ' + context : ''} ${timer.summary()}`)
      }
      return total
    },
  }
  return timer
}
