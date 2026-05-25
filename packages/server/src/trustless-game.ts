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
  getPlayerEscrowScript,
  getHouseEscrowScript,
  getPlayerEscrowAddress,
  getHouseEscrowAddress,
  buildSweepTransaction,
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
  type ArkTxInput,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { hashSecret, networkHrpFromArkInfo } from './house-wallet.js'
import { reservations, selectionMutex, freeHouseVtxos, HouseBusyError, KeyedMutex, outpointKey, pickEscrowVtxo } from './vtxo-pool.js'
import type { AppDeps } from './deps.js'
import type { GameRow } from './repositories/types.js'

export interface Outpoint { txid: string; vout: number; value: number }

export interface TrustlessPlayRequest {
  tier: number
  playerPubkey: string
  playerHash: string
  playerChangeAddress: string
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

  const houseSecret = generateSecret(Math.random() < 0.5 ? 'heads' : 'tails')
  const houseHash = hashSecret(houseSecret)
  const housePubkey = Buffer.from(await deps.identity.compressedPublicKey()).toString('hex')
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  const now = Math.floor(Date.now() / 1000)
  const finalExpiration = now + 1200
  const setupExpiration = now + 600

  const game = await buildGame(deps, req.tier, houseHash, req.playerPubkey, req.playerHash, finalExpiration, setupExpiration)
  // Per-party escrow: the house funds the HOUSE escrow (refundable only by the
  // house); the client funds the PLAYER escrow (refundable only by the player).
  // Neither party's refund leaf can touch the other's stake — abort-theft fix.
  const houseEscrowScript = getHouseEscrowScript(game)
  const playerEscrowAddress = getPlayerEscrowAddress(game, networkHrp).encode()
  const houseEscrowScriptHex = hex.encode(houseEscrowScript.pkScript)

  const gameId = uuidv4()
  // Atomically (under the selection mutex) check liability and pick + reserve a
  // free house VTXO; then escrow OUTSIDE the mutex so concurrent plays run in
  // parallel, each on its own reserved VTXO.
  let houseEscrow!: Outpoint
  let candidate!: ExtendedVirtualCoin
  await selectionMutex.runExclusive(async () => {
    const balance = await deps.wallet.getBalance()
    if (reservations.totalLiability() + req.tier > balance.available) {
      throw new HouseBusyError(`House is busy (liability ${reservations.totalLiability()} + ${req.tier} > ${balance.available}). Try again shortly.`)
    }
    // Pick a FREE, dust-safe VTXO and reserve ITS OUTPOINT (not just liability):
    // the reservation excludes it from every other play's selection even before
    // this spend propagates to getVtxos(), so two plays can never escrow from
    // the same VTXO. `pickEscrowVtxo` skips VTXOs that would leave a sub-dust
    // change output (rejected on mainnet). No fallback to a reserved VTXO — if
    // the pool is momentarily exhausted we surface a retryable "busy" rather
    // than risk a double-spend.
    const dust = Number(deps.arkInfo.dust ?? 546n)
    const picked = pickEscrowVtxo(freeHouseVtxos(await deps.wallet.getVtxos()), req.tier, dust)
    if (!picked) {
      throw new HouseBusyError(`House has no free dust-safe VTXO covering ${req.tier} sats (pool may need refragmenting). Try again shortly.`)
    }
    candidate = picked
    reservations.reserve(gameId, [outpointKey(picked.txid, picked.vout)], req.tier)
  })
  try {
    houseEscrow = await escrowHouseStakeFrom(deps, candidate, houseEscrowScript.pkScript, req.tier)
  } catch (err) {
    reservations.release(gameId)
    throw err
  }

  const state: TrustlessState = { finalExpiration, setupExpiration, houseEscrow }
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
  const winnerRole = determineWinner(houseSecret, playerSecret)
  const winner: 'house' | 'player' = winnerRole === 'creator' ? 'house' : 'player'

  const houseHash = hashSecret(houseSecret)
  const game2 = await buildGame(
    deps, game.tier, houseHash, game.player_pubkey, game.player_hash,
    state.finalExpiration, state.setupExpiration,
  )
  // Rebuild both per-party escrow scripts; the sweep spends each VTXO via its
  // own script's win leaf (win leaves are byte-identical, taptrees differ).
  const escrows: SweepEscrow[] = [
    { script: getHouseEscrowScript(game2), ...state.houseEscrow },
    { script: getPlayerEscrowScript(game2), ...playerEscrow },
  ]
  const pot = escrows.reduce((a, e) => a + e.value, 0)
  const rake = winner === 'player' ? await calcRake(pot, deps) : 0
  const proof =
    `house secret ${houseSecret.length}B, player secret ${playerSecret.length}B ` +
    `→ ${winner} wins (pot ${pot}).`

  return {
    winner, houseSecret, playerSecret,
    houseSecretHex: game.house_secret_hex, playerSecretHex,
    escrows, pot, rake, proof,
    houseAddress: await deps.wallet.getAddress(),
    playerPayoutAddress: game.player_change_address!,
    networkHrp: networkHrpFromArkInfo(deps.arkInfo),
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

// Re-export for callers that need the row shape.
export type { GameRow }
