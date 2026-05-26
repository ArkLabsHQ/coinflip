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
  buildRefundTransaction,
  type Game,
  type SweepEscrow,
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
import { reservations, selectionMutex, freeHouseVtxos, HouseBusyError, KeyedMutex, outpointKey, pickEscrowVtxo, houseVtxoCache } from './vtxo-pool.js'
import type { AppDeps } from './deps.js'
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

/** Build the per-game Game object the lib needs to derive the escrow script. */
async function buildGame(
  deps: AppDeps,
  tier: number,
  houseHashHex: string,
  playerPubkeyHex: string,
  playerHashHex: string,
  finalExpiration: number,
  setupExpiration: number,
  odds?: { oddsN: number; oddsTarget: number; oddsLo: number },
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
  const finalExpiration = now + 1200
  const setupExpiration = now + 600

  const game = await buildGame(deps, req.tier, houseHash, req.playerPubkey, req.playerHash, finalExpiration, setupExpiration, odds)
  // Per-party escrow: the house funds the HOUSE escrow (refundable only by the
  // house); the client funds the PLAYER escrow (refundable only by the player).
  // Neither party's refund leaf can touch the other's stake — abort-theft fix.
  const houseEscrowScript = getHouseEscrowScript(game)
  const playerEscrowAddress = getPlayerEscrowAddress(game, networkHrp).encode()
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

  const state: TrustlessState = { finalExpiration, setupExpiration, houseEscrow, ...odds }
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
  const game2 = await buildGame(
    deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
    state.finalExpiration, state.setupExpiration, odds,
  )
  // Rebuild both per-party escrow scripts; the sweep spends each VTXO via its
  // own script's win leaf (win leaves are byte-identical, taptrees differ).
  const escrows: SweepEscrow[] = [
    { script: getHouseEscrowScript(game2), ...state.houseEscrow },
    { script: getPlayerEscrowScript(game2), ...playerEscrow },
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
 * Build the commit result from a context, WITHOUT side effects. On a house win
 * it also returns the unsigned sweep tx — the caller submits it on a fresh
 * resolve, or discards it and supplies the persisted txid on a replay. On a
 * player win the sweep PSBTs are embedded for the client to sign + submit.
 */
function buildCommitResult(
  ctx: CommitContext,
  deps: AppDeps,
): { result: TrustlessCommitResult; houseSweepTx?: BuiltOffchainTx } {
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
  // Player won — the playerWin leaf needs the player's key, so the server builds
  // the sweep but the CLIENT signs + submits it. Return the PSBTs.
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
    const { result, houseSweepTx } = buildCommitResult(ctx, deps)

    let resolveTxid: string | undefined
    if (houseSweepTx) {
      // House sweeps both escrow VTXOs via creatorWin (single-party, house+server).
      resolveTxid = await submitOffchain(deps, houseSweepTx.arkTx, houseSweepTx.checkpoints, [0, 1], {
        inputs: [0, 1], data: [ctx.houseSecret, ctx.playerSecret],
      })
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
  const game2 = await buildGame(
    deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
    state.finalExpiration, state.setupExpiration, oddsFromState(state),
  )
  const playerEscrowScript = getPlayerEscrowScript(game2)
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
      const game2 = await buildGame(
        deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
        state.finalExpiration, state.setupExpiration, oddsFromState(state),
      )
      const houseEscrowScript = getHouseEscrowScript(game2)
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
      // Most likely the CLTV isn't accepted yet or the escrow was already spent;
      // leave the game for a later pass rather than marking it reclaimed.
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
