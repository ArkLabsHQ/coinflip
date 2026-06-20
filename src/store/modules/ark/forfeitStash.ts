import type { ForfeitResponse } from '@/services/api'

// ---------------------------------------------------------------------------
// Forfeit-stash decision — the pure core of the R1 arkade-script recovery.
//
// WHAT THE FORFEIT IS:
//   Each trustless game escrows the player's stake and (lazily, at `/commit`)
//   the house's stake into a shared Taproot tree. One leaf of that tree — the
//   `playerForfeit` leaf — is a CLTV-gated, emulator-co-signed covenant that
//   authorizes the PLAYER to atomically sweep BOTH stakes (the full pot) to
//   their own payout address once chain time crosses `forfeitClaimableAt`
//   (== the game's finalExpiration), with NO cooperation from the operator.
//
//   It is the recovery of last resort for exactly one bad state: the house
//   funded its escrow at the start of `/commit`, but the covenant sweep that
//   settles the game never landed. The pot is real, sitting in the joint
//   escrow, and the player — who already revealed — is entitled to it.
//
// WHY A PURE FUNCTION (and why it lives apart from the Vuex action):
//   The play flow (`playTrustlessGame`) is a large, SDK-and-network-bound
//   action that is impractical to unit-test directly. The SECURITY-CRITICAL
//   part of stashing a forfeit, however, is a small, pure decision:
//
//     1. Is there even an emulator? (No emulator ⇒ no covenant co-signer ⇒
//        the forfeit leaf can never be exercised ⇒ nothing to stash.)
//     2. Did the server actually hand us a forfeit PSBT? Under lazy funding
//        the server REFUSES (no joint pot) until the house has escrowed at
//        `/commit`; the caller surfaces that refusal to us as `undefined`.
//     3. Does the forfeit pay OUR change address? A PSBT that would sweep the
//        pot to anyone else must NEVER be persisted as "our" recovery.
//
//   Extracting that decision here lets us prove all three guards with fast,
//   deterministic tests (see forfeitStash.spec.ts) instead of a regtest stack.
//
// TIMING (why the caller invokes this only after a `/commit` FAILURE):
//   The joint pot exists only transiently during `/commit` (house funds →
//   covenant sweep). A SUCCESSFUL commit resolves the game, so a forfeit is
//   moot. A FAILED commit is precisely when a funded-but-unswept pot can
//   linger — so that is when the caller probes `/forfeit` and feeds the result
//   here. Stashing eagerly cannot race the server's autonomous reconcile: the
//   forfeit's CLTV opens far in the future (finalExpiration), by which point a
//   healthy operator has long since re-settled and the stash has been cleared.
// ---------------------------------------------------------------------------

/**
 * The exact subset of a stashed-refund record that a forfeit stash writes.
 * Mirrors the optional forfeit fields on `StashedRefund` so the play action can
 * hand this straight to `patchStash` without restating the shape.
 */
export type ForfeitStashPatch = {
  /** Unsigned arkade-script forfeit-claim PSBT (sweeps both escrows → player). */
  forfeitPsbt: string
  /** Per-escrow checkpoint PSBTs the player co-signs alongside the claim. */
  forfeitCheckpoints: string[]
  /** Absolute CLTV (unix seconds) the forfeit becomes claimable at. */
  forfeitClaimableAt: number
  /** Emulator base URL the signed claim is submitted to (`/v1/tx`). */
  forfeitEmulatorUrl: string
  /** Player's game secret — needed to satisfy the leaf's hash condition. */
  playerSecretHex: string
}

/**
 * Why a forfeit was NOT stashed. Surfaced to the caller for logging; none of
 * these are errors — every one has a working fallback (the self-refund stash).
 *
 * - `no-emulator`     — server reports no emulator; the covenant can't be co-signed.
 * - `no-pot`          — server refused to build a forfeit (no joint pot exists yet).
 * - `payout-mismatch` — the forfeit would pay an address that isn't ours.
 */
export type ForfeitStashSkipReason = 'no-emulator' | 'no-pot' | 'payout-mismatch'

/** Discriminated result: either a patch to persist, or a typed skip reason. */
export type ForfeitStashDecision =
  | { kind: 'stash'; patch: ForfeitStashPatch }
  | { kind: 'skip'; reason: ForfeitStashSkipReason }

/**
 * Decide whether — and exactly how — to stash an arkade-script forfeit as the
 * trustless recovery for a game.
 *
 * The guards are checked in escalating order of specificity so the reported
 * reason is the MOST FUNDAMENTAL thing missing (no emulator is reported even
 * when the pot is also absent — see the spec). Returning a discriminated union
 * (rather than throwing) keeps this best-effort: the caller logs the skip and
 * relies on the always-present self-refund stash.
 *
 * @param args.emulatorUrl           Browser-reachable emulator URL, or undefined.
 * @param args.forfeit               The server's forfeit response, or undefined
 *                                   if the `/forfeit` call was refused/failed.
 * @param args.expectedPayoutAddress Our own change address — the forfeit MUST pay this.
 * @param args.playerSecretHex       The game secret, persisted into the stash.
 */
export function resolveForfeitStash(args: {
  emulatorUrl: string | undefined
  forfeit: ForfeitResponse | undefined
  expectedPayoutAddress: string
  playerSecretHex: string
}): ForfeitStashDecision {
  const { emulatorUrl, forfeit, expectedPayoutAddress, playerSecretHex } = args

  // 1. No covenant co-signer ⇒ the forfeit leaf is unspendable ⇒ nothing to do.
  if (!emulatorUrl) return { kind: 'skip', reason: 'no-emulator' }

  // 2. No PSBT means the server had no joint pot to sweep (the normal lazy-
  //    funding state before/at the moment the house escrows). Fall back to the
  //    self-refund of our own stake.
  if (!forfeit) return { kind: 'skip', reason: 'no-pot' }

  // 3. Anti-tamper: only persist a forfeit that pays US. Anything else is a
  //    mis-bound or malicious PSBT and must never become our "recovery".
  if (forfeit.payoutAddress !== expectedPayoutAddress) {
    return { kind: 'skip', reason: 'payout-mismatch' }
  }

  // 4. Valid: bind the PSBT + checkpoints + CLTV to the emulator we'll submit
  //    to and the secret that satisfies the leaf's hash condition.
  return {
    kind: 'stash',
    patch: {
      forfeitPsbt: forfeit.forfeitPsbt,
      forfeitCheckpoints: forfeit.forfeitCheckpoints,
      forfeitClaimableAt: forfeit.forfeitClaimableAt,
      forfeitEmulatorUrl: emulatorUrl,
      playerSecretHex,
    },
  }
}

/**
 * The structural fields a forfeit-claim needs, read off a stashed-refund record.
 * A loose subset of `StashedRefund` so this predicate can live apart from the
 * store (which owns the full type) without a circular import.
 */
export type ForfeitClaimable = {
  revealed?: boolean
  forfeitPsbt?: string
  forfeitCheckpoints?: string[]
  forfeitEmulatorUrl?: string
  forfeitClaimableAt?: number
}

/**
 * Does this stash hold a COMPLETE, revealed forfeit ready to be claimed?
 *
 * This is the single source of truth behind three call sites that previously
 * each hand-rolled a slightly different check: the StalledBets "Claim full pot"
 * button (`hasForfeit`), the `claimForfeit` action's precondition guard, and the
 * background auto-claim poll. Unifying them closes a real inconsistency — only
 * `claimForfeit` checked `forfeitCheckpoints`, so the other two could surface a
 * claim the action would then reject.
 *
 * NOTE: this is purely STRUCTURAL — it answers "is a forfeit stashed and
 * revealed?", NOT "is the CLTV mature yet?". The time gate (`chainTime >=
 * forfeitClaimableAt`) is a separate concern layered on by the auto-claim poll,
 * because the StalledBets button intentionally shows BEFORE maturity (greyed/
 * counting down) while auto-claim only fires once the lock opens.
 *
 * It is a TYPE GUARD: callers that pass the check may then read the forfeit
 * fields as defined (no `!` or re-checks), which is exactly what the
 * claimForfeit action and auto-claim poll rely on. The generic preserves the
 * caller's own record type (e.g. the full StashedRefund) in the narrowing.
 */
export function hasStashedForfeit<T extends ForfeitClaimable>(
  stash: T,
): stash is T & {
  revealed: true
  forfeitPsbt: string
  forfeitCheckpoints: string[]
  forfeitEmulatorUrl: string
  forfeitClaimableAt: number
} {
  return (
    stash.revealed === true &&
    !!stash.forfeitPsbt &&
    Array.isArray(stash.forfeitCheckpoints) && stash.forfeitCheckpoints.length > 0 &&
    !!stash.forfeitEmulatorUrl &&
    stash.forfeitClaimableAt !== undefined
  )
}
