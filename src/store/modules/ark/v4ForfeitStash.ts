import type { V4CovenantParams } from '@/services/api'

// ---------------------------------------------------------------------------
// v0.4 forfeit-stash decision — the pure core of the joint-pot recovery path.
//
// WHAT THE v4 FORFEIT IS:
//   A v0.4 game funds ONE joint-pot VTXO via an atomic two-party co-fund. The
//   pot's taptree carries a `playerForfeit` leaf: CLTVMultisig[player, arkd,
//   emu_tweaked(payTo(player, pot))]. Once chain time crosses the game's
//   `finalExpiration`, that leaf authorizes the PLAYER to sweep the WHOLE pot to
//   their own payout address with NO cooperation from the house operator —
//   only arkd + the emulator (both liveness parties) need to co-sign.
//
//   It is the recovery for exactly one bad state: the pot was co-funded, but the
//   server never settled it (crash, exhausted retries, malice). The win-settle
//   leaf is [arkd, emu] — the server settles UNILATERALLY long before
//   finalExpiration — so a losing player cannot stall to reach the forfeit
//   window. The window only opens if the SERVER fails.
//
// WHY v4 IS DIFFERENT FROM v3 (and gets its own type/store):
//   v3 stashes a SERVER-BUILT forfeit PSBT (from a /forfeit endpoint) plus a
//   player escrow. v4's claim is CLIENT-BUILT: `buildJointPotForfeitClaim`
//   reconstructs the pot from the covenant params and spends the playerForfeit
//   leaf locally. So the v4 stash persists the COVENANT PARAMS + the pot
//   outpoint + the CLTV — not a PSBT — and needs no `revealed` precondition
//   (the leaf is a bare payTo; it reads no secret).
//
// WHY A PURE FUNCTION (mirrors v3's resolveForfeitStash):
//   The play flow is SDK-and-network-bound and impractical to unit-test. The
//   security-critical part is a small, pure decision: is the covenant
//   co-signer reachable, and does the pot actually pay US? Extracting it here
//   lets us prove the guards deterministically (see v4ForfeitStash.spec.ts).
// ---------------------------------------------------------------------------

/** The pot outpoint shape (matches V4CofundFinalizeResponse.potOutpoint). */
export interface V4PotOutpoint {
  txid: string
  vout: number
  value: number
}

/**
 * A stashed v0.4 forfeit — everything the client needs to rebuild + submit the
 * playerForfeit claim with no server round-trip. Held in IDB per active game.
 */
export interface StashedV4Forfeit {
  contractVersion: 'v4'
  gameId: string
  /** Bet tier (sats) — for display parity with v3 stashes. */
  tier: number
  /** The co-funded joint pot. */
  potOutpoint: V4PotOutpoint
  /** Full covenant params — fed straight into CoinflipJointPotScript to rebuild
   *  the pot and its playerForfeit leaf at claim time. */
  covenant: V4CovenantParams
  /** Absolute CLTV (unix seconds) the forfeit becomes claimable at (==
   *  covenant.finalExpiration). */
  forfeitClaimableAt: number
  /** Emulator base URL the signed claim is POSTed to (`/v1/tx`). */
  forfeitEmulatorUrl: string
  /** Player's game secret (hex) — not needed for the collaborative
   *  playerForfeit leaf, but persisted for the unilateral playerForfeitExit
   *  backstop (which satisfies the leaf's hash condition). */
  playerSecretHex: string
  createdAt: number
}

/** The subset `resolveV4ForfeitStash` produces; the play action stamps `gameId`,
 *  `tier`, and `createdAt` and persists the whole `StashedV4Forfeit`. */
export type V4ForfeitStashPatch = Omit<StashedV4Forfeit, 'gameId' | 'tier' | 'createdAt'>

/**
 * Why a v4 forfeit was NOT stashed. Surfaced for logging; not an error.
 * - `no-emulator`     — no emulator URL; the covenant can't be co-signed/submitted.
 * - `payout-mismatch` — the covenant pays an address that isn't ours.
 */
export type V4ForfeitStashSkipReason = 'no-emulator' | 'payout-mismatch'

export type V4ForfeitStashDecision =
  | { kind: 'stash'; patch: V4ForfeitStashPatch }
  | { kind: 'skip'; reason: V4ForfeitStashSkipReason }

/**
 * Decide whether — and how — to stash a v0.4 joint-pot forfeit as the recovery
 * for a game, after the pot has been co-funded.
 *
 * @param args.emulatorUrl              Browser-reachable emulator URL, or undefined.
 * @param args.potOutpoint             The co-funded joint pot.
 * @param args.covenant                The covenant params from /api/v4/play.
 * @param args.expectedPayoutPkScriptHex  Our payout pkScript (hex) — the covenant MUST pay this.
 * @param args.playerSecretHex         The game secret, persisted into the stash.
 */
export function resolveV4ForfeitStash(args: {
  emulatorUrl: string | undefined
  potOutpoint: V4PotOutpoint
  covenant: V4CovenantParams
  expectedPayoutPkScriptHex: string
  playerSecretHex: string
}): V4ForfeitStashDecision {
  const { emulatorUrl, potOutpoint, covenant, expectedPayoutPkScriptHex, playerSecretHex } = args

  // 1. No covenant co-signer reachable ⇒ the forfeit leaf can't be exercised.
  if (!emulatorUrl) return { kind: 'skip', reason: 'no-emulator' }

  // 2. Anti-tamper: only persist a forfeit whose pot pays US. A covenant baked
  //    to anyone else must never become our "recovery".
  if (covenant.playerPayoutPkScript !== expectedPayoutPkScriptHex) {
    return { kind: 'skip', reason: 'payout-mismatch' }
  }

  // 3. Valid: bind the pot + covenant + CLTV to the emulator we'll submit to and
  //    the secret that satisfies the unilateral-exit leaf's hash condition.
  return {
    kind: 'stash',
    patch: {
      contractVersion: 'v4',
      potOutpoint,
      covenant,
      forfeitClaimableAt: covenant.finalExpiration,
      forfeitEmulatorUrl: emulatorUrl,
      playerSecretHex,
    },
  }
}

/**
 * Does this stash hold a structurally COMPLETE v4 forfeit ready to claim?
 * Purely structural (mirrors v3's hasStashedForfeit) — the CLTV maturity gate
 * (`chainTime >= forfeitClaimableAt`) is layered on separately by the claim/poll.
 * Note: NO `revealed` requirement — the playerForfeit leaf is a bare payTo.
 */
export function hasClaimableV4Forfeit(stash: Partial<StashedV4Forfeit>): stash is StashedV4Forfeit {
  return (
    stash.contractVersion === 'v4' &&
    !!stash.potOutpoint &&
    !!stash.covenant &&
    !!stash.forfeitEmulatorUrl &&
    stash.forfeitClaimableAt !== undefined
  )
}
