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
 * Script: SHA256 <creatorHash> EQUALVERIFY
 */
function buildHashCheckScript(hash: Uint8Array): Uint8Array {
  return new Uint8Array([
    OP.SHA256,
    0x20, // push 32 bytes
    ...hash,
    OP.EQUAL,
    OP.VERIFY,
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
