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
  getFinalScript,
  getFinalAddress,
  buildSweepTransaction,
  type Game,
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
import { reservations, selectionMutex, freeHouseVtxos, HouseBusyError } from './vtxo-pool.js'
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
   * Set when the PLAYER won: everything the client needs to build + submit the
   * playerWin sweep itself (single-party). The pot is the two escrow VTXOs.
   */
  sweep?: {
    escrowVtxos: Outpoint[]
    payoutAddress: string
    houseAddress: string
    rake: number
    finalExpiration: number
  }
}

/** Per-party state we persist on the game row (reusing house_vtxos_json). */
interface TrustlessState {
  finalExpiration: number
  setupExpiration: number
  houseEscrow: Outpoint
}

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

/** Escrow `amount` from the house wallet into the escrow address (single-party). */
async function escrowHouseStake(deps: AppDeps, escrowPkScript: Uint8Array, amount: number): Promise<Outpoint> {
  const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
  const all = await deps.wallet.getVtxos()
  const candidate = freeHouseVtxos(all).find((v) => v.value >= amount) ?? all.find((v) => v.value >= amount)
  if (!candidate) throw new Error(`House has no single VTXO covering ${amount} sats`)

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
  const escrowScript = getFinalScript(game)
  const escrowAddress = getFinalAddress(game, networkHrp).encode()
  const escrowScriptHex = hex.encode(escrowScript.pkScript)

  const gameId = uuidv4()
  // Reserve the house stake (its at-risk amount) and escrow it under the mutex
  // so concurrent plays can't over-commit the house balance.
  let houseEscrow!: Outpoint
  await selectionMutex.runExclusive(async () => {
    const balance = await deps.wallet.getBalance()
    if (reservations.totalLiability() + req.tier > balance.available) {
      throw new HouseBusyError(`House is busy (liability ${reservations.totalLiability()} + ${req.tier} > ${balance.available}). Try again shortly.`)
    }
    reservations.reserve(gameId, [], req.tier)
    houseEscrow = await escrowHouseStake(deps, escrowScript.pkScript, req.tier)
  })

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
      finalScriptHex: escrowScriptHex,
      houseVtxosJson: JSON.stringify(state),
    })
  } catch (err) {
    reservations.release(gameId)
    throw err
  }

  return {
    gameId,
    escrowAddress,
    houseHash,
    housePubkey,
    serverPubkey: deps.arkInfo.signerPubkey,
    betAmount: req.tier,
    finalExpiration,
    houseEscrow,
  }
}

export async function handleTrustlessCommit(
  gameId: string,
  req: TrustlessCommitRequest,
  deps: AppDeps,
): Promise<TrustlessCommitResult> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error(`Game not found: ${gameId}`)
  if (game.status !== 'pending') throw new Error(`Game is not pending: ${game.status}`)

  const playerSecret = Buffer.from(req.playerSecretHex, 'hex')
  if (createHash('sha256').update(playerSecret).digest('hex') !== game.player_hash) {
    throw new Error('Player secret does not match committed hash')
  }
  const houseSecret = Buffer.from(game.house_secret_hex, 'hex')
  const state = JSON.parse(game.house_vtxos_json as string) as TrustlessState

  const winnerRole = determineWinner(new Uint8Array(houseSecret), new Uint8Array(playerSecret))
  const winner: 'house' | 'player' = winnerRole === 'creator' ? 'house' : 'player'

  const houseHash = hashSecret(houseSecret)
  const game2 = await buildGame(deps, game.tier, houseHash, game.player_pubkey, game.player_hash, state.finalExpiration, state.setupExpiration)
  const escrowVtxos = [state.houseEscrow, req.playerEscrow]
  const pot = escrowVtxos.reduce((a, e) => a + e.value, 0)
  const houseAddress = await deps.wallet.getAddress()
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)

  const proof =
    `house secret ${houseSecret.length}B, player secret ${playerSecret.length}B ` +
    `→ ${winner} wins (pot ${pot}).`

  let result: TrustlessCommitResult
  if (winner === 'house') {
    // House sweeps both escrow VTXOs via creatorWin (single-party, house+server).
    const sweep = buildSweepTransaction(game2, deps.arkInfo, networkHrp, {
      winner: 'house', escrowVtxos, payoutAddress: houseAddress, houseAddress, rake: 0,
    })
    const txid = await submitOffchain(deps, sweep.arkTx, sweep.checkpoints, [0, 1], {
      inputs: [0, 1], data: [new Uint8Array(houseSecret), new Uint8Array(playerSecret)],
    })
    result = { winner, houseSecret: game.house_secret_hex, playerSecret: req.playerSecretHex, payout: pot, rake: 0, proof, txid }
  } else {
    // Player won — the playerWin leaf needs the player's key, so the client
    // sweeps. Hand back everything it needs (it can re-derive the escrow script
    // from the same params and verify the payout).
    const rake = await calcRake(pot, deps)
    result = {
      winner, houseSecret: game.house_secret_hex, playerSecret: req.playerSecretHex,
      payout: pot - rake, rake, proof,
      sweep: { escrowVtxos, payoutAddress: game.player_change_address!, houseAddress, rake, finalExpiration: state.finalExpiration },
    }
  }

  await deps.repos.games.update(gameId, {
    playerSecretHex: req.playerSecretHex,
    winner,
    rakeAmount: result.rake,
    payoutAmount: result.payout,
    status: 'resolved',
  })
  reservations.release(gameId)
  return result
}

// Re-export for callers that need the row shape.
export type { GameRow }
