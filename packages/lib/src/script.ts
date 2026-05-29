/**
 * CoinflipScript — extends VtxoScript to define the coinflip game tapscripts.
 *
 * Setup output has 2 leaves:
 *   - reveal: SHA256(creatorSecret) + player + creator + server multisig
 *   - abort: CLTV timeout + player + server multisig
 *
 * Final output has 3 leaves:
 *   - creatorWin: condition(secrets same size = false) + creator + server
 *   - playerWin: condition(secrets same size = true) + player + server
 *   - abort: CLTV timeout + creator + server (if player doesn't reveal)
 *
 * Escrow output (`CoinflipEscrowScript`) has 4 leaves: creatorWin, playerWin,
 * refund (owner-scoped CLTV self-refund), and playerPenalty (audit R1 forfeit
 * — ConditionCSVMultisigTapscript leaf: hash-check on the player's revealed
 * secret + relative CSV timelock + 2-of-2[player, server]; the player sweeps
 * both escrows after a stall using only their own secret).
 */

import { OP } from '@scure/btc-signer'
import { hex } from '@scure/base'
import {
  VtxoScript,
  ConditionMultisigTapscript,
  CLTVMultisigTapscript,
  TapLeafScript,
  arkade,
} from '@arkade-os/sdk'
import { buildForfeitArkadeScript } from './arkade-forfeit'

export interface CoinflipSetupOptions {
  creatorPubkey: Uint8Array
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  creatorHash: Uint8Array // SHA256 of creator's secret
  setupExpiration: bigint // absolute locktime for abort
}

export interface CoinflipFinalOptions {
  creatorPubkey: Uint8Array
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  creatorHash: Uint8Array
  playerHash: Uint8Array
  finalExpiration: bigint
}

/**
 * Build the SHA256 hash-check condition script used in the setup reveal leaf.
 * Stack expects: <creatorSecret>
 * Script: SHA256 <creatorHash> EQUAL
 *
 * Important: leave the EQUAL result on the stack — do NOT append OP_VERIFY.
 * `ConditionMultisigTapscript.encode(...)` appends its own VERIFY after the
 * condition script. Adding a second VERIFY here produces `... EQUAL VERIFY
 * VERIFY`, where the second VERIFY pops from an empty stack and arkd
 * rejects the spend with `INVALID_PSBT_INPUT: invalid vtxo scripts`.
 */
function buildHashCheckScript(hash: Uint8Array): Uint8Array {
  return new Uint8Array([
    OP.SHA256,
    0x20, // push 32 bytes
    ...hash,
    OP.EQUAL,
  ])
}

/**
 * Build the condition script that determines the coinflip winner.
 *
 * Stack expects: <creatorSecret> <playerSecret>
 * Result: pushes 0 if creator wins (different sizes), 1 if player wins (same sizes)
 *
 * The logic: validate both hashes, then compare sizes.
 * - Heads = 15 bytes, Tails = 16 bytes
 * - Same size = player wins (pushed 1 / true)
 * - Different size = creator wins (pushed 0 / false)
 */
function buildCoinflipConditionScript(
  creatorHash: Uint8Array,
  playerHash: Uint8Array
): Uint8Array {
  return new Uint8Array([
    // Stack: creatorSecret playerSecret
    OP['2DUP'],        // Stack: cS pS cS pS
    OP.SHA256,         // Stack: cS pS cS h(pS)
    0x20,              // push 32 bytes
    ...playerHash,     // push player's hash
    OP.EQUALVERIFY,    // verify h(pS) == playerHash. Stack: cS pS cS
    OP.SHA256,         // Stack: cS pS h(cS)
    0x20,              // push 32 bytes
    ...creatorHash,    // push creator's hash
    OP.EQUALVERIFY,    // verify h(cS) == creatorHash. Stack: cS pS
    OP.SIZE,           // Stack: cS pS size(pS)
    OP.DUP,            // Stack: cS pS size(pS) size(pS)
    0x60,              // OP_16: push 16
    OP.EQUAL,          // Stack: cS pS size(pS) isSize16
    OP.SWAP,           // Stack: cS pS isSize16 size(pS)
    0x5f,              // OP_15: push 15
    OP.EQUAL,          // Stack: cS pS isSize16 isSize15
    OP.BOOLOR,         // Stack: cS pS isValidSize(pS)
    OP.NOTIF,          // if player secret size is invalid
    OP['2DROP'],       // drop both secrets
    0x00,              // push 0 (creator wins by default)
    OP.ELSE,
    OP.SWAP,           // Stack: pS cS
    OP.SIZE,           // Stack: pS cS size(cS)
    OP.DUP,            // Stack: pS cS size(cS) size(cS)
    0x60,              // OP_16
    OP.EQUAL,          // Stack: pS cS size(cS) isSize16
    OP.SWAP,           // Stack: pS cS isSize16 size(cS)
    0x5f,              // OP_15
    OP.EQUAL,          // Stack: pS cS isSize16 isSize15
    OP.BOOLOR,         // Stack: pS cS isValidSize(cS)
    OP.NOTIF,          // if creator secret size is invalid
    OP['2DROP'],
    0x51,              // push 1 (player wins by default)
    OP.ELSE,
    OP.SIZE,           // Stack: pS cS size(cS)
    OP.SWAP,           // Stack: pS size(cS) cS
    OP.DROP,           // Stack: pS size(cS)
    OP.SWAP,           // Stack: size(cS) pS
    OP.SIZE,           // Stack: size(cS) pS size(pS)
    OP.SWAP,           // Stack: size(cS) size(pS) pS
    OP.DROP,           // Stack: size(cS) size(pS)
    OP.EQUAL,          // Stack: sizesEqual (1 if same = player wins)
    OP.ENDIF,
    OP.ENDIF,
  ])
}

/**
 * Base secret length for variable-odds games. Each party's "digit" is encoded
 * as `secretLength - VARIABLE_ODDS_BASE_LEN`, so a valid secret is
 * `BASE_LEN .. BASE_LEN + n - 1` bytes. 16 bytes keeps the SHA256 commit
 * brute-force-resistant (≥128 bits) at the smallest digit.
 */
export const VARIABLE_ODDS_BASE_LEN = 16

/**
 * Minimal numeric push: OP_0 / OP_1..OP_16 / a minimally-encoded CScriptNum.
 * For v ≤ 127 this is the original `[0x01, v]` 1-byte form (unchanged); for
 * larger v it emits little-endian bytes with a 0x00 pad when the MSB's high bit
 * is set, so the value stays positive. Lets variable-odds use n ≥ 128 (e.g. a
 * 3-dice "beat target" bet, n = 216, threshold up to 215).
 */
function pushNum(v: number): number[] {
  if (!Number.isInteger(v) || v < 0) throw new Error(`pushNum: ${v} must be a non-negative integer`)
  if (v === 0) return [0x00]
  if (v >= 1 && v <= 16) return [0x50 + v] // OP_1..OP_16
  const bytes: number[] = []
  let n = v
  while (n > 0) { bytes.push(n & 0xff); n >>= 8 }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00) // keep positive
  return [bytes.length, ...bytes]
}

/** value ∈ [lo, hi) → leaves one bool on the stack (consumes the value). */
function inRangeOps(lo: number, hi: number): number[] {
  return [
    OP.DUP, ...pushNum(lo), OP.GREATERTHANOREQUAL, // v (v>=lo)
    OP.SWAP, ...pushNum(hi), OP.LESSTHAN,           // (v>=lo) (v<hi)
    OP.BOOLAND,                                     // inRange
  ]
}

/** size ∈ [base, base+n) → leaves one bool on the stack (consumes the size). */
function rangeCheckOps(base: number, n: number): number[] {
  return inRangeOps(base, base + n)
}

/**
 * Variable-odds win condition (generalizes the coin's same/different-size check).
 *
 * Stack expects: <creatorSecret> <playerSecret>. Result: pushes 1 if the PLAYER
 * wins, 0 if the creator (house) wins. The creatorWin leaf wraps this in OP_NOT.
 *
 * Fairness: each party commits a secret hash whose LENGTH encodes a digit in
 * [0, n) — chosen before seeing the opponent's digit (commit-reveal). The roll
 * is `(digitC + digitP) mod n`; the player wins iff `lo <= roll < target`, i.e.
 * with probability `(target - lo)/n`. This arbitrary range lets a skin express
 * "roll a 1" ([0,1)), "roll 4+" ([3,6)), "exactly a 6" ([5,6)), etc. OP_MOD is
 * disabled in Script, so the mod is a single conditional subtraction (sum ∈
 * [0, 2n-2] ⇒ one `-n` suffices).
 *
 * An out-of-range secret makes its submitter LOSE (not void the game), so a
 * sure-loser can't grief a refund by revealing a bad length — exactly the
 * coin's invalid-size handling, generalized.
 */
function buildVariableOddsConditionScript(
  creatorHash: Uint8Array,
  playerHash: Uint8Array,
  n: number,
  target: number,
  lo = 0,
): Uint8Array {
  const base = VARIABLE_ODDS_BASE_LEN
  // The secret LENGTH encodes the digit (base + digit), so the largest valid
  // secret is `base + n - 1` bytes; cap it at the 520-byte push limit. arkd
  // handles the resulting >127 OP_SIZE / pushNum values as ordinary CScriptNums.
  if (!Number.isInteger(n) || n < 2 || base + n - 1 > 520) throw new Error(`invalid n: ${n}`)
  if (!Number.isInteger(lo) || !Number.isInteger(target) || lo < 0 || target <= lo || target > n) {
    throw new Error(`invalid odds range: need 0<=lo<target<=n (got lo=${lo}, target=${target}, n=${n})`)
  }

  return new Uint8Array([
    // Validate both hashes; leaves: cS pS
    OP['2DUP'],
    OP.SHA256, 0x20, ...playerHash, OP.EQUALVERIFY,
    OP.SHA256, 0x20, ...creatorHash, OP.EQUALVERIFY,
    // Validate player secret length ∈ [base, base+n)
    OP.SIZE, ...rangeCheckOps(base, n),  // cS pS isValidP
    OP.NOTIF,
      OP['2DROP'], 0x00,                  // player out of range → house wins (0)
    OP.ELSE,
      OP.SWAP,                            // pS cS
      OP.SIZE, ...rangeCheckOps(base, n), // pS cS isValidC
      OP.NOTIF,
        OP['2DROP'], 0x51,                // creator out of range → player wins (1)
      OP.ELSE,
        // both valid; stack: pS cS. roll = (digitC + digitP) mod n
        OP.SIZE, OP.NIP, ...pushNum(base), OP.SUB,  // pS digitC
        OP.SWAP,                                     // digitC pS
        OP.SIZE, OP.NIP, ...pushNum(base), OP.SUB,  // digitC digitP
        OP.ADD,                                      // sum ∈ [0, 2n-2]
        OP.DUP, ...pushNum(n), OP.GREATERTHANOREQUAL,
        OP.IF, ...pushNum(n), OP.SUB, OP.ENDIF,      // roll = sum mod n
        ...inRangeOps(lo, target),                   // lo <= roll < target → player wins
      OP.ENDIF,
    OP.ENDIF,
  ])
}

/**
 * Setup output VtxoScript.
 * Two leaves:
 *   1. Reveal: condition(SHA256 check) + creator + player + server
 *   2. Abort: CLTV timeout + player + server (player can reclaim after timeout)
 */
export class CoinflipSetupScript extends VtxoScript {
  readonly revealScriptHex: string
  readonly abortScriptHex: string

  constructor(readonly options: CoinflipSetupOptions) {
    const { creatorPubkey, playerPubkey, serverPubkey, creatorHash, setupExpiration } = options

    // Reveal leaf: SHA256(secret) check + 3-of-3 multisig (player, creator, server)
    const revealCondition = buildHashCheckScript(creatorHash)
    const revealTapscript = ConditionMultisigTapscript.encode({
      conditionScript: revealCondition,
      pubkeys: [playerPubkey, creatorPubkey, serverPubkey],
    })

    // Abort leaf: CLTV + 2-of-2 (player, server)
    const abortTapscript = CLTVMultisigTapscript.encode({
      absoluteTimelock: setupExpiration,
      pubkeys: [playerPubkey, serverPubkey],
    })

    super([revealTapscript.script, abortTapscript.script])

    this.revealScriptHex = hex.encode(revealTapscript.script)
    this.abortScriptHex = hex.encode(abortTapscript.script)
  }

  reveal(): TapLeafScript {
    return this.findLeaf(this.revealScriptHex)
  }

  abort(): TapLeafScript {
    return this.findLeaf(this.abortScriptHex)
  }
}

/**
 * Final output VtxoScript.
 * Three leaves:
 *   1. Creator wins: condition(sizes differ) + creator + server
 *   2. Player wins: condition(sizes match) + player + server
 *   3. Abort: CLTV timeout + creator + server (if player never reveals)
 */
export class CoinflipFinalScript extends VtxoScript {
  readonly creatorWinScriptHex: string
  readonly playerWinScriptHex: string
  readonly abortScriptHex: string

  constructor(readonly options: CoinflipFinalOptions) {
    const { creatorPubkey, playerPubkey, serverPubkey, creatorHash, playerHash, finalExpiration } = options

    const conditionScript = buildCoinflipConditionScript(creatorHash, playerHash)

    // Creator wins when condition result is 0 (NOT → true)
    const creatorWinCondition = new Uint8Array([...conditionScript, OP.NOT])
    const creatorWinTapscript = ConditionMultisigTapscript.encode({
      conditionScript: creatorWinCondition,
      pubkeys: [creatorPubkey, serverPubkey],
    })

    // Player wins when condition result is 1 (truthy)
    const playerWinTapscript = ConditionMultisigTapscript.encode({
      conditionScript: conditionScript,
      pubkeys: [playerPubkey, serverPubkey],
    })

    // Abort: CLTV + creator + server
    const abortTapscript = CLTVMultisigTapscript.encode({
      absoluteTimelock: finalExpiration,
      pubkeys: [creatorPubkey, serverPubkey],
    })

    super([creatorWinTapscript.script, playerWinTapscript.script, abortTapscript.script])

    this.creatorWinScriptHex = hex.encode(creatorWinTapscript.script)
    this.playerWinScriptHex = hex.encode(playerWinTapscript.script)
    this.abortScriptHex = hex.encode(abortTapscript.script)
  }

  creatorWin(): TapLeafScript {
    return this.findLeaf(this.creatorWinScriptHex)
  }

  playerWin(): TapLeafScript {
    return this.findLeaf(this.playerWinScriptHex)
  }

  abort(): TapLeafScript {
    return this.findLeaf(this.abortScriptHex)
  }
}

/**
 * Arkade-script forfeit + covenant-win configuration. Required at all
 * times — the coinflip protocol is single-path: it depends on an
 * emulator-signed covenant for resolution and a CLTV-gated covenant
 * for R1 forfeit. There is no legacy fallback.
 */
export interface ArkadeForfeitConfig {
  /** 32-byte x-only OR 33-byte compressed emulator pubkey. */
  emulatorPubkey: Uint8Array
  /**
   * Player payout P2TR pkScript. Pinned by:
   *   - `playerWinCovenant`  (server settles player win, no client sig)
   *   - `playerForfeit`      (R1: player sweeps both stakes after CLTV)
   */
  playerPayoutPkScript: Uint8Array
  /**
   * House payout P2TR pkScript. Pinned by:
   *   - `creatorWinCovenant` (server settles house win, no client sig)
   */
  housePayoutPkScript: Uint8Array
  /** Player stake (this leaf's "other input" value from the house's POV). */
  playerStake: bigint
  /** House stake (this leaf's "other input" value from the player's POV). */
  houseStake: bigint
}

export interface CoinflipEscrowOptions {
  creatorPubkey: Uint8Array
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  creatorHash: Uint8Array
  playerHash: Uint8Array
  finalExpiration: bigint
  /**
   * The FUNDER's pubkey: only this party (+ server) may refund after
   * the timeout. Set to `playerPubkey` for the player's escrow and
   * `creatorPubkey` for the house's. Per-funder refund is the
   * abort-theft fix: the house's refund leaf cannot touch the player's
   * escrow.
   */
  refundPubkey: Uint8Array
  /**
   * Variable-odds parameters. When `oddsN`/`oddsTarget` are set the
   * win condition is `oddsLo <= roll < oddsTarget` over `oddsN`
   * outcomes; unset → the 50/50 coin.
   */
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
  /** Arkade-script covenant config. Required. */
  arkadeForfeit: ArkadeForfeitConfig
}

/**
 * Per-party coinflip escrow. Four leaves, all covenant-bound where the
 * spend resolves a payout:
 *
 *   1. playerWinCovenant  — Condition[player wins] + ConditionMultisig[
 *                           server, emulator_tweaked] + atomic-sweep
 *                           covenant (output → player payout, value = pot,
 *                           other input value = matching escrow stake).
 *                           Server settles, no client signature needed.
 *   2. creatorWinCovenant — Symmetric for a house win, output bound to
 *                           house payout.
 *   3. playerForfeit      — CLTVMultisig[player, server, emulator_tweaked]
 *                           + atomic-sweep covenant (output → player
 *                           payout). R1 safety: after `finalExpiration`
 *                           the player sweeps both stakes with only their
 *                           own key.
 *   4. refund             — CLTVMultisig[refundPubkey(funder), server].
 *                           Pre-reveal abandonment: each funder reclaims
 *                           ONLY their own escrow.
 *
 * The win leaves are mutually exclusive (the condition determines which
 * fires). `playerForfeit` is only reachable past CLTV — by then any
 * honest-server resolve would have already spent the escrow. `refund`
 * lets each side reclaim their own stake if neither party ever reveals.
 */
export class CoinflipEscrowScript extends arkade.ArkadeVtxoScript {
  readonly playerWinCovenantScriptHex: string
  readonly creatorWinCovenantScriptHex: string
  readonly playerForfeitScriptHex: string
  readonly refundScriptHex: string
  readonly playerWinCovenantArkadeScript: Uint8Array
  readonly creatorWinCovenantArkadeScript: Uint8Array
  readonly forfeitArkadeScript: Uint8Array

  constructor(readonly options: CoinflipEscrowOptions) {
    const {
      creatorPubkey, playerPubkey, serverPubkey,
      creatorHash, playerHash, finalExpiration, refundPubkey,
      oddsN, oddsTarget, oddsLo,
      arkadeForfeit: { emulatorPubkey, playerPayoutPkScript, housePayoutPkScript, playerStake, houseStake },
    } = options

    const pot = playerStake + houseStake
    // Which "other input" value each leaf pins is **symmetric** — every
    // leaf on the player's escrow pins the house stake, every leaf on
    // the house's escrow pins the player stake. The atomic-sweep
    // covenant uses this to require both escrows to be in the same tx.
    // The caller picks which "other" to bind by passing `refundPubkey`
    // — player escrow → otherStake = houseStake; house escrow →
    // otherStake = playerStake.
    const isPlayerEscrow = hex.encode(refundPubkey) === hex.encode(playerPubkey)
    const otherStake = isPlayerEscrow ? houseStake : playerStake

    // Win-determination condition (player wins). House wins = OP_NOT.
    const playerWinsCondition =
      oddsN !== undefined && oddsTarget !== undefined
        ? buildVariableOddsConditionScript(creatorHash, playerHash, oddsN, oddsTarget, oddsLo ?? 0)
        : buildCoinflipConditionScript(creatorHash, playerHash)
    const houseWinsCondition = new Uint8Array([...playerWinsCondition, OP.NOT])

    // Covenants — three of them, all atomic-sweep (cross-input value
    // check + single output of the full pot to the winner's address).
    const playerWinCovenantArkadeScript = buildForfeitArkadeScript(
      playerPayoutPkScript, pot, otherStake,
    )
    const creatorWinCovenantArkadeScript = buildForfeitArkadeScript(
      housePayoutPkScript, pot, otherStake,
    )
    const forfeitArkadeScript = buildForfeitArkadeScript(
      playerPayoutPkScript, pot, otherStake,
    )

    // Leaves. ArkadeVtxoScript appends the emulator-tweaked key after
    // hashing each arkade script — we mirror that to compute findLeaf
    // hexes.
    const tweakedEmuKey = (script: Uint8Array) =>
      arkade.computeArkadeScriptPublicKey(emulatorPubkey, script)

    const playerWinCovenantLeaf: arkade.ArkadeLeaf = {
      arkadeScript: playerWinCovenantArkadeScript,
      emulators: [emulatorPubkey],
      tapscript: ConditionMultisigTapscript.encode({
        conditionScript: playerWinsCondition,
        pubkeys: [serverPubkey],
      }),
    }
    const playerWinCovenantScript = ConditionMultisigTapscript.encode({
      conditionScript: playerWinsCondition,
      pubkeys: [serverPubkey, tweakedEmuKey(playerWinCovenantArkadeScript)],
    }).script

    const creatorWinCovenantLeaf: arkade.ArkadeLeaf = {
      arkadeScript: creatorWinCovenantArkadeScript,
      emulators: [emulatorPubkey],
      tapscript: ConditionMultisigTapscript.encode({
        conditionScript: houseWinsCondition,
        pubkeys: [serverPubkey],
      }),
    }
    const creatorWinCovenantScript = ConditionMultisigTapscript.encode({
      conditionScript: houseWinsCondition,
      pubkeys: [serverPubkey, tweakedEmuKey(creatorWinCovenantArkadeScript)],
    }).script

    const forfeitLeaf: arkade.ArkadeLeaf = {
      arkadeScript: forfeitArkadeScript,
      emulators: [emulatorPubkey],
      tapscript: CLTVMultisigTapscript.encode({
        absoluteTimelock: finalExpiration,
        pubkeys: [playerPubkey, serverPubkey],
      }),
    }
    const forfeitLeafScript = CLTVMultisigTapscript.encode({
      absoluteTimelock: finalExpiration,
      pubkeys: [playerPubkey, serverPubkey, tweakedEmuKey(forfeitArkadeScript)],
    }).script

    const refundTapscript = CLTVMultisigTapscript.encode({
      absoluteTimelock: finalExpiration,
      pubkeys: [refundPubkey, serverPubkey],
    })

    super([
      playerWinCovenantLeaf,
      creatorWinCovenantLeaf,
      forfeitLeaf,
      refundTapscript.script,
    ])

    this.playerWinCovenantScriptHex = hex.encode(playerWinCovenantScript)
    this.creatorWinCovenantScriptHex = hex.encode(creatorWinCovenantScript)
    this.playerForfeitScriptHex = hex.encode(forfeitLeafScript)
    this.refundScriptHex = hex.encode(refundTapscript.script)
    this.playerWinCovenantArkadeScript = playerWinCovenantArkadeScript
    this.creatorWinCovenantArkadeScript = creatorWinCovenantArkadeScript
    this.forfeitArkadeScript = forfeitArkadeScript
  }

  /** Server settles a player win (no client signature). */
  playerWinCovenant(): TapLeafScript {
    return this.findLeaf(this.playerWinCovenantScriptHex)
  }

  /** Server settles a house win (no client signature). */
  creatorWinCovenant(): TapLeafScript {
    return this.findLeaf(this.creatorWinCovenantScriptHex)
  }

  /** R1: player sweeps both stakes after `finalExpiration`. */
  playerForfeit(): TapLeafScript {
    return this.findLeaf(this.playerForfeitScriptHex)
  }

  /** Funder reclaims their own stake after `finalExpiration`. */
  refund(): TapLeafScript {
    return this.findLeaf(this.refundScriptHex)
  }
}
