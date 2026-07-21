/**
 * v4 concurrency primitives — the arkd submit funnel + per-game handler locks.
 *
 * These are the ONLY module-level mutable state in the v4 code. They live here as
 * single instances so every handler/reconcile module that imports them shares the
 * SAME serialization point (ES-module singletons); duplicating any of them would
 * silently break the funnel.
 */

import { KeyedMutex } from '../vtxo-pool.js'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Serialize the server's arkd submits/finalizes. Independent concurrent submits
 * race arkd's round assembly → a spurious INVALID_SIGNATURE that still consumes
 * the input (proven in v4-scale). The server is the single submit funnel, so one
 * in-process mutex around submitTx/finalizeTx is the natural serialization point.
 */
let arkSubmitLock: Promise<unknown> = Promise.resolve()
export function withArkSubmit<T>(fn: () => Promise<T>): Promise<T> {
  const run = arkSubmitLock.then(fn, fn)
  arkSubmitLock = run.catch(() => undefined)
  return run
}

// Per-game serialization for the multi-step read-check-act handlers. withArkSubmit
// only serializes the submit call itself; these guard the whole handler so two
// concurrent requests for the same game can't both pass the status/state check
// and both proceed (double co-fund submit, double settle).
export const cofundLocks = new KeyedMutex()
export const revealLocks = new KeyedMutex()
