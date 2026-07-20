/**
 * Bound a promise so a stalled network/arkd/emulator call can't hang the caller —
 * and, via the shared submit funnel (`withArkSubmit`) and `selectionMutex`, the whole
 * money pipeline — indefinitely. The vendored SDK's arkd/emulator providers issue
 * plain `fetch`es with no AbortSignal (undici only bounds each phase at ~300s), so a
 * black-holed request otherwise wedges every game's money operation. Bounding it here
 * lets a genuinely stalled call REJECT (fail fast, free the funnel) instead.
 */

/** Reject with a labelled timeout after `ms`. Always observes `p` (no unhandled
 *  rejection) and clears the timer. */
export function timeoutReject<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** arkd offchain submit/finalize — normally seconds; generous headroom over a full
 *  batch session (~60s) so a legit-but-slow round isn't aborted, but bounded so a
 *  wedged arkd can't stall every game through `withArkSubmit`. Env-overridable. */
export const ARK_SUBMIT_TIMEOUT_MS = Number(process.env.ARK_SUBMIT_TIMEOUT_MS ?? 90_000)
/** A house-wallet `getVtxos` re-sync — seconds normally; bounded so a stalled sync
 *  can't wedge `/play` (which awaits it, historically under selectionMutex). */
export const ARK_SYNC_TIMEOUT_MS = Number(process.env.ARK_SYNC_TIMEOUT_MS ?? 45_000)
