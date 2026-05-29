/**
 * Per-party trustless coin settlement (replaces the custodial sendBitcoin path).
 *
 * Proven by packages/e2e/src/per-party-escrow.spike.test.ts. The economics:
 *   - house and player each escrow their stake into the SAME CoinflipFinal
 *     address with a single-party offchain send (no multi-party checkpoints);
 *   - on resolve, the winner sweeps BOTH escrow VTXOs through their leaf.
 *
 * The server escrows the house stake and, on a house win, sweeps. On a player
 * win the playerWin leaf needs the player's key, so /commit returns the data
 * for the client to sweep itself (single-party, client-side).
 */

import { v4 as uuidv4 } from 'uuid'
import { createHash } from 'crypto'
import { base64, hex } from '@scure/base'
import {
  generateSecret,
  determineWinner,
  generateVariableSecret,
  determineVariableWinner,
  computeVariableRoll,
  getPlayerEscrowScript,
  getHouseEscrowScript,
  getPlayerEscrowAddress,
  getHouseEscrowAddress,
  buildSweepTransaction,
  buildCovenantSweepTransaction,
  buildRefundTransaction,
  buildPenaltyTransaction,
  buildForfeitClaimTransaction,
  type Game,
  type SweepEscrow,
  type ForfeitClaimEscrow,
  type CovenantSweepEscrow,
  type BuiltOffchainTx,
} from 'arkade-coinflip'
import {
  buildOffchainTx,
  decodeTapscript,
  CSVMultisigTapscript,
  ConditionWitness,
  setArkPsbtField,
  Transaction,
  ArkAddress,
  RestIndexerProvider,
  type ArkTxInput,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { hashSecret, networkHrpFromArkInfo } from './house-wallet.js'
import { reservations, selectionMutex, freeHouseVtxos, HouseBusyError, BetExceedsCapacityError, KeyedMutex, outpointKey, pickEscrowVtxo, houseVtxoCache } from './vtxo-pool.js'
import type { AppDeps } from './deps.js'
import { loadEmulatorConfig } from './emulator.js'
import type { GameRow } from './repositories/types.js'

export interface Outpoint { txid: string; vout: number; value: number }

export interface TrustlessPlayRequest {
  tier: number
  playerPubkey: string
  playerHash: string
  playerChangeAddress: string
  /**
   * Variable-odds: player wins with probability `oddsTarget/oddsN`. Both or
   * neither — omit for the 50/50 coin. The house stakes a (house-edged) multiple
   * so payouts reflect the odds; the player still stakes `tier`.
   */
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
}

export interface TrustlessPlayResult {
  gameId: string
  escrowAddress: string
  houseHash: string
  housePubkey: string
  serverPubkey: string
  betAmount: number
  finalExpiration: number
  /** The house's escrow VTXO, so the client can build the winner sweep. */
  houseEscrow: Outpoint
  /** Variable-odds echo + economics so the client can show/verify the bet. */
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
  /** Total pot the winner sweeps = player stake (`betAmount`) + house stake. */
  pot: number
  /**
   * Relative BIP68 timelock (seconds) for the player's R1 penalty leaf, echoed
   * so the client can build the penalty tx and stash it after escrowing — the
   * audit's R1 forfeit relies on the player having the prebuilt penalty PSBT
   * ready before the house's withholding window opens.
   */
  penaltyTimelockSeconds?: number
}

export interface TrustlessCommitRequest {
  playerSecretHex: string
  /** The player's escrow VTXO outpoint (the client's single-party escrow send). */
  playerEscrow: Outpoint
}

export interface TrustlessCommitResult {
  winner: 'house' | 'player'
  houseSecret: string
  playerSecret: string
  payout: number
  rake: number
  proof: string
  /**
   * Variable-odds: the rolled value `(digitC + digitP) mod n` in [0, n) — what
   * the player actually rolled, for the skin to display (the dice face, etc.).
   * null for the 50/50 coin or when a secret was out of range (cheat-penalty,
   * not a fair roll). Echoed alongside the bet's range so the result is
   * self-describing on idempotent replay.
   */
  roll?: number | null
  oddsN?: number
  oddsLo?: number
  oddsTarget?: number
  /** Set when the house won and the server swept. */
  txid?: string
  /**
   * Set when the PLAYER won. The server builds the playerWin sweep (it can't
   * sign it — that needs the player's key), so the client parses these PSBTs,
   * attaches both secrets as the condition witness, signs inputs + checkpoints
   * with its key, and submits. Browser-safe: only the SDK is needed, no lib
   * tx-building (which is Node-crypto bound). The client should verify the
   * sweep pays its own address before signing.
   */
  sweep?: {
    sweepPsbt: string
    sweepCheckpoints: string[]
    /** Input indices the client signs and attaches the witness to. */
    inputCount: number
    /** Both revealed secrets, in [houseSecret, playerSecret] order, as the
     * condition witness for each sweep input. */
    witnessHex: [string, string]
  }
}

/** Per-party state we persist on the game row (reusing house_vtxos_json). */
interface TrustlessState {
  finalExpiration: number
  setupExpiration: number
  houseEscrow: Outpoint
  /**
   * The player's escrow outpoint, persisted at resolve. Lets a retried
   * `/commit` rebuild the player-win sweep deterministically — independent of
   * what the client re-sends — so idempotent replay needs no live request data.
   */
  playerEscrow?: Outpoint
  /**
   * The sweep txid, persisted at resolve on a HOUSE win. On a retried commit we
   * return this instead of re-submitting (the escrow VTXOs are already spent).
   */
  resolveTxid?: string
  /**
   * Set once the house escrow has been reclaimed via refund on a STALLED game
   * (recoverOrphanedHouseEscrows). Idempotency guard so recovery runs once.
   */
  houseRefundTxid?: string
  /**
   * Variable-odds parameters (unset → 50/50 coin). Persisted so commit/refund/
   * recovery rebuild the SAME escrow script (the condition depends on them).
   */
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
  /**
   * Relative BIP68 timelock (seconds) for the player's R1 penalty leaf,
   * persisted so commit/refund/recovery rebuild the EXACT same escrow script —
   * the taproot address is hashed from the leaf bytes, and a drifting timelock
   * would derive a different address and break spends. Optional on the type
   * only for backward-compat with any pre-feature rows; new games always
   * populate it from `handleTrustlessPlay`.
   */
  penaltyTimelockSeconds?: number
  /**
   * Per-game arkade-script forfeit pin. When set, the escrow was minted with
   * the 5-leaf layout and a `playerForfeit` arkade-script leaf is available.
   * All three fields are pinned together — the taproot address is hashed
   * from them, so /commit, /refund, /forfeit and recovery rebuilds MUST use
   * the exact same values that were used at /play. Hex-encoded to keep the
   * persisted JSON small and stable.
   */
  arkadeForfeit?: {
    /** Compressed (33-byte) or x-only (32-byte) emulator pubkey, hex. */
    emulatorPubkeyHex: string
    /** Player payout P2TR pkScript, hex. */
    playerForfeitPkScriptHex: string
    /** Per-escrow value the player's escrow covenant binds (player stake). */
    playerEscrowValue: number
    /** Per-escrow value the house's escrow covenant binds (house stake). */
    houseEscrowValue: number
    /**
     * House payout P2TR pkScript, hex. Optional for back-compat with
     * games minted before covenant-resolved win leaves landed; new
     * games always populate it.
     */
    housePayoutPkScriptHex?: string
  }
}

/**
 * Serializes concurrent `/commit` calls for the SAME game so a game is resolved
 * (and its escrows swept) exactly once; commits for different games run in
 * parallel. Combined with the persisted replay data above, a retried commit
 * returns the original result instead of erroring or double-sweeping.
 */
const commitLocks = new KeyedMutex()

async function getTiers(deps: AppDeps): Promise<number[]> {
  const tiersStr = (await deps.repos.config.get('tiers')) || '[1000,5000,10000,50000]'
  return JSON.parse(tiersStr)
}

async function calcRake(potAmount: number, deps: AppDeps): Promise<number> {
  const type = ((await deps.repos.config.get('rake_type')) || 'percentage') as 'percentage' | 'flat'
  const value = parseInt((await deps.repos.config.get('rake_value')) || '2', 10)
  const rake = type === 'percentage' ? Math.floor((potAmount * value) / 100) : value
  // Waive the rake if it would be a sub-dust output (arkd rejects outputs below
  // its dust limit) or push the payout below dust. For small tiers the 2% rake
  // is dust, so the house simply forgoes it.
  const dust = Number(deps.arkInfo.dust ?? 546n)
  if (rake < dust || potAmount - rake < dust) return 0
  return rake
}

const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)

/**
 * Documented default for the player's R1 penalty leaf BIP68 timelock (seconds).
 * `2 × 512s ≈ 17 min`. MUST be a multiple of 512 and `>= 512` — BIP68 silently
 * floors sub-512 values to zero, which would make the penalty leaf immediately
 * spendable and nullify the R1 forfeit entirely. The escrow taproot address is
 * hashed from the leaf bytes, so this value also has to be IDENTICAL across
 * /play, /commit, /refund and recovery rebuilds — that's why we persist it in
 * `TrustlessState` and read it back at every call site instead of redefining it.
 */
const DEFAULT_PENALTY_TIMELOCK_SECONDS = 1024

/** Build the per-game Game object the lib needs to derive the escrow script. */
async function buildGame(
  deps: AppDeps,
  tier: number,
  houseHashHex: string,
  playerPubkeyHex: string,
  playerHashHex: string,
  finalExpiration: number,
  setupExpiration: number,
  penaltyTimelockSeconds: number,
  odds?: { oddsN: number; oddsTarget: number; oddsLo: number },
  arkadeForfeit?: {
    emulatorPubkey: Uint8Array
    playerForfeitPkScript: Uint8Array
    housePayoutPkScript?: Uint8Array
  },
): Promise<Game> {
  const housePub = await deps.identity.xOnlyPublicKey()
  const playerPub = toXOnly(hex.decode(playerPubkeyHex))
  const serverPub = toXOnly(hex.decode(deps.arkInfo.signerPubkey))
  return {
    gameId: 'escrow',
    betAmount: BigInt(tier),
    serverPubkey: serverPub,
    setupExpiration,
    finalExpiration,
    penaltyTimelockSeconds,
    creator: { pubkey: housePub, hash: hex.decode(houseHashHex) },
    player: { pubkey: playerPub, hash: hex.decode(playerHashHex) },
    oddsN: odds?.oddsN,
    oddsTarget: odds?.oddsTarget,
    oddsLo: odds?.oddsLo,
    emulatorPubkey: arkadeForfeit?.emulatorPubkey,
    playerForfeitPkScript: arkadeForfeit?.playerForfeitPkScript,
    housePayoutPkScript: arkadeForfeit?.housePayoutPkScript,
  }
}

/**
 * House stake for a variable-odds game with a fixed house edge. A FAIR game has
 * the house stake `playerStake·(n−target)/target` (so EV=0); the edge shaves
 * that down so the player wins less than fair (the house's expected cut). Edge
 * is in basis points (300 = 3%). Pure + integer for deterministic agreement
 * with what's escrowed. Unit-tested.
 */
export function computeHouseStake(playerStake: number, n: number, target: number, lo: number, edgeBps: number): number {
  const win = target - lo // size of the player's winning range [lo, target)
  return Math.floor((playerStake * (n - win) * (10000 - edgeBps)) / (win * 10000))
}

/** Configured variable-odds house edge in basis points (default 3%). */
async function getOddsEdgeBps(deps: AppDeps): Promise<number> {
  const v = parseInt((await deps.repos.config.get('variable_odds_edge_bps')) || '300', 10)
  return Number.isFinite(v) && v >= 0 && v < 10000 ? v : 300
}

/** Extract variable-odds params from persisted state (undefined → coin). */
function oddsFromState(state: TrustlessState): { oddsN: number; oddsTarget: number; oddsLo: number } | undefined {
  return state.oddsN !== undefined && state.oddsTarget !== undefined
    ? { oddsN: state.oddsN, oddsTarget: state.oddsTarget, oddsLo: state.oddsLo ?? 0 }
    : undefined
}

/**
 * Read back the persisted BIP68 penalty timelock for an existing game, or fall
 * back to the documented default for any legacy row that predates the field.
 * Logs the fallback so a row drift doesn't silently change the derived escrow
 * address. New games always populate this in `handleTrustlessPlay`.
 */
/**
 * Read back the persisted arkade-forfeit pin and revive it into a form
 * `buildGame` accepts. Returns `undefined` for legacy games (no pin) — those
 * keep using the 4-leaf escrow, matching what was minted at /play.
 *
 * The derived `pot` and the per-escrow `otherStakeValue` pair are what the
 * **atomic-sweep** covenants check: each leaf binds the pot (one output)
 * and the other escrow's stake (one input). Symmetric and consistent.
 */
function rehydrateArkadeForfeit(state: TrustlessState):
  | {
      emulatorPubkey: Uint8Array
      playerForfeitPkScript: Uint8Array
      housePayoutPkScript?: Uint8Array
      playerEscrowValue: bigint
      houseEscrowValue: bigint
      pot: bigint
    }
  | undefined {
  if (!state.arkadeForfeit) return undefined
  const playerEscrowValue = BigInt(state.arkadeForfeit.playerEscrowValue)
  const houseEscrowValue = BigInt(state.arkadeForfeit.houseEscrowValue)
  return {
    emulatorPubkey: hex.decode(state.arkadeForfeit.emulatorPubkeyHex),
    playerForfeitPkScript: hex.decode(state.arkadeForfeit.playerForfeitPkScriptHex),
    housePayoutPkScript: state.arkadeForfeit.housePayoutPkScriptHex
      ? hex.decode(state.arkadeForfeit.housePayoutPkScriptHex)
      : undefined,
    playerEscrowValue,
    houseEscrowValue,
    pot: playerEscrowValue + houseEscrowValue,
  }
}

function ensurePenaltyTimelockSeconds(state: TrustlessState, gameId: string): number {
  if (state.penaltyTimelockSeconds !== undefined) return state.penaltyTimelockSeconds
  console.warn(
    `[trustless] game ${gameId} persisted state missing penaltyTimelockSeconds; ` +
    `using default ${DEFAULT_PENALTY_TIMELOCK_SECONDS} (escrow address will be ` +
    `recomputed from this — if the original game used a different value the spend will fail).`,
  )
  return DEFAULT_PENALTY_TIMELOCK_SECONDS
}

/**
 * Submit a single-party offchain tx: the house identity signs `signInputs` on
 * the ark tx and every checkpoint, optionally attaching a condition witness
 * (revealed secrets) to the given input indices. arkd co-signs the server leg.
 */
async function submitOffchain(
  deps: AppDeps,
  arkTx: Transaction,
  checkpoints: Transaction[],
  signInputs: number[],
  witness?: { inputs: number[]; data: Uint8Array[] },
): Promise<string> {
  if (witness) for (const i of witness.inputs) setArkPsbtField(arkTx, i, ConditionWitness, witness.data)
  const signed = await deps.identity.sign(arkTx, signInputs)
  const { arkTxid, signedCheckpointTxs } = await deps.wallet.arkProvider.submitTx(
    base64.encode(signed.toPSBT()),
    checkpoints.map((c) => base64.encode(c.toPSBT())),
  )
  const finals: string[] = []
  for (const c of signedCheckpointTxs) {
    const tx = Transaction.fromPSBT(base64.decode(c))
    const idx: number[] = []
    for (let i = 0; i < tx.inputsLength; i++) idx.push(i)
    if (witness) for (const i of idx) setArkPsbtField(tx, i, ConditionWitness, witness.data)
    const sc = await deps.identity.sign(tx, idx)
    finals.push(base64.encode(sc.toPSBT()))
  }
  await deps.wallet.arkProvider.finalizeTx(arkTxid, finals)
  return arkTxid
}

function houseVtxoToInput(v: ExtendedVirtualCoin): ArkTxInput {
  return { txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript, tapTree: v.tapTree }
}

/**
 * Escrow `amount` from a PRE-SELECTED house VTXO into the escrow address
 * (single-party). The caller picks + reserves `candidate` under the selection
 * mutex so concurrent plays never escrow from the same VTXO; the actual send
 * runs outside the mutex so escrows for distinct VTXOs proceed in parallel.
 */
async function escrowHouseStakeFrom(
  deps: AppDeps,
  candidate: ExtendedVirtualCoin,
  escrowPkScript: Uint8Array,
  amount: number,
): Promise<Outpoint> {
  const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
  const change = candidate.value - amount
  const houseChange = ArkAddress.decode(await deps.wallet.getAddress())
  const outputs: { script: Uint8Array; amount: bigint }[] = [{ script: escrowPkScript, amount: BigInt(amount) }]
  if (change > 0) outputs.push({ script: houseChange.pkScript, amount: BigInt(change) })

  const { arkTx, checkpoints } = buildOffchainTx([houseVtxoToInput(candidate)], outputs, serverUnroll)
  const txid = await submitOffchain(deps, arkTx, checkpoints, [0])
  return { txid, vout: 0, value: amount }
}

export async function handleTrustlessPlay(req: TrustlessPlayRequest, deps: AppDeps): Promise<TrustlessPlayResult> {
  const tiers = await getTiers(deps)
  if (!tiers.includes(req.tier)) throw new Error(`Invalid tier: ${req.tier}`)
  if ((await deps.repos.games.countPendingForPlayer(req.playerPubkey)) >= 3) {
    throw new Error('Too many pending games. Complete or wait for existing games to expire.')
  }

  // Variable-odds (both params set) vs. the 50/50 coin. The player always stakes
  // `tier`; the house stakes a house-edged multiple so payouts reflect the odds.
  const dust = Number(deps.arkInfo.dust ?? 546n)
  const isVariable = req.oddsN !== undefined && req.oddsTarget !== undefined
  let houseStake = req.tier
  let odds: { oddsN: number; oddsTarget: number; oddsLo: number } | undefined
  if (isVariable) {
    const n = req.oddsN as number, target = req.oddsTarget as number, lo = req.oddsLo ?? 0
    if (!Number.isInteger(n) || n < 2 || !Number.isInteger(target) || !Number.isInteger(lo) || lo < 0 || target <= lo || target > n) {
      throw new Error(`Invalid odds: need oddsN>=2 and 0<=oddsLo<oddsTarget<=oddsN (got n=${n}, target=${target}, lo=${lo})`)
    }
    houseStake = computeHouseStake(req.tier, n, target, lo, await getOddsEdgeBps(deps))
    if (houseStake < dust) {
      throw new Error(`Odds [${lo},${target})/${n} at tier ${req.tier} give a sub-dust house stake (${houseStake}); raise the tier or the win probability.`)
    }
    odds = { oddsN: n, oddsTarget: target, oddsLo: lo }
  }

  const houseSecret = isVariable
    ? generateVariableSecret(req.oddsN as number)
    : generateSecret(Math.random() < 0.5 ? 'heads' : 'tails')
  const houseHash = hashSecret(houseSecret)
  const housePubkey = Buffer.from(await deps.identity.compressedPublicKey()).toString('hex')
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  const now = Math.floor(Date.now() / 1000)
  // The audit's tighter penalty schedule: the refund window stretches to ~30 min
  // (was 20) so the R1 penalty leaf (~17 min CSV) can mature with a comfortable
  // ~13-min margin before the house's self-refund opens.
  const finalExpiration = now + 1800
  const setupExpiration = now + 600
  const penaltyTimelockSeconds = DEFAULT_PENALTY_TIMELOCK_SECONDS

  // Probe the emulator: if configured (EMULATOR_URL env), mint with the
  // arkade-script escrow. The taptree grows two new leaves on top of
  // the legacy 4:
  //   5. playerForfeit  — R1 escape (CLTV + atomic-sweep covenant)
  //   6. playerWinCovenant — server settles player wins, no client sig
  //   7. creatorWinCovenant — server settles house wins, no client sig
  // Both payout pkScripts (player + house) are pinned at /play time
  // and persisted in TrustlessState so /commit and recovery rebuild the
  // exact same taproot.
  const emulator = await loadEmulatorConfig()
  const playerForfeitPkScript = emulator
    ? ArkAddress.decode(req.playerChangeAddress).pkScript
    : undefined
  const housePayoutPkScript = emulator
    ? ArkAddress.decode(await deps.wallet.getAddress()).pkScript
    : undefined
  const arkadeForfeit =
    emulator && playerForfeitPkScript && housePayoutPkScript
      ? {
          emulatorPubkey: emulator.signerPubkey,
          playerForfeitPkScript,
          housePayoutPkScript,
        }
      : undefined

  const game = await buildGame(
    deps, req.tier, houseHash, req.playerPubkey, req.playerHash,
    finalExpiration, setupExpiration, penaltyTimelockSeconds, odds, arkadeForfeit,
  )
  // Per-party escrow: the house funds the HOUSE escrow (refundable only by
  // the house); the client funds the PLAYER escrow (refundable only by the
  // player). Neither party's refund leaf can touch the other's stake —
  // abort-theft fix.
  //
  // When `arkadeForfeit` is active, both escrows mint with the
  // **atomic-sweep** covenant: each leaf pins the FULL pot as the output
  // value and the OTHER escrow's stake as a cross-input value check. A
  // forfeit-claim must therefore spend BOTH escrows in a single tx whose
  // single output pays the player the combined total.
  const pot = arkadeForfeit ? BigInt(req.tier + houseStake) : undefined
  const houseEscrowScript = getHouseEscrowScript(
    game,
    pot,
    arkadeForfeit ? BigInt(req.tier) : undefined,        // player stake = "other" from house's POV
  )
  const playerEscrowAddress = getPlayerEscrowAddress(
    game, networkHrp,
    pot,
    arkadeForfeit ? BigInt(houseStake) : undefined,      // house stake = "other" from player's POV
  ).encode()
  const houseEscrowScriptHex = hex.encode(houseEscrowScript.pkScript)

  const gameId = uuidv4()
  // Atomically (under the selection mutex) check liability and pick + reserve a
  // free house VTXO covering the HOUSE STAKE; then escrow OUTSIDE the mutex so
  // concurrent plays run in parallel, each on its own reserved VTXO.
  let houseEscrow!: Outpoint
  let candidate!: ExtendedVirtualCoin
  // `available` = settled + preconfirmed, exactly what wallet.getBalance()
  // returns, derived from the VTXO list so one snapshot serves both the
  // liability check and the escrow selection.
  const availableOf = (vs: ExtendedVirtualCoin[]): number =>
    vs
      .filter((v) => v.virtualStatus.state === 'settled' || v.virtualStatus.state === 'preconfirmed')
      .reduce((sum, v) => sum + v.value, 0)
  // Read the house VTXOs from the cache (kept warm by pool maintenance) so the
  // hot path skips a full-history wallet sync — each getVtxos() re-syncs and
  // re-annotates thousands of long-spent outputs, costing seconds. Fetched
  // before the mutex so a cache-miss refresh can't serialize concurrent plays.
  let vtxos = await houseVtxoCache.get(deps)
  await selectionMutex.runExclusive(async () => {
    // Pick a FREE, dust-safe VTXO and reserve ITS OUTPOINT (not just liability):
    // the reservation excludes it from every other play's selection even before
    // this spend propagates to getVtxos(), so two plays can never escrow from
    // the same VTXO. No fallback to a reserved VTXO — pool exhaustion surfaces a
    // retryable "busy" rather than risking a double-spend.
    let available = availableOf(vtxos)
    let picked = pickEscrowVtxo(freeHouseVtxos(vtxos), houseStake, dust)
    // A stale snapshot can understate the balance or hide free VTXOs (e.g. right
    // after a settlement). On a liability or selection miss, refresh once and
    // retry before declaring the house busy.
    if (!picked || reservations.totalLiability() + houseStake > available) {
      vtxos = await houseVtxoCache.refresh(deps)
      available = availableOf(vtxos)
      picked = pickEscrowVtxo(freeHouseVtxos(vtxos), houseStake, dust)
    }
    // Distinguish a permanently-unaffordable bet (house stake exceeds the
    // house's TOTAL spendable balance — retrying can't help; the client should
    // have capped it) from transient contention (in-flight liability) and pool
    // fragmentation, which are retryable.
    if (houseStake > available) {
      throw new BetExceedsCapacityError(`Bet exceeds house capacity: needs ${houseStake} sats but the house bankroll is ${available}.`)
    }
    if (reservations.totalLiability() + houseStake > available) {
      throw new HouseBusyError(`House is busy (liability ${reservations.totalLiability()} + ${houseStake} > ${available}). Try again shortly.`)
    }
    if (!picked) {
      throw new HouseBusyError(`House has no free dust-safe VTXO covering ${houseStake} sats (pool may need refragmenting). Try again shortly.`)
    }
    candidate = picked
    reservations.reserve(gameId, [outpointKey(picked.txid, picked.vout)], houseStake)
  })
  // Committed to spending `candidate`: drop it from the cached snapshot now so a
  // later play can't re-select it once this game's reservation is released (the
  // reservation only guards it while the game is in flight). Without this the
  // cached snapshot would keep handing out an escrowed VTXO → VTXO_ALREADY_SPENT.
  houseVtxoCache.removeOutpoint(candidate.txid, candidate.vout)
  try {
    houseEscrow = await escrowHouseStakeFrom(deps, candidate, houseEscrowScript.pkScript, houseStake)
  } catch (err) {
    reservations.release(gameId)
    throw err
  }

  const state: TrustlessState = {
    finalExpiration,
    setupExpiration,
    houseEscrow,
    penaltyTimelockSeconds,
    ...odds,
    // Persist the arkade-forfeit pin so /commit, /refund, /forfeit and
    // recovery rebuilds derive the EXACT same escrow taproot address. Any
    // drift (e.g. emulator pubkey rotated, player payout address looked up
    // freshly) would produce a different address and break spends.
    ...(arkadeForfeit && playerForfeitPkScript && housePayoutPkScript
      ? {
          arkadeForfeit: {
            emulatorPubkeyHex: hex.encode(arkadeForfeit.emulatorPubkey),
            playerForfeitPkScriptHex: hex.encode(playerForfeitPkScript),
            housePayoutPkScriptHex: hex.encode(housePayoutPkScript),
            playerEscrowValue: req.tier,
            houseEscrowValue: houseStake,
          },
        }
      : {}),
  }
  try {
    await deps.repos.games.save({
      id: gameId,
      tier: req.tier,
      playerPubkey: req.playerPubkey,
      playerChoice: 'trustless',
      playerHash: req.playerHash,
      playerChangeAddress: req.playerChangeAddress,
      houseSecretHex: Buffer.from(houseSecret).toString('hex'),
      finalScriptHex: houseEscrowScriptHex,
      houseVtxosJson: JSON.stringify(state),
    })
  } catch (err) {
    reservations.release(gameId)
    throw err
  }

  return {
    gameId,
    escrowAddress: playerEscrowAddress,
    houseHash,
    housePubkey,
    serverPubkey: deps.arkInfo.signerPubkey,
    betAmount: req.tier,
    finalExpiration,
    houseEscrow,
    oddsN: odds?.oddsN,
    oddsTarget: odds?.oddsTarget,
    oddsLo: odds?.oddsLo,
    pot: req.tier + houseStake,
    penaltyTimelockSeconds,
  }
}

/**
 * Everything needed to (re)build a commit result, derived deterministically
 * from the persisted game + escrow state. Shared by the fresh resolve and the
 * idempotent-replay path so both produce identical economics.
 */
interface CommitContext {
  winner: 'house' | 'player'
  houseSecret: Uint8Array
  playerSecret: Uint8Array
  houseSecretHex: string
  playerSecretHex: string
  escrows: SweepEscrow[]
  pot: number
  rake: number
  proof: string
  houseAddress: string
  playerPayoutAddress: string
  networkHrp: string
  /** Variable-odds echo + rolled value for display; all undefined for the coin. */
  odds?: { oddsN: number; oddsTarget: number; oddsLo: number }
  roll: number | null
}

async function buildCommitContext(
  game: GameRow,
  state: TrustlessState,
  playerSecretHex: string,
  playerEscrow: Outpoint,
  deps: AppDeps,
): Promise<CommitContext> {
  const houseSecret = new Uint8Array(Buffer.from(game.house_secret_hex, 'hex'))
  const playerSecret = new Uint8Array(Buffer.from(playerSecretHex, 'hex'))
  // Variable-odds resolve via the mod-N rule; the coin via secret-length parity.
  const odds = oddsFromState(state)
  const winnerRole = odds
    ? determineVariableWinner(houseSecret, playerSecret, odds.oddsN, odds.oddsTarget, odds.oddsLo)
    : determineWinner(houseSecret, playerSecret)
  const winner: 'house' | 'player' = winnerRole === 'creator' ? 'house' : 'player'
  const roll = odds ? computeVariableRoll(houseSecret, playerSecret, odds.oddsN) : null

  const houseHash = hashSecret(houseSecret)
  // Re-derive with the EXACT persisted penalty timelock — the escrow taproot
  // address is hashed from the leaf bytes, so a different timelock here would
  // produce a different address and break the win-leaf sweep. Defensive
  // fallback to the documented default only if a pre-feature row lacks it.
  const penaltyTimelockSeconds = ensurePenaltyTimelockSeconds(state, game.id)
  // Rehydrate the arkade-forfeit pin (no-op for legacy games). Required so
  // the rebuilt taproot matches what /play minted — the arkade-script leaf
  // is part of the tree's hash.
  const arkadeForfeitPin = rehydrateArkadeForfeit(state)
  const game2 = await buildGame(
    deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
    state.finalExpiration, state.setupExpiration, penaltyTimelockSeconds, odds,
    arkadeForfeitPin
      ? {
          emulatorPubkey: arkadeForfeitPin.emulatorPubkey,
          playerForfeitPkScript: arkadeForfeitPin.playerForfeitPkScript,
          housePayoutPkScript: arkadeForfeitPin.housePayoutPkScript,
        }
      : undefined,
  )
  // Rebuild both per-party escrow scripts; the sweep spends each VTXO via its
  // own script's win leaf (win leaves are byte-identical, taptrees differ).
  // Atomic-sweep covenant: same `pot` on both escrows, other-stake symmetric.
  const escrows: SweepEscrow[] = [
    {
      script: getHouseEscrowScript(
        game2,
        arkadeForfeitPin?.pot,
        arkadeForfeitPin?.playerEscrowValue, // house leaf pins player stake as "other"
      ),
      ...state.houseEscrow,
    },
    {
      script: getPlayerEscrowScript(
        game2,
        arkadeForfeitPin?.pot,
        arkadeForfeitPin?.houseEscrowValue, // player leaf pins house stake as "other"
      ),
      ...playerEscrow,
    },
  ]
  const pot = escrows.reduce((a, e) => a + e.value, 0)
  // Variable-odds bake the house edge into the asymmetric stakes, so no rake is
  // taken there (it would double-charge); the coin still rakes player wins.
  const rake = winner === 'player' && !odds ? await calcRake(pot, deps) : 0
  const proof =
    `house secret ${houseSecret.length}B, player secret ${playerSecret.length}B ` +
    `→ ${winner} wins (pot ${pot})${odds ? ` [odds [${odds.oddsLo},${odds.oddsTarget})/${odds.oddsN}]` : ''}.`

  return {
    winner, houseSecret, playerSecret,
    houseSecretHex: game.house_secret_hex, playerSecretHex,
    escrows, pot, rake, proof,
    houseAddress: await deps.wallet.getAddress(),
    playerPayoutAddress: game.player_change_address!,
    networkHrp: networkHrpFromArkInfo(deps.arkInfo),
    odds, roll,
  }
}

/**
 * Build the commit result from a context, WITHOUT side effects.
 *
 * Path selection:
 *  - **House win**: server-side sweep (always). Returned as
 *    `houseSweepTx` for the caller to submit.
 *  - **Player win, covenant-win available**: server-side sweep via
 *    `buildCovenantSweepTransaction`, posted to the emulator's /v1/tx.
 *    Returned as `playerCovenantSweepTx` so the caller can drive it.
 *    NO client signature needed; the leaf is `[server, emulator_tweaked]`.
 *  - **Player win, no covenant**: legacy path — return the PSBTs for
 *    the client to sign + submit.
 *
 * Covenant-win is available when both escrows were minted with
 * `housePayoutPkScript` set (which requires EMULATOR_URL at /play
 * time AND the new lib version).
 */
function buildCommitResult(
  ctx: CommitContext,
  deps: AppDeps,
): {
  result: TrustlessCommitResult
  houseSweepTx?: BuiltOffchainTx
  playerCovenantSweepTx?: BuiltOffchainTx
} {
  if (ctx.winner === 'house') {
    const houseSweepTx = buildSweepTransaction(deps.arkInfo, ctx.networkHrp, {
      winner: 'house', escrows: ctx.escrows,
      payoutAddress: ctx.houseAddress, houseAddress: ctx.houseAddress, rake: 0,
    })
    const result: TrustlessCommitResult = {
      winner: 'house', houseSecret: ctx.houseSecretHex, playerSecret: ctx.playerSecretHex,
      payout: ctx.pot, rake: 0, proof: ctx.proof,
      roll: ctx.roll, oddsN: ctx.odds?.oddsN, oddsLo: ctx.odds?.oddsLo, oddsTarget: ctx.odds?.oddsTarget,
    }
    return { result, houseSweepTx }
  }

  // Player won.
  const haveCovenantLeaves = ctx.escrows.every(
    (e) => e.script.playerWinCovenantArkadeScript !== undefined,
  )
  // Player-win path prefers the covenant sweep: server submits to the
  // emulator + arkd directly, no client interaction needed. Falls back
  // to the legacy "return PSBTs for the client to sign" when the
  // escrows weren't minted with housePayoutPkScript (or the rake is
  // non-zero — the covenant binds a single full-pot output, so rake-
  // taking is incompatible with this path; we still serve those games
  // via the legacy leaves).
  if (haveCovenantLeaves && ctx.rake === 0) {
    const covenantSweep = buildCovenantSweepTransaction(deps.arkInfo, ctx.networkHrp, {
      winner: 'player',
      escrows: ctx.escrows as unknown as CovenantSweepEscrow[],
      payoutAddress: ctx.playerPayoutAddress,
      potAmount: BigInt(ctx.pot),
      bothSecrets: [
        new Uint8Array(Buffer.from(ctx.houseSecretHex, 'hex')),
        new Uint8Array(Buffer.from(ctx.playerSecretHex, 'hex')),
      ],
    })
    const result: TrustlessCommitResult = {
      winner: 'player', houseSecret: ctx.houseSecretHex, playerSecret: ctx.playerSecretHex,
      payout: ctx.pot, rake: 0, proof: ctx.proof,
      roll: ctx.roll, oddsN: ctx.odds?.oddsN, oddsLo: ctx.odds?.oddsLo, oddsTarget: ctx.odds?.oddsTarget,
      // No `sweep` field — the server settles via the emulator and
      // returns the resulting txid. The client doesn't need to do
      // anything.
    }
    return { result, playerCovenantSweepTx: covenantSweep }
  }

  // Legacy: server builds the playerWin sweep but the CLIENT signs + submits.
  const sweep = buildSweepTransaction(deps.arkInfo, ctx.networkHrp, {
    winner: 'player', escrows: ctx.escrows,
    payoutAddress: ctx.playerPayoutAddress, houseAddress: ctx.houseAddress, rake: ctx.rake,
  })
  const result: TrustlessCommitResult = {
    winner: 'player', houseSecret: ctx.houseSecretHex, playerSecret: ctx.playerSecretHex,
    payout: ctx.pot - ctx.rake, rake: ctx.rake, proof: ctx.proof,
    roll: ctx.roll, oddsN: ctx.odds?.oddsN, oddsLo: ctx.odds?.oddsLo, oddsTarget: ctx.odds?.oddsTarget,
    sweep: {
      sweepPsbt: hex.encode(sweep.arkTx.toPSBT()),
      sweepCheckpoints: sweep.checkpoints.map((c) => hex.encode(c.toPSBT())),
      inputCount: ctx.escrows.length,
      witnessHex: [ctx.houseSecretHex, ctx.playerSecretHex],
    },
  }
  return { result }
}

/**
 * Rebuild the result of an already-resolved game for an idempotent `/commit`
 * replay. Rebuilds from the persisted record only — never re-resolves and never
 * re-submits: a house win returns the persisted sweep txid; a player win
 * rebuilds the sweep PSBTs the client still needs to claim.
 */
async function rebuildResolvedResult(game: GameRow, deps: AppDeps): Promise<TrustlessCommitResult> {
  const state = JSON.parse(game.house_vtxos_json as string) as TrustlessState
  if (!state.playerEscrow || !game.player_secret_hex) {
    throw new Error(`Game ${game.id} resolved without replay data; cannot rebuild commit result`)
  }
  const ctx = await buildCommitContext(game, state, game.player_secret_hex, state.playerEscrow, deps)
  const { result } = buildCommitResult(ctx, deps)
  if (ctx.winner === 'house') result.txid = state.resolveTxid
  return result
}

export async function handleTrustlessCommit(
  gameId: string,
  req: TrustlessCommitRequest,
  deps: AppDeps,
): Promise<TrustlessCommitResult> {
  // One game resolves once. Serialize commits per game so concurrent calls (or
  // a client retry) can't double-resolve or double-sweep; different games still
  // commit in parallel.
  return commitLocks.runExclusive(gameId, async () => {
    const game = await deps.repos.games.get(gameId)
    if (!game) throw new Error(`Game not found: ${gameId}`)

    // Idempotent replay: a retried commit (e.g. the client lost our response)
    // returns the SAME result without re-resolving. Essential on a player win —
    // the client needs the sweep PSBT to claim, so erroring here would strand
    // the winnings until the refund timeout.
    if (game.status === 'resolved') return rebuildResolvedResult(game, deps)
    if (game.status !== 'pending') throw new Error(`Game is not pending: ${game.status}`)

    const playerSecret = Buffer.from(req.playerSecretHex, 'hex')
    if (createHash('sha256').update(playerSecret).digest('hex') !== game.player_hash) {
      throw new Error('Player secret does not match committed hash')
    }
    const state = JSON.parse(game.house_vtxos_json as string) as TrustlessState
    const ctx = await buildCommitContext(game, state, req.playerSecretHex, req.playerEscrow, deps)
    const { result, houseSweepTx, playerCovenantSweepTx } = buildCommitResult(ctx, deps)

    let resolveTxid: string | undefined
    if (houseSweepTx) {
      // House sweeps both escrow VTXOs via creatorWin (single-party, house+server).
      resolveTxid = await submitOffchain(deps, houseSweepTx.arkTx, houseSweepTx.checkpoints, [0, 1], {
        inputs: [0, 1], data: [ctx.houseSecret, ctx.playerSecret],
      })
      result.txid = resolveTxid
    } else if (playerCovenantSweepTx) {
      // Player won AND covenant-win leaves are available. Server settles
      // via the emulator: the leaf is [server, emulator_tweaked], so we
      // sign + post to /v1/tx. Emulator validates the covenant +
      // co-signs + forwards to arkd. No client signature needed.
      const cfg = await loadEmulatorConfig()
      if (!cfg) {
        // Should never happen — covenant leaves only exist when emulator
        // was probed OK at /play. Defensive throw rather than silent
        // fallthrough; the client will retry.
        throw new Error('Covenant-win path requires emulator URL but loadEmulatorConfig returned null')
      }
      const signed = await deps.identity.sign(playerCovenantSweepTx.arkTx, [0, 1])
      const emuResp = await fetch(`${cfg.url}/v1/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          arkTx: base64.encode(signed.toPSBT()),
          checkpointTxs: playerCovenantSweepTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!emuResp.ok) {
        throw new Error(`Emulator rejected covenant sweep: ${emuResp.status} ${await emuResp.text()}`)
      }
      const emuBody = (await emuResp.json()) as { signedArkTx?: string }
      if (!emuBody.signedArkTx) {
        throw new Error('Emulator did not return signedArkTx')
      }
      // Extract the txid from the finalized PSBT — the emulator
      // self-finalizes via arkd, so this is the resolved sweep.
      const finalTx = Transaction.fromPSBT(base64.decode(emuBody.signedArkTx))
      resolveTxid = finalTx.id
      result.txid = resolveTxid
    }

    // Persist resolution + the replay data (player escrow outpoint, house-win
    // sweep txid) atomically with the status flip, inside the per-game lock.
    const persisted: TrustlessState = { ...state, playerEscrow: req.playerEscrow, resolveTxid }
    await deps.repos.games.update(gameId, {
      playerSecretHex: req.playerSecretHex,
      winner: ctx.winner,
      rakeAmount: result.rake,
      payoutAmount: result.payout,
      status: 'resolved',
      houseVtxosJson: JSON.stringify(persisted),
    })
    reservations.release(gameId)
    return result
  })
}

export interface TrustlessRefundRequest {
  /** The player's escrow VTXO outpoint to reclaim. */
  playerEscrow: Outpoint
}

export interface TrustlessRefundResult {
  /** Unsigned refund tx spending the player escrow back to the player. The
   * client verifies the output pays its own address, signs, and submits. */
  refundPsbt: string
  refundCheckpoints: string[]
  /** The CLTV the refund is timelocked to; arkd won't co-sign before it. */
  finalExpiration: number
  /** Address the refund pays — the client must check this is its own. */
  refundAddress: string
}

/**
 * Build the player's escrow-refund tx so a player can reclaim a stalled game
 * WITHOUT trusting the server to resolve. The refund leaf is owner-scoped
 * (player + server, CLTV at `finalExpiration`), so the server can't redirect
 * the funds — it only assembles the unsigned tx. Only the player's key can
 * sign it, and arkd won't co-sign until `finalExpiration`. The client fetches
 * this right after escrowing and keeps it, so even a later server outage can't
 * strand the stake. Rejected once the game is resolved (escrow already swept).
 */
export async function handleTrustlessRefund(
  gameId: string,
  req: TrustlessRefundRequest,
  deps: AppDeps,
): Promise<TrustlessRefundResult> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error(`Game not found: ${gameId}`)
  if (game.status === 'resolved') throw new Error(`Game ${gameId} is resolved; escrow already swept`)
  if (!game.player_change_address) throw new Error(`Game ${gameId} has no player change address`)

  const state = JSON.parse(game.house_vtxos_json as string) as TrustlessState
  const houseHash = hashSecret(new Uint8Array(Buffer.from(game.house_secret_hex, 'hex')))
  const penaltyTimelockSeconds = ensurePenaltyTimelockSeconds(state, game.id)
  const arkadeForfeitPin = rehydrateArkadeForfeit(state)
  const game2 = await buildGame(
    deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
    state.finalExpiration, state.setupExpiration, penaltyTimelockSeconds, oddsFromState(state),
    arkadeForfeitPin
      ? {
          emulatorPubkey: arkadeForfeitPin.emulatorPubkey,
          playerForfeitPkScript: arkadeForfeitPin.playerForfeitPkScript,
          housePayoutPkScript: arkadeForfeitPin.housePayoutPkScript,
        }
      : undefined,
  )
  const playerEscrowScript = getPlayerEscrowScript(
    game2,
    arkadeForfeitPin?.pot,
    arkadeForfeitPin?.houseEscrowValue,
  )
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  const refund = buildRefundTransaction(deps.arkInfo, networkHrp, {
    escrowScript: playerEscrowScript,
    txid: req.playerEscrow.txid,
    vout: req.playerEscrow.vout,
    value: req.playerEscrow.value,
    refundAddress: game.player_change_address,
  })
  return {
    refundPsbt: hex.encode(refund.arkTx.toPSBT()),
    refundCheckpoints: refund.checkpoints.map((c) => hex.encode(c.toPSBT())),
    finalExpiration: state.finalExpiration,
    refundAddress: game.player_change_address,
  }
}

export interface TrustlessPenaltyRequest {
  /** The player's escrow VTXO outpoint (the one the client supplied at /play time). */
  playerEscrow: Outpoint
}

export interface TrustlessPenaltyResult {
  /** Unsigned penalty tx (hex-encoded PSBT) spending BOTH escrows via the
   * playerPenalty leaf, paying the full pot to the player's change address.
   * Client attaches [playerSecret] as the condition witness, signs both inputs
   * with its key, and submits after the CSV timelock matures (arkd enforces). */
  penaltyPsbt: string
  penaltyCheckpoints: string[]
  /** Relative BIP68 CSV timelock (seconds) baked into the playerPenalty leaf —
   * for the client's UX countdown / readiness gating. */
  penaltyTimelockSeconds: number
  /** Address the penalty pays — the client MUST verify this is its own
   * change address before signing. */
  payoutAddress: string
}

/**
 * Build the unsigned penalty-claim tx for a game where the house withheld at
 * /commit (R1 forfeit). The penalty leaf is [player + arkd] + hash-check(playerHash)
 * + CSV(penaltyTimelockSeconds), so the client can sweep BOTH escrows with its
 * own secret once the relative timelock matures — no house cooperation required.
 * Rejected once the game is resolved (escrows already swept).
 */
export async function handleTrustlessPenalty(
  gameId: string,
  req: TrustlessPenaltyRequest,
  deps: AppDeps,
): Promise<TrustlessPenaltyResult> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error(`Game not found: ${gameId}`)
  if (game.status === 'resolved') throw new Error(`Game ${gameId} is resolved; escrows already swept`)
  if (!game.player_change_address) throw new Error(`Game ${gameId} has no player change address`)

  const state = JSON.parse(game.house_vtxos_json as string) as TrustlessState
  if (!state.houseEscrow) throw new Error(`Game ${gameId} has no recorded house escrow`)
  const penaltyTimelockSeconds = ensurePenaltyTimelockSeconds(state, gameId)
  const arkadeForfeitPin = rehydrateArkadeForfeit(state)
  const houseHash = hashSecret(new Uint8Array(Buffer.from(game.house_secret_hex, 'hex')))
  const game2 = await buildGame(
    deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
    state.finalExpiration, state.setupExpiration, penaltyTimelockSeconds, oddsFromState(state),
    arkadeForfeitPin
      ? {
          emulatorPubkey: arkadeForfeitPin.emulatorPubkey,
          playerForfeitPkScript: arkadeForfeitPin.playerForfeitPkScript,
          housePayoutPkScript: arkadeForfeitPin.housePayoutPkScript,
        }
      : undefined,
  )
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  const escrows: SweepEscrow[] = [
    {
      script: getHouseEscrowScript(
        game2,
        arkadeForfeitPin?.pot,
        arkadeForfeitPin?.playerEscrowValue,
      ),
      ...state.houseEscrow,
    },
    {
      script: getPlayerEscrowScript(
        game2,
        arkadeForfeitPin?.pot,
        arkadeForfeitPin?.houseEscrowValue,
      ),
      ...req.playerEscrow,
    },
  ]
  const penalty = buildPenaltyTransaction(deps.arkInfo, networkHrp, {
    escrows,
    payoutAddress: game.player_change_address,
  })
  return {
    penaltyPsbt: hex.encode(penalty.arkTx.toPSBT()),
    penaltyCheckpoints: penalty.checkpoints.map((c) => hex.encode(c.toPSBT())),
    penaltyTimelockSeconds,
    payoutAddress: game.player_change_address,
  }
}

export interface TrustlessForfeitRequest {
  /** The player's escrow VTXO outpoint (supplied at /play). */
  playerEscrow: Outpoint
}

export interface TrustlessForfeitResult {
  /** Unsigned forfeit-claim tx (hex-encoded PSBT) spending BOTH escrows
   * atomically via the arkade-script `playerForfeit` leaf. Single user
   * output pays the player the FULL POT. The covenants on both inputs
   * pin the same pot and verify each other's stake via INSPECTINPUTVALUE,
   * so neither escrow is spendable alone. Client signs + submits to the
   * emulator first (POST /v1/tx), then arkd accepts the finalized tx
   * after CLTV maturity. */
  forfeitPsbt: string
  forfeitCheckpoints: string[]
  /** Absolute CLTV timelock (unix seconds) baked into the playerForfeit
   * leaf's CLTVMultisigTapscript closure. Same value as the refund leaf's
   * — by design the forfeit window opens exactly when the abort window
   * closes. */
  forfeitClaimableAt: number
  /** Address the forfeit pays. The client MUST verify this matches its own
   * change address before signing (the arkade-script covenant pins this
   * pkScript exactly — submitting with a different one means the emulator
   * refuses to sign). */
  payoutAddress: string
  /** The pot — player stake + house stake. The covenant on EACH input
   * verifies the single output pays exactly this amount. */
  potAmount: number
  /** Per-escrow values for client-side display and audit. The covenants
   * pin each: `[houseStake, playerStake]`. Sum must equal `potAmount`. */
  stakes: [number, number]
}

/**
 * Build the unsigned arkade-script forfeit-claim tx for a game where the
 * house withheld at /commit AND the game was minted with the 5-leaf
 * escrow (server had EMULATOR_URL set at /play time).
 *
 * Architectural difference from /penalty:
 * - /penalty spends via `ConditionCSVMultisigTapscript playerPenalty` —
 *   arkd's exit bucket. Forces a unilateral on-chain exit.
 * - /forfeit spends via `CLTVMultisigTapscript playerForfeit` wrapping an
 *   arkade-script covenant — arkd's execution bucket. Stays off-chain,
 *   matches the architectural intent that "CSV is for unilateral exit;
 *   CLTV is for execution paths."
 *
 * Rejected for games that don't have a pinned arkadeForfeit (legacy games
 * before EMULATOR_URL was set, or sessions where the emulator probe failed
 * at /play time). Those keep using /penalty.
 */
export async function handleTrustlessForfeit(
  gameId: string,
  req: TrustlessForfeitRequest,
  deps: AppDeps,
): Promise<TrustlessForfeitResult> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error(`Game not found: ${gameId}`)
  if (game.status === 'resolved') throw new Error(`Game ${gameId} is resolved; escrows already swept`)
  if (!game.player_change_address) throw new Error(`Game ${gameId} has no player change address`)

  const state = JSON.parse(game.house_vtxos_json as string) as TrustlessState
  if (!state.houseEscrow) throw new Error(`Game ${gameId} has no recorded house escrow`)
  const arkadeForfeitPin = rehydrateArkadeForfeit(state)
  if (!arkadeForfeitPin) {
    throw new Error(
      `Game ${gameId} was minted without arkade-script forfeit (no EMULATOR_URL at /play time); ` +
        `use /api/game/:id/penalty for the CSV-based playerPenalty leaf instead`,
    )
  }

  const penaltyTimelockSeconds = ensurePenaltyTimelockSeconds(state, gameId)
  const houseHash = hashSecret(new Uint8Array(Buffer.from(game.house_secret_hex, 'hex')))
  const game2 = await buildGame(
    deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
    state.finalExpiration, state.setupExpiration, penaltyTimelockSeconds, oddsFromState(state),
    {
      emulatorPubkey: arkadeForfeitPin.emulatorPubkey,
      playerForfeitPkScript: arkadeForfeitPin.playerForfeitPkScript,
          housePayoutPkScript: arkadeForfeitPin.housePayoutPkScript,
    },
  )
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  // Atomic-sweep escrows. Order [house, player] matters — the
  // EmulatorPacket entries reference each input's covenant + witness in
  // this same order, with witness[1-i] pointing at the OTHER input.
  const escrows: ForfeitClaimEscrow[] = [
    {
      script: getHouseEscrowScript(
        game2,
        arkadeForfeitPin.pot,
        arkadeForfeitPin.playerEscrowValue,
      ),
      ...state.houseEscrow,
    },
    {
      script: getPlayerEscrowScript(
        game2,
        arkadeForfeitPin.pot,
        arkadeForfeitPin.houseEscrowValue,
      ),
      ...req.playerEscrow,
    },
  ]
  const forfeit = buildForfeitClaimTransaction(deps.arkInfo, networkHrp, {
    escrows,
    payoutAddress: game.player_change_address,
    potAmount: arkadeForfeitPin.pot,
  })

  return {
    forfeitPsbt: hex.encode(forfeit.arkTx.toPSBT()),
    forfeitCheckpoints: forfeit.checkpoints.map((c) => hex.encode(c.toPSBT())),
    forfeitClaimableAt: state.finalExpiration,
    payoutAddress: game.player_change_address,
    potAmount: Number(arkadeForfeitPin.pot),
    stakes: [
      Number(arkadeForfeitPin.houseEscrowValue),
      Number(arkadeForfeitPin.playerEscrowValue),
    ],
  }
}

/**
 * Reclaim orphaned HOUSE escrows for stalled (expired) games whose refund CLTV
 * (finalExpiration) has matured. The per-party model means each side reclaims
 * ONLY its own escrow on a stall — the player does so client-side (see the
 * client reclaim flow); this is the house's counterpart. Without it the house's
 * stake on every abandoned game would sit stuck at the escrow address — a slow
 * fund leak at scale. Idempotent via the persisted `houseRefundTxid`, so it's
 * safe to run on a timer and at boot. Returns the number of escrows reclaimed.
 */
export async function recoverOrphanedHouseEscrows(deps: AppDeps): Promise<number> {
  const now = Math.floor(Date.now() / 1000)
  const expired = await deps.repos.games.list({ status: 'expired', limit: 500 })
  let recovered = 0
  for (const game of expired) {
    if (game.player_choice !== 'trustless' || !game.house_vtxos_json) continue
    let state: TrustlessState
    try {
      state = JSON.parse(game.house_vtxos_json) as TrustlessState
    } catch {
      continue
    }
    if (!state.houseEscrow || state.houseRefundTxid) continue // not trustless, or already reclaimed
    if (state.finalExpiration > now) continue // refund CLTV not matured yet

    try {
      const houseHash = hashSecret(new Uint8Array(Buffer.from(game.house_secret_hex, 'hex')))
      const penaltyTimelockSeconds = ensurePenaltyTimelockSeconds(state, game.id)
      const arkadeForfeitPin = rehydrateArkadeForfeit(state)
      const game2 = await buildGame(
        deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
        state.finalExpiration, state.setupExpiration, penaltyTimelockSeconds, oddsFromState(state),
        arkadeForfeitPin
          ? {
              emulatorPubkey: arkadeForfeitPin.emulatorPubkey,
              playerForfeitPkScript: arkadeForfeitPin.playerForfeitPkScript,
          housePayoutPkScript: arkadeForfeitPin.housePayoutPkScript,
            }
          : undefined,
      )
      const houseEscrowScript = getHouseEscrowScript(
        game2,
        arkadeForfeitPin?.pot,
        arkadeForfeitPin?.playerEscrowValue,
      )
      const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
      const refund = buildRefundTransaction(deps.arkInfo, networkHrp, {
        escrowScript: houseEscrowScript,
        txid: state.houseEscrow.txid,
        vout: state.houseEscrow.vout,
        value: state.houseEscrow.value,
        refundAddress: await deps.wallet.getAddress(),
      })
      const txid = await submitOffchain(deps, refund.arkTx, refund.checkpoints, [0])
      await deps.repos.games.update(game.id, {
        houseVtxosJson: JSON.stringify({ ...state, houseRefundTxid: txid } as TrustlessState),
      })
      reservations.release(game.id)
      recovered++
      console.log(`[recovery] reclaimed house escrow for stalled game ${game.id} (${state.houseEscrow.value} sats), txid ${txid}`)
    } catch (err) {
      // Most likely the CLTV isn't accepted yet or the escrow was already spent.
      // A new expected case (R1 forfeit): if the player penalty-claimed (spending
      // BOTH escrows via the playerPenalty leaf after penaltyTimelockSeconds),
      // the house escrow VTXO is already spent by the time we try to refund it
      // here. The submit rejects with a double-spend error, which lands here.
      // That is the correct outcome — the house has nothing to reclaim because the
      // player took the whole pot under the R1 forfeit rules. We deliberately do
      // NOT pre-check for this state (e.g. via an indexer isSpent lookup) because
      // the catch is sufficient and avoids an extra round-trip on every recovery
      // pass for the common (non-penalty) case.
      //
      // Leave the game for a later pass rather than marking it reclaimed — if it
      // was a transient CLTV rejection the next scheduled run will succeed.
      console.warn(`[recovery] house escrow reclaim failed for game ${game.id}:`, err instanceof Error ? err.message : err)
    }
  }
  if (recovered > 0) console.log(`[recovery] reclaimed ${recovered} orphaned house escrow(s)`)
  return recovered
}

/**
 * Reconcile games stuck `pending` because the server crashed AFTER submitting a
 * house-win sweep but BEFORE persisting the result. A player win is persisted
 * `resolved` BEFORE the client ever spends the escrow, so a `pending` game whose
 * HOUSE escrow is already spent on-Ark can ONLY be a crashed house-win sweep —
 * we mark it resolved (winner = house, pot to the house). Detection is a direct
 * indexer lookup of the escrow outpoint's `isSpent`; no hot-path write-ahead
 * needed. Returns the number reconciled.
 */
export async function reconcilePendingSweeps(deps: AppDeps): Promise<number> {
  const pending = await deps.repos.games.list({ status: 'pending', limit: 500 })
  const trustless = pending.filter((g) => g.player_choice === 'trustless' && g.house_vtxos_json)
  if (trustless.length === 0) return 0

  const indexer = new RestIndexerProvider(process.env.ARK_SERVER_URL || 'https://mutinynet.arkade.sh')
  let reconciled = 0
  for (const game of trustless) {
    let state: TrustlessState
    try {
      state = JSON.parse(game.house_vtxos_json as string) as TrustlessState
    } catch {
      continue
    }
    if (!state.houseEscrow) continue
    try {
      const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid: state.houseEscrow.txid, vout: state.houseEscrow.vout }] })
      const v = vtxos.find((x) => x.txid === state.houseEscrow.txid && x.vout === state.houseEscrow.vout) ?? vtxos[0]
      if (!v || !v.isSpent) continue // not swept → still genuinely pending

      const pot = state.houseEscrow.value + game.tier // house stake + player stake
      await deps.repos.games.update(game.id, {
        winner: 'house',
        rakeAmount: 0,
        payoutAmount: pot,
        status: 'resolved',
        houseVtxosJson: JSON.stringify({ ...state, resolveTxid: v.spentBy ?? state.resolveTxid } as TrustlessState),
      })
      reservations.release(game.id)
      reconciled++
      console.log(`[reconcile] crash-mid-sweep house win ${game.id} resolved (escrow spent by ${v.spentBy ?? 'unknown'})`)
    } catch (err) {
      console.warn(`[reconcile] spent-check failed for game ${game.id}:`, err instanceof Error ? err.message : err)
    }
  }
  if (reconciled > 0) console.log(`[reconcile] resolved ${reconciled} crash-mid-sweep game(s)`)
  return reconciled
}

/**
 * Run escrow reconciliation + house-escrow recovery shortly after boot, then on
 * a timer. `reconcilePendingSweeps` cleans up crash-mid-sweep house wins;
 * `recoverOrphanedHouseEscrows` reclaims stalled house stakes once their CLTV
 * matures (the longer `finalExpiration` cadence, not the 5-min expiry sweep).
 */
export function startEscrowRecoveryTimer(deps: AppDeps, intervalMs = 120_000): NodeJS.Timeout {
  const tick = async () => {
    await reconcilePendingSweeps(deps).catch((e) =>
      console.error('[reconcile] tick failed:', e instanceof Error ? e.message : e),
    )
    await recoverOrphanedHouseEscrows(deps).catch((e) =>
      console.error('[recovery] tick failed:', e instanceof Error ? e.message : e),
    )
  }
  setTimeout(tick, 5_000)
  return setInterval(tick, intervalMs)
}

// Re-export for callers that need the row shape.
export type { GameRow }
