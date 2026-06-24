/**
 * Suppress repeated identical log lines so a sustained failure — e.g. an Ark
 * backend RPC outage hit on every recovery/renewal tick — doesn't spam the log.
 * Logs the first occurrence and any change to the message; re-logs an unchanged
 * message only after `heartbeatMs`, so an ongoing failure stays visible. Call
 * `clear(key)` when the operation succeeds, so the next failure logs fresh.
 *
 * Pure, with an injectable clock for testing. This gates only console OUTPUT —
 * the recovery/renewal RETRY cadence is untouched (reclaim still fires each tick).
 */
export interface LogDedup {
  /** true if `msg` should be logged for `key`; false to suppress a recent repeat. */
  shouldLog(key: string, msg: string): boolean
  /** Reset `key` (call on success) so its next message logs fresh. */
  clear(key: string): void
}

export function makeLogDedup(heartbeatMs = 5 * 60_000, now: () => number = Date.now): LogDedup {
  const last = new Map<string, { msg: string; at: number }>()
  return {
    shouldLog(key, msg) {
      const prev = last.get(key)
      const t = now()
      if (prev && prev.msg === msg && t - prev.at < heartbeatMs) return false
      last.set(key, { msg, at: t })
      return true
    },
    clear(key) {
      last.delete(key)
    },
  }
}
