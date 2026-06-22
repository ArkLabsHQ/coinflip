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
 *   2. playerReveal        — ConditionMultisig[player, server, emu(payTo(StageTwo, pot))] + SHA256(playerSecret)  (Phase 2 stage 1)
 *   3. cooperativeSpend    — CLTVMultisig[server, emu(splitTo)] @ cancelDelay  (the covenant-only refund-split spends this)
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
  ConditionMultisigTapscript,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  MultisigTapscript,
  TapLeafScript,
  arkade,
} from '@arkade-os/sdk'
import { buildForfeitArkadeScript, buildSplitArkadeScript } from './arkade-forfeit'
import { buildVariableOddsWinPredicate } from './arkade-win'
import { StageTwoScript } from './joint-pot-stage2'

export interface CoinflipJointPotOptions {
  creatorPubkey: Uint8Array // house
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  creatorHash: Uint8Array
  playerHash: Uint8Array
  /** Vestigial since Phase 2 — no covenant leaf uses it now (the whole-pot forfeit
   *  became the playerReveal -> StageTwo contest). Kept for server game-timing. */
  finalExpiration: bigint
  /** CLTV on the cooperativeSpend (covenant-only refund) leaf, gating the split-back.
   *  > the normal settle time so a losing player can't refund-escape; the playerReveal
   *  (no timelock) races it, so a player revealing on-chain before cancelDelay
   *  pre-empts the refund. */
  cancelDelay: bigint
  exitDelay: bigint
  /** Phase 2: CSV window (seconds, 512-multiple) on the StageTwo playerTakeAll leaf —
   *  the house's budget to settle a contested game after the player reveals on-chain,
   *  before the player can sweep the whole pot. */
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

/** SHA256 hash-check (no trailing VERIFY — ConditionCSVMultisig appends its own). */
function buildHashCheckScript(hash: Uint8Array): Uint8Array {
  return new Uint8Array([OP.SHA256, 0x20, ...hash, OP.EQUAL])
}

export class CoinflipJointPotScript extends VtxoScript {
  readonly playerWinCovenantScriptHex: string
  readonly creatorWinCovenantScriptHex: string
  readonly playerRevealScriptHex: string
  readonly cooperativeSpendScriptHex: string
  readonly playerWinExitScriptHex: string
  readonly creatorWinExitScriptHex: string
  readonly playerForfeitExitScriptHex: string
  readonly cooperativeSpendExitScriptHex: string

  readonly playerWinFullArkadeScript: Uint8Array
  readonly creatorWinFullArkadeScript: Uint8Array
  readonly forfeitArkadeScript: Uint8Array
  readonly splitArkadeScript: Uint8Array
  /** payTo(StageTwo, pot) — the emulator packet for the playerReveal (stage 1). */
  readonly revealArkadeScript: Uint8Array
  /** The StageTwo contest covenant the playerReveal pays into (Phase 2). */
  readonly stageTwo: StageTwoScript

  constructor(readonly options: CoinflipJointPotOptions) {
    const {
      creatorPubkey, playerPubkey, serverPubkey,
      creatorHash, playerHash, cancelDelay, exitDelay, settleWindow,
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
    // Refund splits the pot back: playerStake → player, houseStake → house. The
    // emulator enforces BOTH outputs, so the cooperative refund is covenant-only
    // (no player/creator pre-sign needed — the covenant guarantees the split).
    const splitArkadeScript = buildSplitArkadeScript(playerPayoutPkScript, playerStake, housePayoutPkScript, houseStake)

    // Phase 2 staged forfeit: the player's recovery no longer takes the whole pot
    // directly — it routes the pot into a StageTwo contest. playerReveal publishes
    // the player's secret on-chain and pays the pot to the StageTwo covenant, where
    // the house can settle to the ACTUAL winner OR (after settleWindow) the player
    // sweeps everything — closing the "house stalls on a loss" gap.
    const stageTwo = new StageTwoScript({
      creatorPubkey, playerPubkey, serverPubkey, creatorHash, playerHash, settleWindow,
      oddsN, oddsTarget, oddsLo, emulatorPubkey, playerPayoutPkScript, housePayoutPkScript, playerStake, houseStake,
    })
    const revealArkadeScript = buildForfeitArkadeScript(stageTwo.pkScript, pot) // payTo(StageTwo, pot)

    const tweakedEmuKey = (script: Uint8Array) => arkade.computeArkadeScriptPublicKey(emulatorPubkey, script)

    const playerWinCovenantScript = MultisigTapscript.encode({
      pubkeys: [serverPubkey, tweakedEmuKey(playerWinFullArkadeScript)],
    }).script
    const creatorWinCovenantScript = MultisigTapscript.encode({
      pubkeys: [serverPubkey, tweakedEmuKey(creatorWinFullArkadeScript)],
    }).script
    // playerReveal (Phase 2 stage 1): the player publishes their secret (the SHA256
    // condition) and the emulator enforces payTo(StageTwo, pot). No timelock — it's
    // available immediately so the client can fire it before cancelDelay and pre-empt
    // the refund. [player, server, emu] sign; the on-chain secret lets StageTwo
    // settle to the actual winner.
    const playerRevealScript = ConditionMultisigTapscript.encode({
      conditionScript: buildHashCheckScript(playerHash),
      pubkeys: [playerPubkey, serverPubkey, tweakedEmuKey(revealArkadeScript)],
    }).script
    // Cooperative split spender — the COVENANT-ONLY refund spends this leaf. The
    // emulator enforces the split (buildSplitArkadeScript), so it needs no
    // player/creator pre-sign: like the settle/forfeit, only [server, emu] sign,
    // and arkd + the emulator co-sign automatically for a valid (correctly-split)
    // tx. CLTV-gated at cancelDelay so the refund cannot confirm until then — the
    // normal settle finishes first (a losing player can't refund-escape), and the
    // house can still refund a never-revealed pot before the player's forfeit opens.
    const cooperativeSpendScript = CLTVMultisigTapscript.encode({
      absoluteTimelock: cancelDelay,
      pubkeys: [serverPubkey, tweakedEmuKey(splitArkadeScript)],
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
      playerRevealScript,        // 2 (Phase 2: was playerForfeit)
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
    this.playerRevealScriptHex = hex.encode(playerRevealScript)
    this.cooperativeSpendScriptHex = hex.encode(cooperativeSpendScript)
    this.playerWinExitScriptHex = hex.encode(playerWinExitScript)
    this.creatorWinExitScriptHex = hex.encode(creatorWinExitScript)
    this.playerForfeitExitScriptHex = hex.encode(playerForfeitExitScript)
    this.cooperativeSpendExitScriptHex = hex.encode(cooperativeSpendExitScript)
    this.playerWinFullArkadeScript = playerWinFullArkadeScript
    this.creatorWinFullArkadeScript = creatorWinFullArkadeScript
    this.forfeitArkadeScript = forfeitArkadeScript
    this.splitArkadeScript = splitArkadeScript
    this.revealArkadeScript = revealArkadeScript
    this.stageTwo = stageTwo
  }

  playerWinCovenant(): TapLeafScript { return this.findLeaf(this.playerWinCovenantScriptHex) }
  creatorWinCovenant(): TapLeafScript { return this.findLeaf(this.creatorWinCovenantScriptHex) }
  playerReveal(): TapLeafScript { return this.findLeaf(this.playerRevealScriptHex) }
  cooperativeSpend(): TapLeafScript { return this.findLeaf(this.cooperativeSpendScriptHex) }
  playerWinExit(): TapLeafScript { return this.findLeaf(this.playerWinExitScriptHex) }
  creatorWinExit(): TapLeafScript { return this.findLeaf(this.creatorWinExitScriptHex) }
  playerForfeitExit(): TapLeafScript { return this.findLeaf(this.playerForfeitExitScriptHex) }
  cooperativeSpendExit(): TapLeafScript { return this.findLeaf(this.cooperativeSpendExitScriptHex) }
  /** SDK annotation hook (same role as v3). */
  forfeit(): TapLeafScript { return this.findLeaf(this.cooperativeSpendScriptHex) }
}
