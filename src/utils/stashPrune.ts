import type { StashedRefund } from '@/store/modules/ark/ark'

/**
 * Decide which stashes are safe to drop on load. Pure (no I/O, no imports with
 * runtime side-effects) so it's unit-testable without the IndexedDB adapter.
 * Consumed by `loadStashes` in stashStore.ts.
 *
 * Policy: a time-based grace measured FROM `finalExpiration`, plus a count cap.
 *
 * Grace is measured from finalExpiration, NOT createdAt. Both the refund and
 * playerForfeit leaves unlock AT finalExpiration (same absolute CLTV in
 * CoinflipEscrowScript), so that timestamp is when a stash becomes *claimable*,
 * not when it expires. Dropping at finalExpiration would evict a stash exactly
 * when it turns useful — the grace gives the 15s auto-claim loop ample time to
 * fire against the now-open window. A successful claim clears its own stash, so
 * any entry still here past `finalExpiration + grace` is one the auto-claim has
 * been *failing* to land (dead emulator, drifted arkd state); we give up on it
 * to stop the doomed-retry spam and reclaim space.
 *
 * Revealed stashes get a longer grace: they can sweep the full pot via the
 * forfeit leaf, vs an unrevealed stash only reclaiming the player's own stake —
 * higher-value recovery is worth holding onto longer.
 */
export function pruneOnLoad(stashes: StashedRefund[], nowSec: number): StashedRefund[] {
  const REVEALED_GRACE_SEC = 30 * 24 * 60 * 60   // 30 days
  const UNREVEALED_GRACE_SEC = 7 * 24 * 60 * 60  //  7 days
  // Catastrophic-growth backstop: even if the time filter misses an edge case
  // (e.g. a malformed finalExpiration), never let the set exceed this. Keep the
  // most-recently-created entries.
  const MAX_ENTRIES = 200

  const live = stashes.filter((s) => {
    // Defensive: a missing/insane finalExpiration shouldn't make a stash
    // immortal — treat it as expired-now so the count cap can reap it.
    if (!Number.isFinite(s.finalExpiration)) return false
    const grace = s.revealed === true ? REVEALED_GRACE_SEC : UNREVEALED_GRACE_SEC
    return nowSec < s.finalExpiration + grace
  })

  if (live.length <= MAX_ENTRIES) return live
  // Over the cap: keep the newest MAX_ENTRIES by createdAt (ms).
  return [...live].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ENTRIES)
}
