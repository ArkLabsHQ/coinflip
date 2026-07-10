/**
 * Bound an awaited promise so a hung dependency can't freeze the UI forever.
 *
 * The client's money paths (play → co-fund → reveal, settle, send, claim) await
 * SDK / emulator / arkd calls whose loading + lock state is only cleared in a
 * `finally`. If the underlying call never settles (a dead connection, a stalled
 * emulator), that `finally` never runs — so the button sticks on "FLIPPING…" /
 * "Settling…" and, worse, single-flight and `claimingGames` locks wedge `true`
 * forever, disabling every retry until a page reload.
 *
 * `withTimeout` rejects after `ms` so the caller's `finally` runs, the lock
 * frees, and the error surfaces. It does NOT cancel the underlying work (a bare
 * promise has no cancel) — the call keeps running and settles harmlessly later;
 * `fetch` callers should prefer `AbortSignal.timeout` where they can, which
 * actually aborts the request.
 *
 * A `TimeoutError` (name set) lets callers distinguish "timed out" from a real
 * rejection when they want to word the message differently.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** Default ceilings (ms) for the client's awaited money-path calls. Generous
 *  enough never to trip a legitimately-slow call, tight enough to bound a hang. */
export const TIMEOUTS = {
  /** Server HTTP calls (play/co-fund/reveal chain to emulator→arkd server-side). */
  api: 60_000,
  /** Wallet settlement — waits for a batch swap to form, so the most generous. */
  settle: 120_000,
  /** Off-chain submit/finalize + send. */
  submit: 60_000,
  /** Direct client→emulator claim POSTs (server bounds its own at ~25s). */
  emulator: 45_000,
} as const

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${label} timed out after ${Math.round(ms / 1000)}s — please try again.`)),
      ms,
    )
  })
  // Clear the timer once the real promise settles so a resolved call doesn't
  // leave a dangling handle (and, under fake timers in tests, doesn't leak).
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}
