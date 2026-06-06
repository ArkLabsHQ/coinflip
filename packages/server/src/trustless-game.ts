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
  generateRandomCoinSecret,
  determineWinner,
  generateVariableSecret,
  determineVariableWinner,
  computeVariableRoll,
  getPlayerEscrowScript,
  getHouseEscrowScript,
  getPlayerEscrowAddress,
  getHouseEscrowAddress,
  getHouseEscrowOptions,
  getPlayerEscrowOptions,
  buildCovenantSweepTransaction,
  buildRefundTransaction,
  buildForfeitClaimTransaction,
  COINFLIP_ESCROW_TYPE,
  CoinflipEscrowContractHandler,
  COINFLIP_ESCROW_V3_TYPE,
  CoinflipEscrowV3ContractHandler,
  getPlayerEscrowScriptV3,
  getHouseEscrowScriptV3,
  getPlayerEscrowAddressV3,
  getHouseEscrowAddressV3,
  getHouseEscrowOptionsV3,
  getPlayerEscrowOptionsV3,
  buildCovenantSweepTransactionV3,
  buildRefundTransactionV3,
  buildForfeitClaimTransactionV3,
  determineWinnerV3,
  computeRollV3,
  commitDigit,
  randomUniformInt,
  type CoinflipEscrowScriptV3,
  type DigitCommit,
  type EscrowInputV3,
  type Game,
  type EscrowInput,
  type BuiltOffchainTx,
} from 'arkade-coinflip'
import { packets } from '@arklabshq/contract-workflows-prototype'
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
  type IndexerProvider,
} from '@arkade-os/sdk'
import { hashSecret, networkHrpFromArkInfo, ARK_SERVER_URL } from './house-wallet.js'
import { reservations, selectionMutex, freeHouseVtxos, HouseBusyError, BetExceedsCapacityError, KeyedMutex, outpointKey, pickEscrowVtxos, houseVtxoCache } from './vtxo-pool.js'
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
  /**
   * The house's escrow VTXO, if the house has funded yet. Since lazy-funding
   * (v0.3.5+): the house funds at /commit, so this is absent on /play. The
   * client doesn't use it for tx building (the server handles the sweep);
   * kept for legacy clients that still read it.
   */
  houseEscrow?: Outpoint
  /**
   * Serialized params of the PLAYER escrow's `coinflip-escrow` contract — the
   * exact options that produce the on-chain player-escrow pkScript. The client
   * feeds these to `ContractManager.createContract` so its own ContractWatcher
   * re-derives a byte-identical script and emits `vtxo_spent` the instant the
   * atomic sweep settles (house OR player win), clearing the stalled-bet stash.
   */
  escrowContractParams: Record<string, string>
  /** Variable-odds echo + economics so the client can show/verify the bet. */
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
  /** Total pot the winner sweeps = player stake (`betAmount`) + house stake. */
  pot: number
  /**
   * Contract version of the escrow this game uses — 'v2' (today's
   * legacy length-encoded predicate) or 'v3' (arkade-script + packet-borne
   * reveals). Defaults to 'v2' on response unless the server is configured
   * with LEGACY_ESCROW=false. The client uses this to route to the right
   * contract handler when registering the player's escrow with the SDK.
   */
  contractVersion?: 'v2' | 'v3'
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
  proof: string
  /**
   * Variable-odds: the rolled value `(digitC + digitP) mod n` in [0, n) — the
   * dice/crash face for the skin to display. null for the 50/50 coin or when
   * a secret was out of range (cheat-penalty).
   */
  roll?: number | null
  oddsN?: number
  oddsLo?: number
  oddsTarget?: number
  /** The covenant-sweep txid. Always set on resolve — the server settles
   *  both wins via the emulator-bound covenant. */
  txid?: string
}

/**
 * Decide which escrow shape to mint NEW games with. v2 is the default. Set
 * `ESCROW_VERSION=v3` to mint games against the v0.3 arkade-script + reveal-
 * packet escrow. Existing in-flight games keep using whatever shape they were
 * minted with (state.contractVersion); only NEW /play calls read this.
 */
export function newGameEscrowVersion(): 'v2' | 'v3' {
  const v = (process.env.ESCROW_VERSION ?? 'v2').trim().toLowerCase()
  return v === 'v3' ? 'v3' : 'v2'
}

/**
 * For v3 we always run the arkade-script with concrete (n, target, lo). The
 * coin (no client-supplied odds) maps to n=2, target=1, lo=0 — exactly the
 * regtest's player-wins-iff-roll==0 setup, faithful to a 50/50 coin.
 */
const V3_COIN_ODDS = { oddsN: 2, oddsTarget: 1, oddsLo: 0 } as const

/** Per-party state we persist on the game row (reusing house_vtxos_json). */
interface TrustlessState {
  /**
   * Contract version this specific game was minted with. Missing means v2
   * (forward-compat: rows written before the v3 toggle existed are v2). All
   * commit/refund/forfeit/recovery paths branch on this so an in-flight v2
   * game stays v2 even after the operator flips ESCROW_VERSION=v3.
   */
  contractVersion?: 'v2' | 'v3'
  finalExpiration: number
  setupExpiration: number
  /**
   * The house's escrow outpoint, written ONCE the house actually funds
   * (`fundHouseEscrowOnce()` runs the first time `/commit` arrives with a
   * valid player escrow). Absent at /play time — see `houseVtxoOutpoint`
   * for the RESERVED-but-unspent input that will be used to fund. Recovery /
   * forfeit / refund all skip games whose house escrow is still absent
   * (no on-chain footprint to clean up — the reservation handles it).
   */
  houseEscrow?: Outpoint
  /**
   * The pre-selected house VTXO outpoints to consume when funding the
   * house escrow at /commit. Reserved under `selectionMutex` at /play, so
   * concurrent plays can't pick them; persisted so `rebuildReservations`
   * can restore the reservation after a restart. Multi-input (since
   * v0.3.6) lets large bets compose from several smaller VTXOs without
   * needing a single covering input. Holds liability = houseStake exactly;
   * the sum of the VTXOs may be larger (change goes back to the house
   * wallet at funding time).
   *
   * Backwards-compat with v0.3.5 (single-outpoint shape `houseVtxoOutpoint`):
   * code that reads this MUST also fall back to the legacy field via the
   * `readReservedHouseVtxos()` helper.
   */
  houseVtxoOutpoints?: { txid: string; vout: number; value: number }[]
  /** Legacy v0.3.5 single-outpoint field. Read-only at v0.3.6+; new rows
   *  write `houseVtxoOutpoints` (array) instead. */
  houseVtxoOutpoint?: { txid: string; vout: number; value: number }
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
   * Per-game arkade-script pin. Required for all new games — the
   * coinflip protocol is single-path (covenant-resolved). Hex-encoded
   * to keep the persisted JSON small.
   */
  arkadeForfeit: {
    /** Compressed (33-byte) or x-only (32-byte) emulator pubkey, hex. */
    emulatorPubkeyHex: string
    /** Player payout P2TR pkScript, hex. */
    playerPayoutPkScriptHex: string
    /** House payout P2TR pkScript, hex. */
    housePayoutPkScriptHex: string
    /** Player stake in sats. */
    playerStake: number
    /** House stake in sats. */
    houseStake: number
    /** CSV exit_delay (seconds) baked into the exit-mirror leaves. */
    exitDelay: number
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


const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)

/**
 * Per-version dispatch for escrow script builders. Both v2 and v3 take the
 * same Game shape; only the resulting taptree differs. Centralized here so
 * /play / /commit / /refund / /forfeit / recovery share one branch.
 */
function v3Escrows(game: Game): { player: CoinflipEscrowScriptV3; house: CoinflipEscrowScriptV3 } {
  return { player: getPlayerEscrowScriptV3(game), house: getHouseEscrowScriptV3(game) }
}

function v2Escrows(game: Game): { player: ReturnType<typeof getPlayerEscrowScript>; house: ReturnType<typeof getHouseEscrowScript> } {
  return { player: getPlayerEscrowScript(game), house: getHouseEscrowScript(game) }
}

/** Build the per-game Game object the lib needs to derive the escrow script. */
async function buildGame(
  deps: AppDeps,
  tier: number,
  houseHashHex: string,
  playerPubkeyHex: string,
  playerHashHex: string,
  finalExpiration: number,
  setupExpiration: number,
  odds: { oddsN: number; oddsTarget: number; oddsLo: number } | undefined,
  arkadeForfeit: {
    emulatorPubkey: Uint8Array
    playerPayoutPkScript: Uint8Array
    housePayoutPkScript: Uint8Array
    playerStake: number
    houseStake: number
    exitDelay: number
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
    creator: { pubkey: housePub, hash: hex.decode(houseHashHex) },
    player: { pubkey: playerPub, hash: hex.decode(playerHashHex) },
    oddsN: odds?.oddsN,
    oddsTarget: odds?.oddsTarget,
    oddsLo: odds?.oddsLo,
    emulatorPubkey: arkadeForfeit.emulatorPubkey,
    playerForfeitPkScript: arkadeForfeit.playerPayoutPkScript,
    housePayoutPkScript: arkadeForfeit.housePayoutPkScript,
    playerStake: arkadeForfeit.playerStake,
    houseStake: arkadeForfeit.houseStake,
    exitDelay: arkadeForfeit.exitDelay,
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
/** Rehydrate the arkade-forfeit pin from persisted state. */
function rehydrateArkadeForfeit(state: TrustlessState): {
  emulatorPubkey: Uint8Array
  playerPayoutPkScript: Uint8Array
  housePayoutPkScript: Uint8Array
  playerStake: number
  houseStake: number
  exitDelay: number
} {
  return {
    emulatorPubkey: hex.decode(state.arkadeForfeit.emulatorPubkeyHex),
    playerPayoutPkScript: hex.decode(state.arkadeForfeit.playerPayoutPkScriptHex),
    housePayoutPkScript: hex.decode(state.arkadeForfeit.housePayoutPkScriptHex),
    playerStake: state.arkadeForfeit.playerStake,
    houseStake: state.arkadeForfeit.houseStake,
    exitDelay: state.arkadeForfeit.exitDelay,
  }
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
 * Read the reserved house VTXO outpoints from persisted state, honouring
 * the v0.3.5 → v0.3.6 schema transition: returns the new array shape if
 * present, else wraps the legacy single-outpoint field as a 1-element
 * array, else an empty array (eagerly-funded games at upgrade time skip
 * this path entirely via the `state.houseEscrow` check).
 */
function readReservedHouseVtxos(state: TrustlessState): { txid: string; vout: number; value: number }[] {
  if (state.houseVtxoOutpoints && state.houseVtxoOutpoints.length > 0) return state.houseVtxoOutpoints
  if (state.houseVtxoOutpoint) return [state.houseVtxoOutpoint]
  return []
}

/**
 * Escrow `amount` from one or more PRE-SELECTED house VTXOs into the
 * escrow address (single-party, multi-input). The caller picks + reserves
 * `candidates` under the selection mutex so concurrent plays never escrow
 * from the same VTXOs; the actual send runs outside the mutex so escrows
 * for distinct VTXO sets proceed in parallel. A single change output goes
 * back to the house when `sum > amount`.
 *
 * Multi-input support (v0.3.6+) lets large bets compose from several
 * smaller VTXOs without needing a single covering input — the bottleneck
 * was previously the largest free VTXO, which capped concurrent high-tier
 * bets at the count of large-enough single inputs in the pool.
 */
async function escrowHouseStakeFrom(
  deps: AppDeps,
  candidates: ExtendedVirtualCoin[],
  escrowPkScript: Uint8Array,
  amount: number,
): Promise<Outpoint> {
  if (candidates.length === 0) {
    throw new Error('escrowHouseStakeFrom: at least one candidate VTXO required')
  }
  const totalIn = candidates.reduce((sum, v) => sum + v.value, 0)
  if (totalIn < amount) {
    throw new Error(`escrowHouseStakeFrom: sum of inputs ${totalIn} < required amount ${amount}`)
  }
  const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
  const change = totalIn - amount
  const houseChange = ArkAddress.decode(await deps.wallet.getAddress())
  const outputs: { script: Uint8Array; amount: bigint }[] = [{ script: escrowPkScript, amount: BigInt(amount) }]
  if (change > 0) outputs.push({ script: houseChange.pkScript, amount: BigInt(change) })

  const inputs = candidates.map(houseVtxoToInput)
  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, serverUnroll)
  // Sign every input — submitOffchain handles a list of indices.
  const signIndices = candidates.map((_, i) => i)
  const txid = await submitOffchain(deps, arkTx, checkpoints, signIndices)
  return { txid, vout: 0, value: amount }
}

/**
 * Fund the house escrow on demand from the VTXO reserved at /play time —
 * idempotent: a second call after the first succeeds is a no-op that returns
 * the same outpoint. Called from /commit AFTER the player escrow has been
 * verified on-chain, so the house only locks funds when the bet is real.
 *
 * Pre-condition: `state.houseVtxoOutpoint` is set (every game minted on
 * v0.3.5+ has it; legacy games that pre-funded at /play go through the
 * `state.houseEscrow` branch instead and skip this entirely).
 *
 * The reserved VTXO is fetched from the wallet's current view, not from the
 * stale cache snapshot, so we always get the live tapLeafScript/tapTree. If
 * the VTXO no longer exists (spent by another path, or a wallet resync moved
 * it), this throws — the calling /commit returns an error to the client and
 * the bet stays pending until a retry. Reservation persistence + the
 * selection mutex make 'no longer exists' a near-impossible state in
 * practice.
 */
async function fundHouseEscrowOnce(
  deps: AppDeps,
  gameId: string,
  state: TrustlessState,
  escrowPkScript: Uint8Array,
): Promise<{ outpoint: Outpoint; mutated: boolean }> {
  // Already funded — re-entrant /commit after a transient failure path.
  if (state.houseEscrow) return { outpoint: state.houseEscrow, mutated: false }
  const want = readReservedHouseVtxos(state)
  if (want.length === 0) {
    throw new Error(
      `Game ${gameId} has neither houseEscrow nor reserved house VTXOs — corrupt state`,
    )
  }
  const live = await deps.wallet.getVtxos()
  const reservedVtxos: ExtendedVirtualCoin[] = []
  for (const w of want) {
    const match = live.find((v) => v.txid === w.txid && v.vout === w.vout)
    if (!match) {
      throw new Error(
        `Reserved house VTXO ${w.txid}:${w.vout} no longer present in the house wallet ` +
        `(possible double-spend, wallet resync, or pool maintenance — retry the bet)`,
      )
    }
    if (match.value !== w.value) {
      throw new Error(
        `Reserved house VTXO ${w.txid}:${w.vout} value mismatch: ` +
        `state recorded ${w.value} sats, wallet sees ${match.value} sats`,
      )
    }
    reservedVtxos.push(match)
  }
  const houseStake = state.arkadeForfeit.houseStake
  const outpoint = await escrowHouseStakeFrom(deps, reservedVtxos, escrowPkScript, houseStake)
  for (const v of reservedVtxos) houseVtxoCache.removeOutpoint(v.txid, v.vout)
  console.log(
    `[lazy-fund] game ${gameId} → house escrow funded at /commit from ${reservedVtxos.length} VTXO(s): ` +
    `${outpoint.txid}:${outpoint.vout} (${outpoint.value} sats)`,
  )
  return { outpoint, mutated: true }
}

export async function handleTrustlessPlay(req: TrustlessPlayRequest, deps: AppDeps): Promise<TrustlessPlayResult> {
  const tiers = await getTiers(deps)
  if (!tiers.includes(req.tier)) throw new Error(`Invalid tier: ${req.tier}`)
  if ((await deps.repos.games.countPendingForPlayer(req.playerPubkey)) >= 3) {
    throw new Error('Too many pending games. Complete or wait for existing games to expire.')
  }
  const version = newGameEscrowVersion()

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

  // v3 escrow ALWAYS runs the arkade-script with concrete (n, target, lo). The
  // coin (no client-supplied odds) maps to n=2, target=1, lo=0 — the regtest's
  // player-wins-iff-roll==0 setup, faithful to a 50/50 coin.
  if (version === 'v3' && !odds) odds = { ...V3_COIN_ODDS }

  const houseSecret = version === 'v3'
    // v3: persist the house's reveal as `[digit] || salt` (= packets.encodeReveal).
    // sha256 of these bytes equals digitHash({digit, salt}), so hashSecret still
    // produces the on-chain creatorHash unchanged.
    ? (() => {
        const n = odds!.oddsN
        const c = commitDigit(randomUniformInt(n), n)
        return packets.encodeReveal(c.digit, c.salt)
      })()
    : isVariable
      ? generateVariableSecret(req.oddsN as number)
      : generateRandomCoinSecret()
  const houseHash = hashSecret(houseSecret)
  const housePubkey = Buffer.from(await deps.identity.compressedPublicKey()).toString('hex')
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  const now = Math.floor(Date.now() / 1000)
  // The audit's tighter penalty schedule: the refund window stretches to ~30 min
  // (was 20) so the R1 penalty leaf (~17 min CSV) can mature with a comfortable
  // ~13-min margin before the house's self-refund opens.
  const finalExpiration = now + 1800
  const setupExpiration = now + 600

  // Emulator is REQUIRED — the coinflip protocol is single-path
  // (covenant-resolved). If EMULATOR_URL is unset or the probe failed
  // at boot, /play refuses to mint new games until the operator brings
  // the emulator back up.
  const emulator = await loadEmulatorConfig()
  if (!emulator) {
    throw new Error(
      'Emulator not configured or unreachable. /play requires arkade-script support; ' +
      'set EMULATOR_URL and restart the server.',
    )
  }
  // arkd's configured unilateral-exit delay (BIP68 seconds). Operator-
  // wide constant, surfaced via /v1/info. Used as the CSV gate on every
  // unilateral exit-mirror leaf so the user can recover funds on-chain
  // if arkd censors. Round up to a multiple of 512 if needed — BIP68
  // silently floors non-multiples.
  const rawExitDelay = Number(deps.arkInfo.unilateralExitDelay ?? 86400)
  const exitDelay = Math.max(512, Math.ceil(rawExitDelay / 512) * 512)
  const arkadeForfeit = {
    emulatorPubkey: emulator.signerPubkey,
    playerPayoutPkScript: ArkAddress.decode(req.playerChangeAddress).pkScript,
    housePayoutPkScript: ArkAddress.decode(await deps.wallet.getAddress()).pkScript,
    playerStake: req.tier,
    houseStake,
    exitDelay,
  }

  const game = await buildGame(
    deps, req.tier, houseHash, req.playerPubkey, req.playerHash,
    finalExpiration, setupExpiration, odds, arkadeForfeit,
  )
  // Per-party escrow: house funds the HOUSE escrow (refundable only by
  // the house); the client funds the PLAYER escrow (refundable only by
  // the player). Abort-theft fix.
  const houseEscrowScript = version === 'v3' ? getHouseEscrowScriptV3(game) : getHouseEscrowScript(game)
  const playerEscrowAddress = (version === 'v3'
    ? getPlayerEscrowAddressV3(game, networkHrp)
    : getPlayerEscrowAddress(game, networkHrp)).encode()

  const gameId = uuidv4()
  // Pick + RESERVE one or more free house VTXOs that sum to ≥ houseStake.
  // The actual on-chain spend (`escrowHouseStakeFrom`) is DEFERRED until
  // /commit — see `fundHouseEscrowOnce()`. This means a player who never
  // funds their own escrow leaves NO on-chain house footprint, so no orphan
  // recovery needed and no bankroll fragmentation. Multi-input support
  // (v0.3.6+) lets large bets compose from several smaller VTXOs without
  // needing a single covering input.
  let candidates!: ExtendedVirtualCoin[]
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
    // Pick a SET of free, dust-safe VTXOs that sum to ≥ houseStake and
    // reserve ALL their outpoints. The reservation excludes them from every
    // other play's selection so concurrent plays never escrow from the
    // same VTXO. Multi-input fallback (pickEscrowVtxos) lets a high-stake
    // bet compose from several smaller VTXOs when no single covering input
    // exists. No fallback to a reserved VTXO — pool exhaustion surfaces a
    // retryable "busy" rather than risking a double-spend.
    let available = availableOf(vtxos)
    let picked = pickEscrowVtxos(freeHouseVtxos(vtxos), houseStake, dust)
    // A stale snapshot can understate the balance or hide free VTXOs (e.g. right
    // after a settlement). On a liability or selection miss, refresh once and
    // retry before declaring the house busy.
    if (!picked || reservations.totalLiability() + houseStake > available) {
      vtxos = await houseVtxoCache.refresh(deps)
      available = availableOf(vtxos)
      picked = pickEscrowVtxos(freeHouseVtxos(vtxos), houseStake, dust)
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
    if (!picked || picked.length === 0) {
      throw new HouseBusyError(`House has no free dust-safe VTXO set covering ${houseStake} sats (pool may need refragmenting). Try again shortly.`)
    }
    candidates = picked
    reservations.reserve(gameId, picked.map((v) => outpointKey(v.txid, v.vout)), houseStake)
  })
  // Committed to ALLOCATING `candidates` to this game: drop each from the
  // cached snapshot so a later play can't re-select them before the actual
  // on-chain spend at /commit. The reservation guards them cross-process;
  // this drop just keeps the cache consistent.
  for (const c of candidates) houseVtxoCache.removeOutpoint(c.txid, c.vout)

  // Persist the reserved VTXO outpoints so /commit (and rebuildReservations
  // after a restart) can find them later without re-running the selection
  // mutex. Multi-input (v0.3.6+) shape.
  const reservedHouseVtxos = candidates.map((c) => ({ txid: c.txid, vout: c.vout, value: c.value }))

  // Persist the arkade-forfeit pin so /commit, /refund, /forfeit, and
  // recovery rebuilds derive the EXACT same escrow taproot address. NOTE:
  // `houseEscrow` is INTENTIONALLY absent — the house funds at /commit, not
  // here. recoverOrphanedHouseEscrows checks `state.houseEscrow` before doing
  // anything, so a no-show player leaves no on-chain footprint to recover.
  const state: TrustlessState = {
    contractVersion: version,
    finalExpiration,
    setupExpiration,
    houseVtxoOutpoints: reservedHouseVtxos,
    ...odds,
    arkadeForfeit: {
      emulatorPubkeyHex: hex.encode(arkadeForfeit.emulatorPubkey),
      playerPayoutPkScriptHex: hex.encode(arkadeForfeit.playerPayoutPkScript),
      housePayoutPkScriptHex: hex.encode(arkadeForfeit.housePayoutPkScript),
      playerStake: arkadeForfeit.playerStake,
      houseStake: arkadeForfeit.houseStake,
      exitDelay: arkadeForfeit.exitDelay,
    },
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
      houseVtxosJson: JSON.stringify(state),
    })
  } catch (err) {
    reservations.release(gameId)
    throw err
  }

  // Best-effort: register the house escrow as an ACTIVE contract so the
  // ContractManager/ContractWatcher tracks it and emits a `vtxo_spent` event
  // when it settles, letting `startContractWatch` reconcile the game eagerly.
  // The serialized params are the EXACT options that produced the on-chain
  // pkScript, so the handler re-derives a byte-identical script. A failure here
  // MUST NOT fail the play — the failsafe reconcile still resolves the game.
  try {
    const houseAddress = (version === 'v3'
      ? getHouseEscrowAddressV3(game, networkHrp)
      : getHouseEscrowAddress(game, networkHrp)).encode()
    const params = version === 'v3'
      ? CoinflipEscrowV3ContractHandler.serializeParams(getHouseEscrowOptionsV3(game))
      : CoinflipEscrowContractHandler.serializeParams(getHouseEscrowOptions(game))
    await deps.contractManager?.createContract({
      type: version === 'v3' ? COINFLIP_ESCROW_V3_TYPE : COINFLIP_ESCROW_TYPE,
      params,
      script: hex.encode(houseEscrowScript.pkScript),
      address: houseAddress,
      state: 'active',
      label: gameId,
    })
  } catch (err) {
    console.warn(`[contract] could not register house escrow for game ${gameId}:`, err instanceof Error ? err.message : err)
  }

  return {
    gameId,
    escrowAddress: playerEscrowAddress,
    houseHash,
    housePubkey,
    serverPubkey: deps.arkInfo.signerPubkey,
    betAmount: req.tier,
    finalExpiration,
    // The PLAYER escrow's serialized contract params (mirrors the house side
    // registered above) — the client registers its own escrow with these so its
    // ContractWatcher reproduces the same script and observes the sweep.
    escrowContractParams: version === 'v3'
      ? CoinflipEscrowV3ContractHandler.serializeParams(getPlayerEscrowOptionsV3(game))
      : CoinflipEscrowContractHandler.serializeParams(getPlayerEscrowOptions(game)),
    oddsN: odds?.oddsN,
    oddsTarget: odds?.oddsTarget,
    oddsLo: odds?.oddsLo,
    pot: req.tier + houseStake,
    contractVersion: version,
  }
}

/**
 * Decode a v3 reveal from a persisted secret. v3 packs `[digit_byte] ‖ salt`
 * exactly as `packets.encodeReveal(digit, salt)` does — first byte is the
 * digit, remaining bytes are the salt. Throws if the bytes are too short
 * for a salted commit (≥ 1 + 1 byte salt).
 */
function decodeV3Reveal(secret: Uint8Array): DigitCommit {
  if (secret.length < 2) {
    throw new Error(`decodeV3Reveal: v3 reveal must be ≥ 2 bytes, got ${secret.length}`)
  }
  return { digit: secret[0], salt: secret.slice(1) }
}

/**
 * Everything needed to (re)build a commit result, derived deterministically
 * from the persisted game + escrow state. Shared by the fresh resolve and the
 * idempotent-replay path so both produce identical economics.
 */
interface CommitContext {
  /** Escrow contract version for THIS game — chooses winner-rule + sweep builder. */
  version: 'v2' | 'v3'
  winner: 'house' | 'player'
  houseSecret: Uint8Array
  playerSecret: Uint8Array
  houseSecretHex: string
  playerSecretHex: string
  /** v2 path. Set iff version === 'v2'. */
  escrowsV2?: EscrowInput[]
  /** v3 path. Set iff version === 'v3'. */
  escrowsV3?: [EscrowInputV3, EscrowInputV3]
  /** v3 path: pre-decoded reveals (for sweep builder + display). */
  creatorReveal?: DigitCommit
  playerReveal?: DigitCommit
  /** Hex of the house-escrow pkScript — for contract deactivation. */
  houseEscrowPkScriptHex: string
  pot: number
  proof: string
  houseAddress: string
  playerPayoutAddress: string
  networkHrp: string
  /** Variable-odds echo + rolled value for display; all undefined for the v2 coin. */
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
  // Pre-condition: the house escrow MUST be funded by the time we get here.
  // `handleTrustlessCommit` calls `fundHouseEscrowOnce` before this; the
  // background reconcile path checks `state.houseEscrow` itself before
  // calling buildCommitContext. The cast below relies on this invariant.
  if (!state.houseEscrow) {
    throw new Error(
      `buildCommitContext: state.houseEscrow not set for game ${game.id} — ` +
      `lazy-funding should have run first`,
    )
  }
  const houseEscrow = state.houseEscrow
  const houseSecret = new Uint8Array(Buffer.from(game.house_secret_hex, 'hex'))
  const playerSecret = new Uint8Array(Buffer.from(playerSecretHex, 'hex'))
  const odds = oddsFromState(state)
  const version: 'v2' | 'v3' = state.contractVersion === 'v3' ? 'v3' : 'v2'

  let winner: 'house' | 'player'
  let roll: number | null
  let creatorReveal: DigitCommit | undefined
  let playerReveal: DigitCommit | undefined
  if (version === 'v3') {
    if (!odds) throw new Error(`v3 commit for game ${game.id} has no odds persisted`)
    creatorReveal = decodeV3Reveal(houseSecret)
    playerReveal = decodeV3Reveal(playerSecret)
    const role = determineWinnerV3(creatorReveal, playerReveal, odds.oddsN, odds.oddsTarget, odds.oddsLo)
    winner = role === 'creator' ? 'house' : 'player'
    roll = computeRollV3(creatorReveal, playerReveal, odds.oddsN)
  } else {
    // v2 — variable-odds resolve via the mod-N rule; the coin via secret-length parity.
    const role = odds
      ? determineVariableWinner(houseSecret, playerSecret, odds.oddsN, odds.oddsTarget, odds.oddsLo)
      : determineWinner(houseSecret, playerSecret)
    winner = role === 'creator' ? 'house' : 'player'
    roll = odds ? computeVariableRoll(houseSecret, playerSecret, odds.oddsN) : null
  }

  const houseHash = hashSecret(houseSecret)
  const arkadeForfeitPin = rehydrateArkadeForfeit(state)
  const game2 = await buildGame(
    deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
    state.finalExpiration, state.setupExpiration, odds, arkadeForfeitPin,
  )

  let pot = 0
  let houseEscrowPkScriptHex = ''
  let escrowsV2: EscrowInput[] | undefined
  let escrowsV3: [EscrowInputV3, EscrowInputV3] | undefined
  if (version === 'v3') {
    const s = v3Escrows(game2)
    escrowsV3 = [
      { script: s.house, ...houseEscrow },
      { script: s.player, ...playerEscrow },
    ]
    pot = escrowsV3[0].value + escrowsV3[1].value
    houseEscrowPkScriptHex = hex.encode(s.house.pkScript)
  } else {
    const s = v2Escrows(game2)
    escrowsV2 = [
      { script: s.house, ...houseEscrow },
      { script: s.player, ...playerEscrow },
    ]
    pot = escrowsV2.reduce((a, e) => a + e.value, 0)
    houseEscrowPkScriptHex = hex.encode(s.house.pkScript)
  }

  const proof = version === 'v3'
    ? `[v3] creatorDigit=${creatorReveal!.digit}, playerDigit=${playerReveal!.digit}, roll=${roll ?? 'n/a'} → ${winner} wins (pot ${pot})${odds ? ` [odds [${odds.oddsLo},${odds.oddsTarget})/${odds.oddsN}]` : ''}.`
    : `house secret ${houseSecret.length}B, player secret ${playerSecret.length}B ` +
      `→ ${winner} wins (pot ${pot})${odds ? ` [odds [${odds.oddsLo},${odds.oddsTarget})/${odds.oddsN}]` : ''}.`

  return {
    version,
    winner, houseSecret, playerSecret,
    houseSecretHex: game.house_secret_hex, playerSecretHex,
    escrowsV2, escrowsV3,
    creatorReveal, playerReveal,
    houseEscrowPkScriptHex,
    pot, proof,
    houseAddress: await deps.wallet.getAddress(),
    playerPayoutAddress: game.player_change_address!,
    networkHrp: networkHrpFromArkInfo(deps.arkInfo),
    odds, roll,
  }
}

/**
 * Build the unsigned covenant-sweep tx for a resolved game. Single path —
 * the winner's covenant-win leaf, [server, emulator_tweaked] multisig,
 * single output of the full pot. Caller signs + posts to the emulator.
 */
function buildCommitResult(
  ctx: CommitContext,
  deps: AppDeps,
): { result: TrustlessCommitResult; sweepTx: BuiltOffchainTx } {
  const payoutAddress = ctx.winner === 'player' ? ctx.playerPayoutAddress : ctx.houseAddress
  const potAmount = BigInt(ctx.pot)
  const sweepTx: BuiltOffchainTx = ctx.version === 'v3'
    ? buildCovenantSweepTransactionV3(deps.arkInfo, {
        winner: ctx.winner,
        escrows: ctx.escrowsV3!,
        payoutAddress,
        potAmount,
        playerReveal: ctx.playerReveal!,
        creatorReveal: ctx.creatorReveal!,
      })
    : buildCovenantSweepTransaction(deps.arkInfo, ctx.networkHrp, {
        winner: ctx.winner,
        escrows: ctx.escrowsV2!,
        payoutAddress,
        potAmount,
        bothSecrets: [
          new Uint8Array(Buffer.from(ctx.houseSecretHex, 'hex')),
          new Uint8Array(Buffer.from(ctx.playerSecretHex, 'hex')),
        ],
      })
  const result: TrustlessCommitResult = {
    winner: ctx.winner,
    houseSecret: ctx.houseSecretHex,
    playerSecret: ctx.playerSecretHex,
    payout: ctx.pot,
    proof: ctx.proof,
    roll: ctx.roll,
    oddsN: ctx.odds?.oddsN,
    oddsLo: ctx.odds?.oddsLo,
    oddsTarget: ctx.odds?.oddsTarget,
  }
  return { result, sweepTx }
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
  result.txid = state.resolveTxid
  return result
}

/**
 * Submit the covenant-sweep PSBT to the emulator. The operator does NOT
 * sign anything: the covenant leaves are `[arkd_server, emu_tweaked]`
 * — arkd is the only server-side signer, and the emulator cosigns the
 * emu_tweaked slot AFTER running the arkade-script covenant. The
 * emulator then forwards the finalized tx to arkd for the final
 * co-signature. Returns the resolved txid.
 *
 * `deps` is unused but kept for symmetry with other handlers.
 */
async function submitCovenantSweep(
  sweepTx: BuiltOffchainTx,
  _deps: AppDeps,
): Promise<string> {
  const cfg = await loadEmulatorConfig()
  if (!cfg) throw new Error('Emulator not configured — required for covenant sweep')
  const payload = JSON.stringify({
    arkTx: base64.encode(sweepTx.arkTx.toPSBT()),
    checkpointTxs: sweepTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
  })

  // The sweep spends the player's freshly-submitted escrow VTXO. Under
  // concurrent load arkd can lag indexing that VTXO, so the emulator's own
  // arkd submit fails transiently ("failed to process transaction" → its
  // internal VTXO_NOT_FOUND). Retry with backoff — the escrow lands a beat
  // later. A genuine validation rejection (4xx, bad script/signature, or an
  // already-spent input) is NOT retried.
  const MAX_ATTEMPTS = 8
  let lastErr = ''
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const resp = await fetch(`${cfg.url}/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(20_000),
    })
    if (resp.ok) {
      const body = (await resp.json()) as { signedArkTx?: string }
      if (!body.signedArkTx) throw new Error('Emulator did not return signedArkTx')
      return Transaction.fromPSBT(base64.decode(body.signedArkTx)).id
    }
    const text = await resp.text()
    lastErr = `Emulator rejected sweep: ${resp.status} ${text}`
    const transient = resp.status >= 500 && /failed to process transaction|VTXO_NOT_FOUND|not found/i.test(text)
    if (!transient || attempt === MAX_ATTEMPTS - 1) throw new Error(lastErr)
    await new Promise((r) => setTimeout(r, 400 + attempt * 400)) // ~0.4s→3.2s, ~11s total
  }
  throw new Error(lastErr)
}

/**
 * Best-effort: mark a finished bet's house-escrow contract `inactive` so the
 * ContractManager/ContractWatcher stops watching it. Called at every point a
 * game resolves or its house escrow is reclaimed ("when a bet is done,
 * deactivate its contract"). A no-op when the ContractManager is absent or the
 * contract was never registered; never throws.
 */
async function deactivateHouseEscrowContract(deps: AppDeps, houseEscrowScriptHex: string): Promise<void> {
  try {
    await deps.contractManager?.setContractState(houseEscrowScriptHex, 'inactive')
  } catch (err) {
    console.warn('[contract] could not deactivate house escrow contract:', err instanceof Error ? err.message : err)
  }
}

export async function handleTrustlessCommit(
  gameId: string,
  req: TrustlessCommitRequest,
  deps: AppDeps,
): Promise<TrustlessCommitResult> {
  // Serialize commits per game.
  return commitLocks.runExclusive(gameId, async () => {
    const game = await deps.repos.games.get(gameId)
    if (!game) throw new Error(`Game not found: ${gameId}`)
    if (game.status === 'resolved') return rebuildResolvedResult(game, deps)
    if (game.status !== 'pending') throw new Error(`Game is not pending: ${game.status}`)

    const playerSecret = Buffer.from(req.playerSecretHex, 'hex')
    if (createHash('sha256').update(playerSecret).digest('hex') !== game.player_hash) {
      throw new Error('Player secret does not match committed hash')
    }
    let state = JSON.parse(game.house_vtxos_json as string) as TrustlessState

    // Lazy-fund the house escrow now that the player has revealed (and is
    // about to claim the pot if they win). Idempotent — a re-entrant /commit
    // after a transient sweep failure sees `state.houseEscrow` already set
    // and returns the existing outpoint without re-funding.
    if (!state.houseEscrow && state.houseVtxoOutpoint) {
      // Reconstruct the house escrow's pkScript from the persisted game data so
      // it matches what the player escrow is funding into (same Game,
      // refundPubkey = house). buildCommitContext below also rebuilds the same
      // escrow script for the sweep; doing it once here is the same derivation.
      const houseHashForFund = hashSecret(new Uint8Array(Buffer.from(game.house_secret_hex, 'hex')))
      const arkadeForfeitForFund = rehydrateArkadeForfeit(state)
      const gameForFund = await buildGame(
        deps, game.tier, houseHashForFund, game.player_pubkey, game.player_hash,
        state.finalExpiration, state.setupExpiration, oddsFromState(state),
        arkadeForfeitForFund,
      )
      const versionForFund: 'v2' | 'v3' = state.contractVersion === 'v3' ? 'v3' : 'v2'
      const houseEscrowScriptForFund = versionForFund === 'v3'
        ? getHouseEscrowScriptV3(gameForFund)
        : getHouseEscrowScript(gameForFund)
      const { outpoint, mutated } = await fundHouseEscrowOnce(deps, gameId, state, houseEscrowScriptForFund.pkScript)
      if (mutated) {
        state = { ...state, houseEscrow: outpoint }
        await deps.repos.games.update(gameId, {
          houseVtxosJson: JSON.stringify(state),
        })
      }
    }

    const ctx = await buildCommitContext(game, state, req.playerSecretHex, req.playerEscrow, deps)
    const { result, sweepTx } = buildCommitResult(ctx, deps)

    // Persist the player's reveal + escrow BEFORE attempting the sweep. If the
    // sweep then fails (emulator/arkd hiccup, crash, exhausted retries), the
    // game is left `pending` WITH the secret, so the background reconcile can
    // finish settling it autonomously — instead of the secret being lost and
    // the player forced down the forfeit path ("house didn't reveal").
    const committed: TrustlessState = { ...state, playerEscrow: req.playerEscrow }
    await deps.repos.games.update(gameId, {
      playerSecretHex: req.playerSecretHex,
      houseVtxosJson: JSON.stringify(committed),
    })

    const resolveTxid = await submitCovenantSweep(sweepTx, deps)
    result.txid = resolveTxid
    await deps.repos.games.update(gameId, {
      winner: ctx.winner,
      rakeAmount: 0,
      payoutAmount: result.payout,
      status: 'resolved',
      houseVtxosJson: JSON.stringify({ ...committed, resolveTxid }),
    })
    reservations.release(gameId)
    // Bet done → stop watching its house escrow. escrows[0] is the house escrow.
    await deactivateHouseEscrowContract(deps, ctx.houseEscrowPkScriptHex)
    return result
  })
}

/**
 * Finish a game the player already committed to (their reveal is persisted) but
 * whose covenant sweep never landed — a transient /commit failure, exhausted
 * retries, or a crash after persisting the reveal but before the sweep. Rebuilds
 * the SAME sweep and re-submits it. Returns 1 if it resolved the game, else 0.
 *
 * Lock-free: assumes the per-game `commitLocks` mutex is ALREADY held by the
 * caller (`reconcileGame`). The KeyedMutex is non-reentrant, so re-acquiring it
 * here would deadlock; the sole caller already holds the lock, which is what
 * keeps this from racing a live `/commit`.
 */
async function resettleCommittedGameLocked(game: GameRow, state: TrustlessState, deps: AppDeps): Promise<number> {
  const fresh = await deps.repos.games.get(game.id)
  if (!fresh || fresh.status !== 'pending' || !fresh.player_secret_hex || !state.playerEscrow) return 0
  try {
    const ctx = await buildCommitContext(fresh, state, fresh.player_secret_hex, state.playerEscrow, deps)
    const { result, sweepTx } = buildCommitResult(ctx, deps)
    const resolveTxid = await submitCovenantSweep(sweepTx, deps)
    await deps.repos.games.update(game.id, {
      winner: ctx.winner, rakeAmount: 0, payoutAmount: result.payout,
      status: 'resolved', houseVtxosJson: JSON.stringify({ ...state, resolveTxid }),
    })
    reservations.release(game.id)
    await deactivateHouseEscrowContract(deps, ctx.houseEscrowPkScriptHex)
    console.log(`[reconcile] re-settled committed game ${game.id} (winner ${ctx.winner}, tx ${resolveTxid})`)
    return 1
  } catch (e) {
    console.warn(`[reconcile] re-settle of ${game.id} failed (retry next tick): ${e instanceof Error ? e.message : e}`)
    return 0
  }
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
  const version: 'v2' | 'v3' = state.contractVersion === 'v3' ? 'v3' : 'v2'
  const houseHash = hashSecret(new Uint8Array(Buffer.from(game.house_secret_hex, 'hex')))
  const arkadeForfeitPin = rehydrateArkadeForfeit(state)
  const game2 = await buildGame(
    deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
    state.finalExpiration, state.setupExpiration, oddsFromState(state),
    arkadeForfeitPin,
  )
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  const refund: BuiltOffchainTx = version === 'v3'
    ? buildRefundTransactionV3(deps.arkInfo, {
        escrowScript: getPlayerEscrowScriptV3(game2),
        txid: req.playerEscrow.txid,
        vout: req.playerEscrow.vout,
        value: req.playerEscrow.value,
        refundAddress: game.player_change_address,
      })
    : buildRefundTransaction(deps.arkInfo, networkHrp, {
        escrowScript: getPlayerEscrowScript(game2),
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
 * Build the unsigned R1 forfeit-claim. After `finalExpiration`, the
 * player sweeps both escrows to its payout address via the
 * `playerForfeit` leaf (atomic-sweep covenant + CLTV). Single tx, both
 * inputs, single full-pot output.
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
  if (!state.houseEscrow) {
    // Lazy-funding (v0.3.5+) means the house escrow only exists if /commit
    // already ran. A game in pending state without a house escrow means the
    // player never revealed — there's no joint pot to forfeit-sweep, so the
    // correct recovery is `/refund` (which only needs the player escrow).
    throw new Error(
      `Game ${gameId} has no joint pot to forfeit — the house only funds at /commit. ` +
      `Use /refund to reclaim your own stake after finalExpiration.`,
    )
  }
  const version: 'v2' | 'v3' = state.contractVersion === 'v3' ? 'v3' : 'v2'
  const arkadeForfeitPin = rehydrateArkadeForfeit(state)
  const houseHash = hashSecret(new Uint8Array(Buffer.from(game.house_secret_hex, 'hex')))
  const game2 = await buildGame(
    deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
    state.finalExpiration, state.setupExpiration, oddsFromState(state),
    arkadeForfeitPin,
  )
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  const pot = BigInt(arkadeForfeitPin.playerStake + arkadeForfeitPin.houseStake)
  const forfeit: BuiltOffchainTx = version === 'v3'
    ? buildForfeitClaimTransactionV3(deps.arkInfo, {
        escrows: [
          { script: getHouseEscrowScriptV3(game2), ...state.houseEscrow },
          { script: getPlayerEscrowScriptV3(game2), ...req.playerEscrow },
        ],
        payoutAddress: game.player_change_address,
        potAmount: pot,
      })
    : buildForfeitClaimTransaction(deps.arkInfo, networkHrp, {
        escrows: [
          { script: getHouseEscrowScript(game2), ...state.houseEscrow },
          { script: getPlayerEscrowScript(game2), ...req.playerEscrow },
        ],
        payoutAddress: game.player_change_address,
        potAmount: pot,
      })

  return {
    forfeitPsbt: hex.encode(forfeit.arkTx.toPSBT()),
    forfeitCheckpoints: forfeit.checkpoints.map((c) => hex.encode(c.toPSBT())),
    forfeitClaimableAt: state.finalExpiration,
    payoutAddress: game.player_change_address,
    potAmount: Number(pot),
    stakes: [arkadeForfeitPin.houseStake, arkadeForfeitPin.playerStake],
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
  // Gate on CHAIN time, not wall-clock. arkd enforces the refund CLTV against
  // block time (BIP113 MTP), which lags wall-clock — so Date.now() fired the
  // reclaim early and spammed `FORFEIT_CLOSURE_LOCKED` until the chain caught
  // up. Use the chain tip like the client does. Fall back to wall-clock only
  // when the tip is unavailable (some providers, e.g. the regtest esplora,
  // return "No chain tip found"); the per-game catch below absorbs an early
  // CLTV rejection, so recovery still works there — just slightly eagerly.
  let chainTime: number
  try {
    chainTime = (await deps.wallet.onchainProvider.getChainTip()).time
  } catch {
    chainTime = Math.floor(Date.now() / 1000)
  }
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
    if (state.finalExpiration > chainTime) continue // refund CLTV not matured (chain block time)

    try {
      const houseHash = hashSecret(new Uint8Array(Buffer.from(game.house_secret_hex, 'hex')))
      const arkadeForfeitPin = rehydrateArkadeForfeit(state)
      const game2 = await buildGame(
        deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
        state.finalExpiration, state.setupExpiration, oddsFromState(state),
        arkadeForfeitPin,
      )
      const version: 'v2' | 'v3' = state.contractVersion === 'v3' ? 'v3' : 'v2'
      const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
      const houseEscrowScriptV2 = version === 'v2' ? getHouseEscrowScript(game2) : undefined
      const houseEscrowScriptV3 = version === 'v3' ? getHouseEscrowScriptV3(game2) : undefined
      const houseEscrowScriptPkScript = (houseEscrowScriptV2 ?? houseEscrowScriptV3)!.pkScript
      const refund: BuiltOffchainTx = version === 'v3'
        ? buildRefundTransactionV3(deps.arkInfo, {
            escrowScript: houseEscrowScriptV3!,
            txid: state.houseEscrow.txid,
            vout: state.houseEscrow.vout,
            value: state.houseEscrow.value,
            refundAddress: await deps.wallet.getAddress(),
          })
        : buildRefundTransaction(deps.arkInfo, networkHrp, {
            escrowScript: houseEscrowScriptV2!,
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
      // Bet done (house stake reclaimed) → stop watching its house escrow.
      await deactivateHouseEscrowContract(deps, hex.encode(houseEscrowScriptPkScript))
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
 * Decide whether the tx that spent the house escrow paid the pot to the PLAYER
 * (an R1 forfeit) rather than to the house (a crashed house-win covenant sweep).
 * BOTH paths atomically spend both escrows; they differ only in the payout
 * destination, so the only reliable signal is the output script of the resulting
 * Arkade transaction.
 *
 * Decodes the arkTx that spent the escrow (`arkTxId`, the final virtual tx — the
 * checkpoint output it goes through is a connector, not the payout) and matches
 * any output against the player's persisted payout script. Returns false on ANY
 * uncertainty (missing arkTxId, fetch/decode failure, no match) so the caller
 * keeps the safe house-win default and a transient hiccup never mislabels a real
 * house win as a player win.
 */
async function sweepPaidPlayer(
  indexer: IndexerProvider,
  houseEscrowVtxo: { arkTxId?: string; spentBy?: string },
  state: TrustlessState,
): Promise<boolean> {
  const playerScriptHex = state.arkadeForfeit?.playerPayoutPkScriptHex
  // The payout output lives in the arkTx, not the intermediate checkpoint, so
  // decoding `spentBy` (the checkpoint) would never see the player script.
  const txid = houseEscrowVtxo.arkTxId
  if (!playerScriptHex || !txid) return false
  try {
    const { txs } = await indexer.getVirtualTxs([txid])
    if (!txs?.length) return false
    const tx = Transaction.fromPSBT(base64.decode(txs[0]))
    for (let i = 0; i < tx.outputsLength; i++) {
      const out = tx.getOutput(i)
      if (out?.script && hex.encode(out.script) === playerScriptHex) return true
    }
    return false
  } catch (err) {
    console.warn(`[reconcile] could not decode sweep tx ${txid}:`, err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Reconcile games stuck `pending` because the server crashed AFTER a covenant
 * sweep was submitted but BEFORE the result was persisted. A `pending` trustless
 * game whose HOUSE escrow is already spent on-Ark was resolved by one of two
 * atomic sweeps:
 *   - the crashed HOUSE-WIN sweep (pot → house), or
 *   - the player's R1 FORFEIT (pot → player) after the server stalled past
 *     `forfeitClaimableAt`.
 * Both spend the house escrow, so we decode the spending arkTx and check who the
 * pot was paid to (`sweepPaidPlayer`) — labelling the winner accordingly instead
 * of always assuming house. Detection is a direct indexer lookup of the escrow
 * outpoint's `isSpent`; no hot-path write-ahead needed. The optional
 * `indexerOverride` is for tests; production builds its own. Returns the count
 * reconciled.
 */
export async function reconcilePendingSweeps(
  deps: AppDeps,
  indexerOverride?: IndexerProvider,
): Promise<number> {
  const pending = await deps.repos.games.list({ status: 'pending', limit: 500 })
  const trustless = pending.filter((g) => g.player_choice === 'trustless' && g.house_vtxos_json)
  if (trustless.length === 0) return 0

  const indexer = indexerOverride ?? new RestIndexerProvider(ARK_SERVER_URL)
  let reconciled = 0
  for (const game of trustless) {
    reconciled += await reconcileGame(game, deps, indexer)
  }
  if (reconciled > 0) console.log(`[reconcile] resolved ${reconciled} crash-mid-sweep game(s)`)
  return reconciled
}

/**
 * Reconcile a single pending trustless game against the indexer. Shared by the
 * failsafe `reconcilePendingSweeps` loop and the eager `startContractWatch`
 * event handler so both resolve a crash-mid-sweep / R1-forfeit game identically.
 *
 * Runs under the per-game `commitLocks` mutex so it can't race a live `/commit`,
 * re-fetching the game inside the lock (it may have resolved between selection
 * and acquisition). If the house escrow is already spent on-Ark, it decodes the
 * spending arkTx to attribute the winner (`sweepPaidPlayer`) and marks the game
 * resolved + releases its reservation. If the escrow is still unspent but the
 * player already committed, it re-attempts the sweep (`resettleCommittedGameLocked`,
 * lock-free — the lock is already held). Returns the number reconciled (0 or 1).
 */
async function reconcileGame(game: GameRow, deps: AppDeps, indexer: IndexerProvider): Promise<number> {
  return commitLocks.runExclusive(game.id, async () => {
    const fresh = await deps.repos.games.get(game.id)
    if (!fresh || fresh.status !== 'pending') return 0
    let state: TrustlessState
    try {
      state = JSON.parse(fresh.house_vtxos_json as string) as TrustlessState
    } catch {
      return 0
    }
    if (!state.houseEscrow) return 0
    const houseEscrow = state.houseEscrow
    try {
      const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid: houseEscrow.txid, vout: houseEscrow.vout }] })
      const v = vtxos.find((x) => x.txid === houseEscrow.txid && x.vout === houseEscrow.vout) ?? vtxos[0]
      if (!v || !v.isSpent) {
        // Escrow not yet spent → the sweep never landed. If the player already
        // committed (their reveal is persisted), the server has everything it
        // needs to finish settling — re-attempt the sweep so a transient commit
        // failure resolves itself instead of stranding the game on the forfeit
        // path. Otherwise it's genuinely pending (player hasn't revealed yet).
        if (fresh.player_secret_hex && state.playerEscrow) {
          return await resettleCommittedGameLocked(fresh, state, deps)
        }
        return 0
      }

      const pot = houseEscrow.value + fresh.tier // house stake + player stake
      const winner: 'house' | 'player' = (await sweepPaidPlayer(indexer, v, state)) ? 'player' : 'house'
      await deps.repos.games.update(fresh.id, {
        winner,
        rakeAmount: 0,
        payoutAmount: pot,
        status: 'resolved',
        houseVtxosJson: JSON.stringify({ ...state, resolveTxid: v.arkTxId ?? v.spentBy ?? state.resolveTxid } as TrustlessState),
      })
      reservations.release(fresh.id)
      // Bet done → stop watching its house escrow. The escrow's pkScript hex is
      // the contract key the escrow was registered under at /play.
      await deactivateHouseEscrowContract(deps, v.script)
      console.log(
        winner === 'player'
          ? `[reconcile] R1 forfeit player win ${fresh.id} resolved (player swept the pot, tx ${v.arkTxId})`
          : `[reconcile] crash-mid-sweep house win ${fresh.id} resolved (escrow spent by ${v.spentBy ?? 'unknown'})`,
      )
      return 1
    } catch (err) {
      console.warn(`[reconcile] spent-check failed for game ${fresh.id}:`, err instanceof Error ? err.message : err)
      return 0
    }
  })
}

/**
 * Subscribe to the wallet's ContractManager so a house escrow being spent
 * on-Ark reconciles its game EAGERLY — instead of waiting up to 120s for the
 * failsafe `reconcilePendingSweeps` tick. On a `vtxo_spent` event for a
 * `coinflip-escrow` contract, look the game up by the contract's `label` (the
 * gameId set at /play) and run the SAME `reconcileGame` the failsafe uses, then
 * deactivate the contract. This is purely an optimization: if the
 * ContractManager is absent or an event is missed, the failsafe still resolves
 * the game. The handler body is wrapped in try/catch so a single bad event
 * never tears down the subscription. Returns the unsubscribe function (or a
 * no-op when there's no ContractManager).
 */
export function startContractWatch(deps: AppDeps): () => void {
  if (!deps.contractManager) return () => {}
  // Build our own indexer (mirrors reconcilePendingSweeps' production default)
  // so the eager path shares the exact reconcile logic + provider shape.
  const indexer = new RestIndexerProvider(ARK_SERVER_URL)
  return deps.contractManager.onContractEvent((event) => {
    if (event.type !== 'vtxo_spent' || event.contract.type !== COINFLIP_ESCROW_TYPE) return
    void (async () => {
      try {
        const gameId = event.contract.label
        if (!gameId) {
          console.warn(`[contract] vtxo_spent for ${event.contractScript} has no game label; leaving to failsafe`)
          return
        }
        const game = await deps.repos.games.get(gameId)
        if (!game) {
          console.warn(`[contract] vtxo_spent for game ${gameId} but no such row; leaving to failsafe`)
          return
        }
        const reconciled = await reconcileGame(game, deps, indexer)
        if (reconciled > 0) console.log(`[contract] eagerly reconciled game ${gameId} from vtxo_spent event`)
        // Bet done → stop watching this escrow (idempotent with reconcileGame's
        // own deactivation; harmless if already inactive).
        await deactivateHouseEscrowContract(deps, event.contract.script)
      } catch (err) {
        console.error('[contract] vtxo_spent handler failed:', err instanceof Error ? err.message : err)
      }
    })()
  })
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
