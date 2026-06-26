/** A single-flight-wrapped function: callable, plus an `active` flag. */
export interface SingleFlight<A extends unknown[], R> {
  (...args: A): Promise<R>;
  /** True while a run is in flight (no new run starts until it settles). */
  readonly active: boolean;
}

/**
 * Wrap an async function so concurrent callers SHARE one in-flight run instead of
 * each starting their own. While a run is pending, every call returns the same
 * promise; once it settles (resolve OR reject) the slot frees, so the next call
 * starts a fresh run. The first caller's arguments win. `active` reports whether a
 * run is in flight (e.g. so a poller can avoid re-attaching follow-up handlers).
 *
 * Used to serialize wallet settlement: the auto-settle (refreshBalance) and the
 * manual "Settle Into Ark" action must never run two concurrent rounds for the
 * same boarding UTXO — they register competing intents and the loser hangs.
 */
export function singleFlight<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>
): SingleFlight<A, R> {
  let inflight: Promise<R> | null = null;
  const run = ((...args: A): Promise<R> => {
    if (inflight) return inflight;
    inflight = fn(...args).finally(() => {
      inflight = null;
    });
    return inflight;
  }) as SingleFlight<A, R>;
  Object.defineProperty(run, "active", { get: () => inflight !== null });
  return run;
}
