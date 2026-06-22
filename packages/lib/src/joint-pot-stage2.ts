/**
 * StageTwoScript — the intermediate-output covenant of the v4 staged-forfeit
 * contest (Phase 2). After the player publishes their secret on-chain
 * (`playerReveal`, stage 1), the pot lands in an output guarded by this script.
 * Two outcomes:
 *   - houseSettle — the house settles to the ACTUAL winner (the emulator computes
 *     it from both now-on-chain reveals, so the house cannot cheat). No delay.
 *   - playerTakeAll — after `settleWindow` (a CSV), the player sweeps the WHOLE
 *     pot. This is the credible threat that forces the house to settle honestly:
 *     a winning player gets paid (or sweeps); a stalling house loses everything.
 *
 * Reuses CoinflipJointPotScript's win-predicate + emulator-tweak + btcd-taptree
 * machinery verbatim — this is a strict subset of the pot covenant (the two
 * win-covenants) plus a timelocked player sweep.
 *
 * 3-leaf taptree:
 *   0. playerWinCovenant  — Multisig[server, emu(predicateP + payTo(player, pot))]
 *   1. creatorWinCovenant — Multisig[server, emu(predicateC + payTo(house, pot))]
 *   2. playerTakeAll      — CSVMultisig[player, server, emu(payTo(player, pot))] @ settleWindow
 */

import { OP, p2tr, TAPROOT_UNSPENDABLE_KEY } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { assembleBtcdTaprootTree } from './btcd-taproot-tree'
import { VtxoScript, CSVMultisigTapscript, MultisigTapscript, TapLeafScript, arkade } from '@arkade-os/sdk'
import { buildForfeitArkadeScript } from './arkade-forfeit'
import { buildVariableOddsWinPredicate } from './arkade-win'

export interface StageTwoOptions {
  creatorPubkey: Uint8Array // house
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  creatorHash: Uint8Array
  playerHash: Uint8Array
  /** CSV (seconds) — the house's budget to settle this contest before the player
   *  can sweep the whole pot. Must comfortably exceed the house's settle latency. */
  settleWindow: bigint
  oddsN: number
  oddsTarget: number
  oddsLo: number
  emulatorPubkey: Uint8Array
  playerPayoutPkScript: Uint8Array
  housePayoutPkScript: Uint8Array
  playerStake: bigint
  houseStake: bigint
}

export class StageTwoScript extends VtxoScript {
  readonly playerWinCovenantScriptHex: string
  readonly creatorWinCovenantScriptHex: string
  readonly playerTakeAllScriptHex: string

  readonly playerWinFullArkadeScript: Uint8Array
  readonly creatorWinFullArkadeScript: Uint8Array
  readonly takeAllArkadeScript: Uint8Array

  constructor(readonly options: StageTwoOptions) {
    const {
      creatorPubkey, playerPubkey, serverPubkey,
      creatorHash, playerHash, settleWindow,
      oddsN, oddsTarget, oddsLo,
      emulatorPubkey, playerPayoutPkScript, housePayoutPkScript, playerStake, houseStake,
    } = options

    const pot = playerStake + houseStake

    // Win predicates + payouts — identical to CoinflipJointPotScript's leaves 0/1.
    const playerWinPredicate = buildVariableOddsWinPredicate(creatorHash, playerHash, oddsN, oddsTarget, oddsLo, true)
    const creatorWinPredicate = buildVariableOddsWinPredicate(creatorHash, playerHash, oddsN, oddsTarget, oddsLo, false)
    const playerPayoutCovenant = buildForfeitArkadeScript(playerPayoutPkScript, pot)
    const creatorPayoutCovenant = buildForfeitArkadeScript(housePayoutPkScript, pot)
    const playerWinFullArkadeScript = new Uint8Array([...playerWinPredicate, OP.VERIFY, ...playerPayoutCovenant])
    const creatorWinFullArkadeScript = new Uint8Array([...creatorWinPredicate, OP.VERIFY, ...creatorPayoutCovenant])
    // playerTakeAll pays the whole pot to the player (predicate-free; covenant only).
    const takeAllArkadeScript = buildForfeitArkadeScript(playerPayoutPkScript, pot)

    const tweakedEmuKey = (script: Uint8Array) => arkade.computeArkadeScriptPublicKey(emulatorPubkey, script)

    const playerWinCovenantScript = MultisigTapscript.encode({
      pubkeys: [serverPubkey, tweakedEmuKey(playerWinFullArkadeScript)],
    }).script
    const creatorWinCovenantScript = MultisigTapscript.encode({
      pubkeys: [serverPubkey, tweakedEmuKey(creatorWinFullArkadeScript)],
    }).script
    const playerTakeAllScript = CSVMultisigTapscript.encode({
      timelock: { value: settleWindow, type: 'seconds' },
      pubkeys: [playerPubkey, serverPubkey, tweakedEmuKey(takeAllArkadeScript)],
    }).script

    const scripts = [
      playerWinCovenantScript, // 0
      creatorWinCovenantScript, // 1
      playerTakeAllScript, // 2
    ]
    super(scripts)

    // Override scure's Huffman taptree with btcd's (same reasoning/mechanism as
    // CoinflipJointPotScript) so arkd agrees on the tapkey.
    const btcdTree = assembleBtcdTaprootTree(scripts)
    const btcdPayment = p2tr(TAPROOT_UNSPENDABLE_KEY, btcdTree, undefined, true)
    if (!btcdPayment.tapLeafScript || btcdPayment.tapLeafScript.length !== scripts.length) {
      throw new Error('StageTwoScript: btcd taptree produced invalid leaves')
    }
    ;(this as { leaves: typeof btcdPayment.tapLeafScript }).leaves = btcdPayment.tapLeafScript
    ;(this as { tweakedPublicKey: Uint8Array }).tweakedPublicKey = btcdPayment.tweakedPubkey
    ;(this as { pkScript: Uint8Array }).pkScript = btcdPayment.script

    this.playerWinCovenantScriptHex = hex.encode(playerWinCovenantScript)
    this.creatorWinCovenantScriptHex = hex.encode(creatorWinCovenantScript)
    this.playerTakeAllScriptHex = hex.encode(playerTakeAllScript)
    this.playerWinFullArkadeScript = playerWinFullArkadeScript
    this.creatorWinFullArkadeScript = creatorWinFullArkadeScript
    this.takeAllArkadeScript = takeAllArkadeScript
  }

  playerWinCovenant(): TapLeafScript { return this.findLeaf(this.playerWinCovenantScriptHex) }
  creatorWinCovenant(): TapLeafScript { return this.findLeaf(this.creatorWinCovenantScriptHex) }
  playerTakeAll(): TapLeafScript { return this.findLeaf(this.playerTakeAllScriptHex) }
  /** SDK annotation hook (same role as v3/v4). */
  forfeit(): TapLeafScript { return this.findLeaf(this.playerTakeAllScriptHex) }
}
