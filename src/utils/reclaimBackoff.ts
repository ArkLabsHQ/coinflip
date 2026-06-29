/**
 * Auto-claim back-off policy. Lives in a zero-dependency module (like
 * `stashPrune`) so it's unit-testable without the SDK / IndexedDB / vuex.
 *
 * Why this exists: `runAutoClaim` re-submits a stash's stashed refund/forfeit on
 * every tick AND every reconnect. For a game whose stashed PSBT no longer matches
 * the Arkade Service's VTXO — e.g. a pre-v4 escrow (the v4 joint-pot redesign
 * landed after the game was created) or an escrow stranded by a server signer
 * rotation — the submit fails with the SAME script mismatch forever. The stake
 * still recovers via the operator's batch sweep, but the cooperative reclaim is
 * dead, so retrying it just spams `/v1/tx/submit` with `400`s. This back-off
 * stops that after a few attempts.
 */

/**
 * After this many PERMANENT auto-claim failures, stop re-submitting a refund/
 * forfeit that can never succeed. Small so the noise dies quickly; the stake is
 * unaffected (it recovers via the sweep, not the reclaim).
 */
export const MAX_RECLAIM_ATTEMPTS = 3

/**
 * True for an auto-claim error that will NOT change on retry: the submitted
 * PSBT's input doesn't match the Service's VTXO (a stale/wrong escrow script —
 * a pre-v4 or rotated-signer escrow). Distinct from transient failures
 * (network, or a `*_LOCKED` / "not reclaimable yet" CLTV-timing race), which
 * auto-claim SHOULD keep retrying.
 */
export function isPermanentReclaimError(msg: string): boolean {
  return /INVALID_PSBT_INPUT|witness utxo script mismatch/i.test(msg)
}

/**
 * Whether a stash has exhausted its permanent-failure budget and should be
 * skipped by auto-claim. `claimFailures` only counts PERMANENT failures.
 */
export function hasExhaustedReclaim(claimFailures: number | undefined): boolean {
  return (claimFailures ?? 0) >= MAX_RECLAIM_ATTEMPTS
}
