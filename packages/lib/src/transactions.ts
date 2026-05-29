/**
 * Transaction building for coinflip games using SDK primitives.
 */

import { randomBytes } from 'crypto'
import { hex } from '@scure/base'
import {
  ArkAddress,
  ArkInfo,
  ArkTxInput,
  buildOffchainTx,
  CSVMultisigTapscript,
  decodeTapscript,
  Transaction,
  VtxoScript,
  ConditionWitness,
  setArkPsbtField,
  getArkPsbtFields,
  TapLeafScript,
} from '@arkade-os/sdk'
// `@scure/btc-signer` exposes this via the `./payment.js` subpath (its
// package.json `exports` map requires the `.js` suffix); without the
// suffix Node's runtime resolver returns ERR_PACKAGE_PATH_NOT_EXPORTED.
import { TAP_LEAF_VERSION, tapLeafHash } from '@scure/btc-signer/payment.js'
import { CoinflipSetupScript, CoinflipFinalScript, CoinflipEscrowScript, VARIABLE_ODDS_BASE_LEN } from './script'
import { Game, VtxoInput } from './types'
import {
  addEmulatorPacket,
  encodeEmulatorWitness,
  encodeOutputIndexWitness,
} from './arkade-forfeit'

function assertDefined<T>(value: T | undefined | null, name: string): asserts value is T {
  if (value === undefined || value === null) {
    throw new Error(`Missing ${name}`)
  }
}

/** Get the setup VtxoScript for a game */
export function getSetupScript(game: Game): CoinflipSetupScript {
  assertDefined(game.creator, 'creator')
  assertDefined(game.player, 'player')
  assertDefined(game.serverPubkey, 'serverPubkey')
  assertDefined(game.creator.hash, 'creator.hash')
  assertDefined(game.creator.pubkey, 'creator.pubkey')
  assertDefined(game.player.pubkey, 'player.pubkey')
  assertDefined(game.setupExpiration, 'setupExpiration')

  return new CoinflipSetupScript({
    creatorPubkey: game.creator.pubkey,
    playerPubkey: game.player.pubkey,
    serverPubkey: game.serverPubkey,
    creatorHash: game.creator.hash,
    setupExpiration: BigInt(game.setupExpiration),
  })
}

/** Get the final VtxoScript for a game */
export function getFinalScript(game: Game): CoinflipFinalScript {
  assertDefined(game.creator, 'creator')
  assertDefined(game.player, 'player')
  assertDefined(game.serverPubkey, 'serverPubkey')
  assertDefined(game.creator.hash, 'creator.hash')
  assertDefined(game.creator.pubkey, 'creator.pubkey')
  assertDefined(game.player.pubkey, 'player.pubkey')
  assertDefined(game.player.hash, 'player.hash')
  assertDefined(game.finalExpiration, 'finalExpiration')

  return new CoinflipFinalScript({
    creatorPubkey: game.creator.pubkey,
    playerPubkey: game.player.pubkey,
    serverPubkey: game.serverPubkey,
    creatorHash: game.creator.hash,
    playerHash: game.player.hash,
    finalExpiration: BigInt(game.finalExpiration),
  })
}

/** Get the ArkAddress for the setup output */
export function getSetupAddress(game: Game, networkHrp: string): ArkAddress {
  assertDefined(game.serverPubkey, 'serverPubkey')
  const script = getSetupScript(game)
  return script.address(networkHrp, game.serverPubkey)
}

/** Get the ArkAddress for the final output */
export function getFinalAddress(game: Game, networkHrp: string): ArkAddress {
  assertDefined(game.serverPubkey, 'serverPubkey')
  const script = getFinalScript(game)
  return script.address(networkHrp, game.serverPubkey)
}

/**
 * Per-party escrow scripts. Both share the win leaves but differ in an
 * owner-scoped refund leaf, so each party can only reclaim its OWN escrow on a
 * stall — the house cannot sweep the player's stake (abort-theft fix).
 *
 * Arkade-script forfeit (5th leaf) is layered on when `game.emulatorPubkey`
 * and `game.playerForfeitPkScript` are both set. **Atomic-sweep mode**
 * (default for callers that pass `otherStakeValue`) binds BOTH escrows
 * together — the covenant on each input verifies the other input's value,
 * so neither escrow is spendable alone via forfeit. Single-output pays the
 * full pot.
 *
 * Per-escrow caller wiring:
 *   - player escrow: `forfeitDestValue = pot`, `otherStakeValue = houseStake`
 *   - house escrow:  `forfeitDestValue = pot`, `otherStakeValue = playerStake`
 *
 * Both `forfeitDestValue` values are the SAME (the pot); the `otherStakeValue`
 * is what's symmetric — each covenant pins the other's contribution.
 */
function escrowScript(
  game: Game,
  refundPubkey: Uint8Array,
  forfeitDestValue?: bigint,
  otherStakeValue?: bigint,
): CoinflipEscrowScript {
  assertDefined(game.creator, 'creator')
  assertDefined(game.player, 'player')
  assertDefined(game.serverPubkey, 'serverPubkey')
  assertDefined(game.creator.hash, 'creator.hash')
  assertDefined(game.creator.pubkey, 'creator.pubkey')
  assertDefined(game.player.pubkey, 'player.pubkey')
  assertDefined(game.player.hash, 'player.hash')
  assertDefined(game.finalExpiration, 'finalExpiration')
  assertDefined(game.penaltyTimelockSeconds, 'penaltyTimelockSeconds')
  const arkadeForfeit =
    game.emulatorPubkey && game.playerForfeitPkScript && forfeitDestValue !== undefined
      ? {
          emulatorPubkey: game.emulatorPubkey,
          forfeitDestPkScript: game.playerForfeitPkScript,
          forfeitDestValue,
          otherStakeValue,
        }
      : undefined
  return new CoinflipEscrowScript({
    creatorPubkey: game.creator.pubkey,
    playerPubkey: game.player.pubkey,
    serverPubkey: game.serverPubkey,
    creatorHash: game.creator.hash,
    playerHash: game.player.hash,
    finalExpiration: BigInt(game.finalExpiration),
    penaltyTimelockSeconds: BigInt(game.penaltyTimelockSeconds),
    refundPubkey,
    oddsN: game.oddsN,
    oddsTarget: game.oddsTarget,
    oddsLo: game.oddsLo,
    arkadeForfeit,
  })
}

/**
 * Escrow the player funds; refundable only by the player after timeout.
 *
 * @param forfeitDestValue — required ONLY when wiring the arkade-script leaf.
 *   Pass the FULL POT (atomic mode) or the player stake alone (legacy single-
 *   input mode). Omit for the legacy 4-leaf escrow.
 * @param otherStakeValue — when set, switches to atomic-sweep mode. Pass the
 *   HOUSE stake for the player escrow.
 */
export function getPlayerEscrowScript(
  game: Game,
  forfeitDestValue?: bigint,
  otherStakeValue?: bigint,
): CoinflipEscrowScript {
  return escrowScript(game, game.player!.pubkey!, forfeitDestValue, otherStakeValue)
}

/**
 * Escrow the house funds; refundable only by the house after timeout.
 *
 * @param forfeitDestValue — full pot in atomic mode, house stake alone in
 *   legacy single-input mode. Omit for the legacy 4-leaf escrow.
 * @param otherStakeValue — atomic mode: pass the PLAYER stake.
 */
export function getHouseEscrowScript(
  game: Game,
  forfeitDestValue?: bigint,
  otherStakeValue?: bigint,
): CoinflipEscrowScript {
  return escrowScript(game, game.creator!.pubkey!, forfeitDestValue, otherStakeValue)
}

export function getPlayerEscrowAddress(
  game: Game,
  networkHrp: string,
  forfeitDestValue?: bigint,
  otherStakeValue?: bigint,
): ArkAddress {
  return getPlayerEscrowScript(game, forfeitDestValue, otherStakeValue).address(
    networkHrp,
    game.serverPubkey!,
  )
}

export function getHouseEscrowAddress(
  game: Game,
  networkHrp: string,
  forfeitDestValue?: bigint,
  otherStakeValue?: bigint,
): ArkAddress {
  return getHouseEscrowScript(game, forfeitDestValue, otherStakeValue).address(
    networkHrp,
    game.serverPubkey!,
  )
}

/** Get the pot amount (2x bet) */
export function getPotAmount(game: Game): bigint {
  assertDefined(game.betAmount, 'betAmount')
  return 2n * game.betAmount
}

/**
 * Convert a VtxoInput to an ArkTxInput suitable for buildOffchainTx.
 */
function vtxoInputToArkTxInput(input: VtxoInput): ArkTxInput {
  const scripts = input.vtxo.tapscripts.map((s: string) => hex.decode(s))
  const vtxoScript = new VtxoScript(scripts)
  const leafScript = vtxoScript.findLeaf(input.leaf)

  return {
    txid: input.vtxo.outpoint.txid,
    vout: input.vtxo.outpoint.vout,
    value: Number(input.vtxo.amount),
    tapLeafScript: leafScript,
    tapTree: vtxoScript.encode(),
  }
}

/**
 * A built Ark off-chain transaction with its checkpoint chain. Both halves
 * are needed to submit through `arkProvider.submitTx(arkTx, checkpoints)`;
 * the older API returned only the `arkTx`, which made the trustless
 * fallback actually unsubmittable to arkd.
 */
export interface BuiltOffchainTx {
  arkTx: Transaction
  checkpoints: Transaction[]
}

/**
 * Build the setup and final transactions for a coinflip game.
 *
 * Each half carries its own checkpoint set — the setup tx consumes the
 * creator + player wallet VTXOs (one checkpoint per input), and the
 * final tx consumes the setup output via the reveal leaf (one checkpoint
 * for that single input). Callers that actually want to broadcast (the
 * trustless fallback path) need both PSBTs *and* the checkpoint PSBTs.
 */
export function buildGameTransactions(
  game: Game,
  arkInfo: ArkInfo,
  networkHrp: string,
): { setup: BuiltOffchainTx; final: BuiltOffchainTx } {
  assertDefined(game.creator, 'creator')
  assertDefined(game.player, 'player')
  assertDefined(game.creator.vtxos, 'creator.vtxos')
  assertDefined(game.player.vtxos, 'player.vtxos')
  assertDefined(game.betAmount, 'betAmount')

  // Decode server unroll script from arkInfo
  const serverUnrollScript = decodeTapscript(
    hex.decode(arkInfo.checkpointTapscript)
  ) as CSVMultisigTapscript.Type

  // Build setup transaction inputs
  const allVtxoInputs = [...game.creator.vtxos, ...game.player.vtxos]
  const setupInputs = allVtxoInputs.map(vtxoInputToArkTxInput)

  // Build setup outputs
  const setupAddress = getSetupAddress(game, networkHrp)
  const potAmount = getPotAmount(game)

  const setupOutputs: { script: Uint8Array; amount: bigint }[] = [
    { script: setupAddress.pkScript, amount: potAmount },
  ]

  // Creator change
  const creatorSum = game.creator.vtxos.reduce(
    (acc, v) => acc + BigInt(v.vtxo.amount),
    0n
  )
  const creatorChange = creatorSum - game.betAmount
  if (creatorChange < 0n) throw new Error('Creator insufficient funds')
  if (creatorChange > 0n) {
    assertDefined(game.creator.changeAddress, 'creator.changeAddress')
    const changeAddr = ArkAddress.decode(game.creator.changeAddress)
    setupOutputs.push({ script: changeAddr.pkScript, amount: creatorChange })
  }

  // Player change
  const playerSum = game.player.vtxos.reduce(
    (acc, v) => acc + BigInt(v.vtxo.amount),
    0n
  )
  const playerChange = playerSum - game.betAmount
  if (playerChange < 0n) throw new Error('Player insufficient funds')
  if (playerChange > 0n) {
    assertDefined(game.player.changeAddress, 'player.changeAddress')
    const changeAddr = ArkAddress.decode(game.player.changeAddress)
    setupOutputs.push({ script: changeAddr.pkScript, amount: playerChange })
  }

  const { arkTx: setupArkTx, checkpoints: setupCheckpoints } = buildOffchainTx(
    setupInputs,
    setupOutputs,
    serverUnrollScript,
  )

  // Apply existing signatures to setup tx if present
  applySetupSignatures(setupArkTx, game)

  // Build final transaction
  const setupScript = getSetupScript(game)
  const finalInput: ArkTxInput = {
    txid: setupArkTx.id!,
    vout: 0,
    value: Number(potAmount),
    tapLeafScript: setupScript.reveal(),
    tapTree: setupScript.encode(),
  }

  const finalAddress = getFinalAddress(game, networkHrp)
  const finalOutputs = [{ script: finalAddress.pkScript, amount: potAmount }]
  const { arkTx: finalArkTx, checkpoints: finalCheckpoints } = buildOffchainTx(
    [finalInput],
    finalOutputs,
    serverUnrollScript,
  )

  // Apply existing final signatures
  applyFinalSignatures(finalArkTx, game, setupScript)

  return {
    setup: { arkTx: setupArkTx, checkpoints: setupCheckpoints },
    final: { arkTx: finalArkTx, checkpoints: finalCheckpoints },
  }
}

/**
 * The outpoint of the coinflip-final VTXO, addressable before the final tx is
 * broadcast. The ark tx id excludes witness data, so it is stable across
 * signing — this is what lets the player pre-sign the winner-claim (validated
 * by the deterministic-txid gate test).
 */
export function getFinalOutpoint(finalArkTx: Transaction): { txid: string; vout: number } {
  return { txid: finalArkTx.id!, vout: 0 }
}

export interface ClaimArgs {
  winner: 'player' | 'house'
  /** Outpoint of the coinflip-final VTXO (see getFinalOutpoint). */
  finalOutpoint: { txid: string; vout: number }
  /** Ark address the winner is paid to. */
  payoutAddress: string
  /** Ark address the rake goes to (player-win only). */
  houseAddress: string
  /** Rake in sats, deducted from the pot on a player win; 0 otherwise. */
  rake: number
}

/**
 * Build the winner-claim tx spending the coinflip-final VTXO via the winner's
 * leaf. Player win → two outputs (pot−rake to player, rake to house); house win
 * → single pot output to the house. The condition witness (both secrets) is
 * attached by the broadcaster, not here — the signature does not cover it.
 */
export function buildClaimTransaction(
  game: Game,
  arkInfo: ArkInfo,
  networkHrp: string,
  args: ClaimArgs,
): BuiltOffchainTx {
  void networkHrp // reserved for symmetry with the other builders
  const pot = Number(getPotAmount(game))
  const finalScript = getFinalScript(game)
  const leaf = args.winner === 'player' ? finalScript.playerWin() : finalScript.creatorWin()
  const serverUnrollScript = decodeTapscript(
    hex.decode(arkInfo.checkpointTapscript),
  ) as CSVMultisigTapscript.Type

  const input: ArkTxInput = {
    txid: args.finalOutpoint.txid,
    vout: args.finalOutpoint.vout,
    value: pot,
    tapLeafScript: leaf,
    tapTree: finalScript.encode(),
  }

  const winnerAddr = ArkAddress.decode(args.payoutAddress)
  const outputs: { script: Uint8Array; amount: bigint }[] = []
  if (args.winner === 'player' && args.rake > 0) {
    outputs.push({ script: winnerAddr.pkScript, amount: BigInt(pot - args.rake) })
    outputs.push({ script: ArkAddress.decode(args.houseAddress).pkScript, amount: BigInt(args.rake) })
  } else {
    outputs.push({ script: winnerAddr.pkScript, amount: BigInt(pot) })
  }

  const { arkTx, checkpoints } = buildOffchainTx([input], outputs, serverUnrollScript)
  return { arkTx, checkpoints }
}

/** One escrow VTXO plus the per-party script it sits behind. */
export interface SweepEscrow {
  script: CoinflipEscrowScript
  txid: string
  vout: number
  value: number
}

export interface SweepArgs {
  winner: 'player' | 'house'
  /** The escrow VTXOs to sweep — each at its own per-party escrow address. */
  escrows: SweepEscrow[]
  payoutAddress: string
  houseAddress: string
  rake: number
}

/**
 * Sweep the per-party escrow VTXOs through the winner's leaf into one payout.
 * Each input is spent via ITS OWN escrow script's win leaf (the win leaves are
 * identical across player/house escrows, but the taptrees differ, so each input
 * carries its own leaf + tree). Single-party: only the winner + Ark server sign.
 * Player win → two outputs (pot−rake to player, rake to house); house win →
 * single pot output. The condition witness (both secrets) is attached by the
 * broadcaster.
 */
export function buildSweepTransaction(
  arkInfo: ArkInfo,
  networkHrp: string,
  args: SweepArgs,
): BuiltOffchainTx {
  void networkHrp
  const serverUnrollScript = decodeTapscript(
    hex.decode(arkInfo.checkpointTapscript),
  ) as CSVMultisigTapscript.Type

  const inputs: ArkTxInput[] = args.escrows.map((e) => ({
    txid: e.txid,
    vout: e.vout,
    value: e.value,
    tapLeafScript: args.winner === 'player' ? e.script.playerWin() : e.script.creatorWin(),
    tapTree: e.script.encode(),
  }))
  const pot = args.escrows.reduce((a, e) => a + e.value, 0)

  const winnerAddr = ArkAddress.decode(args.payoutAddress)
  const outputs: { script: Uint8Array; amount: bigint }[] = []
  if (args.winner === 'player' && args.rake > 0) {
    outputs.push({ script: winnerAddr.pkScript, amount: BigInt(pot - args.rake) })
    outputs.push({ script: ArkAddress.decode(args.houseAddress).pkScript, amount: BigInt(args.rake) })
  } else {
    outputs.push({ script: winnerAddr.pkScript, amount: BigInt(pot) })
  }

  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, serverUnrollScript)
  return { arkTx, checkpoints }
}

export interface PenaltyArgs {
  escrows: SweepEscrow[]
  /** Player's Ark address — receives the entire pot via the playerPenalty leaf. */
  payoutAddress: string
}

/**
 * Build the player's penalty-claim spending BOTH escrow VTXOs via the
 * `playerPenalty` leaf (hash-check + CSV(penaltyTimelockSeconds) + 2-of-2[player,
 * server]). Single output = the whole pot to the player. The condition witness
 * is just [playerSecret], attached by the broadcaster (not covered by the
 * signature, as with the sweep). The CSV is enforced by arkd at the VTXO layer
 * via per-input nSequence — no explicit nLockTime, mirroring buildRefundTransaction.
 */
export function buildPenaltyTransaction(
  arkInfo: ArkInfo,
  networkHrp: string,
  args: PenaltyArgs,
): BuiltOffchainTx {
  void networkHrp // reserved for symmetry with the other builders
  const serverUnrollScript = decodeTapscript(
    hex.decode(arkInfo.checkpointTapscript),
  ) as CSVMultisigTapscript.Type

  const inputs: ArkTxInput[] = args.escrows.map((e) => ({
    txid: e.txid,
    vout: e.vout,
    value: e.value,
    tapLeafScript: e.script.playerPenalty(),
    tapTree: e.script.encode(),
  }))
  const pot = args.escrows.reduce((a, e) => a + e.value, 0)
  const payoutAddr = ArkAddress.decode(args.payoutAddress)
  const { arkTx, checkpoints } = buildOffchainTx(
    inputs,
    [{ script: payoutAddr.pkScript, amount: BigInt(pot) }],
    serverUnrollScript,
  )
  return { arkTx, checkpoints }
}

export interface ForfeitClaimEscrow {
  script: CoinflipEscrowScript
  txid: string
  vout: number
  value: number
}

export interface ForfeitClaimArgs {
  /**
   * Escrows to sweep — exactly two for atomic mode (player + house).
   * Each MUST have been constructed with an `arkadeForfeit` config in
   * **atomic mode** (`otherStakeValue` set on each, such that each leaf
   * pins the OTHER escrow's stake). The covenants on the two leaves are
   * symmetric and consistent: their combined value checks guarantee the
   * full pot lands at `payoutAddress`.
   */
  escrows: ForfeitClaimEscrow[]
  /**
   * Player payout. MUST match each escrow's bound `forfeitDestPkScript`.
   * The arkade covenant checks output.scriptPubKey exactly — a mismatch
   * means the emulator refuses to co-sign.
   */
  payoutAddress: string
  /**
   * The full pot — equals `forfeitDestValue` from BOTH escrows (which
   * are equal in atomic mode). Caller passes it explicitly so this
   * builder doesn't have to read it back from the script.
   */
  potAmount: bigint
}

/**
 * Build the player's R1 forfeit claim through the arkade-script
 * `playerForfeit` leaf on each escrow. Produces **one** Ark transaction
 * with two inputs (both escrows) and **one** user output (the full pot
 * to the player). An EmulatorPacket reveals each input's arkade script
 * with the witness `[output_index=0, other_input_index=1-i]` so the
 * emulator can validate the cross-input covenant before co-signing.
 *
 * Output layout (atomic mode):
 *   output[0]   pays escrows[*].forfeitDestPkScript  (== payoutAddress)
 *               for `potAmount` sats (sum of both stakes)
 *   output[1]+  (P2A anchor + OP_RETURN extension carrying the
 *               EmulatorPacket — added by buildOffchainTx +
 *               addEmulatorPacket; not inspected by the covenant)
 *
 * After the emulator co-signs (POST /v1/tx), the player + arkd sign the
 * remaining slots (the tapscript leaf is 3-of-3 [player, server,
 * emulator_tweaked]). Mirrors the arkade-htlc.test.ts refund path.
 */
export function buildForfeitClaimTransaction(
  arkInfo: ArkInfo,
  networkHrp: string,
  args: ForfeitClaimArgs,
): BuiltOffchainTx & { emulatorEntries: { vin: number; script: Uint8Array; witness: Uint8Array }[] } {
  void networkHrp
  if (args.escrows.length !== 2) {
    throw new Error(
      `buildForfeitClaimTransaction: atomic forfeit requires exactly 2 escrows (got ${args.escrows.length})`,
    )
  }
  for (let i = 0; i < args.escrows.length; i++) {
    const e = args.escrows[i]
    if (!e.script.forfeitArkadeScript) {
      throw new Error(
        `buildForfeitClaimTransaction: escrow #${i} has no arkadeForfeit config — call escrowScript with one or fall back to buildPenaltyTransaction`,
      )
    }
  }
  if (args.potAmount <= 0n) {
    throw new Error('buildForfeitClaimTransaction: potAmount must be positive')
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
  // Atomic sweep: ONE output for the full pot. Both covenants verify it.
  const outputs = [{ script: payoutAddr.pkScript, amount: args.potAmount }]

  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, serverUnrollScript)

  // EmulatorPacket per input. Witness = [out_idx=0, other_in_idx=1-i].
  // Both covenants check the SAME output (index 0); each pins the OTHER
  // input's value via its other_in_idx witness arg.
  // Witness stack semantics: pushed in order, top item consumed first.
  // The script's INSPECTINPUTVALUE consumes other_in_idx first, then the
  // enforcePayTo body operates on out_idx.
  const emulatorEntries = args.escrows.map((_e, i) => ({
    vin: i,
    script: args.escrows[i].script.forfeitArkadeScript!,
    // Order in the witness array: [bottom, ..., top]. Bottom = out_idx,
    // top = other_in_idx.
    witness: encodeEmulatorWitness([
      encodeOutputIndexWitness(0),       // out_idx (bottom)
      encodeOutputIndexWitness(1 - i),   // other_in_idx (top)
    ]),
  }))
  addEmulatorPacket(arkTx, emulatorEntries)

  return { arkTx, checkpoints, emulatorEntries }
}

export interface RefundArgs {
  escrowScript: CoinflipEscrowScript
  txid: string
  vout: number
  value: number
  /** Address the funder reclaims to. */
  refundAddress: string
}

/**
 * Refund a single escrow VTXO to its funder via the `refund` leaf after the
 * timeout. Only the funder (+ server) can sign this leaf, so a stalled game
 * lets each side reclaim its own stake — and only its own. The CLTV timelock is
 * baked into the leaf and enforced by arkd at the VTXO layer (mirrors how
 * auto-claim.ts spends the CLTV abort leaf via buildOffchainTx).
 */
export function buildRefundTransaction(
  arkInfo: ArkInfo,
  networkHrp: string,
  args: RefundArgs,
): BuiltOffchainTx {
  void networkHrp
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

function getLeafHash(leaf: TapLeafScript): Uint8Array {
  const scriptWithVersion = leaf[1]
  const script = scriptWithVersion.slice(0, -1)
  return tapLeafHash(script, TAP_LEAF_VERSION)
}

function applySetupSignatures(tx: Transaction, game: Game): void {
  const creator = game.creator!
  const player = game.player!

  if (creator.setupTxSignatures?.length) {
    for (let i = 0; i < creator.setupTxSignatures.length; i++) {
      const inputLeaf = tx.getInput(i).tapLeafScript?.[0]
      if (!inputLeaf) continue
      tx.updateInput(i, {
        tapScriptSig: [[
          { pubKey: creator.pubkey!, leafHash: getLeafHash(inputLeaf) },
          creator.setupTxSignatures[i],
        ]],
      })
    }
  }

  if (player.setupTxSignatures?.length) {
    const offset = creator.vtxos!.length
    for (let i = 0; i < player.setupTxSignatures.length; i++) {
      const inputLeaf = tx.getInput(offset + i).tapLeafScript?.[0]
      if (!inputLeaf) continue
      tx.updateInput(offset + i, {
        tapScriptSig: [[
          { pubKey: player.pubkey!, leafHash: getLeafHash(inputLeaf) },
          player.setupTxSignatures[i],
        ]],
      })
    }
  }
}

function applyFinalSignatures(
  tx: Transaction,
  game: Game,
  setupScript: CoinflipSetupScript
): void {
  const revealLeaf = setupScript.reveal()
  const leafHash = getLeafHash(revealLeaf)

  const sigs: [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array][] = []

  if (game.creator?.finalTxSignature) {
    sigs.push([{ pubKey: game.creator.pubkey!, leafHash }, game.creator.finalTxSignature])
  }
  if (game.player?.finalTxSignature) {
    sigs.push([{ pubKey: game.player.pubkey!, leafHash }, game.player.finalTxSignature])
  }

  if (sigs.length > 0) {
    tx.updateInput(0, { tapScriptSig: sigs })
  }
}

/**
 * Determine the winner of a coinflip game.
 * Same size = player wins, different size = creator wins.
 * Valid sizes are 15 (heads) or 16 (tails) bytes.
 */
export function determineWinner(
  creatorSecret: Uint8Array,
  playerSecret: Uint8Array
): 'creator' | 'player' {
  const validSizes = [15, 16]
  if (!validSizes.includes(creatorSecret.length)) return 'player'
  if (!validSizes.includes(playerSecret.length)) return 'creator'
  return creatorSecret.length === playerSecret.length ? 'player' : 'creator'
}

/**
 * Generate a random secret for choosing heads or tails.
 * Heads = 15 bytes, Tails = 16 bytes.
 */
export function generateSecret(choice: 'heads' | 'tails'): Uint8Array {
  const length = choice === 'heads' ? 15 : 16
  return randomBytes(length)
}

/**
 * Off-chain mirror of the variable-odds on-chain condition (must match its
 * branch order exactly): an out-of-range secret makes its submitter lose, else
 * the player wins iff `lo <= (digitC + digitP) mod n < target`. `digit = length
 * - base`; `lo` defaults to 0.
 */
export function determineVariableWinner(
  creatorSecret: Uint8Array,
  playerSecret: Uint8Array,
  n: number,
  target: number,
  lo = 0,
): 'creator' | 'player' {
  const base = VARIABLE_ODDS_BASE_LEN
  const digitP = playerSecret.length - base
  const digitC = creatorSecret.length - base
  if (digitP < 0 || digitP >= n) return 'creator' // player out of range → loses
  if (digitC < 0 || digitC >= n) return 'player' // creator out of range → loses
  const roll = (digitC + digitP) % n
  return roll >= lo && roll < target ? 'player' : 'creator'
}

/**
 * The roll `(digitC + digitP) mod n` for display (e.g. the dice face the player
 * rolled), or null if either secret's length is out of [base, base+n) — in which
 * case the outcome was decided by the cheat-penalty, not a fair roll.
 */
export function computeVariableRoll(
  creatorSecret: Uint8Array,
  playerSecret: Uint8Array,
  n: number,
): number | null {
  const base = VARIABLE_ODDS_BASE_LEN
  const digitP = playerSecret.length - base
  const digitC = creatorSecret.length - base
  if (digitP < 0 || digitP >= n || digitC < 0 || digitC >= n) return null
  return (digitC + digitP) % n
}

/**
 * Random variable-odds secret: a uniformly chosen digit in [0, n) encoded as the
 * byte length (`base + digit`). Choosing uniformly makes the summed roll uniform.
 */
export function generateVariableSecret(n: number): Uint8Array {
  const digit = Math.floor(Math.random() * n)
  return randomBytes(VARIABLE_ODDS_BASE_LEN + digit)
}

/**
 * Add condition witness (secrets) to a transaction for cashout.
 */
export function addConditionWitness(
  tx: Transaction,
  inputIndex: number,
  witnesses: Uint8Array[]
): void {
  setArkPsbtField(tx, inputIndex, ConditionWitness, witnesses)
}

/**
 * Get condition witness from a transaction.
 */
export function getConditionWitness(
  tx: Transaction,
  inputIndex: number
): Uint8Array[] | undefined {
  const witnesses = getArkPsbtFields(tx, inputIndex, ConditionWitness)
  return witnesses.length > 0 ? witnesses[0] : undefined
}
