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
 * Build the atomic co-fund: ONE offchain tx spending the player's stake input
 * (vin 0) and the house's stake input (vin 1) into the joint-pot output (vout 0)
 * plus changes. Each party then signs ONLY its own input + checkpoint; arkd
 * cosigns. (Proven feasible by v4-cofund-probe.)
 */
export function buildJointPotCofundTx(
  playerInput: ArkTxInput,
  houseInput: ArkTxInput,
  outputs: PotOutput[],
  serverUnroll: CSVMultisigTapscript.Type,
): BuiltJointPotTx {
  return buildOffchainTx([playerInput, houseInput], outputs, serverUnroll)
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

/** The subset of a /play response that buildCofundFromPlay reads. */
export interface PlayResponseForCofund {
  potAddress: string
  pot: number
  houseStake: number
  houseVtxo: { txid: string; vout: number; value: number }
  houseLeaf: SerializedTapLeaf
  houseTapTree: string
  covenant: { housePayoutPkScript: string }
}

/**
 * Assemble the (unsigned) co-fund from a /play response + the player's own stake
 * input — the client primitive. The player input is the client's enriched VTXO;
 * the house input is rebuilt from the serialized leaf + tapTree (no server-side
 * VTXO access). The caller then signs vin 0 and drives the /cofund handshake.
 */
export function buildCofundFromPlay(args: {
  play: PlayResponseForCofund
  playerInput: ArkTxInput
  playerChangePkScript: Uint8Array
  betAmount: number
  serverUnroll: CSVMultisigTapscript.Type
}): BuiltJointPotTx {
  const { play } = args
  const houseInput: ArkTxInput = {
    txid: play.houseVtxo.txid, vout: play.houseVtxo.vout, value: play.houseVtxo.value,
    tapLeafScript: deserializeTapLeaf(play.houseLeaf),
    tapTree: hex.decode(play.houseTapTree),
  }
  const outs = jointPotCofundOutputs({
    potPkScript: ArkAddress.decode(play.potAddress).pkScript, potAmount: BigInt(play.pot),
    playerChangePkScript: args.playerChangePkScript, playerChange: BigInt(args.playerInput.value - args.betAmount),
    houseChangePkScript: hex.decode(play.covenant.housePayoutPkScript), houseChange: BigInt(play.houseVtxo.value - play.houseStake),
  })
  return buildJointPotCofundTx(args.playerInput, houseInput, outs, args.serverUnroll)
}
