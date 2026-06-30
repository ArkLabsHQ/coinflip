/**
 * Concurrency-collapsed, TTL-cached, timeout-bounded wallet reads for the admin
 * dashboard.
 *
 * The dashboard polls `/api/status`, `/api/wallet`, `/api/vtxos`, and
 * `/api/wallet/history` on an interval. Each underlying SDK read
 * (`getBalance` / `getVtxos` / `getTransactionHistory`) forces a FULL re-sync of
 * the house's entire VTXO history — seconds of work for a long-lived house (see
 * `HouseVtxoCache` in vtxo-pool.ts). Uncached and uncollapsed, the polls stack
 * faster than they drain: requests pile up and the dashboard "loads forever".
 *
 * `collapsedTtlRead` wraps a read so that:
 *  - concurrent callers share a single in-flight fetch (no pile-up), and
 *  - a result younger than `ttlMs` is served from the snapshot (no re-sync per poll).
 * Each fetch is bounded by `timeoutMs` (`timeoutReject`) so a genuinely stalled
 * sync rejects — the endpoint returns an error — instead of hanging forever. A
 * failed (rejected or timed-out) fetch is NOT cached, so the next poll retries live.
 */

/** Reject with a labelled timeout after `ms`. Always observes `p` (no unhandled rejection) and clears the timer. */
export function timeoutReject<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Wrap `fetchFn` into a read that collapses concurrent calls onto one fetch,
 * serves a snapshot younger than `ttlMs`, and bounds each fetch by `timeoutMs`.
 * A rejected/timed-out fetch is not cached — the next call fetches live.
 */
export function collapsedTtlRead<T>(
  fetchFn: () => Promise<T>,
  ttlMs: number,
  timeoutMs: number,
  label: string,
): () => Promise<T> {
  let snapshot: { at: number; value: T } | null = null
  let inflight: Promise<T> | null = null
  return () => {
    if (snapshot && Date.now() - snapshot.at < ttlMs) return Promise.resolve(snapshot.value)
    if (inflight) return inflight
    inflight = timeoutReject(fetchFn(), timeoutMs, label)
      .then((value) => {
        snapshot = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}

/** How long an admin balance/history snapshot is reused before a fresh re-sync. */
export const ADMIN_WALLET_READ_TTL_MS = Number(process.env.ADMIN_WALLET_READ_TTL_MS || 10_000)

/** Caps a stalled SDK re-sync so an admin wallet read can't hang the request forever. */
export const ADMIN_WALLET_READ_TIMEOUT_MS = Number(process.env.ADMIN_WALLET_READ_TIMEOUT_MS || 30_000)
