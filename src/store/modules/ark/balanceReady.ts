/**
 * When is a zero balance REAL, as opposed to "the wallet hasn't loaded yet"?
 *
 * This matters because we force the wallet drawer open on a zero balance, and
 * a false positive puts a non-dismissible "fund me" panel in front of a user
 * who is already funded.
 *
 * A zero balance on its own can't answer it. `walletBalance` is a fully-formed
 * object with `settled: 0` before the vtxos sync, so a null check passes on a
 * balance that means nothing yet. The previous fix waited a fixed 2s for the
 * zero to "persist", which is a guess about how long a sync takes — and it lost
 * the race often enough that the drawer still popped open on load.
 *
 * The SDK does carry a causal answer. `IContractManager.getSyncState()` reports
 * sync freshness, and `getBalance()` drives a real sync on the way through
 * (`getVtxos` -> `getContractsWithVtxos` -> `syncContracts`), so the state read
 * straight after a completed `getBalance()` describes THAT sync.
 *
 * The catch is `mode` alone is not the signal. `getSyncState()` derives
 * `degraded` from the presence of a stored failure reason, so a manager that
 * has never synced at all reports `{ mode: "online", lastSyncedAt: undefined }`
 * — indistinguishable from healthy. Only `lastSyncedAt` is positive evidence:
 * it is written solely by `markSyncOnline()`, after a sync succeeds.
 *
 * Hence both conditions below.
 */

/** The shape we depend on from the SDK's `ContractSyncState`. */
export interface SyncSnapshot {
  mode: 'online' | 'degraded'
  /** Set only once a sync has actually succeeded. */
  lastSyncedAt?: number
}

/**
 * True when a sync has demonstrably completed and is not degraded — i.e. the
 * balance sitting alongside it can be believed, including when it reads zero.
 *
 * Returns false when the state is unavailable: an unknown sync is not a
 * confirmed one, and the failure mode we care about is claiming "you have no
 * funds" without proof.
 */
export function isSyncConfirmed(sync: SyncSnapshot | null | undefined): boolean {
  if (!sync) return false
  // `lastSyncedAt` is the load-bearing half: a never-synced manager still
  // reports mode "online" because no failure has been recorded against it.
  return sync.mode === 'online' && typeof sync.lastSyncedAt === 'number'
}
