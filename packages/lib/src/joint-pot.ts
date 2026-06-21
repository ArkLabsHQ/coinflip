/**
 * CoinflipJointPotScript — v4 single joint-pot taptree.
 *
 * v3 funds two per-party escrows and sweeps BOTH on settle (`atomicSweep`).
 * v4 funds ONE joint pot (value = playerStake + houseStake) via an atomic
 * two-party co-fund, and settles by paying the WHOLE pot to the winner from
 * that single VTXO — so the win covenant is `payTo(winner, pot)`, not
 * `atomicSweep`. The win predicate, emulator tweak, and the btcd-taptree
 * override are reused verbatim from CoinflipEscrowScriptV3.
 *
 * 8-leaf taptree:
 *   0. playerWinCovenant   — Multisig[server, emu_tweaked(predicateP + payTo(player, pot))]
 *   1. creatorWinCovenant  — Multisig[server, emu_tweaked(predicateC + payTo(house, pot))]
 *   2. playerForfeit       — CLTVMultisig[player, server, emu_tweaked(payTo(player, pot))]
 *   3. cooperativeSpend    — Multisig[player, creator, server]  (the pre-signed refund-split spends this)
 *   4. playerWinExit       — CSVMultisig[player, emu_tweaked(predicateP + payTo(player, pot))]
 *   5. creatorWinExit      — CSVMultisig[creator, emu_tweaked(predicateC + payTo(house, pot))]
 *   6. playerForfeitExit   — ConditionCSVMultisig[player, emu_tweaked(payTo(player, pot))] + SHA256(playerSecret)
 *   7. cooperativeSpendExit — CSVMultisig[player, creator]
 *
 * The per-party `refund`/`refundExit` leaves of v3 are replaced by
 * `cooperativeSpend` — a single pot is split back by the pre-signed refund
 * (a normal tx both parties sign), not a per-funder unilateral reclaim.
 */

import { OP, p2tr, TAPROOT_UNSPENDABLE_KEY } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { assembleBtcdTaprootTree } from './btcd-taproot-tree'
import {
  VtxoScript,
  ConditionCSVMultisigTapscript,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  MultisigTapscript,
  TapLeafScript,
  arkade,
} from '@arkade-os/sdk'
import { buildForfeitArkadeScript } from './arkade-forfeit'
import { buildVariableOddsWinPredicate } from './arkade-win'

export interface CoinflipJointPotOptions {
  creatorPubkey: Uint8Array // house
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  creatorHash: Uint8Array
  playerHash: Uint8Array
  finalExpiration: bigint
  exitDelay: bigint
  oddsN: number
  oddsTarget: number
  oddsLo: number
  emulatorPubkey: Uint8Array
  playerPayoutPkScript: Uint8Array
  housePayoutPkScript: Uint8Array
  playerStake: bigint
  houseStake: bigint
}

/** SHA256 hash-check (no trailing VERIFY — ConditionCSVMultisig appends its own). */
function buildHashCheckScript(hash: Uint8Array): Uint8Array {
  return new Uint8Array([OP.SHA256, 0x20, ...hash, OP.EQUAL])
}

export class CoinflipJointPotScript extends VtxoScript {
  readonly playerWinCovenantScriptHex: string
  readonly creatorWinCovenantScriptHex: string
  readonly playerForfeitScriptHex: string
  readonly cooperativeSpendScriptHex: string
  readonly playerWinExitScriptHex: string
  readonly creatorWinExitScriptHex: string
  readonly playerForfeitExitScriptHex: string
  readonly cooperativeSpendExitScriptHex: string

  readonly playerWinFullArkadeScript: Uint8Array
  readonly creatorWinFullArkadeScript: Uint8Array
  readonly forfeitArkadeScript: Uint8Array

  constructor(readonly options: CoinflipJointPotOptions) {
    const {
      creatorPubkey, playerPubkey, serverPubkey,
      creatorHash, playerHash, finalExpiration, exitDelay,
      oddsN, oddsTarget, oddsLo,
      emulatorPubkey, playerPayoutPkScript, housePayoutPkScript, playerStake, houseStake,
    } = options

    const pot = playerStake + houseStake

    // Win predicates (arkade-script, emulator-evaluated) — reused from v3.
    const playerWinPredicate = buildVariableOddsWinPredicate(creatorHash, playerHash, oddsN, oddsTarget, oddsLo, true)
    const creatorWinPredicate = buildVariableOddsWinPredicate(creatorHash, playerHash, oddsN, oddsTarget, oddsLo, false)

    // Single-pot covenants: pay the WHOLE pot to the winner (payTo, not atomicSweep).
    // buildForfeitArkadeScript(payout, amount) with no otherStakeValue == payTo.
    const playerPayoutCovenant = buildForfeitArkadeScript(playerPayoutPkScript, pot)
    const creatorPayoutCovenant = buildForfeitArkadeScript(housePayoutPkScript, pot)

    const playerWinFullArkadeScript = new Uint8Array([...playerWinPredicate, OP.VERIFY, ...playerPayoutCovenant])
    const creatorWinFullArkadeScript = new Uint8Array([...creatorWinPredicate, OP.VERIFY, ...creatorPayoutCovenant])
    // Forfeit pays the whole pot to the player (predicate-free; covenant only).
    const forfeitArkadeScript = buildForfeitArkadeScript(playerPayoutPkScript, pot)

    const tweakedEmuKey = (script: Uint8Array) => arkade.computeArkadeScriptPublicKey(emulatorPubkey, script)

    const playerWinCovenantScript = MultisigTapscript.encode({
      pubkeys: [serverPubkey, tweakedEmuKey(playerWinFullArkadeScript)],
    }).script
    const creatorWinCovenantScript = MultisigTapscript.encode({
      pubkeys: [serverPubkey, tweakedEmuKey(creatorWinFullArkadeScript)],
    }).script
    const playerForfeitScript = CLTVMultisigTapscript.encode({
      absoluteTimelock: finalExpiration,
      pubkeys: [playerPubkey, serverPubkey, tweakedEmuKey(forfeitArkadeScript)],
    }).script
    // Cooperative split spender (the pre-signed refund signs this leaf). Includes
    // serverPubkey because arkd requires the signer pubkey in every ForfeitClosure
    // multisig; arkd's signature is automatic for valid spends.
    const cooperativeSpendScript = MultisigTapscript.encode({
      pubkeys: [playerPubkey, creatorPubkey, serverPubkey],
    }).script

    const playerWinExitScript = CSVMultisigTapscript.encode({
      timelock: { value: exitDelay, type: 'seconds' },
      pubkeys: [playerPubkey, tweakedEmuKey(playerWinFullArkadeScript)],
    }).script
    const creatorWinExitScript = CSVMultisigTapscript.encode({
      timelock: { value: exitDelay, type: 'seconds' },
      pubkeys: [creatorPubkey, tweakedEmuKey(creatorWinFullArkadeScript)],
    }).script
    const playerForfeitExitScript = ConditionCSVMultisigTapscript.encode({
      conditionScript: buildHashCheckScript(playerHash),
      timelock: { value: exitDelay, type: 'seconds' },
      pubkeys: [playerPubkey, tweakedEmuKey(forfeitArkadeScript)],
    }).script
    const cooperativeSpendExitScript = CSVMultisigTapscript.encode({
      timelock: { value: exitDelay, type: 'seconds' },
      pubkeys: [playerPubkey, creatorPubkey],
    }).script

    const scripts = [
      playerWinCovenantScript,   // 0
      creatorWinCovenantScript,  // 1
      playerForfeitScript,       // 2
      cooperativeSpendScript,    // 3
      playerWinExitScript,       // 4
      creatorWinExitScript,      // 5
      playerForfeitExitScript,   // 6
      cooperativeSpendExitScript, // 7
    ]
    super(scripts)

    // Override scure's Huffman taptree with btcd's, so arkd agrees on the tapkey
    // (identical reasoning + mechanism as CoinflipEscrowScriptV3).
    const btcdTree = assembleBtcdTaprootTree(scripts)
    const btcdPayment = p2tr(TAPROOT_UNSPENDABLE_KEY, btcdTree, undefined, true)
    if (!btcdPayment.tapLeafScript || btcdPayment.tapLeafScript.length !== scripts.length) {
      throw new Error('CoinflipJointPotScript: btcd taptree produced invalid leaves')
    }
    ;(this as { leaves: typeof btcdPayment.tapLeafScript }).leaves = btcdPayment.tapLeafScript
    ;(this as { tweakedPublicKey: Uint8Array }).tweakedPublicKey = btcdPayment.tweakedPubkey
    ;(this as { pkScript: Uint8Array }).pkScript = btcdPayment.script

    this.playerWinCovenantScriptHex = hex.encode(playerWinCovenantScript)
    this.creatorWinCovenantScriptHex = hex.encode(creatorWinCovenantScript)
    this.playerForfeitScriptHex = hex.encode(playerForfeitScript)
    this.cooperativeSpendScriptHex = hex.encode(cooperativeSpendScript)
    this.playerWinExitScriptHex = hex.encode(playerWinExitScript)
    this.creatorWinExitScriptHex = hex.encode(creatorWinExitScript)
    this.playerForfeitExitScriptHex = hex.encode(playerForfeitExitScript)
    this.cooperativeSpendExitScriptHex = hex.encode(cooperativeSpendExitScript)
    this.playerWinFullArkadeScript = playerWinFullArkadeScript
    this.creatorWinFullArkadeScript = creatorWinFullArkadeScript
    this.forfeitArkadeScript = forfeitArkadeScript
  }

  playerWinCovenant(): TapLeafScript { return this.findLeaf(this.playerWinCovenantScriptHex) }
  creatorWinCovenant(): TapLeafScript { return this.findLeaf(this.creatorWinCovenantScriptHex) }
  playerForfeit(): TapLeafScript { return this.findLeaf(this.playerForfeitScriptHex) }
  cooperativeSpend(): TapLeafScript { return this.findLeaf(this.cooperativeSpendScriptHex) }
  playerWinExit(): TapLeafScript { return this.findLeaf(this.playerWinExitScriptHex) }
  creatorWinExit(): TapLeafScript { return this.findLeaf(this.creatorWinExitScriptHex) }
  playerForfeitExit(): TapLeafScript { return this.findLeaf(this.playerForfeitExitScriptHex) }
  cooperativeSpendExit(): TapLeafScript { return this.findLeaf(this.cooperativeSpendExitScriptHex) }
  /** SDK annotation hook (same role as v3). */
  forfeit(): TapLeafScript { return this.findLeaf(this.cooperativeSpendScriptHex) }
}
