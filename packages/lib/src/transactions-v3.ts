/**
 * v0.3 escrow transaction-building helpers — parallel to transactions.ts.
 *
 * Mirrors the v0.2.x helpers' surface so callers (server, client) can swap
 * between v2 / v3 by routing on `game.contractVersion`. Only the
 * escrow-script construction differs (`CoinflipEscrowScriptV3` vs. v2's
 * `CoinflipEscrowScript`); the broader tx-builder API stays compatible.
 *
 * Sweep / forfeit / refund tx builders for v3 live next to their v2
 * counterparts and reuse the same patterns; the only v3-specific addition
 * is reveal-packet attachment via `addRevealPacket` (called from the
 * server's commit handler, not here — this module stays transport-free).
 */

import { hex } from '@scure/base'
import {
  ArkAddress,
  ArkInfo,
  buildOffchainTx,
  CSVMultisigTapscript,
  decodeTapscript,
  Transaction,
  type TapLeafScript,
} from '@arkade-os/sdk'
import { emulator, packets } from '@arklabshq/contract-workflows-prototype'
import {
  CoinflipEscrowScriptV3,
  type CoinflipEscrowOptionsV3,
} from './script-v3'
import { type DigitCommit } from './arkade-win'
import type { Game } from './types'
import type { BuiltOffchainTx } from './transactions'

function assertDefined<T>(v: T | undefined | null, name: string): asserts v is T {
  if (v === undefined || v === null) throw new Error(`${name} is required for v3`)
}

function escrowScriptV3(game: Game, refundPubkey: Uint8Array): CoinflipEscrowScriptV3 {
  assertDefined(game.creator, 'creator')
  assertDefined(game.player, 'player')
  assertDefined(game.serverPubkey, 'serverPubkey')
  assertDefined(game.creator.hash, 'creator.hash')
  assertDefined(game.creator.pubkey, 'creator.pubkey')
  assertDefined(game.player.pubkey, 'player.pubkey')
  assertDefined(game.player.hash, 'player.hash')
  assertDefined(game.finalExpiration, 'finalExpiration')
  assertDefined(game.emulatorPubkey, 'emulatorPubkey')
  assertDefined(game.playerForfeitPkScript, 'playerForfeitPkScript')
  assertDefined(game.housePayoutPkScript, 'housePayoutPkScript')
  assertDefined(game.playerStake, 'playerStake')
  assertDefined(game.houseStake, 'houseStake')
  assertDefined(game.exitDelay, 'exitDelay')
  assertDefined(game.oddsN, 'oddsN (v3 requires variable-odds; n=2 is the coin)')
  assertDefined(game.oddsTarget, 'oddsTarget')
  // oddsLo defaults to 0 for the coin / "0 to target" range.
  const lo = game.oddsLo ?? 0
  return new CoinflipEscrowScriptV3({
    creatorPubkey: game.creator.pubkey,
    playerPubkey: game.player.pubkey,
    serverPubkey: game.serverPubkey,
    creatorHash: game.creator.hash,
    playerHash: game.player.hash,
    finalExpiration: BigInt(game.finalExpiration),
    refundPubkey,
    exitDelay: BigInt(game.exitDelay),
    oddsN: game.oddsN,
    oddsTarget: game.oddsTarget,
    oddsLo: lo,
    arkadeForfeit: {
      emulatorPubkey: game.emulatorPubkey,
      playerPayoutPkScript: game.playerForfeitPkScript,
      housePayoutPkScript: game.housePayoutPkScript,
      playerStake: BigInt(game.playerStake),
      houseStake: BigInt(game.houseStake),
    },
  })
}

export function getPlayerEscrowScriptV3(game: Game): CoinflipEscrowScriptV3 {
  return escrowScriptV3(game, game.player!.pubkey!)
}

export function getHouseEscrowScriptV3(game: Game): CoinflipEscrowScriptV3 {
  return escrowScriptV3(game, game.creator!.pubkey!)
}

export function getPlayerEscrowAddressV3(game: Game, networkHrp: string): ArkAddress {
  return getPlayerEscrowScriptV3(game).address(networkHrp, game.serverPubkey!)
}

export function getHouseEscrowAddressV3(game: Game, networkHrp: string): ArkAddress {
  return getHouseEscrowScriptV3(game).address(networkHrp, game.serverPubkey!)
}

export function getPlayerEscrowOptionsV3(game: Game): CoinflipEscrowOptionsV3 {
  return getPlayerEscrowScriptV3(game).options
}

export function getHouseEscrowOptionsV3(game: Game): CoinflipEscrowOptionsV3 {
  return getHouseEscrowScriptV3(game).options
}

export interface EscrowInputV3 {
  script: CoinflipEscrowScriptV3
  txid: string
  vout: number
  value: number
}

export interface CovenantSweepArgsV3 {
  winner: 'player' | 'house'
  /** Exactly 2 escrows: player's escrow and house's escrow. */
  escrows: [EscrowInputV3, EscrowInputV3]
  /** Address the pot is paid to (winner's Ark address). */
  payoutAddress: string
  /** Total pot = sum of both stakes. */
  potAmount: bigint
  /** Both parties' digit + salt reveals (server holds both at commit time). */
  playerReveal: DigitCommit
  creatorReveal: DigitCommit
}

/**
 * Build the v3 covenant sweep transaction.
 *
 * Two-input → one-output atomic sweep:
 *   - Inputs: both escrow VTXOs spent via the winner's covenant leaf.
 *   - Output: full pot to winner's payout address.
 *
 * Witness components per input:
 *   - Multisig sigs: [server_sig, emu_sig] (server signs at /commit, emu cosigns
 *     after running the arkade-script).
 *   - EmulatorPacket: carries the full arkade-script (predicate + atomic-sweep
 *     covenant) committed via the emu-tweaked key. Per-input witness =
 *     `[output_index=0, other_input_index=1-i]`.
 *
 * Extension packets on the tx (NEW in v3 — read by OP_INSPECTPACKET):
 *   - 0x10 (REVEAL_PLAYER_PACKET_TYPE):  `[playerDigit] ‖ playerSalt`
 *   - 0x11 (REVEAL_CREATOR_PACKET_TYPE): `[creatorDigit] ‖ creatorSalt`
 *
 * NO ConditionWitness — v3 leaves are plain Multisig (predicate moved into
 * arkade-script). NO secret bytes in the witness stack — reveals ride packets.
 */
export function buildCovenantSweepTransactionV3(
  arkInfo: ArkInfo,
  args: CovenantSweepArgsV3,
): BuiltOffchainTx & {
  emulatorEntries: { vin: number; script: Uint8Array; witness: Uint8Array }[]
} {
  if (args.potAmount <= 0n) {
    throw new Error('buildCovenantSweepTransactionV3: potAmount must be positive')
  }
  const serverUnrollScript = decodeTapscript(
    hex.decode(arkInfo.checkpointTapscript),
  ) as CSVMultisigTapscript.Type

  const leafFor = (s: CoinflipEscrowScriptV3): TapLeafScript =>
    args.winner === 'player' ? s.playerWinCovenant() : s.creatorWinCovenant()
  const arkadeFor = (s: CoinflipEscrowScriptV3): Uint8Array =>
    args.winner === 'player' ? s.playerWinFullArkadeScript : s.creatorWinFullArkadeScript

  const inputs = args.escrows.map((e) => ({
    txid: e.txid,
    vout: e.vout,
    value: e.value,
    tapLeafScript: leafFor(e.script),
    tapTree: e.script.encode(),
  }))

  const payoutAddr = ArkAddress.decode(args.payoutAddress)
  const outputs = [{ script: payoutAddr.pkScript, amount: args.potAmount }]

  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, serverUnrollScript)

  // EmulatorPacket per input: arkade-script + covenant witness args.
  // Witness layout: `[out_idx=0, other_in_idx=(1-i)]` — covenant pops these in
  // order. EmulatorPacket entries carry the script + per-input witness so the
  // emulator can re-run each leaf's commitment under its specific witness.
  const emulatorEntries = args.escrows.map((_e, i) => ({
    vin: i,
    script: arkadeFor(args.escrows[i].script),
    witness: emulator.encodeWitness([
      emulator.encodeIndex(0),
      emulator.encodeIndex(1 - i),
    ]),
  }))
  emulator.addPacket(arkTx, emulatorEntries)

  // Reveal packets — game-specific digit+salt reveals read by OP_INSPECTPACKET.
  // Attached to the arkTx ONLY (the spending tx the emu sees when running the
  // arkade-script). DO NOT add them to checkpoints — that would mutate the
  // checkpoint txs, changing their hashes, and breaking the
  // arkTx.input[i].txid → checkpoint[i].id linkage that buildOffchainTx
  // established at construction time. The emu's checkpoint resolution would
  // then fail with "checkpoint not found for input i".
  const playerData = packets.encodeReveal(args.playerReveal.digit, args.playerReveal.salt)
  const creatorData = packets.encodeReveal(args.creatorReveal.digit, args.creatorReveal.salt)
  packets.addRevealPacket(arkTx, packets.REVEAL_PLAYER_PACKET_TYPE, playerData)
  packets.addRevealPacket(arkTx, packets.REVEAL_CREATOR_PACKET_TYPE, creatorData)

  return { arkTx, checkpoints, emulatorEntries }
}

// Ensure the unused parameter import is not flagged.
void Transaction
