/**
 * v4 joint-pot game — server side (Phase 3).
 *
 * v4 replaces v3's two per-party escrows + lazy house funding with ONE joint-pot
 * VTXO funded by an atomic two-party co-fund, settled in 2 on-chain txs. The
 * protocol + tx-builders are proven (v4-game-probe, v4-scale, lib/joint-pot-tx).
 *
 * This module implements the API the design's co-fund handshake needs. Built
 * incrementally, each endpoint verified e2e (bootstrapDeps + supertest) before
 * the next:
 *   - handleV4Play  — reserve a house stake VTXO, derive the joint-pot covenant,
 *     persist the game, return the covenant params for the client to co-fund.
 *   - (next) handleV4Cofund / handleV4CofundFinalize — the 2-round co-fund.
 *   - (next) handleV4Reveal — settle the pot to the winner via the win covenant.
 */

import { base64, hex } from '@scure/base'
import { ArkAddress, Transaction, decodeTapscript, CSVMultisigTapscript, type ExtendedVirtualCoin, type TapLeafScript } from '@arkade-os/sdk'
import {
  CoinflipJointPotScript, commitDigit, randomUniformInt,
  determineWinnerV3, computeRollV3, buildJointPotSettleTx, encodeSettleForEmulator,
} from 'arkade-coinflip'
import { packets } from '@arklabshq/contract-workflows-prototype'
import { v4 as uuidv4 } from 'uuid'
import { hashSecret, networkHrpFromArkInfo } from './house-wallet.js'
import { reservations, selectionMutex, outpointKey, houseVtxoCache, HouseBusyError, BetExceedsCapacityError } from './vtxo-pool.js'
import { loadEmulatorConfig } from './emulator.js'
import { computeHouseStake } from './trustless-game.js'
import type { AppDeps } from './deps.js'

const toXOnly = (b: Uint8Array): Uint8Array => (b.length === 33 ? b.slice(1) : b)
/** The coin (no client odds) maps to n=2,target=1,lo=0 — player wins iff roll==0. */
const COIN_ODDS = { oddsN: 2, oddsTarget: 1, oddsLo: 0 } as const

async function getTiers(deps: AppDeps): Promise<number[]> {
  return JSON.parse((await deps.repos.config.get('tiers')) || '[1000,5000,10000,50000]')
}
async function getOddsEdgeBps(deps: AppDeps): Promise<number> {
  return parseInt((await deps.repos.config.get('variable_odds_edge_bps')) || '300', 10)
}

/** A TapLeafScript serialized for HTTP transport (all bytes → hex). */
export interface SerializedTapLeaf {
  controlBlock: { version: number; internalKey: string; merklePath: string[] }
  script: string
}
function serializeTapLeaf(tl: TapLeafScript): SerializedTapLeaf {
  return {
    controlBlock: {
      version: tl[0].version,
      internalKey: hex.encode(tl[0].internalKey),
      merklePath: tl[0].merklePath.map((m) => hex.encode(m)),
    },
    script: hex.encode(tl[1]),
  }
}

export interface V4PlayRequest {
  tier: number
  /** x-only pubkey hex (32 bytes). */
  playerPubkey: string
  /** sha256 commitment to the player's reveal, hex. */
  playerHash: string
  /** Ark address the pot pays to if the PLAYER wins. */
  playerPayoutAddress: string
  /** Ark address for the player's co-fund change. */
  playerChangeAddress: string
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
}

/** Covenant params the client re-derives the identical CoinflipJointPotScript from. */
export interface V4CovenantParams {
  creatorPubkey: string // house, x-only hex
  playerPubkey: string
  serverPubkey: string
  creatorHash: string
  playerHash: string
  finalExpiration: number
  exitDelay: number
  oddsN: number
  oddsTarget: number
  oddsLo: number
  emulatorPubkey: string
  playerPayoutPkScript: string // hex
  housePayoutPkScript: string // hex
  playerStake: number
  houseStake: number
}

export interface V4PlayResult {
  gameId: string
  potAddress: string
  /** bech32m HRP the server encoded potAddress with — the client re-derives + parses with it. */
  networkHrp: string
  pot: number
  betAmount: number
  houseStake: number
  /** The house's RESERVED stake input — vin 1 of the co-fund. */
  houseVtxo: { txid: string; vout: number; value: number }
  /** The house input's forfeit leaf + tapTree, so the client assembles vin 1
   *  of the co-fund without any server-side VTXO access. */
  houseLeaf: SerializedTapLeaf
  houseTapTree: string
  housePubkey: string
  houseHash: string
  serverPubkey: string
  emulatorPubkey: string
  finalExpiration: number
  oddsN: number
  oddsTarget: number
  oddsLo: number
  covenant: V4CovenantParams
}

/** v4 per-game state persisted on the game row (house_vtxos_json). */
export interface V4State {
  protocolVersion: 'v4'
  finalExpiration: number
  setupExpiration: number
  oddsN: number
  oddsTarget: number
  oddsLo: number
  exitDelay: number
  pot: number
  houseStake: number
  potAddress: string
  /** The reserved house stake input. */
  houseVtxo: { txid: string; vout: number; value: number }
  covenant: V4CovenantParams
  /** Set by /cofund: the submitted arkTx id + the house-signed checkpoint (vin 1), base64. */
  cofundArkTxid?: string
  houseSignedCheckpoint?: string
  /** Set by /cofund-finalize: the on-chain co-fund txid (== the pot VTXO txid). */
  cofundTxid?: string
}

const settledOrPre = (v: ExtendedVirtualCoin): boolean =>
  v.virtualStatus.state === 'settled' || v.virtualStatus.state === 'preconfirmed'

/**
 * POST /api/v4/play — reserve a house stake VTXO, derive the joint-pot covenant,
 * persist the game, and return the params the client co-funds against. No
 * signing happens here; the co-fund is the next handshake step.
 */
export async function handleV4Play(req: V4PlayRequest, deps: AppDeps): Promise<V4PlayResult> {
  const tiers = await getTiers(deps)
  if (!tiers.includes(req.tier)) throw new Error(`Invalid tier: ${req.tier}`)
  if ((await deps.repos.games.countPendingForPlayer(req.playerPubkey)) >= 3) {
    throw new Error('Too many pending games. Complete or wait for existing games to expire.')
  }

  // House stake: tier for the coin, a house-edged multiple for variable odds.
  const dust = Number(deps.arkInfo.dust ?? 546n)
  const isVariable = req.oddsN !== undefined && req.oddsTarget !== undefined
  let houseStake = req.tier
  let odds: { oddsN: number; oddsTarget: number; oddsLo: number } = { ...COIN_ODDS }
  if (isVariable) {
    const n = req.oddsN as number, target = req.oddsTarget as number, lo = req.oddsLo ?? 0
    if (!Number.isInteger(n) || n < 2 || !Number.isInteger(target) || !Number.isInteger(lo) || lo < 0 || target <= lo || target > n) {
      throw new Error(`Invalid odds: need oddsN>=2 and 0<=oddsLo<oddsTarget<=oddsN (got n=${n}, target=${target}, lo=${lo})`)
    }
    houseStake = computeHouseStake(req.tier, n, target, lo, await getOddsEdgeBps(deps))
    if (houseStake < dust) {
      throw new Error(`Odds [${lo},${target})/${n} at tier ${req.tier} give a sub-dust house stake (${houseStake}); raise the tier or win probability.`)
    }
    odds = { oddsN: n, oddsTarget: target, oddsLo: lo }
  }

  // House reveal — same `[digit] || salt` shape as v3 so hashSecret yields the
  // on-chain creatorHash unchanged.
  const c = commitDigit(randomUniformInt(odds.oddsN), odds.oddsN)
  const houseSecret = packets.encodeReveal(c.digit, c.salt)
  const houseHash = hashSecret(houseSecret) // hex string
  const houseHashBytes = hex.decode(houseHash)

  const emulator = await loadEmulatorConfig()
  if (!emulator) {
    throw new Error('Emulator not configured or unreachable. /api/v4/play requires arkade-script support.')
  }

  const rawExitDelay = Number(deps.arkInfo.unilateralExitDelay ?? 86400)
  const exitDelay = Math.max(512, Math.ceil(rawExitDelay / 512) * 512)
  const now = Math.floor(Date.now() / 1000)
  const finalExpiration = now + 1800
  const setupExpiration = now + 600

  const housePubkey = toXOnly(await deps.identity.compressedPublicKey())
  const serverPubkey = toXOnly(hex.decode(deps.arkInfo.signerPubkey))
  const playerPubkey = hex.decode(req.playerPubkey)
  const playerHashBytes = hex.decode(req.playerHash)
  const playerPayoutPkScript = ArkAddress.decode(req.playerPayoutAddress).pkScript
  const housePayoutPkScript = ArkAddress.decode(await deps.wallet.getAddress()).pkScript
  const pot = req.tier + houseStake

  const covenantScript = new CoinflipJointPotScript({
    creatorPubkey: housePubkey, playerPubkey, serverPubkey,
    creatorHash: houseHashBytes, playerHash: playerHashBytes,
    finalExpiration: BigInt(finalExpiration), exitDelay: BigInt(exitDelay),
    oddsN: odds.oddsN, oddsTarget: odds.oddsTarget, oddsLo: odds.oddsLo,
    emulatorPubkey: emulator.signerPubkey,
    playerPayoutPkScript, housePayoutPkScript,
    playerStake: BigInt(req.tier), houseStake: BigInt(houseStake),
  })
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  const potAddress = covenantScript.address(networkHrp, serverPubkey).encode()

  const gameId = uuidv4()

  // Reserve a SPECIFIC house stake VTXO (vin 1 of the co-fund). Unlike v3's
  // liability-only reservation, v4 pins the exact outpoint the co-fund spends.
  let houseVtxo: { txid: string; vout: number; value: number } | null = null
  let houseLeaf: SerializedTapLeaf | null = null
  let houseTapTree = ''
  await selectionMutex.runExclusive(async () => {
    let vtxos = await houseVtxoCache.get(deps)
    let candidate = vtxos.find((v) => settledOrPre(v) && v.value >= houseStake && !reservations.isReserved(outpointKey(v.txid, v.vout)))
    if (!candidate) {
      vtxos = await houseVtxoCache.refresh(deps)
      candidate = vtxos.find((v) => settledOrPre(v) && v.value >= houseStake && !reservations.isReserved(outpointKey(v.txid, v.vout)))
    }
    if (!candidate) {
      const max = vtxos.filter(settledOrPre).reduce((m, v) => Math.max(m, v.value), 0)
      if (max < houseStake) throw new BetExceedsCapacityError(`Bet exceeds house capacity: needs a ${houseStake}-sat VTXO, largest free is ${max}.`)
      throw new HouseBusyError('House is busy (no free stake VTXO). Try again shortly.')
    }
    houseVtxo = { txid: candidate.txid, vout: candidate.vout, value: candidate.value }
    houseLeaf = serializeTapLeaf(candidate.forfeitTapLeafScript)
    houseTapTree = hex.encode(candidate.tapTree)
    reservations.reserve(gameId, [outpointKey(candidate.txid, candidate.vout)], houseStake)
  })
  if (!houseVtxo || !houseLeaf) throw new HouseBusyError('House is busy. Try again shortly.')

  const covenant: V4CovenantParams = {
    creatorPubkey: hex.encode(housePubkey),
    playerPubkey: req.playerPubkey,
    serverPubkey: hex.encode(serverPubkey),
    creatorHash: houseHash,
    playerHash: req.playerHash,
    finalExpiration, exitDelay,
    oddsN: odds.oddsN, oddsTarget: odds.oddsTarget, oddsLo: odds.oddsLo,
    emulatorPubkey: hex.encode(emulator.signerPubkey),
    playerPayoutPkScript: hex.encode(playerPayoutPkScript),
    housePayoutPkScript: hex.encode(housePayoutPkScript),
    playerStake: req.tier, houseStake,
  }
  const state: V4State = {
    protocolVersion: 'v4', finalExpiration, setupExpiration,
    oddsN: odds.oddsN, oddsTarget: odds.oddsTarget, oddsLo: odds.oddsLo,
    exitDelay, pot, houseStake, potAddress, houseVtxo, covenant,
  }
  try {
    await deps.repos.games.save({
      id: gameId,
      tier: req.tier,
      playerPubkey: req.playerPubkey,
      playerChoice: 'trustless-v4',
      playerHash: req.playerHash,
      playerChangeAddress: req.playerChangeAddress,
      houseSecretHex: Buffer.from(houseSecret).toString('hex'),
      houseVtxosJson: JSON.stringify(state),
    })
  } catch (err) {
    reservations.release(gameId)
    throw err
  }

  return {
    gameId, potAddress, networkHrp, pot, betAmount: req.tier, houseStake,
    houseVtxo, houseLeaf, houseTapTree, housePubkey: hex.encode(housePubkey), houseHash,
    serverPubkey: hex.encode(serverPubkey), emulatorPubkey: hex.encode(emulator.signerPubkey),
    finalExpiration, oddsN: odds.oddsN, oddsTarget: odds.oddsTarget, oddsLo: odds.oddsLo,
    covenant,
  }
}

// ── Co-fund handshake (endpoints 2-3) ───────────────────────────────────────

/**
 * Serialize the server's arkd submits/finalizes. Independent concurrent submits
 * race arkd's round assembly → a spurious INVALID_SIGNATURE that still consumes
 * the input (proven in v4-scale). The server is the single submit funnel, so one
 * in-process mutex around submitTx/finalizeTx is the natural serialization point.
 */
let arkSubmitLock: Promise<unknown> = Promise.resolve()
function withArkSubmit<T>(fn: () => Promise<T>): Promise<T> {
  const run = arkSubmitLock.then(fn, fn)
  arkSubmitLock = run.catch(() => undefined)
  return run
}

async function loadV4Game(deps: AppDeps, gameId: string): Promise<{ state: V4State; status: string }> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error('Game not found')
  const state = JSON.parse(game.house_vtxos_json || '{}') as V4State
  if (state.protocolVersion !== 'v4') throw new Error('Not a v4 game')
  return { state, status: game.status }
}

export interface V4CofundRequest {
  /** The co-fund arkTx (player-signed input vin 0), base64 PSBT. */
  arkTx: string
  /** The co-fund checkpoints (one per input), base64 PSBTs. */
  checkpoints: string[]
}
export interface V4CofundResult {
  arkTxid: string
  /** The player's checkpoint (vin 0) for the client to sign, base64 PSBT. */
  playerCheckpoint: string
}

/**
 * POST /api/v4/game/:id/cofund — the client has signed the co-fund arkTx's
 * player input (vin 0). The server signs the house input (vin 1), submits the
 * tx, signs the house checkpoint (vin 1), and returns the player checkpoint
 * (vin 0) for the client to sign in the finalize step.
 */
export async function handleV4Cofund(gameId: string, req: V4CofundRequest, deps: AppDeps): Promise<V4CofundResult> {
  const { state, status } = await loadV4Game(deps, gameId)
  if (status !== 'pending') throw new Error('Game is not pending')
  if (state.cofundArkTxid) throw new Error('Co-fund already submitted')
  if (req.checkpoints.length !== 2) throw new Error(`Co-fund must have exactly 2 checkpoints (got ${req.checkpoints.length})`)

  const arkTx = Transaction.fromPSBT(base64.decode(req.arkTx))
  // Guard: output 0 must be the agreed pot (exact amount to the covenant script).
  const potOut = arkTx.getOutput(0)
  const potPkScript = ArkAddress.decode(state.potAddress).pkScript
  if (!potOut || potOut.amount !== BigInt(state.pot) || !potOut.script || hex.encode(potOut.script) !== hex.encode(potPkScript)) {
    throw new Error('Co-fund output 0 does not match the agreed pot (amount or script mismatch)')
  }

  // Sign the house input (vin 1), then submit (serialized) + sign the house checkpoint (vin 1).
  const signed = await deps.identity.sign(arkTx, [1])
  const { arkTxid, signedCheckpointTxs } = await withArkSubmit(() =>
    deps.wallet.arkProvider.submitTx(base64.encode(signed.toPSBT()), req.checkpoints),
  )
  if (signedCheckpointTxs.length !== 2) throw new Error(`Expected 2 checkpoints back, got ${signedCheckpointTxs.length}`)
  const cp1 = Transaction.fromPSBT(base64.decode(signedCheckpointTxs[1]))
  const cp1Signed = await deps.identity.sign(cp1, Array.from({ length: cp1.inputsLength }, (_, i) => i))

  state.cofundArkTxid = arkTxid
  state.houseSignedCheckpoint = base64.encode(cp1Signed.toPSBT())
  await deps.repos.games.update(gameId, { houseVtxosJson: JSON.stringify(state) })

  return { arkTxid, playerCheckpoint: signedCheckpointTxs[0] }
}

export interface V4CofundFinalizeRequest {
  /** The player's checkpoint (vin 0), now player-signed, base64 PSBT. */
  playerCheckpoint: string
}
export interface V4CofundFinalizeResult {
  cofundTxid: string
  potOutpoint: { txid: string; vout: number; value: number }
}

/**
 * POST /api/v4/game/:id/cofund-finalize — the client has signed its checkpoint
 * (vin 0). The server finalizes the co-fund (player checkpoint + the house
 * checkpoint it signed at /cofund), creating the joint-pot VTXO.
 */
export async function handleV4CofundFinalize(gameId: string, req: V4CofundFinalizeRequest, deps: AppDeps): Promise<V4CofundFinalizeResult> {
  const { state } = await loadV4Game(deps, gameId)
  if (!state.cofundArkTxid || !state.houseSignedCheckpoint) throw new Error('Co-fund not submitted yet (call /cofund first)')
  if (state.cofundTxid) throw new Error('Co-fund already finalized')

  // finalizeTx takes the checkpoints in input order: [vin0 (player), vin1 (house)].
  await withArkSubmit(() =>
    deps.wallet.arkProvider.finalizeTx(state.cofundArkTxid!, [req.playerCheckpoint, state.houseSignedCheckpoint!]),
  )
  state.cofundTxid = state.cofundArkTxid
  await deps.repos.games.update(gameId, { houseVtxosJson: JSON.stringify(state) })

  return { cofundTxid: state.cofundArkTxid, potOutpoint: { txid: state.cofundArkTxid, vout: 0, value: state.pot } }
}

// ── Reveal + settle (endpoint 4) ─────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Reconstruct the joint-pot covenant from the persisted (hex) params. */
function rebuildCovenant(cv: V4CovenantParams): CoinflipJointPotScript {
  return new CoinflipJointPotScript({
    creatorPubkey: hex.decode(cv.creatorPubkey),
    playerPubkey: hex.decode(cv.playerPubkey),
    serverPubkey: hex.decode(cv.serverPubkey),
    creatorHash: hex.decode(cv.creatorHash),
    playerHash: hex.decode(cv.playerHash),
    finalExpiration: BigInt(cv.finalExpiration),
    exitDelay: BigInt(cv.exitDelay),
    oddsN: cv.oddsN, oddsTarget: cv.oddsTarget, oddsLo: cv.oddsLo,
    emulatorPubkey: hex.decode(cv.emulatorPubkey),
    playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
    housePayoutPkScript: hex.decode(cv.housePayoutPkScript),
    playerStake: BigInt(cv.playerStake), houseStake: BigInt(cv.houseStake),
  })
}

export interface V4RevealRequest {
  /** The player's reveal bytes (`[digit] || salt`, = packets.encodeReveal), hex. */
  playerSecretHex: string
}
export interface V4RevealResult {
  winner: 'player' | 'house'
  settleTxid: string
  payout: number
  /** Now-public house reveal. */
  houseSecretHex: string
  /** Rolled value (digitC + digitP) mod n, or null on a cheat-penalty. */
  roll: number | null
}

/**
 * POST /api/v4/game/:id/reveal — the player reveals its secret. The server
 * determines the winner from both reveals, settles the WHOLE pot to the winner
 * via the win-covenant leaf (lib buildJointPotSettleTx → emulator /v1/tx), and
 * marks the game resolved.
 */
export async function handleV4Reveal(gameId: string, req: V4RevealRequest, deps: AppDeps): Promise<V4RevealResult> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error('Game not found')
  const state = JSON.parse(game.house_vtxos_json || '{}') as V4State
  if (state.protocolVersion !== 'v4') throw new Error('Not a v4 game')
  if (!state.cofundTxid) throw new Error('Pot not co-funded yet (finalize the co-fund first)')
  if (game.status === 'resolved') throw new Error('Game already resolved')

  const playerSecret = hex.decode(req.playerSecretHex)
  if (hashSecret(playerSecret) !== game.player_hash) {
    throw new Error('Player secret does not match the committed hash')
  }
  const houseSecret = hex.decode(game.house_secret_hex)

  // First byte of each reveal is the digit (packets.encodeReveal: `[digit] || salt`).
  const creatorReveal = { digit: houseSecret[0], salt: houseSecret.slice(1) }
  const playerReveal = { digit: playerSecret[0], salt: playerSecret.slice(1) }
  const outcome = determineWinnerV3(creatorReveal, playerReveal, state.oddsN, state.oddsTarget, state.oddsLo)
  const roll = computeRollV3(creatorReveal, playerReveal, state.oddsN)

  const pot = rebuildCovenant(state.covenant)
  const winnerPayoutPkScript = hex.decode(outcome === 'player' ? state.covenant.playerPayoutPkScript : state.covenant.housePayoutPkScript)
  const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
  const settle = buildJointPotSettleTx({
    pot, cofund: { txid: state.cofundTxid, vout: 0, value: state.pot },
    winner: outcome, winnerPayoutPkScript, potAmount: BigInt(state.pot),
    playerRevealBytes: playerSecret, creatorRevealBytes: houseSecret, serverUnroll,
  })

  const cfg = await loadEmulatorConfig()
  if (!cfg) throw new Error('Emulator not configured')
  const body = JSON.stringify(encodeSettleForEmulator(settle))
  // The emulator forwards the finalized settle to arkd, so each POST is an arkd
  // submit — serialize it (backoff outside the lock), retry transient lag.
  const postOnce = async (): Promise<{ ok: true; txid: string } | { ok: false; status: number; text: string }> => {
    const r = await fetch(`${cfg.url}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(25_000) })
    if (r.ok) return { ok: true, txid: Transaction.fromPSBT(base64.decode((await r.json() as { signedArkTx: string }).signedArkTx)).id }
    return { ok: false, status: r.status, text: await r.text() }
  }
  let settleTxid = ''
  for (let a = 0; a < 10; a++) {
    const res = await withArkSubmit(postOnce)
    if (res.ok) { settleTxid = res.txid; break }
    const transient = res.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(res.text)
    if (!transient || a === 9) throw new Error(`Emulator rejected settle: ${res.status} ${res.text}`)
    await sleep(500 + a * 500)
  }

  const winner: 'player' | 'house' = outcome === 'player' ? 'player' : 'house'
  reservations.release(gameId)
  await deps.repos.games.update(gameId, {
    status: 'resolved',
    winner,
    payoutAmount: state.pot,
    playerSecretHex: req.playerSecretHex,
  })

  return { winner, settleTxid, payout: state.pot, houseSecretHex: game.house_secret_hex, roll }
}
