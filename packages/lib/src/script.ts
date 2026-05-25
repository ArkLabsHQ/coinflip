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
 */

import { OP } from '@scure/btc-signer'
import { hex } from '@scure/base'
import {
  VtxoScript,
  ConditionMultisigTapscript,
  CLTVMultisigTapscript,
  TapLeafScript,
} from '@arkade-os/sdk'

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

/** Minimal numeric push: OP_0 / OP_1..OP_16 / single-byte (values 0..127). */
function pushNum(v: number): number[] {
  if (v === 0) return [0x00]
  if (v >= 1 && v <= 16) return [0x50 + v] // OP_1..OP_16
  if (v <= 127) return [0x01, v] // 1-byte minimal-encoded script number
  throw new Error(`pushNum: ${v} out of supported range [0,127]`)
}

/** size ∈ [base, base+n) → leaves one bool on the stack (consumes the size). */
function rangeCheckOps(base: number, n: number): number[] {
  return [
    OP.DUP, ...pushNum(base), OP.GREATERTHANOREQUAL, // size (size>=base)
    OP.SWAP, ...pushNum(base + n), OP.LESSTHAN,       // (size>=base) (size<base+n)
    OP.BOOLAND,                                       // isInRange
  ]
}

/**
 * Variable-odds win condition (generalizes the coin's same/different-size check).
 *
 * Stack expects: <creatorSecret> <playerSecret>. Result: pushes 1 if the PLAYER
 * wins, 0 if the creator (house) wins. The creatorWin leaf wraps this in OP_NOT.
 *
 * Fairness: each party commits a secret hash whose LENGTH encodes a digit in
 * [0, n) — chosen before seeing the opponent's digit (commit-reveal). The roll
 * is `(digitC + digitP) mod n`; the player wins iff `roll < target`, i.e. with
 * probability `target/n`. OP_MOD is disabled in Script, so the mod is done with
 * a single conditional subtraction (sum ∈ [0, 2n-2] ⇒ one `-n` suffices).
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
): Uint8Array {
  const base = VARIABLE_ODDS_BASE_LEN
  if (!Number.isInteger(n) || n < 2 || base + n > 127) throw new Error(`invalid n: ${n}`)
  if (!Number.isInteger(target) || target < 1 || target >= n) throw new Error(`invalid target: ${target}`)

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
        ...pushNum(target), OP.LESSTHAN,             // roll < target → player wins
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

export interface CoinflipEscrowOptions {
  creatorPubkey: Uint8Array
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  creatorHash: Uint8Array
  playerHash: Uint8Array
  finalExpiration: bigint
  /**
   * The FUNDER's pubkey: only this party (+ server) may refund after the
   * timeout. Set to `playerPubkey` for the player's escrow and `creatorPubkey`
   * for the house's. This is the abort-theft fix — because the player's escrow
   * refund leaf requires the PLAYER's key, the house can never sweep the
   * player's stake on a stall.
   */
  refundPubkey: Uint8Array
  /**
   * Variable-odds parameters. When BOTH are set the win condition becomes
   * `roll < oddsTarget` over `oddsN` outcomes (probability `oddsTarget/oddsN`)
   * instead of the 50/50 coin (equal/different secret length). The escrow
   * structure (leaves, refund, sweep) is otherwise identical.
   */
  oddsN?: number
  oddsTarget?: number
}

/**
 * Per-party escrow output. Both parties fund a (different) escrow address that
 * shares the win leaves but differs only in the owner-scoped refund leaf:
 *   1. creatorWin: condition(sizes differ → house wins) + creator + server
 *   2. playerWin:  condition(sizes equal → player wins) + player + server
 *   3. refund:     CLTV(finalExpiration) + refundPubkey(funder) + server
 *
 * The winner sweeps BOTH escrow VTXOs through `creatorWin`/`playerWin` (same
 * leaf script in either escrow); on a stall each side reclaims ONLY its own
 * escrow via `refund`. No cross-party theft is expressible.
 */
export class CoinflipEscrowScript extends VtxoScript {
  readonly creatorWinScriptHex: string
  readonly playerWinScriptHex: string
  readonly refundScriptHex: string

  constructor(readonly options: CoinflipEscrowOptions) {
    const { creatorPubkey, playerPubkey, serverPubkey, creatorHash, playerHash, finalExpiration, refundPubkey, oddsN, oddsTarget } = options

    // Variable-odds when both params are set; otherwise the 50/50 coin.
    const conditionScript =
      oddsN !== undefined && oddsTarget !== undefined
        ? buildVariableOddsConditionScript(creatorHash, playerHash, oddsN, oddsTarget)
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

    super([creatorWinTapscript.script, playerWinTapscript.script, refundTapscript.script])

    this.creatorWinScriptHex = hex.encode(creatorWinTapscript.script)
    this.playerWinScriptHex = hex.encode(playerWinTapscript.script)
    this.refundScriptHex = hex.encode(refundTapscript.script)
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
}
