/** A queue: each task starts only after the previous one settles. */
export type SerialQueue = <T>(fn: () => Promise<T>) => Promise<T>

/**
 * Run tasks one at a time instead of together. Each waits for the previous to
 * settle (resolve OR reject), then runs, and every caller gets its OWN result.
 *
 * The sibling of `singleFlight`, for the opposite case: that one shares a run
 * between callers who all want the same thing, this one serialises callers who
 * want DIFFERENT things but must not overlap.
 *
 * Used for wallet settlement — `settle(undefined)` sweeps boarding inputs AND
 * preconfirmed VTXOs, so a boarding auto-settle and an offboard can select the
 * same coin, register competing intents, and leave the loser waiting for a
 * round it never joins. Queueing also means each task picks its coins when its
 * turn comes, so it sees what the previous round actually left behind.
 */
export function serialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    // then(fn, fn) — run whether the previous settled or failed, so one failure
    // never blocks the queue.
    const next = tail.then(fn, fn)
    // The stored tail swallows rejections so a failure can't poison later
    // callers; `next` is returned unswallowed, so THIS caller still sees it.
    tail = next.catch(() => {})
    return next
  }
}
