/**
 * v0.4 SELF-REFUND — the player's covenant-only reclaim of their OWN stake from a
 * stalled joint pot, used by the actionable-restore recovery path.
 *
 * WHAT THIS IS (and how it differs from the staged forfeit):
 *   The joint-pot taptree carries a `cooperativeSpend` leaf —
 *   `CLTVMultisig[server, emu_tweaked(splitTo)]` @ `cancelDelay` — that splits the
 *   pot back to BOTH funders' payout scripts (player stake → player, house stake →
 *   house). It is COVENANT-ONLY: the leaf has NO player key, so the player signs
 *   NOTHING. The emulator co-signs its tweaked slot only for a correctly-split tx,
 *   and arkd co-signs the `server` slot — exactly like the server's own
 *   `broadcastV4Refund` (trustless-game-v4.ts), which builds this same tx and POSTs
 *   it with no pre-signing. So the client submission is POST-ONLY too.
 *
 *   The staged forfeit (`claimV4Forfeit`) instead sweeps the WHOLE pot via the
 *   playerReveal → playerTakeAll leaves, which DO carry the player key and REQUIRE
 *   the player's secret as an on-chain SHA256 witness. A RESTORED game (re-armed from
 *   a server `reclaimHint`) has no secret — the server never holds the take-the-pot
 *   key — so it can only ever self-refund its own stake here.
 *
 * WHY THE GATE IS cancelDelay, NOT finalExpiration:
 *   arkd enforces the `cooperativeSpend` CLTV (`cancelDelay`) against the chain's
 *   median-time-past; the split-back cannot confirm before it. `finalExpiration`
 *   (> cancelDelay) gates the take-all leaf, NOT this one. The caller gates on
 *   chain-time ≥ cancelDelay (mirroring the server reconcile + the v3 refund gate).
 *
 * WHY A SEPARATE, MOSTLY-PURE MODULE (mirrors v4ForfeitStash.ts):
 *   The tx construction + the secret/no-secret branch are the security-critical,
 *   deterministic parts. Isolating them here lets a unit test build the refund from a
 *   fixture covenant and assert the branch — without the SDK wallet / network the
 *   full claim action needs (see v4SelfRefund.spec.ts).
 */

import { hex } from '@scure/base'
import { CSVMultisigTapscript } from '@arkade-os/sdk'
// Subpath imports (not the package root) so the browser bundle doesn't pull in the
// v2 transactions module, which imports Node's `crypto` — same reasoning as ark.ts.
import { buildJointPotRefundTx, type BuiltJointPotTx } from 'arkade-coinflip/dist/joint-pot-tx'
import { CoinflipJointPotScript } from 'arkade-coinflip/dist/joint-pot'
import type { V4CovenantParams, V4ReclaimHint } from '@/services/api'
import type { StashedV4Forfeit, V4PotOutpoint } from './v4ForfeitStash'

/**
 * Reconstruct the joint-pot covenant from its persisted (hex) params — the SINGLE
 * place the client rebuilds `CoinflipJointPotScript`, shared by the self-refund here
 * and the staged-forfeit claim. Mirrors the server's `rebuildCovenant`
 * (trustless-game-v4.ts) field-for-field so the rebuilt taptree (hence the pot
 * address arkd pins) is identical to the one the pot was funded at.
 */
export function rebuildJointPot(cv: V4CovenantParams): CoinflipJointPotScript {
  return new CoinflipJointPotScript({
    creatorPubkey: hex.decode(cv.creatorPubkey),
    playerPubkey: hex.decode(cv.playerPubkey),
    serverPubkey: hex.decode(cv.serverPubkey),
    creatorHash: hex.decode(cv.creatorHash),
    playerHash: hex.decode(cv.playerHash),
    finalExpiration: BigInt(cv.finalExpiration),
    cancelDelay: BigInt(cv.cancelDelay),
    exitDelay: BigInt(cv.exitDelay),
    oddsN: cv.oddsN,
    oddsTarget: cv.oddsTarget,
    oddsLo: cv.oddsLo,
    emulatorPubkey: hex.decode(cv.emulatorPubkey),
    playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
    housePayoutPkScript: hex.decode(cv.housePayoutPkScript),
    playerStake: BigInt(cv.playerStake),
    houseStake: BigInt(cv.houseStake),
  })
}

/**
 * Does this emulator/arkd rejection mean the pot is ALREADY SPENT — i.e. the game
 * was already refunded/settled, so our self-refund is a no-op? Used ONLY by the
 * self-refund path to fail SAFE: a restored game the server's refund timer already
 * split back must be treated as success (clear the stash), never retried into a
 * `/v1/tx` spam loop. The split-back pays the player's OWN payout script, so "spent"
 * here means our stake is already home.
 *
 * Deliberately NARROW — only spent/missing-input signals, NOT a generic error — so a
 * transient emulator/arkd hiccup keeps the stash for a retry instead of dropping a
 * still-live recovery. Distinct from the v3 `cooperativeSpend` CLTV-lock messages
 * ("locked"/"too early"), which mean "not yet" and must keep retrying.
 */
export function isAlreadySpentError(msg: string): boolean {
  return /already spent|VTXO_ALREADY_SPENT|not found|VTXO_NOT_FOUND|already been spent|missing input|input not found|unknown input|spent vtxo/i.test(
    msg,
  )
}

/**
 * Is this self-refund failure TRANSIENT — worth retrying next tick rather than
 * counting toward the permanent-failure back-off? The covenant-only refund tx is
 * fully deterministic from the stash, so the only non-permanent reasons it fails are:
 *   - the CLTV (cancelDelay) hasn't matured at the chain's MTP yet ("not reclaimable
 *     yet" / locked / locktime) — clears on a future block;
 *   - a network/connectivity blip reaching the emulator (fetch reject, timeout, 5xx).
 * Anything else (the emulator hard-rejecting a built split) will recur every tick, so
 * it is treated as permanent and backed off — never spam `/v1/tx`.
 *
 * NOTE: the "already spent" case is handled BEFORE this — that path clears the stash
 * as success, so it never reaches the back-off counter.
 */
export function isTransientSelfRefundError(msg: string): boolean {
  return /not reclaimable yet|locked|too early|cltv|locktime|timeout|timed out|network|failed to fetch|fetch failed|ECONN|socket|503|502|504|temporar/i.test(
    msg,
  )
}

/** Which recovery a v4 stash can drive at claim time. */
export type V4ClaimPath = 'forfeit' | 'self-refund'

/**
 * Pick the recovery path for a v4 stash: the staged FORFEIT (take the whole pot)
 * when we hold the player secret, else the covenant-only SELF-REFUND (reclaim our own
 * stake). A restored stash carries `playerSecretHex: null` and so always self-refunds.
 *
 * Treat empty-string as absent too, so a malformed `''` can never be fed to the
 * forfeit's on-chain SHA256 witness (which would publish a bogus preimage).
 */
export function pickV4ClaimPath(stash: Pick<StashedV4Forfeit, 'playerSecretHex'>): V4ClaimPath {
  return stash.playerSecretHex ? 'forfeit' : 'self-refund'
}

/**
 * Build the (unsigned-by-the-player) self-refund tx for a stash — the
 * `cooperativeSpend` split-back of the pot to both funders' payout scripts.
 *
 * Reconstructs the identical inputs the server's `broadcastV4Refund` passes to
 * `buildJointPotRefundTx`:
 *   - pot                  = rebuildJointPot(covenant)
 *   - cofund               = the stash's pot outpoint {txid, vout, value}
 *   - playerStake/houseStake = covenant.playerStake / covenant.houseStake
 *   - playerPayoutPkScript/housePayoutPkScript = covenant.*PayoutPkScript (hex→bytes)
 *   - serverUnroll         = the arkd checkpoint tapscript (passed in by the caller)
 *
 * `buildJointPotRefundTx` itself asserts `playerStake + houseStake === pot value`
 * (and both > 0), so a stash whose covenant stakes don't sum to the pot fails CLOSED
 * here rather than producing an unbalanced refund. The returned tx is POSTed to the
 * emulator as-is (no player signing — the leaf has no player slot).
 */
export function buildV4SelfRefund(
  stash: Pick<StashedV4Forfeit, 'covenant' | 'potOutpoint'>,
  serverUnroll: CSVMultisigTapscript.Type,
): BuiltJointPotTx {
  const cv = stash.covenant
  const pot = rebuildJointPot(cv)
  return buildJointPotRefundTx({
    pot,
    cofund: stash.potOutpoint,
    playerStake: BigInt(cv.playerStake),
    houseStake: BigInt(cv.houseStake),
    playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
    housePayoutPkScript: hex.decode(cv.housePayoutPkScript),
    serverUnroll,
  })
}

/** Why a restored v4 reclaim hint was NOT re-armed into a self-refund stash.
 *  Surfaced for logging; not an error (the server's own refund timer is the backstop).
 *  - `not-pending`     — the game isn't pending (resolved/expired → nothing to reclaim).
 *  - `incomplete`      — the hint lacks a complete covenant or pot outpoint.
 *  - `payout-mismatch` — the covenant pays an address that isn't this wallet.
 *  - `no-emulator`     — no emulator URL to POST the covenant-only refund to. */
export type V4RearmSkipReason = 'not-pending' | 'incomplete' | 'payout-mismatch' | 'no-emulator'

export type V4RearmDecision =
  | { kind: 'rearm'; stash: StashedV4Forfeit }
  | { kind: 'skip'; reason: V4RearmSkipReason }

/**
 * Convert a restored `V4ReclaimHint` (from GET /api/games) into a no-secret
 * SELF-REFUND stash — the actionable-restore re-arm. Fails CLOSED: only a pending
 * game with a complete covenant + pot outpoint, paying THIS wallet, with a reachable
 * emulator, is re-armed; anything else is skipped (the server's refund timer still
 * covers it). `playerSecretHex` is ALWAYS null — the server never holds the
 * take-the-pot key, so a restored game can only ever reclaim its own stake.
 *
 * @param hint                       The server-returned reclaim hint.
 * @param status                     The game's status from its history summary ('pending' to act).
 * @param expectedPayoutPkScriptHex  This wallet's payout pkScript (hex) — the covenant MUST pay it.
 * @param fallbackEmulatorUrl        Emulator URL to use when the hint omits one (the network's).
 */
export function rearmV4ReclaimHint(args: {
  hint: V4ReclaimHint
  status: string
  expectedPayoutPkScriptHex: string
  fallbackEmulatorUrl: string | undefined
}): V4RearmDecision {
  const { hint, status, expectedPayoutPkScriptHex, fallbackEmulatorUrl } = args

  // 1. Only a still-pending game has an unspent pot to reclaim. A resolved/expired
  //    game was already settled or refunded server-side.
  if (status !== 'pending') return { kind: 'skip', reason: 'not-pending' }

  // 2. Need a complete covenant AND a fully-specified pot outpoint (the server nulls
  //    txid/value before co-fund). Without both we cannot build the refund.
  const { covenant, potOutpoint } = hint
  if (
    !covenant ||
    !potOutpoint ||
    potOutpoint.txid == null ||
    potOutpoint.value == null
  ) {
    return { kind: 'skip', reason: 'incomplete' }
  }

  // 3. Anti-tamper (defense in depth — the server is the source, but IDB/network are
  //    not trust boundaries): only re-arm a pot that pays US. The claim re-asserts
  //    this too, but skipping here keeps a foreign pot out of the recovery UI entirely.
  if (covenant.playerPayoutPkScript !== expectedPayoutPkScriptHex) {
    return { kind: 'skip', reason: 'payout-mismatch' }
  }

  // 4. The covenant-only refund is POSTed to the emulator; without one it can't be
  //    co-signed. Prefer the hint's URL, fall back to the network's.
  const forfeitEmulatorUrl = hint.forfeitEmulatorUrl || fallbackEmulatorUrl
  if (!forfeitEmulatorUrl) return { kind: 'skip', reason: 'no-emulator' }

  const pot: V4PotOutpoint = { txid: potOutpoint.txid, vout: potOutpoint.vout, value: potOutpoint.value }
  return {
    kind: 'rearm',
    stash: {
      contractVersion: 'v4',
      gameId: hint.gameId,
      // The pot value isn't a "tier" exactly, but the StalledBets v4 row displays
      // potOutpoint.value, not tier — so any non-negative number is fine here.
      tier: 0,
      potOutpoint: pot,
      covenant,
      // SELF-REFUND gates on cancelDelay (the cooperativeSpend CLTV), but the stash's
      // forfeitClaimableAt field is the staged-forfeit CLTV; keep it = finalExpiration
      // for shape/parity with funded stashes. The claim + auto-claim read
      // covenant.cancelDelay directly for the self-refund gate, NOT this field.
      forfeitClaimableAt: hint.forfeitClaimableAt ?? covenant.finalExpiration,
      forfeitEmulatorUrl,
      // No secret on a restore — this is the whole reason it's self-refund-only.
      playerSecretHex: null,
      createdAt: Date.now(),
    },
  }
}
