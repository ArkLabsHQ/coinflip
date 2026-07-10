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

import { VtxoScript, TapLeafScript } from '@arkade-os/sdk'
import { StageTwoScript } from './joint-pot-stage2'
import { buildJointPotArtifactContract } from './artifact/joint-pot'

export interface CoinflipJointPotOptions {
  creatorPubkey: Uint8Array // house
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  creatorHash: Uint8Array
  playerHash: Uint8Array
  /** Absolute expiry of the game, and the CLTV on the StageTwo playerTakeAll leaf:
   *  after it, a player who revealed on-chain sweeps the whole pot if the house
   *  stalled — so it doubles as the house's stage-2 settle deadline. (Absolute, not
   *  a relative window: arkd rejects CSV/relative timelocks for offchain spends.) */
  finalExpiration: bigint
  /** CLTV on the cooperativeSpend (covenant-only refund) leaf, gating the split-back.
   *  > the normal settle time so a losing player can't refund-escape; the playerReveal
   *  (no timelock) races it, so a player revealing on-chain before cancelDelay
   *  pre-empts the refund. */
  cancelDelay: bigint
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
    // The v4 contract is assembled from the artifact-JSON covenant model
    // (declarative asm fragments → the SDK's arkade.resolveAsm → tapscript
    // primitives). `buildJointPotArtifactContract` is byte-identical to the
    // former hand-rolled construction (frozen in joint-pot-golden.unit.test.ts).
    // The SDK's VtxoScript already assembles the btcd-ordered taptree, so the
    // old local Huffman→btcd override is no longer needed — `super(scripts)`
    // derives the same tapkey arkd expects.
    const c = buildJointPotArtifactContract(options)
    super(c.scripts)

    this.playerWinCovenantScriptHex = c.leafScriptsHex[0]
    this.creatorWinCovenantScriptHex = c.leafScriptsHex[1]
    this.playerRevealScriptHex = c.leafScriptsHex[2]
    this.cooperativeSpendScriptHex = c.leafScriptsHex[3]
    this.playerWinExitScriptHex = c.leafScriptsHex[4]
    this.creatorWinExitScriptHex = c.leafScriptsHex[5]
    this.playerForfeitExitScriptHex = c.leafScriptsHex[6]
    this.cooperativeSpendExitScriptHex = c.leafScriptsHex[7]
    this.playerWinFullArkadeScript = c.arkadeScripts.playerWinFull
    this.creatorWinFullArkadeScript = c.arkadeScripts.creatorWinFull
    this.forfeitArkadeScript = c.arkadeScripts.forfeit
    this.splitArkadeScript = c.arkadeScripts.split
    this.revealArkadeScript = c.arkadeScripts.reveal
    this.stageTwo = c.stageTwo
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
