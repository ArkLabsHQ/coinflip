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
  ConditionWitness,
  setArkPsbtField,
} from '@arkade-os/sdk'
import { CoinflipEscrowScript, VARIABLE_ODDS_BASE_LEN, type CoinflipEscrowOptions } from './script'
import { Game } from './types'
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

/**
 * Per-party escrow scripts — 4 leaves each (`playerWinCovenant`,
 * `creatorWinCovenant`, `playerForfeit`, `refund`). All payout-emitting
 * leaves are covenant-bound to the matching payout pkScript.
 *
 * The arkade-script config (`emulatorPubkey`, both payout pkScripts,
 * both stakes) is required on the `Game` — there is no fallback escrow
 * shape.
 */
function escrowScript(game: Game, refundPubkey: Uint8Array): CoinflipEscrowScript {
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
  return new CoinflipEscrowScript({
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
    oddsLo: game.oddsLo,
    arkadeForfeit: {
      emulatorPubkey: game.emulatorPubkey,
      playerPayoutPkScript: game.playerForfeitPkScript,
      housePayoutPkScript: game.housePayoutPkScript,
      playerStake: BigInt(game.playerStake),
      houseStake: BigInt(game.houseStake),
    },
  })
}

export function getPlayerEscrowScript(game: Game): CoinflipEscrowScript {
  return escrowScript(game, game.player!.pubkey!)
}

export function getHouseEscrowScript(game: Game): CoinflipEscrowScript {
  return escrowScript(game, game.creator!.pubkey!)
}

export function getPlayerEscrowAddress(game: Game, networkHrp: string): ArkAddress {
  return getPlayerEscrowScript(game).address(networkHrp, game.serverPubkey!)
}

export function getHouseEscrowAddress(game: Game, networkHrp: string): ArkAddress {
  return getHouseEscrowScript(game).address(networkHrp, game.serverPubkey!)
}

/**
 * The exact `CoinflipEscrowOptions` that produced the house escrow's on-chain
 * pkScript. `CoinflipEscrowScript` stores its constructor opts on the public
 * `readonly options` field, so this is the single source of truth — serialize
 * these through `CoinflipEscrowContractHandler.serializeParams` and the handler
 * re-derives a byte-identical script. Used to register the house escrow as a
 * first-class SDK contract.
 */
export function getHouseEscrowOptions(game: Game): CoinflipEscrowOptions {
  return getHouseEscrowScript(game).options
}

/**
 * The exact `CoinflipEscrowOptions` that produced the PLAYER escrow's on-chain
 * pkScript — the player-side mirror of `getHouseEscrowOptions`. Same single
 * source of truth: serialize these through
 * `CoinflipEscrowContractHandler.serializeParams` and the handler re-derives a
 * byte-identical script. Used by the client to register its own escrow as a
 * first-class SDK contract so the ContractWatcher clears the stalled-bet stash
 * the instant the atomic sweep spends it.
 */
export function getPlayerEscrowOptions(game: Game): CoinflipEscrowOptions {
  return getPlayerEscrowScript(game).options
}

/** Get the pot amount (2x bet) */
export function getPotAmount(game: Game): bigint {
  assertDefined(game.betAmount, 'betAmount')
  return 2n * game.betAmount
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

/** One escrow VTXO plus the per-party script it sits behind. */
/** One escrow VTXO plus the per-party script it sits behind. */
export interface EscrowInput {
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
  escrows: EscrowInput[]
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

export interface CovenantSweepArgs {
  winner: 'player' | 'house'
  /**
   * Both escrows. MUST have been constructed with
   * `arkadeForfeit.housePayoutPkScript` set so the covenant-win leaves
   * exist (`playerWinCovenant()` / `creatorWinCovenant()`).
   */
  escrows: EscrowInput[]
  /**
   * Winner's payout. MUST match the corresponding pin on the covenant
   * leaf — `forfeitDestPkScript` for a player win,
   * `housePayoutPkScript` for a house win.
   */
  payoutAddress: string
  /** Full pot — the covenants check output[0].value == potAmount. */
  potAmount: bigint
  /**
   * Condition witness — both revealed secrets in order
   * `[houseSecret, playerSecret]`, attached to each input via
   * `ConditionWitness` PSBT field. Same shape as the legacy
   * `buildSweepTransaction` consumes.
   */
  bothSecrets: [Uint8Array, Uint8Array]
}

/**
 * Server-resolved win sweep using the covenant-win leaves. One Ark tx
 * with both escrow inputs and a single user output paying the winner
 * the full pot. EmulatorPacket per input reveals the arkade-script
 * covenant + witness arg (`[output_idx=0, other_input_idx=1-i]`).
 *
 * Unlike `buildSweepTransaction`, no winner key is in the multisig —
 * the tapscript closure is `ConditionMultisig[server, emulator_tweaked]`,
 * so the server signs + the emulator co-signs after running the
 * covenant. **The winner does not need to sign anything**.
 *
 * Falls back to `buildSweepTransaction` is the caller's responsibility
 * when the escrows weren't minted with `housePayoutPkScript` set.
 */
export function buildCovenantSweepTransaction(
  arkInfo: ArkInfo,
  networkHrp: string,
  args: CovenantSweepArgs,
): BuiltOffchainTx & { emulatorEntries: { vin: number; script: Uint8Array; witness: Uint8Array }[] } {
  void networkHrp
  if (args.escrows.length !== 2) {
    throw new Error(
      `buildCovenantSweepTransaction: requires exactly 2 escrows (got ${args.escrows.length})`,
    )
  }
  for (let i = 0; i < args.escrows.length; i++) {
    const want = args.winner === 'player'
      ? args.escrows[i].script.playerWinCovenantArkadeScript
      : args.escrows[i].script.creatorWinCovenantArkadeScript
    if (!want) {
      throw new Error(
        `buildCovenantSweepTransaction: escrow #${i} has no ${args.winner}WinCovenant leaf (housePayoutPkScript missing at /play time?)`,
      )
    }
  }
  if (args.potAmount <= 0n) {
    throw new Error('buildCovenantSweepTransaction: potAmount must be positive')
  }

  const serverUnrollScript = decodeTapscript(
    hex.decode(arkInfo.checkpointTapscript),
  ) as CSVMultisigTapscript.Type

  const inputs: ArkTxInput[] = args.escrows.map((e) => ({
    txid: e.txid,
    vout: e.vout,
    value: e.value,
    tapLeafScript: args.winner === 'player' ? e.script.playerWinCovenant() : e.script.creatorWinCovenant(),
    tapTree: e.script.encode(),
  }))

  const payoutAddr = ArkAddress.decode(args.payoutAddress)
  const outputs = [{ script: payoutAddr.pkScript, amount: args.potAmount }]

  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, serverUnrollScript)

  // Condition witness — both revealed secrets, attached per input on
  // BOTH the ark tx AND each checkpoint. The covenant-win leaves are
  // ConditionMultisig closures, so arkd's predicate must evaluate on
  // every signed psbt — checkpoint signatures are validated against the
  // same condition witness as the ark tx.
  for (let i = 0; i < args.escrows.length; i++) {
    setArkPsbtField(arkTx, i, ConditionWitness, args.bothSecrets)
  }
  for (const cp of checkpoints) {
    setArkPsbtField(cp, 0, ConditionWitness, args.bothSecrets)
  }

  // EmulatorPacket per input. Witness = [out_idx=0, other_in_idx=1-i].
  const emulatorEntries = args.escrows.map((_e, i) => ({
    vin: i,
    script: (args.winner === 'player'
      ? args.escrows[i].script.playerWinCovenantArkadeScript
      : args.escrows[i].script.creatorWinCovenantArkadeScript)!,
    witness: encodeEmulatorWitness([
      encodeOutputIndexWitness(0),
      encodeOutputIndexWitness(1 - i),
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
 * Cryptographically-uniform integer in `[0, n)`. Uses `crypto.randomBytes`
 * (CSPRNG) with rejection sampling to avoid modulo bias.
 *
 * This matters for game-outcome selection: `Math.random()` is a non-crypto PRNG
 * whose internal state can be recovered from a sequence of observed outputs. The
 * house's chosen coin side / odds digit is revealed at settlement, so a stream of
 * `Math.random()`-derived choices would leak the PRNG state and let a player
 * predict (and match) the next house pick. A CSPRNG closes that channel.
 */
export function randomUniformInt(n: number): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`randomUniformInt: n must be a positive integer (got ${n})`)
  }
  if (n === 1) return 0
  const bytes = Math.ceil(Math.log2(n) / 8) || 1
  const max = 256 ** bytes
  const limit = max - (max % n) // largest multiple of n that fits in `bytes` bytes
  // Rejection-sample: discard draws in the non-uniform tail [limit, max).
  for (;;) {
    const buf = randomBytes(bytes)
    let x = 0
    for (const b of buf) x = x * 256 + b
    if (x < limit) return x % n
  }
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
 * Pick a coin side uniformly with a CSPRNG (not `Math.random`) and return the
 * corresponding secret. Used by the house when minting a 50/50 game.
 */
export function generateRandomCoinSecret(): Uint8Array {
  return generateSecret(randomUniformInt(2) === 0 ? 'heads' : 'tails')
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
  const digit = randomUniformInt(n)
  return randomBytes(VARIABLE_ODDS_BASE_LEN + digit)
}

// addConditionWitness + getConditionWitness moved to ./condition-witness — they're
// crypto-free, so the browser bundle (which imports the v4 builders from
// joint-pot-tx) can use them without dragging in this module's Node `crypto` import.
