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
  ArkTxInput,
  buildOffchainTx,
  CSVMultisigTapscript,
  decodeTapscript,
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
  // Runtime guards. The TS tuple `[EscrowInputV3, EscrowInputV3]` is a
  // compile-time constraint — a deserialized JSON array or `as any` cast slips
  // past it. The emulator-witness builder below assumes exactly 2 escrows
  // (witness index is `1 - i`), so 3+ escrows would produce negative indices
  // and a witness the emulator rejects opaquely. Fail loudly here instead.
  if (args.escrows.length !== 2) {
    throw new Error(
      `buildCovenantSweepTransactionV3: requires exactly 2 escrows (got ${args.escrows.length})`,
    )
  }
  if (args.potAmount <= 0n) {
    throw new Error('buildCovenantSweepTransactionV3: potAmount must be positive')
  }
  // Self-consistency: the atomic-sweep covenant pins output[0].amount to the
  // exact potAmount, AND each leaf's covenant pins the OTHER input's value.
  // A potAmount that doesn't match the sum of escrow values will be rejected
  // by the emulator with an opaque "output value mismatch" deep in arkade-
  // script evaluation; surface the mismatch here as a clear local error.
  const expectedPot = BigInt(args.escrows[0].value) + BigInt(args.escrows[1].value)
  if (args.potAmount !== expectedPot) {
    throw new Error(
      `buildCovenantSweepTransactionV3: potAmount ${args.potAmount} != sum of escrow values ${expectedPot}`,
    )
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

  // Patch witnessUtxo.script on each CHECKPOINT'S input. Each checkpoint
  // spends one of our escrow VTXOs; buildOffchainTx sets the checkpoint's
  // input.witnessUtxo.script via `VtxoScript.decode(input.tapTree).pkScript`,
  // which goes through scure-btc-signer's Huffman tree builder. For v3's
  // 10-leaf taptree the SDK's Huffman shape disagrees with arkd's btcd
  // tree — wrong pkScript. We override the parent VtxoScript's tree
  // derivation inside CoinflipEscrowScriptV3, so `e.script.pkScript` is
  // the btcd-correct on-chain prevout. Patch the checkpoint to match.
  //
  // The arkTx's inputs reference the CHECKPOINT outputs (2-leaf VtxoScript
  // = `[serverUnroll, collaborativeClosure]`), which the SDK builds
  // identically with Huffman vs btcd (2 leaves form the simplest balanced
  // tree), so the arkTx's witnessUtxo stays correct without patching.
  for (let i = 0; i < args.escrows.length; i++) {
    const cp = checkpoints[i]
    const cpInput = cp.getInput(0)
    if (cpInput?.witnessUtxo) {
      cp.updateInput(0, {
        witnessUtxo: {
          script: args.escrows[i].script.pkScript,
          amount: cpInput.witnessUtxo.amount,
        },
      })
    }
  }

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

/**
 * v3 refund builder — same shape as v2 `buildRefundTransaction` but binds to
 * the v3 escrow's `refund()` leaf (UNCHANGED from v2 at the leaf-script level,
 * but lives in a different tap-tree shape, so encode()/refund() differ).
 */
export interface RefundArgsV3 {
  escrowScript: CoinflipEscrowScriptV3
  txid: string
  vout: number
  value: number
  refundAddress: string
}

export function buildRefundTransactionV3(
  arkInfo: ArkInfo,
  args: RefundArgsV3,
): BuiltOffchainTx {
  const serverUnrollScript = decodeTapscript(
    hex.decode(arkInfo.checkpointTapscript),
  ) as CSVMultisigTapscript.Type

  const input: ArkTxInput = {
    txid: args.txid,
    vout: args.vout,
    value: args.value,
    tapLeafScript: args.escrowScript.refund(),
    tapTree: args.escrowScript.encode(),
  }
  const refundAddr = ArkAddress.decode(args.refundAddress)
  const { arkTx, checkpoints } = buildOffchainTx(
    [input],
    [{ script: refundAddr.pkScript, amount: BigInt(args.value) }],
    serverUnrollScript,
  )

  return { arkTx, checkpoints }
}

/**
 * v3 R1 forfeit-claim builder. Two-input → one-output atomic sweep through each
 * escrow's `playerForfeit` (CLTV) leaf, paying the full pot to the player.
 *
 * The leaf is `CLTVMultisig[player, server, emu_tweaked(forfeitArkadeScript)]`,
 * same shape as v2. Difference vs v2: the escrow's TAP TREE uses btcd's
 * algorithm (`CoinflipEscrowScriptV3` overrides the parent's huffman build),
 * so the tap-key + per-leaf merkle proof differ. Using `e.script.encode()` +
 * `e.script.playerForfeit()` from v3 keeps the consensus side correct.
 *
 * Like v3 covenant-sweep: NO ConditionWitness needed (no condition-multisig
 * closure on this leaf), and we patch each checkpoint's witnessUtxo to the
 * btcd-correct pkScript (the SDK's buildOffchainTx re-derives it from the
 * tapTree via the SDK's Huffman builder, which is wrong for 10 leaves).
 */
export interface ForfeitClaimArgsV3 {
  /** Exactly 2 escrows: player's escrow and house's escrow. */
  escrows: [EscrowInputV3, EscrowInputV3]
  /** Player's payout address (the covenant pins this exactly). */
  payoutAddress: string
  /** Full pot = sum of both stakes. */
  potAmount: bigint
}

export function buildForfeitClaimTransactionV3(
  arkInfo: ArkInfo,
  args: ForfeitClaimArgsV3,
): BuiltOffchainTx & {
  emulatorEntries: { vin: number; script: Uint8Array; witness: Uint8Array }[]
} {
  // Same runtime + consistency guards as buildCovenantSweepTransactionV3:
  // the TS tuple type evaporates at runtime, and the emulator-witness builder
  // below assumes exactly 2 escrows.
  if (args.escrows.length !== 2) {
    throw new Error(
      `buildForfeitClaimTransactionV3: requires exactly 2 escrows (got ${args.escrows.length})`,
    )
  }
  if (args.potAmount <= 0n) {
    throw new Error('buildForfeitClaimTransactionV3: potAmount must be positive')
  }
  const expectedPot = BigInt(args.escrows[0].value) + BigInt(args.escrows[1].value)
  if (args.potAmount !== expectedPot) {
    throw new Error(
      `buildForfeitClaimTransactionV3: potAmount ${args.potAmount} != sum of escrow values ${expectedPot}`,
    )
  }
  const serverUnrollScript = decodeTapscript(
    hex.decode(arkInfo.checkpointTapscript),
  ) as CSVMultisigTapscript.Type

  const inputs: ArkTxInput[] = args.escrows.map((e) => ({
    txid: e.txid,
    vout: e.vout,
    value: e.value,
    tapLeafScript: e.script.playerForfeit(),
    tapTree: e.script.encode(),
  }))

  const payoutAddr = ArkAddress.decode(args.payoutAddress)
  const outputs = [{ script: payoutAddr.pkScript, amount: args.potAmount }]

  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, serverUnrollScript)

  // Same checkpoint witnessUtxo patch as buildCovenantSweepTransactionV3 — see
  // the comment block there for the root-cause rationale (SDK Huffman vs btcd
  // tap-key mismatch on 10-leaf taptrees).
  for (let i = 0; i < args.escrows.length; i++) {
    const cp = checkpoints[i]
    const cpInput = cp.getInput(0)
    if (cpInput?.witnessUtxo) {
      cp.updateInput(0, {
        witnessUtxo: {
          script: args.escrows[i].script.pkScript,
          amount: cpInput.witnessUtxo.amount,
        },
      })
    }
  }

  const emulatorEntries = args.escrows.map((_e, i) => ({
    vin: i,
    script: args.escrows[i].script.forfeitArkadeScript,
    witness: emulator.encodeWitness([
      emulator.encodeIndex(0),
      emulator.encodeIndex(1 - i),
    ]),
  }))
  emulator.addPacket(arkTx, emulatorEntries)

  return { arkTx, checkpoints, emulatorEntries }
}

/**
 * v3 winner determination — mirrors the on-chain arkade-script in
 * `buildVariableOddsWinPredicate`. Bad creator → player wins; bad player →
 * creator wins; else `(digitC + digitP) mod n` in `[lo, target)` → player wins.
 *
 * Inputs are the FULL reveal bytes — `[digitByte] ‖ salt` produced by
 * `packets.encodeReveal(digit, salt)`. The first byte IS the digit, by
 * construction (`pushNum(1) OP_LEFT OP_BIN2NUM` reads it on-chain).
 */
export function determineWinnerV3(
  creatorReveal: DigitCommit,
  playerReveal: DigitCommit,
  n: number,
  target: number,
  lo: number,
): 'creator' | 'player' {
  const dC = creatorReveal.digit
  const dP = playerReveal.digit
  if (dC < 0 || dC >= n) return 'player' // bad creator → player wins
  if (dP < 0 || dP >= n) return 'creator' // bad player → creator wins
  const roll = (dC + dP) % n
  return roll >= lo && roll < target ? 'player' : 'creator'
}

/**
 * Roll value `(digitC + digitP) mod n` for display, or null if either digit
 * is out of `[0, n)` (winner was decided by the cheat-penalty, not a fair roll).
 */
export function computeRollV3(
  creatorReveal: DigitCommit,
  playerReveal: DigitCommit,
  n: number,
): number | null {
  const dC = creatorReveal.digit, dP = playerReveal.digit
  if (dC < 0 || dC >= n || dP < 0 || dP >= n) return null
  return (dC + dP) % n
}

