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

/**
 * Build the player's FORFEIT claim — the recovery path when the pot is funded
 * but the server never settles. Spends the joint pot via the `playerForfeit`
 * leaf into payTo(player, pot): the player sweeps the WHOLE pot. That leaf is
 * CLTVMultisig[player, server, emu_tweaked(payTo(player,pot))], so the claim is
 * collaborative (player + server + emulator) and valid only after the game's
 * finalExpiration (the leaf's absolute timelock). The server signs its slot via
 * /api/v4/game/:id/forfeit; the player signs and POSTs to the emulator.
 *
 * No reveal packets: the covenant is a bare payTo (it reads no secrets). For a
 * server that's gone entirely, the unilateral `playerForfeitExit` leaf (player +
 * emulator, after the CSV exit delay, with the secret as a condition witness) is
 * the no-server backstop — a separate builder still to come.
 */
export function buildJointPotForfeitClaim(args: {
  pot: CoinflipJointPotScript
  cofund: Outpoint
  playerPayoutPkScript: Uint8Array
  potAmount: bigint
  serverUnroll: CSVMultisigTapscript.Type
}): BuiltJointPotTx {
  const { pot, cofund } = args
  // The pot is 1-input→1-output with no ark-tx fee: the payout MUST equal the
  // pot value. Fail loud + early on a mismatch (cofund.value is a number).
  if (args.potAmount <= 0n || args.potAmount !== BigInt(cofund.value)) {
    throw new Error(`buildJointPotForfeitClaim: potAmount ${args.potAmount} must equal the pot value ${cofund.value}`)
  }
  const input: ArkTxInput = {
    txid: cofund.txid, vout: cofund.vout, value: cofund.value,
    tapLeafScript: pot.playerForfeit(), tapTree: pot.encode(),
  }
  const built = buildOffchainTx([input], [{ script: args.playerPayoutPkScript, amount: args.potAmount }], args.serverUnroll)

  const cp = built.checkpoints[0]
  const cpIn = cp.getInput(0)
  if (cpIn?.witnessUtxo) {
    cp.updateInput(0, { witnessUtxo: { script: pot.pkScript, amount: cpIn.witnessUtxo.amount } })
  }
  // Emulator packet: forfeitArkadeScript = payTo(player, pot), inspects output 0.
  emulator.addPacket(built.arkTx, [
    { vin: 0, script: pot.forfeitArkadeScript, witness: emulator.encodeWitness([emulator.encodeIndex(0)]) },
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
