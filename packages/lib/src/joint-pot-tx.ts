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

import { base64 } from '@scure/base'
import {
  buildOffchainTx,
  CSVMultisigTapscript,
  Transaction,
  type ArkTxInput,
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
