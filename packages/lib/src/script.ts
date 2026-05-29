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
  ConditionCSVMultisigTapscript,
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
 * Optional arkade-script forfeit configuration for `CoinflipEscrowScript`.
 *
 * When supplied, the escrow grows a 5th `playerForfeit` leaf gated by
 * `CLTVMultisigTapscript(finalExpiration, [player, server, emulator_tweaked])`
 * wrapping an arkade-script covenant that enforces the spending tx pays
 * `forfeitDestPkScript` exactly `forfeitDestValue` sats to one of its
 * outputs (output index is supplied by the spender as a witness arg).
 *
 * This is the **execution-bucket** (CLTV) replacement for the legacy
 * `playerPenalty` CSV leaf. Old clients without emulator wiring stay on
 * the CSV path; clients that trust the operator's emulator get the cleaner
 * forfeit path that lives alongside the win-resolution closures rather
 * than forcing unilateral exit.
 *
 * Adding the leaf changes the escrow's taptree → **new address**. Game
 * setup must decide upfront whether the new layout is used (off by default).
 */
export interface ArkadeForfeitConfig {
  /** 32-byte x-only OR 33-byte compressed emulator pubkey. */
  emulatorPubkey: Uint8Array
  /**
   * On-chain P2TR pkScript (`0x51 0x20 <32-byte witness program>`) of the
   * player's payout address. The arkade-script covenant pins this script
   * exactly — the spending tx MUST produce an output matching it.
   *
   * Used by **two** leaves when both are wired (5-leaf + win-covenant
   * layout): `playerForfeit` (R1 escape) and `playerWinCovenant`
   * (server-resolved player win).
   */
  forfeitDestPkScript: Uint8Array
  /**
   * Optional: house's payout pkScript. When supplied alongside
   * `forfeitDestPkScript`, the escrow grows two additional covenant-
   * resolved win leaves (`playerWinCovenant`, `creatorWinCovenant`)
   * that let the server settle a resolved game without any client
   * signature — the covenant pins the destination + amount, the
   * multisig is `[server, emulator_tweaked]`. Omit to keep the
   * 5-leaf layout (forfeit only).
   */
  housePayoutPkScript?: Uint8Array
  /**
   * Amount the spending tx MUST pay to `forfeitDestPkScript` (in sats).
   *
   * In **single-input mode** (`otherStakeValue` undefined): this escrow's
   * own stake. The matching escrow's covenant is independent — partial
   * forfeits (one escrow at a time) are allowed.
   *
   * In **atomic-sweep mode** (`otherStakeValue` set): the full POT
   * (this stake + the other stake). The covenant requires BOTH escrows
   * to be in the same transaction, paying the combined total to ONE
   * output. Strictly stronger than single-input mode.
   */
  forfeitDestValue: bigint
  /**
   * When set, switches to atomic-sweep mode. The covenant additionally
   * verifies that another input of the spending transaction has this
   * exact satoshi value — typically the matching escrow's stake. The
   * spender supplies the other input's index as the SECOND witness arg
   * (the first being the output index, as in single-input mode).
   *
   * For the player's escrow leaf, pass the house stake. For the house's
   * escrow leaf, pass the player stake. The two covenants are symmetric
   * and consistent: each pins the other's stake by value.
   */
  otherStakeValue?: bigint
}

export interface CoinflipEscrowOptions {
  creatorPubkey: Uint8Array
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  creatorHash: Uint8Array
  playerHash: Uint8Array
  finalExpiration: bigint
  /**
   * Relative timelock (in seconds, BIP68) after the escrow VTXO is confirmed,
   * after which the player can sweep BOTH escrows via the playerPenalty leaf
   * with only its own secret — the forfeit a withholding house suffers (R1).
   * MUST be less than the time-to-`finalExpiration` so the player's penalty
   * beats the house's self-refund. BIP68 grants 512-second granularity for
   * seconds-type timelocks, so values rounded to multiples of 512 avoid
   * surprises. The default in production callers is 1024n (~17 min, with
   * 30-min refund leaving a ~13-min margin for the house to claim wins).
   *
   * **BIP68 silent-floor warning.** Seconds-type timelocks are encoded in
   * 512-second units; the SDK encoder silently floors non-multiples of 512n
   * down to the nearest lower multiple. A value below 512n encodes as 0n —
   * producing an **immediately-spendable** leaf, which **nullifies the R1
   * forfeit entirely**. Callers MUST pass a value that is `>= 512n` and a
   * multiple of 512n. The documented default is `1024n` (2 × 512s ≈ 17 min).
   */
  penaltyTimelockSeconds: bigint
  /**
   * The FUNDER's pubkey: only this party (+ server) may refund after the
   * timeout. Set to `playerPubkey` for the player's escrow and `creatorPubkey`
   * for the house's. This is the abort-theft fix — because the player's escrow
   * refund leaf requires the PLAYER's key, the house can never sweep the
   * player's stake on a stall.
   */
  refundPubkey: Uint8Array
  /**
   * Variable-odds parameters. When `oddsN`/`oddsTarget` are set the win
   * condition becomes `oddsLo <= roll < oddsTarget` over `oddsN` outcomes
   * (probability `(oddsTarget - oddsLo)/oddsN`) instead of the 50/50 coin.
   * `oddsLo` defaults to 0 (a low-threshold bet); an arbitrary range expresses
   * "roll 4+", "exactly a 6", etc. Escrow structure is otherwise identical.
   */
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
  /**
   * Opt-in arkade-script forfeit leaf. When set, a 5th leaf is added.
   * See {@link ArkadeForfeitConfig}.
   */
  arkadeForfeit?: ArkadeForfeitConfig
}

/**
 * Per-party escrow output. Both parties fund a (different) escrow address that
 * shares the win leaves but differs only in the owner-scoped refund leaf:
 *   1. creatorWin:    condition(sizes differ → house wins) + creator + server
 *   2. playerWin:     condition(sizes equal → player wins) + player + server
 *   3. refund:        CLTV(finalExpiration) + refundPubkey(funder) + server
 *   4. playerPenalty: ConditionCSVMultisigTapscript leaf —
 *                     condition(hash-check on player) + relative CSV timelock
 *                     + 2-of-2[player, server] (audit R1: house-withholding
 *                     forfeit). A recognized SDK tapscript type, so the
 *                     standard `buildOffchainTx` helper handles it.
 *
 * The winner sweeps BOTH escrow VTXOs through `creatorWin`/`playerWin` (same
 * leaf script in either escrow); on a stall each side reclaims ONLY its own
 * escrow via `refund`. If the player revealed and the house withholds, after
 * `penaltyTimelockSeconds` has elapsed (relative to the escrow VTXO's
 * confirmation), the player sweeps BOTH escrows via `playerPenalty` with just
 * its own secret — forfeiting the house's stake. No cross-party theft is
 * expressible: penalty requires the player's revealed secret, refund requires
 * the funder's key.
 */
export class CoinflipEscrowScript extends arkade.ArkadeVtxoScript {
  readonly creatorWinScriptHex: string
  readonly playerWinScriptHex: string
  readonly refundScriptHex: string
  readonly playerPenaltyScriptHex: string
  /**
   * Hex of the `playerForfeit` arkade-script leaf script (post-tweak),
   * or `undefined` when `arkadeForfeit` was not supplied. Use
   * `playerForfeit()` to get the `TapLeafScript` for spending.
   */
  readonly playerForfeitScriptHex?: string
  /**
   * Raw arkade-script bytecode for the forfeit leaf, or `undefined`. Needed
   * at spend time to add the EmulatorPacket entry that reveals the script
   * the emulator must execute before signing.
   */
  readonly forfeitArkadeScript?: Uint8Array
  /**
   * Hex of the covenant-resolved `playerWinCovenant` /
   * `creatorWinCovenant` leaves (post-tweak), or `undefined` when
   * `arkadeForfeit.housePayoutPkScript` was not supplied. Each leaf is
   * `ConditionMultisig[server, emulator_tweaked]` + win-condition
   * predicate + atomic-sweep covenant binding the winner's payout.
   */
  readonly playerWinCovenantScriptHex?: string
  readonly creatorWinCovenantScriptHex?: string
  /** Raw arkade-script bytes for the two covenant-win leaves. */
  readonly playerWinCovenantArkadeScript?: Uint8Array
  readonly creatorWinCovenantArkadeScript?: Uint8Array

  constructor(readonly options: CoinflipEscrowOptions) {
    const { creatorPubkey, playerPubkey, serverPubkey, creatorHash, playerHash, finalExpiration, penaltyTimelockSeconds, refundPubkey, oddsN, oddsTarget, oddsLo, arkadeForfeit } = options

    // Variable-odds when both params are set; otherwise the 50/50 coin.
    const conditionScript =
      oddsN !== undefined && oddsTarget !== undefined
        ? buildVariableOddsConditionScript(creatorHash, playerHash, oddsN, oddsTarget, oddsLo ?? 0)
        : buildCoinflipConditionScript(creatorHash, playerHash)

    const creatorWinCondition = new Uint8Array([...conditionScript, OP.NOT])
    const creatorWinTapscript = ConditionMultisigTapscript.encode({
      conditionScript: creatorWinCondition,
      pubkeys: [creatorPubkey, serverPubkey],
    })

    const playerWinTapscript = ConditionMultisigTapscript.encode({
      conditionScript,
      pubkeys: [playerPubkey, serverPubkey],
    })

    // Owner-scoped refund: only the funder (+ server) can reclaim after timeout.
    const refundTapscript = CLTVMultisigTapscript.encode({
      absoluteTimelock: finalExpiration,
      pubkeys: [refundPubkey, serverPubkey],
    })

    // Legacy player-forfeit penalty (CSV, exit-bucket). Kept as the fallback
    // forfeit path for clients that don't trust an emulator. See the class
    // docstring for the architectural bucket trade-off and
    // `docs/superpowers/specs/2026-05-28-r1-via-arkade-script-research.md`
    // for the rationale behind preferring the arkade-script leaf when an
    // emulator is wired in.
    const playerPenaltyTapscript = ConditionCSVMultisigTapscript.encode({
      conditionScript: buildHashCheckScript(playerHash),
      timelock: { value: penaltyTimelockSeconds, type: 'seconds' },
      pubkeys: [playerPubkey, serverPubkey],
    })

    // 5th leaf (optional) — arkade-script forfeit (execution-bucket CLTV +
    // covenant). The CLTV uses `finalExpiration` (same gate as `refund`) so
    // the forfeit window opens exactly when the game window closes; if the
    // house signed the win or refunded earlier the escrow is spent already
    // so this leaf never fires.
    //
    // The covenant pins `(forfeitDestPkScript, forfeitDestValue)` — the
    // spend MUST produce one output matching exactly. The output_index
    // the covenant inspects is supplied as a witness arg by the spender.
    //
    // Multisig is [player, server, emulator_tweaked]: player gates "who is
    // spending", server cosigns the CLTV satisfaction, emulator only
    // cosigns when the arkade-script runs to true.
    const forfeitArkadeScript = arkadeForfeit
      ? buildForfeitArkadeScript(
          arkadeForfeit.forfeitDestPkScript,
          arkadeForfeit.forfeitDestValue,
          arkadeForfeit.otherStakeValue,
        )
      : undefined
    const forfeitLeaf: arkade.ArkadeLeaf | undefined =
      arkadeForfeit && forfeitArkadeScript
        ? {
            arkadeScript: forfeitArkadeScript,
            emulators: [arkadeForfeit.emulatorPubkey],
            tapscript: CLTVMultisigTapscript.encode({
              absoluteTimelock: finalExpiration,
              pubkeys: [playerPubkey, serverPubkey],
            }),
          }
        : undefined
    // ArkadeVtxoScript appends the emulator-tweaked key to the leaf's
    // pubkey list before encoding. Mirror that to compute the post-tweak
    // script bytes (so we can locate the leaf via findLeaf).
    const forfeitLeafScript = arkadeForfeit && forfeitArkadeScript
      ? CLTVMultisigTapscript.encode({
          absoluteTimelock: finalExpiration,
          pubkeys: [
            playerPubkey,
            serverPubkey,
            arkade.computeArkadeScriptPublicKey(
              arkadeForfeit.emulatorPubkey,
              forfeitArkadeScript,
            ),
          ],
        }).script
      : undefined

    // Covenant-resolved win leaves (opt-in via arkadeForfeit.housePayoutPkScript).
    // When both payout pkScripts are pinned, the escrow gets TWO additional
    // leaves that let the server settle a resolved game with NO client
    // signature — the covenant binds the winner's destination + the full
    // pot, the multisig collapses to [server, emulator_tweaked]. The
    // condition script is the same coinflip win-determination predicate
    // (so arkd still checks "both secrets reveal AND winner == X" via
    // ConditionMultisig).
    //
    // Cross-input value pinning is the same shape as forfeit: each leaf
    // checks the OTHER escrow's stake via INSPECTINPUTVALUE, so neither
    // escrow can be claimed alone via covenant-win.
    const wantWinCovenant =
      arkadeForfeit !== undefined &&
      arkadeForfeit.housePayoutPkScript !== undefined &&
      arkadeForfeit.otherStakeValue !== undefined &&
      arkadeForfeit.forfeitDestValue !== undefined
    const playerWinCovenantArkadeScript = wantWinCovenant && arkadeForfeit
      ? buildForfeitArkadeScript(
          arkadeForfeit.forfeitDestPkScript,                 // player payout
          arkadeForfeit.forfeitDestValue,                    // pot
          arkadeForfeit.otherStakeValue,                     // other escrow stake
        )
      : undefined
    const creatorWinCovenantArkadeScript = wantWinCovenant && arkadeForfeit
      ? buildForfeitArkadeScript(
          arkadeForfeit.housePayoutPkScript!,                // house payout
          arkadeForfeit.forfeitDestValue,                    // pot
          arkadeForfeit.otherStakeValue,                     // other escrow stake
        )
      : undefined
    const playerWinCovenantLeaf: arkade.ArkadeLeaf | undefined =
      wantWinCovenant && arkadeForfeit && playerWinCovenantArkadeScript
        ? {
            arkadeScript: playerWinCovenantArkadeScript,
            emulators: [arkadeForfeit.emulatorPubkey],
            tapscript: ConditionMultisigTapscript.encode({
              conditionScript,                                // player-wins predicate
              pubkeys: [serverPubkey],
            }),
          }
        : undefined
    const creatorWinCovenantLeaf: arkade.ArkadeLeaf | undefined =
      wantWinCovenant && arkadeForfeit && creatorWinCovenantArkadeScript
        ? {
            arkadeScript: creatorWinCovenantArkadeScript,
            emulators: [arkadeForfeit.emulatorPubkey],
            tapscript: ConditionMultisigTapscript.encode({
              conditionScript: creatorWinCondition,           // house-wins predicate
              pubkeys: [serverPubkey],
            }),
          }
        : undefined
    // Mirror ArkadeVtxoScript's pubkey-append to compute findLeaf hexes.
    const playerWinCovenantScript =
      wantWinCovenant && arkadeForfeit && playerWinCovenantArkadeScript
        ? ConditionMultisigTapscript.encode({
            conditionScript,
            pubkeys: [
              serverPubkey,
              arkade.computeArkadeScriptPublicKey(
                arkadeForfeit.emulatorPubkey,
                playerWinCovenantArkadeScript,
              ),
            ],
          }).script
        : undefined
    const creatorWinCovenantScript =
      wantWinCovenant && arkadeForfeit && creatorWinCovenantArkadeScript
        ? ConditionMultisigTapscript.encode({
            conditionScript: creatorWinCondition,
            pubkeys: [
              serverPubkey,
              arkade.computeArkadeScriptPublicKey(
                arkadeForfeit.emulatorPubkey,
                creatorWinCovenantArkadeScript,
              ),
            ],
          }).script
        : undefined

    const leaves: arkade.ArkadeVtxoInput[] = [
      creatorWinTapscript.script,
      playerWinTapscript.script,
      refundTapscript.script,
      playerPenaltyTapscript.script,
    ]
    if (forfeitLeaf) leaves.push(forfeitLeaf)
    if (playerWinCovenantLeaf) leaves.push(playerWinCovenantLeaf)
    if (creatorWinCovenantLeaf) leaves.push(creatorWinCovenantLeaf)
    super(leaves)

    this.creatorWinScriptHex = hex.encode(creatorWinTapscript.script)
    this.playerWinScriptHex = hex.encode(playerWinTapscript.script)
    this.refundScriptHex = hex.encode(refundTapscript.script)
    this.playerPenaltyScriptHex = hex.encode(playerPenaltyTapscript.script)
    this.playerForfeitScriptHex = forfeitLeafScript ? hex.encode(forfeitLeafScript) : undefined
    this.forfeitArkadeScript = forfeitArkadeScript
    this.playerWinCovenantScriptHex = playerWinCovenantScript
      ? hex.encode(playerWinCovenantScript)
      : undefined
    this.creatorWinCovenantScriptHex = creatorWinCovenantScript
      ? hex.encode(creatorWinCovenantScript)
      : undefined
    this.playerWinCovenantArkadeScript = playerWinCovenantArkadeScript
    this.creatorWinCovenantArkadeScript = creatorWinCovenantArkadeScript
  }

  creatorWin(): TapLeafScript {
    return this.findLeaf(this.creatorWinScriptHex)
  }

  playerWin(): TapLeafScript {
    return this.findLeaf(this.playerWinScriptHex)
  }

  refund(): TapLeafScript {
    return this.findLeaf(this.refundScriptHex)
  }

  playerPenalty(): TapLeafScript {
    return this.findLeaf(this.playerPenaltyScriptHex)
  }

  /**
   * Arkade-script playerForfeit leaf — only present when the constructor
   * received an `arkadeForfeit` config. Throws if you call it on an escrow
   * that wasn't built with one.
   */
  playerForfeit(): TapLeafScript {
    if (!this.playerForfeitScriptHex) {
      throw new Error(
        'CoinflipEscrowScript: playerForfeit() called but no arkadeForfeit config was supplied',
      )
    }
    return this.findLeaf(this.playerForfeitScriptHex)
  }

  /**
   * Covenant-resolved player-win leaf. Only present when the constructor
   * received `arkadeForfeit.housePayoutPkScript`. The server can spend
   * this without any client signature — the covenant binds the player's
   * payout address + pot, and the multisig is [server, emulator_tweaked].
   */
  playerWinCovenant(): TapLeafScript {
    if (!this.playerWinCovenantScriptHex) {
      throw new Error(
        'CoinflipEscrowScript: playerWinCovenant() called but no housePayoutPkScript was supplied',
      )
    }
    return this.findLeaf(this.playerWinCovenantScriptHex)
  }

  /** Covenant-resolved house-win leaf. Symmetric to `playerWinCovenant`. */
  creatorWinCovenant(): TapLeafScript {
    if (!this.creatorWinCovenantScriptHex) {
      throw new Error(
        'CoinflipEscrowScript: creatorWinCovenant() called but no housePayoutPkScript was supplied',
      )
    }
    return this.findLeaf(this.creatorWinCovenantScriptHex)
  }
}
