/**
 * v4 joint-pot transaction builders — the PURE (unsigned) tx construction the
 * co-fund and settle flows need, extracted from the proven probes/scale harness
 * so the server and client share one implementation.
 *
 * Signing (each party signs its own input + checkpoint) and submission
 * (arkd submitTx/finalizeTx, or the emulator POST for the settle) stay with the
 * caller — these functions only assemble the transactions.
 *
 * Proven on the live regtest stack by v4-game-probe.test.ts and v4-scale.test.ts.
 */

import { base64, hex } from '@scure/base'
import {
  buildOffchainTx,
  CSVMultisigTapscript,
  Transaction,
  ArkAddress,
  type ArkTxInput,
  type TapLeafScript,
} from '@arkade-os/sdk'
import { emulator, packets } from '@arklabshq/contract-workflows-prototype'
import { CoinflipJointPotScript } from './joint-pot'
import { StageTwoScript } from './joint-pot-stage2'
import { addConditionWitness } from './transactions'

/** A built (unsigned) offchain tx: the round tx + one checkpoint per input. */
export interface BuiltJointPotTx {
  arkTx: Transaction
  checkpoints: Transaction[]
}

/** An offchain-tx output: a scriptPubKey and an amount (the shape buildOffchainTx takes). */
export interface PotOutput {
  script: Uint8Array
  amount: bigint
}

/** An on-chain outpoint with its value, identifying a VTXO to spend. */
export interface Outpoint {
  txid: string
  vout: number
  value: number
}

/**
 * Co-fund outputs: the joint pot (output 0, the WHOLE pot) followed by each
 * funder's change. Output 0 MUST be the pot — the settle covenant pins it, and
 * the settle spends `{cofundTxid, vout: 0}`.
 */
export function jointPotCofundOutputs(args: {
  potPkScript: Uint8Array
  potAmount: bigint
  playerChangePkScript: Uint8Array
  playerChange: bigint
  houseChangePkScript: Uint8Array
  houseChange: bigint
  dust?: bigint
}): PotOutput[] {
  const dust = args.dust ?? 330n
  const outs: PotOutput[] = [{ script: args.potPkScript, amount: args.potAmount }]
  if (args.playerChange > dust) outs.push({ script: args.playerChangePkScript, amount: args.playerChange })
  if (args.houseChange > dust) outs.push({ script: args.houseChangePkScript, amount: args.houseChange })
  return outs
}

/**
 * Build the atomic co-fund: ONE offchain tx spending ARBITRARY player stake
 * inputs followed by ARBITRARY house stake inputs into the joint-pot output
 * (vout 0) plus changes. Each party signs ONLY its own inputs + checkpoints;
 * arkd cosigns. (Two-party atomic co-fund proven by v4-cofund-probe.)
 *
 * Ordering is load-bearing: the player's inputs occupy vins `[0, k)` and the
 * house's the LAST `m` vins `[k, k+m)`. The handshake uses that — the server
 * signs the trailing `m` inputs/checkpoints, the client the leading `k`.
 */
export function buildJointPotCofundTx(
  playerInputs: ArkTxInput[],
  houseInputs: ArkTxInput[],
  outputs: PotOutput[],
  serverUnroll: CSVMultisigTapscript.Type,
): BuiltJointPotTx {
  if (playerInputs.length === 0) throw new Error('buildJointPotCofundTx: at least one player input required')
  if (houseInputs.length === 0) throw new Error('buildJointPotCofundTx: at least one house input required')
  return buildOffchainTx([...playerInputs, ...houseInputs], outputs, serverUnroll)
}

/**
 * Build the settle: spend the joint pot (one input) via the winner's
 * win-covenant leaf into a single output paying the WHOLE pot to the winner.
 *
 * Attaches the emulator packet (the `payTo` covenant inspects output 0, so the
 * witness is `[encodeIndex(0)]`) and BOTH reveal packets (read on-chain by the
 * win predicate). The checkpoint's witnessUtxo.script is patched to the pot's
 * btcd-correct pkScript (buildOffchainTx derives it via scure's Huffman tree,
 * which disagrees for the 8-leaf taptree).
 *
 * The returned arkTx is UNSIGNED by the operator: the win leaf is
 * `[arkd_server, emu_tweaked]` — arkd signs automatically and the emulator
 * cosigns after running the covenant. POST it to the emulator's `/v1/tx`.
 */
export function buildJointPotSettleTx(args: {
  pot: CoinflipJointPotScript
  cofund: Outpoint
  winner: 'player' | 'creator'
  winnerPayoutPkScript: Uint8Array
  potAmount: bigint
  playerRevealBytes: Uint8Array
  creatorRevealBytes: Uint8Array
  serverUnroll: CSVMultisigTapscript.Type
}): BuiltJointPotTx {
  const { pot, cofund, winner, winnerPayoutPkScript, potAmount } = args
  // Same balance guard as the forfeit builder — payout must equal the pot.
  if (potAmount <= 0n || potAmount !== BigInt(cofund.value)) {
    throw new Error(`buildJointPotSettleTx: potAmount ${potAmount} must equal the pot value ${cofund.value}`)
  }
  const leaf = winner === 'player' ? pot.playerWinCovenant() : pot.creatorWinCovenant()
  const arkadeScript = winner === 'player' ? pot.playerWinFullArkadeScript : pot.creatorWinFullArkadeScript

  const input: ArkTxInput = {
    txid: cofund.txid, vout: cofund.vout, value: cofund.value, tapLeafScript: leaf, tapTree: pot.encode(),
  }
  const built = buildOffchainTx([input], [{ script: winnerPayoutPkScript, amount: potAmount }], args.serverUnroll)

  // Patch the checkpoint's prevout script to the pot's btcd-correct pkScript.
  const cp = built.checkpoints[0]
  const cpIn = cp.getInput(0)
  if (cpIn?.witnessUtxo) {
    cp.updateInput(0, { witnessUtxo: { script: pot.pkScript, amount: cpIn.witnessUtxo.amount } })
  }

  // Emulator packet: the payTo covenant inspects output 0.
  emulator.addPacket(built.arkTx, [
    { vin: 0, script: arkadeScript, witness: emulator.encodeWitness([emulator.encodeIndex(0)]) },
  ])
  // Reveal packets (read on-chain by OP_INSPECTPACKET in the win predicate).
  packets.addRevealPacket(built.arkTx, packets.REVEAL_PLAYER_PACKET_TYPE, args.playerRevealBytes)
  packets.addRevealPacket(built.arkTx, packets.REVEAL_CREATOR_PACKET_TYPE, args.creatorRevealBytes)
  return built
}

/** Patch the checkpoint's prevout script to a covenant's btcd-correct pkScript. */
function patchCheckpointPrevout(built: BuiltJointPotTx, pkScript: Uint8Array): void {
  const cp = built.checkpoints[0]
  const cpIn = cp.getInput(0)
  if (cpIn?.witnessUtxo) {
    cp.updateInput(0, { witnessUtxo: { script: pkScript, amount: cpIn.witnessUtxo.amount } })
  }
}

/**
 * Build the player's REVEAL (Phase 2 staged-forfeit, stage 1) — the recovery
 * path when the pot is funded but the server stalls. Spends the joint pot via the
 * `playerReveal` leaf (ConditionMultisig[player, server, emu(payTo(StageTwo,pot))]
 * + SHA256(playerSecret)) into the StageTwo CONTEST covenant — publishing the
 * player's secret on-chain (the condition witness). No timelock, so the client
 * fires this before cancelDelay to pre-empt the refund. From StageTwo the house
 * settles to the actual winner, or (after finalExpiration) the player sweeps all.
 */
export function buildPlayerRevealTx(args: {
  pot: CoinflipJointPotScript
  cofund: Outpoint
  /** The player's reveal `[digit] || salt` — the SHA256 preimage published on-chain. */
  playerRevealBytes: Uint8Array
  serverUnroll: CSVMultisigTapscript.Type
}): BuiltJointPotTx {
  const { pot, cofund } = args
  const input: ArkTxInput = {
    txid: cofund.txid, vout: cofund.vout, value: cofund.value,
    tapLeafScript: pot.playerReveal(), tapTree: pot.encode(),
  }
  // Output 0: the WHOLE pot to the StageTwo contest covenant (pinned by revealArkadeScript).
  const built = buildOffchainTx([input], [{ script: pot.stageTwo.pkScript, amount: BigInt(cofund.value) }], args.serverUnroll)
  patchCheckpointPrevout(built, pot.pkScript)
  // Emulator packet: revealArkadeScript = payTo(StageTwo, pot), inspects output 0.
  emulator.addPacket(built.arkTx, [
    { vin: 0, script: pot.revealArkadeScript, witness: emulator.encodeWitness([emulator.encodeIndex(0)]) },
  ])
  // Condition witness: the SHA256(playerSecret) preimage. Ark's checkpoint
  // indirection carries the playerReveal leaf on BOTH the checkpoint (the actual
  // pot spend) and the arkTx (the reference), so the condition must be satisfied
  // on both or one side's SHA256 fails (empty-stack on the checkpoint, or an
  // INVALID_SIGNATURE on the arkTx).
  addConditionWitness(built.checkpoints[0], 0, [args.playerRevealBytes])
  addConditionWitness(built.arkTx, 0, [args.playerRevealBytes])
  return built
}

/**
 * Build the StageTwo SETTLE (Phase 2 stage 2) — the house settles the contest to
 * the ACTUAL winner, using both now-on-chain reveals. The emulator computes the
 * winner (the win-predicate) and pays them, so the house cannot cheat. Mirrors
 * buildJointPotSettleTx but on the StageTwo covenant/output.
 */
export function buildStageTwoSettleTx(args: {
  stageTwo: StageTwoScript
  stageTwoOutpoint: Outpoint
  winner: 'player' | 'creator'
  winnerPayoutPkScript: Uint8Array
  potAmount: bigint
  playerRevealBytes: Uint8Array
  creatorRevealBytes: Uint8Array
  serverUnroll: CSVMultisigTapscript.Type
}): BuiltJointPotTx {
  const { stageTwo, stageTwoOutpoint, winner, winnerPayoutPkScript, potAmount } = args
  if (potAmount <= 0n || potAmount !== BigInt(stageTwoOutpoint.value)) {
    throw new Error(`buildStageTwoSettleTx: potAmount ${potAmount} must equal the StageTwo value ${stageTwoOutpoint.value}`)
  }
  const leaf = winner === 'player' ? stageTwo.playerWinCovenant() : stageTwo.creatorWinCovenant()
  const arkadeScript = winner === 'player' ? stageTwo.playerWinFullArkadeScript : stageTwo.creatorWinFullArkadeScript
  const input: ArkTxInput = {
    txid: stageTwoOutpoint.txid, vout: stageTwoOutpoint.vout, value: stageTwoOutpoint.value,
    tapLeafScript: leaf, tapTree: stageTwo.encode(),
  }
  const built = buildOffchainTx([input], [{ script: winnerPayoutPkScript, amount: potAmount }], args.serverUnroll)
  patchCheckpointPrevout(built, stageTwo.pkScript)
  emulator.addPacket(built.arkTx, [
    { vin: 0, script: arkadeScript, witness: emulator.encodeWitness([emulator.encodeIndex(0)]) },
  ])
  packets.addRevealPacket(built.arkTx, packets.REVEAL_PLAYER_PACKET_TYPE, args.playerRevealBytes)
  packets.addRevealPacket(built.arkTx, packets.REVEAL_CREATOR_PACKET_TYPE, args.creatorRevealBytes)
  return built
}

/**
 * Build the StageTwo TAKE-ALL (Phase 2 stage 2 fallback) — after finalExpiration,
 * the player sweeps the WHOLE pot via the `playerTakeAll` leaf. This is the
 * credible threat that forces the house to settle honestly: a stalling house
 * loses everything. Spends StageTwo via CLTVMultisig[player, server, emu(payTo
 * player)] @ finalExpiration into payTo(player, pot).
 */
export function buildStageTwoTakeAllTx(args: {
  stageTwo: StageTwoScript
  stageTwoOutpoint: Outpoint
  playerPayoutPkScript: Uint8Array
  potAmount: bigint
  serverUnroll: CSVMultisigTapscript.Type
}): BuiltJointPotTx {
  const { stageTwo, stageTwoOutpoint } = args
  if (args.potAmount <= 0n || args.potAmount !== BigInt(stageTwoOutpoint.value)) {
    throw new Error(`buildStageTwoTakeAllTx: potAmount ${args.potAmount} must equal the StageTwo value ${stageTwoOutpoint.value}`)
  }
  const input: ArkTxInput = {
    txid: stageTwoOutpoint.txid, vout: stageTwoOutpoint.vout, value: stageTwoOutpoint.value,
    tapLeafScript: stageTwo.playerTakeAll(), tapTree: stageTwo.encode(),
  }
  // playerTakeAll is a CLTV leaf (absolute @ finalExpiration), so buildOffchainTx
  // derives the nLockTime + flips the input sequence on both the checkpoint and the
  // arkTx automatically (buildVirtualTx handles CLTV leaves) — no manual sequence
  // surgery. arkd accepts absolute timelocks for offchain spends; it rejects relative
  // (CSV) ones, which is why this leaf is CLTV and not a settleWindow CSV.
  const built = buildOffchainTx([input], [{ script: args.playerPayoutPkScript, amount: args.potAmount }], args.serverUnroll)
  patchCheckpointPrevout(built, stageTwo.pkScript)
  emulator.addPacket(built.arkTx, [
    { vin: 0, script: stageTwo.takeAllArkadeScript, witness: emulator.encodeWitness([emulator.encodeIndex(0)]) },
  ])
  return built
}

/**
 * Build the REFUND — the house's protection against a player who co-funds then
 * never reveals. Spends the joint pot via the `cooperativeSpend` leaf
 * (CLTVMultisig[server, emu(splitTo)] @ cancelDelay) into TWO outputs: the
 * player's stake back to playerPayoutPkScript and the house's stake back to
 * housePayoutPkScript.
 *
 * COVENANT-ONLY (like the settle/forfeit): the emulator enforces the exact split
 * via the splitTo arkade script, so the refund needs NO player/creator pre-sign.
 * The house builds it on demand and POSTs it to the emulator, which co-signs only
 * a correctly-split tx; arkd co-signs the server slot after the CLTV.
 *
 * buildOffchainTx derives nLockTime = cancelDelay from the CLTV leaf, so the
 * refund cannot confirm until then — the normal settle finishes first (a losing
 * player can't refund-escape), yet the house can still refund a never-revealed
 * pot before the player's forfeit (finalExpiration) opens.
 */
export function buildJointPotRefundTx(args: {
  pot: CoinflipJointPotScript
  cofund: Outpoint
  playerStake: bigint
  houseStake: bigint
  playerPayoutPkScript: Uint8Array
  housePayoutPkScript: Uint8Array
  serverUnroll: CSVMultisigTapscript.Type
}): BuiltJointPotTx {
  const { pot, cofund } = args
  if (args.playerStake <= 0n || args.houseStake <= 0n) {
    throw new Error('buildJointPotRefundTx: both stakes must be positive')
  }
  if (args.playerStake + args.houseStake !== BigInt(cofund.value)) {
    throw new Error(
      `buildJointPotRefundTx: stakes (${args.playerStake} + ${args.houseStake}) must equal the pot value ${cofund.value}`,
    )
  }
  const input: ArkTxInput = {
    txid: cofund.txid, vout: cofund.vout, value: cofund.value,
    tapLeafScript: pot.cooperativeSpend(), tapTree: pot.encode(),
  }
  const outputs: PotOutput[] = [
    { script: args.playerPayoutPkScript, amount: args.playerStake },
    { script: args.housePayoutPkScript, amount: args.houseStake },
  ]
  const built = buildOffchainTx([input], outputs, args.serverUnroll)

  const cp = built.checkpoints[0]
  const cpIn = cp.getInput(0)
  if (cpIn?.witnessUtxo) {
    cp.updateInput(0, { witnessUtxo: { script: pot.pkScript, amount: cpIn.witnessUtxo.amount } })
  }
  // Emulator packet: the splitTo covenant inspects output 0 (player stake) and
  // output 1 (house stake). Witness = [playerOutIdx=0, houseOutIdx=1] (the house
  // index is on top, checked first — see buildSplitArkadeScript).
  emulator.addPacket(built.arkTx, [
    {
      vin: 0,
      script: pot.splitArkadeScript,
      witness: emulator.encodeWitness([emulator.encodeIndex(0), emulator.encodeIndex(1)]),
    },
  ])
  return built
}


/** Serialize a built tx for an emulator `/v1/tx` POST body. */
export function encodeSettleForEmulator(built: BuiltJointPotTx): { arkTx: string; checkpointTxs: string[] } {
  return {
    arkTx: base64.encode(built.arkTx.toPSBT()),
    checkpointTxs: built.checkpoints.map((c) => base64.encode(c.toPSBT())),
  }
}

// ── Client co-fund primitives (shared by the server /play + the client) ──────

/** A TapLeafScript serialized for HTTP transport (all bytes → hex). */
export interface SerializedTapLeaf {
  controlBlock: { version: number; internalKey: string; merklePath: string[] }
  script: string
}

/** Serialize a VTXO's tapleaf so it can ride a JSON response. */
export function serializeTapLeaf(tl: TapLeafScript): SerializedTapLeaf {
  return {
    controlBlock: {
      version: tl[0].version,
      internalKey: hex.encode(tl[0].internalKey),
      merklePath: tl[0].merklePath.map((m) => hex.encode(m)),
    },
    script: hex.encode(tl[1]),
  }
}

/** Rebuild a tapleaf from its serialized form (inverse of serializeTapLeaf). */
export function deserializeTapLeaf(s: SerializedTapLeaf): TapLeafScript {
  return [
    {
      version: s.controlBlock.version,
      internalKey: hex.decode(s.controlBlock.internalKey),
      merklePath: s.controlBlock.merklePath.map((m) => hex.decode(m)),
    },
    hex.decode(s.script),
  ]
}

/** A house stake input as serialized in the /play response (outpoint + the
 *  forfeit leaf + tapTree the client needs to spend it). */
export interface SerializedHouseInput {
  txid: string
  vout: number
  value: number
  leaf: SerializedTapLeaf
  tapTree: string
}

/** The subset of a /play response that buildCofundFromPlay reads. */
export interface PlayResponseForCofund {
  potAddress: string
  pot: number
  houseStake: number
  /** The house's reserved stake inputs (one or many) — rebuilt into the co-fund. */
  houseInputs: SerializedHouseInput[]
  covenant: { housePayoutPkScript: string }
}

/**
 * Assemble the (unsigned) co-fund from a /play response + the player's OWN stake
 * inputs — the client primitive. The player inputs are the client's enriched
 * VTXOs (one or many, summing to ≥ tier); the house inputs are rebuilt from the
 * serialized leaves + tapTrees (no server-side VTXO access). Both sides may
 * contribute arbitrary inputs; change is computed from the per-side sums. The
 * caller then signs its own input vins and drives the /cofund handshake.
 */
export function buildCofundFromPlay(args: {
  play: PlayResponseForCofund
  playerInputs: ArkTxInput[]
  playerChangePkScript: Uint8Array
  betAmount: number
  serverUnroll: CSVMultisigTapscript.Type
}): BuiltJointPotTx {
  const { play } = args
  const houseInputs: ArkTxInput[] = play.houseInputs.map((h) => ({
    txid: h.txid, vout: h.vout, value: h.value,
    tapLeafScript: deserializeTapLeaf(h.leaf), tapTree: hex.decode(h.tapTree),
  }))
  const playerSum = args.playerInputs.reduce((s, i) => s + i.value, 0)
  const houseSum = play.houseInputs.reduce((s, h) => s + h.value, 0)
  const outs = jointPotCofundOutputs({
    potPkScript: ArkAddress.decode(play.potAddress).pkScript, potAmount: BigInt(play.pot),
    playerChangePkScript: args.playerChangePkScript, playerChange: BigInt(playerSum - args.betAmount),
    houseChangePkScript: hex.decode(play.covenant.housePayoutPkScript), houseChange: BigInt(houseSum - play.houseStake),
  })
  return buildJointPotCofundTx(args.playerInputs, houseInputs, outs, args.serverUnroll)
}
