/**
 * v4 joint-pot game — server side.
 *
 * v4 replaces v3's two per-party escrows + lazy house funding with ONE joint-pot
 * VTXO funded by an atomic two-party co-fund, settled in 2 on-chain txs. The
 * protocol + tx-builders are proven (v4-game-probe, v4-scale, lib/joint-pot-tx).
 *
 * This module implements the API the design's co-fund handshake needs; each
 * endpoint is verified e2e (bootstrapDeps + supertest):
 *   - handleV4Play  — reserve a house stake VTXO, derive the joint-pot covenant,
 *     persist the game, return the covenant params for the client to co-fund.
 *   - handleV4Cofund / handleV4CofundFinalize — the 2-round co-fund.
 *   - handleV4Reveal — settle the pot to the winner via the win covenant.
 */

import { base64, hex } from '@scure/base'
import { ArkAddress, Transaction, decodeTapscript, CSVMultisigTapscript, RestIndexerProvider, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import {
  CoinflipJointPotScript, commitDigit, randomUniformInt,
  determineWinnerV3, computeRollV3, buildJointPotSettleTx, buildStageTwoSettleTx, buildJointPotRefundTx,
  encodeSettleForEmulator, getConditionWitness,
  serializeTapLeaf, type SerializedTapLeaf, type SerializedHouseInput, type BuiltJointPotTx,
} from 'arkade-coinflip'
import { packets } from '@arklabshq/contract-workflows-prototype'
import { v4 as uuidv4 } from 'uuid'
import { hashSecret, networkHrpFromArkInfo, ARK_SERVER_URL } from './house-wallet.js'
import { reservations, selectionMutex, outpointKey, houseVtxoCache, HouseBusyError, BetExceedsCapacityError, KeyedMutex } from './vtxo-pool.js'
import { loadEmulatorConfig } from './emulator.js'
import { computeHouseStake } from './trustless-game.js'
import type { AppDeps } from './deps.js'

const toXOnly = (b: Uint8Array): Uint8Array => (b.length === 33 ? b.slice(1) : b)
/** The coin (no client odds) maps to n=2,target=1,lo=0 — player wins iff roll==0. */
const COIN_ODDS = { oddsN: 2, oddsTarget: 1, oddsLo: 0 } as const

/**
 * Which protocol NEW games use — 'v3' (per-party escrow, the default) or 'v4'
 * (joint pot). Set PROTOCOL_VERSION=v4 to advertise + serve the v0.4 flow; the
 * client reads it from /api/network and routes to /api/v4 accordingly. Defaults
 * to 'v3' so the joint-pot path is strictly opt-in.
 */
export function newGameProtocolVersion(): 'v3' | 'v4' {
  return (process.env.PROTOCOL_VERSION ?? 'v3').trim().toLowerCase() === 'v4' ? 'v4' : 'v3'
}

async function getTiers(deps: AppDeps): Promise<number[]> {
  return JSON.parse((await deps.repos.config.get('tiers')) || '[1000,5000,10000,50000]')
}
async function getOddsEdgeBps(deps: AppDeps): Promise<number> {
  return parseInt((await deps.repos.config.get('variable_odds_edge_bps')) || '300', 10)
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
  cancelDelay: number
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
  /** The house's RESERVED stake inputs (one or many, summing to ≥ houseStake) —
   *  the TRAILING inputs of the co-fund. Each carries its forfeit leaf + tapTree
   *  so the client assembles them with no server-side VTXO access. */
  houseInputs: SerializedHouseInput[]
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
  /** The reserved house stake inputs (the trailing co-fund inputs). */
  houseInputs: SerializedHouseInput[]
  covenant: V4CovenantParams
  /** Set by /cofund: the submitted arkTx id + the house-signed checkpoints (one
   *  per house input, in vin order), base64. */
  cofundArkTxid?: string
  houseSignedCheckpoints?: string[]
  /** Player input count (the leading k vins), set by /cofund so /cofund-finalize
   *  can reject a wrong number of player checkpoints early. */
  playerInputCount?: number
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
  // Forfeit/refund CLTV window. Configurable (V4_FINAL_EXPIRATION_SECS) so the
  // recovery e2e can use a short timelock; production default is 30 min. Guard
  // against a malformed env (Number('x') → NaN) silently breaking the window.
  const finalExpirationSecs = Number(process.env.V4_FINAL_EXPIRATION_SECS ?? 1800)
  const windowSecs = Number.isFinite(finalExpirationSecs) && finalExpirationSecs > 0 ? finalExpirationSecs : 1800
  const finalExpiration = now + windowSecs
  // Pre-signed refund CLTV: half the forfeit window. < finalExpiration (the house
  // refunds a never-revealed pot before the player's forfeit opens) and well past
  // the (seconds-fast) settle (a losing player can't refund-escape).
  const cancelDelay = now + Math.max(1, Math.floor(windowSecs / 2))
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
    finalExpiration: BigInt(finalExpiration), cancelDelay: BigInt(cancelDelay), exitDelay: BigInt(exitDelay),
    oddsN: odds.oddsN, oddsTarget: odds.oddsTarget, oddsLo: odds.oddsLo,
    emulatorPubkey: emulator.signerPubkey,
    playerPayoutPkScript, housePayoutPkScript,
    playerStake: BigInt(req.tier), houseStake: BigInt(houseStake),
  })
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  const potAddress = covenantScript.address(networkHrp, serverPubkey).encode()

  const gameId = uuidv4()

  // Reserve enough SPECIFIC house stake VTXOs to cover houseStake (one or many).
  // Unlike v3's liability-only reservation, v4 pins the exact outpoints the
  // co-fund spends. Greedy largest-first keeps the input count small; the house
  // change (Hsum − houseStake) returns to the house in the co-fund.
  let houseInputs: SerializedHouseInput[] = []
  await selectionMutex.runExclusive(async () => {
    const choose = (vtxos: ExtendedVirtualCoin[]): ExtendedVirtualCoin[] | null => {
      const free = vtxos
        .filter((v) => settledOrPre(v) && !reservations.isReserved(outpointKey(v.txid, v.vout)))
        .sort((a, b) => b.value - a.value)
      const picked: ExtendedVirtualCoin[] = []
      let sum = 0
      for (const v of free) {
        if (sum >= houseStake) break
        picked.push(v)
        sum += v.value
      }
      return sum >= houseStake ? picked : null
    }
    // Always select from a FRESH fetch: v4 pins exact outpoints, so a stale cache
    // (e.g. a VTXO another game just co-funded) would hand the client an
    // already-spent input → VTXO_ALREADY_SPENT at submit. (v3 reserves liability,
    // not outpoints, so it tolerates staleness; v4 cannot.)
    const vtxos = await houseVtxoCache.refresh(deps)
    const picked = choose(vtxos)
    if (!picked) {
      const freeTotal = vtxos
        .filter((v) => settledOrPre(v) && !reservations.isReserved(outpointKey(v.txid, v.vout)))
        .reduce((s, v) => s + v.value, 0)
      if (freeTotal < houseStake) throw new BetExceedsCapacityError(`Bet exceeds house capacity: needs ${houseStake} sat, free house balance is ${freeTotal}.`)
      throw new HouseBusyError('House is busy (insufficient free stake VTXOs). Try again shortly.')
    }
    houseInputs = picked.map((v) => ({
      txid: v.txid, vout: v.vout, value: v.value,
      leaf: serializeTapLeaf(v.forfeitTapLeafScript), tapTree: hex.encode(v.tapTree),
    }))
    reservations.reserve(gameId, picked.map((v) => outpointKey(v.txid, v.vout)), houseStake)
  })
  if (houseInputs.length === 0) throw new HouseBusyError('House is busy. Try again shortly.')

  const covenant: V4CovenantParams = {
    creatorPubkey: hex.encode(housePubkey),
    playerPubkey: req.playerPubkey,
    serverPubkey: hex.encode(serverPubkey),
    creatorHash: houseHash,
    playerHash: req.playerHash,
    finalExpiration, cancelDelay, exitDelay,
    oddsN: odds.oddsN, oddsTarget: odds.oddsTarget, oddsLo: odds.oddsLo,
    emulatorPubkey: hex.encode(emulator.signerPubkey),
    playerPayoutPkScript: hex.encode(playerPayoutPkScript),
    housePayoutPkScript: hex.encode(housePayoutPkScript),
    playerStake: req.tier, houseStake,
  }
  const state: V4State = {
    protocolVersion: 'v4', finalExpiration, setupExpiration,
    oddsN: odds.oddsN, oddsTarget: odds.oddsTarget, oddsLo: odds.oddsLo,
    exitDelay, pot, houseStake, potAddress, houseInputs, covenant,
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
    houseInputs, housePubkey: hex.encode(housePubkey), houseHash,
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

// Per-game serialization for the multi-step read-check-act handlers. withArkSubmit
// only serializes the submit call itself; these guard the whole handler so two
// concurrent requests for the same game can't both pass the status/state check
// and both proceed (double co-fund submit, double settle).
const cofundLocks = new KeyedMutex()
const revealLocks = new KeyedMutex()

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
  /** The player's checkpoints (the LEADING k inputs) for the client to sign, base64. */
  playerCheckpoints: string[]
}

/**
 * POST /api/v4/game/:id/cofund — the client has signed the co-fund arkTx's
 * player inputs (the leading k vins). The server validates the tx, signs the
 * house inputs (the trailing m vins), submits, signs the house checkpoints, and
 * returns the player checkpoints for the client to sign in the finalize step.
 */
export async function handleV4Cofund(gameId: string, req: V4CofundRequest, deps: AppDeps): Promise<V4CofundResult> {
  return cofundLocks.runExclusive(gameId, () => handleV4CofundInner(gameId, req, deps))
}

async function handleV4CofundInner(gameId: string, req: V4CofundRequest, deps: AppDeps): Promise<V4CofundResult> {
  const { state, status } = await loadV4Game(deps, gameId)
  if (status !== 'pending') throw new Error('Game is not pending')
  if (state.cofundArkTxid) throw new Error('Co-fund already submitted')

  const m = state.houseInputs.length
  const arkTx = Transaction.fromPSBT(base64.decode(req.arkTx))
  const total = arkTx.inputsLength
  const k = total - m // player inputs occupy the leading k vins, house the trailing m
  if (k < 1) throw new Error(`Co-fund must include at least one player input (got ${total} inputs for ${m} house inputs)`)
  if (req.checkpoints.length !== total) throw new Error(`Co-fund must have ${total} checkpoints (got ${req.checkpoints.length})`)

  // Guard 0: each of the trailing m house checkpoints must spend EXACTLY the
  // reserved house outpoint, in order. The arkTx's trailing vins reference these
  // checkpoints (Ark's checkpoint indirection — the vins are NOT the VTXO
  // outpoints), so the checkpoint's spent VTXO is where we confirm the house
  // signs only its reserved inputs. Guard 2 checks the contribution against the
  // persisted state, not the tx, so without this a client could place other
  // inputs at the trailing positions and have the house blindly sign them.
  for (let i = 0; i < m; i++) {
    const cp = Transaction.fromPSBT(base64.decode(req.checkpoints[k + i]))
    const cpIn = cp.getInput(0)
    const expected = state.houseInputs[i]
    const cpTxid = cpIn?.txid ? hex.encode(cpIn.txid) : ''
    if (cp.inputsLength !== 1 || cpTxid !== expected.txid || cpIn?.index !== expected.vout) {
      throw new Error(`Co-fund house checkpoint ${k + i} does not spend the reserved house input ${expected.txid}:${expected.vout}`)
    }
  }

  // Guard 1: output 0 is the agreed pot — exact amount to the covenant script.
  const potOut = arkTx.getOutput(0)
  const potPkScript = ArkAddress.decode(state.potAddress).pkScript
  if (!potOut || potOut.amount !== BigInt(state.pot) || !potOut.script || hex.encode(potOut.script) !== hex.encode(potPkScript)) {
    throw new Error('Co-fund output 0 does not match the agreed pot (amount or script mismatch)')
  }
  // Guard 2: the house contributes EXACTLY houseStake (no more). Its reserved
  // inputs sum to Hsum and its change returns to housePayoutPkScript, so
  // Hsum − houseChange must equal houseStake (±dust, since sub-dust change is
  // dropped). Protects the house from a client-crafted co-fund that overdraws it.
  const dust = Number(deps.arkInfo.dust ?? 546n)
  const Hsum = state.houseInputs.reduce((s, h) => s + h.value, 0)
  let houseChange = 0
  for (let o = 1; o < arkTx.outputsLength; o++) {
    const out = arkTx.getOutput(o)
    if (out?.script && hex.encode(out.script) === state.covenant.housePayoutPkScript) houseChange += Number(out.amount)
  }
  const houseContribution = Hsum - houseChange
  if (houseContribution < state.houseStake || houseContribution > state.houseStake + dust) {
    throw new Error(`Co-fund house contribution ${houseContribution} outside [${state.houseStake}, ${state.houseStake + dust}] — refusing to sign`)
  }

  // Sign the house input vins (trailing m), submit (serialized), sign the house
  // checkpoints (trailing m), return the player checkpoints (leading k).
  const houseVins = Array.from({ length: m }, (_, i) => k + i)
  const signed = await deps.identity.sign(arkTx, houseVins)
  const { arkTxid, signedCheckpointTxs } = await withArkSubmit(() =>
    deps.wallet.arkProvider.submitTx(base64.encode(signed.toPSBT()), req.checkpoints),
  )
  if (signedCheckpointTxs.length !== total) throw new Error(`Expected ${total} checkpoints back, got ${signedCheckpointTxs.length}`)
  const houseSignedCheckpoints: string[] = []
  for (let i = 0; i < m; i++) {
    const cp = Transaction.fromPSBT(base64.decode(signedCheckpointTxs[k + i]))
    let cpSigned = cp
    try {
      cpSigned = await deps.identity.sign(cp, Array.from({ length: cp.inputsLength }, (_, j) => j))
    } catch (e) {
      // "No taproot scripts signed" = arkd already completed this checkpoint, so
      // there's nothing for the house to add — use it as-is (a genuinely missing
      // signature fails loudly later at finalizeTx, not here).
      if (!String(e instanceof Error ? e.message : e).includes('No taproot scripts signed')) throw e
    }
    houseSignedCheckpoints.push(base64.encode(cpSigned.toPSBT()))
  }

  state.cofundArkTxid = arkTxid
  state.houseSignedCheckpoints = houseSignedCheckpoints
  state.playerInputCount = k
  await deps.repos.games.update(gameId, { houseVtxosJson: JSON.stringify(state) })

  return { arkTxid, playerCheckpoints: signedCheckpointTxs.slice(0, k) }
}

export interface V4CofundFinalizeRequest {
  /** The player's checkpoints (the leading k inputs), now player-signed, base64. */
  playerCheckpoints: string[]
}
export interface V4CofundFinalizeResult {
  cofundTxid: string
  potOutpoint: { txid: string; vout: number; value: number }
}

/**
 * POST /api/v4/game/:id/cofund-finalize — the client has signed its checkpoints
 * (the leading k inputs). The server finalizes the co-fund (player checkpoints +
 * the house checkpoints it signed at /cofund), creating the joint-pot VTXO.
 */
export async function handleV4CofundFinalize(gameId: string, req: V4CofundFinalizeRequest, deps: AppDeps): Promise<V4CofundFinalizeResult> {
  const { state } = await loadV4Game(deps, gameId)
  if (!state.cofundArkTxid || !state.houseSignedCheckpoints) throw new Error('Co-fund not submitted yet (call /cofund first)')
  if (state.cofundTxid) throw new Error('Co-fund already finalized')
  // Reject a wrong number of player checkpoints early (forward-compat: skip for
  // games co-funded before playerInputCount was persisted).
  if (state.playerInputCount !== undefined && req.playerCheckpoints.length !== state.playerInputCount) {
    throw new Error(`Expected ${state.playerInputCount} player checkpoints, got ${req.playerCheckpoints.length}`)
  }

  // finalizeTx takes checkpoints in vin order: [player (leading k), house (trailing m)].
  await withArkSubmit(() =>
    deps.wallet.arkProvider.finalizeTx(state.cofundArkTxid!, [...req.playerCheckpoints, ...state.houseSignedCheckpoints!]),
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
    cancelDelay: BigInt(cv.cancelDelay),
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
  return revealLocks.runExclusive(gameId, () => handleV4RevealInner(gameId, req, deps))
}

async function handleV4RevealInner(gameId: string, req: V4RevealRequest, deps: AppDeps): Promise<V4RevealResult> {
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

/**
 * Broadcast the REFUND for a co-funded game whose player never revealed — the
 * house's protection against the never-reveal griefing vector. Past cancelDelay
 * (enforced by arkd/emulator via the cooperativeSpend CLTV) this splits the pot
 * back: the player's stake to its payout, the house's to its payout — pre-empting
 * the player's later forfeit (finalExpiration > cancelDelay).
 *
 * COVENANT-ONLY: the emulator enforces the exact split (the splitTo arkade
 * script in buildJointPotRefundTx), so there is NO pre-signing — the house just
 * builds the tx and POSTs it, exactly like the settle. Idempotency: throws if the
 * pot was never co-funded or the game already settled.
 */
export async function broadcastV4Refund(gameId: string, deps: AppDeps): Promise<{ refundTxid: string }> {
  const { state, status } = await loadV4Game(deps, gameId)
  if (!state.cofundTxid) throw new Error('Cannot refund: pot not co-funded')
  if (status === 'resolved') throw new Error('Cannot refund: game already resolved')

  const pot = rebuildCovenant(state.covenant)
  const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
  const refund = buildJointPotRefundTx({
    pot,
    cofund: { txid: state.cofundTxid, vout: 0, value: state.pot },
    playerStake: BigInt(state.covenant.playerStake),
    houseStake: BigInt(state.covenant.houseStake),
    playerPayoutPkScript: hex.decode(state.covenant.playerPayoutPkScript),
    housePayoutPkScript: hex.decode(state.covenant.housePayoutPkScript),
    serverUnroll,
  })

  const cfg = await loadEmulatorConfig()
  if (!cfg) throw new Error('Emulator not configured')
  const body = JSON.stringify(encodeSettleForEmulator(refund))
  // The emulator co-signs the split covenant + forwards to arkd (each POST is an
  // arkd submit) — serialize it, retry transient lag. arkd enforces the CLTV, so
  // this only succeeds once the chain's MTP is past cancelDelay.
  const postOnce = async (): Promise<{ ok: true; txid: string } | { ok: false; status: number; text: string }> => {
    const r = await fetch(`${cfg.url}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(25_000) })
    if (r.ok) return { ok: true, txid: Transaction.fromPSBT(base64.decode((await r.json() as { signedArkTx: string }).signedArkTx)).id }
    return { ok: false, status: r.status, text: await r.text() }
  }
  let refundTxid = ''
  for (let a = 0; a < 10; a++) {
    const res = await withArkSubmit(postOnce)
    if (res.ok) { refundTxid = res.txid; break }
    const transient = res.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(res.text)
    if (!transient || a === 9) throw new Error(`Emulator rejected refund: ${res.status} ${res.text}`)
    await sleep(500 + a * 500)
  }

  reservations.release(gameId)
  await deps.repos.games.update(gameId, { status: 'resolved' })
  return { refundTxid }
}

/**
 * Failsafe reconcile — the house's AUTO-protection. For every co-funded v4 game
 * that's still unresolved and whose cancelDelay has passed (the player never
 * revealed), broadcast the refund to split the pot back — pre-empting the
 * player's later forfeit. Best-effort per game (one failure can't block the
 * rest). Returns the refund txids broadcast this pass.
 */
export async function reconcileV4Refunds(deps: AppDeps): Promise<string[]> {
  // Gate on the CHAIN tip time, not Date.now() — the cooperativeSpend CLTV is
  // enforced against the chain's median-time-past, so this matches what arkd will
  // accept (and the regtest mock-time the recovery e2e advances). Same source as
  // the v3 escrow recovery's CLTV gate.
  const chainTime = (await deps.wallet.onchainProvider.getChainTip()).time
  const pending = await deps.repos.games.list({ status: 'pending', limit: 500 })
  const stalled = pending.filter((g) => g.player_choice === 'trustless-v4' && g.house_vtxos_json)
  const refundTxids: string[] = []
  for (const game of stalled) {
    let state: V4State
    try {
      state = JSON.parse(game.house_vtxos_json as string) as V4State
    } catch {
      continue
    }
    if (state.protocolVersion !== 'v4' || !state.cofundTxid) continue // not co-funded → nothing to refund
    if (chainTime <= state.covenant.cancelDelay) continue // CLTV not matured yet
    try {
      const { refundTxid } = await broadcastV4Refund(game.id, deps)
      console.log(`[v4-refund] reconciled stalled game ${game.id} → split-back ${refundTxid}`)
      refundTxids.push(refundTxid)
    } catch (e) {
      console.error(`[v4-refund] reconcile failed for ${game.id}:`, e instanceof Error ? e.message : e)
    }
  }
  return refundTxids
}

/**
 * Submit a built (covenant-only) joint-pot tx to the emulator (it co-signs +
 * forwards to arkd). Serialized via withArkSubmit + transient-retry, exactly like
 * the inline settle/refund posts. Returns the on-chain txid.
 */
async function submitBuiltToEmulator(built: BuiltJointPotTx, label: string): Promise<string> {
  const cfg = await loadEmulatorConfig()
  if (!cfg) throw new Error('Emulator not configured')
  const body = JSON.stringify(encodeSettleForEmulator(built))
  const postOnce = async (): Promise<{ ok: true; txid: string } | { ok: false; status: number; text: string }> => {
    const r = await fetch(`${cfg.url}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(25_000) })
    if (r.ok) return { ok: true, txid: Transaction.fromPSBT(base64.decode((await r.json() as { signedArkTx: string }).signedArkTx)).id }
    return { ok: false, status: r.status, text: await r.text() }
  }
  for (let a = 0; a < 10; a++) {
    const res = await withArkSubmit(postOnce)
    if (res.ok) return res.txid
    const transient = res.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(res.text)
    if (!transient || a === 9) throw new Error(`Emulator rejected ${label}: ${res.status} ${res.text}`)
    await sleep(500 + a * 500)
  }
  throw new Error(`Emulator ${label}: retries exhausted`)
}

/**
 * Extract the player's secret from the on-chain stage-1 reveal — the house's
 * defence when it never received /reveal (a losing player who skips it then sweeps
 * via takeAll). The preimage rides in the ConditionWitness PSBT field of one of
 * the StageTwo VTXO's ancestry txs; scan for the 17-byte element whose SHA256
 * equals the committed player hash. Returns undefined if not yet recoverable.
 */
async function extractPlayerSecretFromChain(indexer: RestIndexerProvider, stageTwoTxid: string, playerHashHex: string): Promise<Uint8Array | undefined> {
  const txids: string[] = [stageTwoTxid]
  try {
    const chain = await indexer.getVtxoChain({ txid: stageTwoTxid, vout: 0 })
    for (const c of chain.chain) if (!txids.includes(c.txid)) txids.push(c.txid)
  } catch { /* fall back to the StageTwo tx alone */ }
  for (const t of txids) {
    let raws: string[]
    try { raws = (await indexer.getVirtualTxs([t])).txs } catch { continue }
    for (const raw of raws) {
      let psbt: Transaction
      try { psbt = Transaction.fromPSBT(base64.decode(raw)) } catch { continue }
      for (let i = 0; i < psbt.inputsLength; i++) {
        const cw = getConditionWitness(psbt, i)
        if (cw) for (const el of cw) if (el.length === 17 && hashSecret(el) === playerHashHex) return el
      }
    }
  }
  return undefined
}

/**
 * Settle a CONTESTED game's StageTwo to the actual winner — the house's stage-2
 * response when a player revealed on-chain (pot -> StageTwo). The emulator
 * recomputes the winner from BOTH secrets, so the house can't cheat; settling
 * before finalExpiration pre-empts the player's takeAll. REQUIRED for fund-safety:
 * without it, a losing player who reveals on-chain would sweep the whole pot via
 * takeAll once finalExpiration passes.
 */
export async function settleV4StageTwo(gameId: string, deps: AppDeps): Promise<{ settleTxid: string; winner: 'player' | 'house' }> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error('Game not found')
  const state = JSON.parse(game.house_vtxos_json || '{}') as V4State
  if (state.protocolVersion !== 'v4') throw new Error('Not a v4 game')
  if (!state.cofundTxid) throw new Error('Pot not co-funded')
  if (game.status === 'resolved') throw new Error('Game already resolved')

  const pot = rebuildCovenant(state.covenant)
  const indexer = new RestIndexerProvider(ARK_SERVER_URL)
  const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(pot.stageTwo.pkScript)] })
  const hit = vtxos.find((v) => v.value === state.pot)
  if (!hit) throw new Error('No StageTwo VTXO — stage 1 not revealed, nothing to settle')
  const stageTwoOutpoint = { txid: hit.txid, vout: hit.vout, value: hit.value }

  // The player's secret: stored if /reveal reached us (fast path), else extracted
  // from the on-chain stage-1 reveal (the house may never have received /reveal).
  let playerSecret = game.player_secret_hex ? hex.decode(game.player_secret_hex) : undefined
  if (!playerSecret) playerSecret = await extractPlayerSecretFromChain(indexer, hit.txid, game.player_hash)
  if (!playerSecret) throw new Error('Cannot settle StageTwo: player secret not yet recoverable from the chain')
  const houseSecret = hex.decode(game.house_secret_hex)

  const creatorReveal = { digit: houseSecret[0], salt: houseSecret.slice(1) }
  const playerReveal = { digit: playerSecret[0], salt: playerSecret.slice(1) }
  const outcome = determineWinnerV3(creatorReveal, playerReveal, state.oddsN, state.oddsTarget, state.oddsLo)
  const winnerPayoutPkScript = hex.decode(outcome === 'player' ? state.covenant.playerPayoutPkScript : state.covenant.housePayoutPkScript)
  const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

  const settle = buildStageTwoSettleTx({
    stageTwo: pot.stageTwo, stageTwoOutpoint,
    winner: outcome, winnerPayoutPkScript, potAmount: BigInt(state.pot),
    playerRevealBytes: playerSecret, creatorRevealBytes: houseSecret, serverUnroll,
  })
  const settleTxid = await submitBuiltToEmulator(settle, 'stage-2 settle')

  const winner: 'player' | 'house' = outcome === 'player' ? 'player' : 'house'
  reservations.release(gameId)
  await deps.repos.games.update(gameId, {
    status: 'resolved', winner, payoutAmount: state.pot, playerSecretHex: hex.encode(playerSecret),
  })
  return { settleTxid, winner }
}

/**
 * Failsafe reconcile — the house's AUTO stage-2 response. For every co-funded v4
 * game whose pot has been spent into its StageTwo covenant (a player revealed
 * on-chain), settle StageTwo to the actual winner. Runs BEFORE reconcileV4Refunds
 * each tick (a revealed pot can't be refunded). Best-effort per game. Returns the
 * settle txids broadcast this pass.
 */
export async function reconcileV4StageTwo(deps: AppDeps): Promise<string[]> {
  const pending = await deps.repos.games.list({ status: 'pending', limit: 500 })
  const cofunded = pending.filter((g) => g.player_choice === 'trustless-v4' && g.house_vtxos_json)
  const indexer = new RestIndexerProvider(ARK_SERVER_URL)
  const settleTxids: string[] = []
  for (const game of cofunded) {
    let state: V4State
    try { state = JSON.parse(game.house_vtxos_json as string) as V4State } catch { continue }
    if (state.protocolVersion !== 'v4' || !state.cofundTxid) continue
    try {
      const pot = rebuildCovenant(state.covenant)
      const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(pot.stageTwo.pkScript)] })
      if (!vtxos.some((v) => v.value === state.pot)) continue // not revealed → nothing to settle
      const { settleTxid, winner } = await settleV4StageTwo(game.id, deps)
      console.log(`[v4-stage2] settled contested game ${game.id} to ${winner} → ${settleTxid}`)
      settleTxids.push(settleTxid)
    } catch (e) {
      console.error(`[v4-stage2] reconcile failed for ${game.id}:`, e instanceof Error ? e.message : e)
    }
  }
  return settleTxids
}

/**
 * Periodic v4 reconcile (mirrors startEscrowRecoveryTimer's cadence). Each tick:
 * (1) settle CONTESTED games (pot revealed into StageTwo) to the winner, then
 * (2) refund never-revealed games past cancelDelay. Order matters — a revealed pot
 * can't be refunded, so stage-2 settle runs first.
 */
export function startV4RefundTimer(deps: AppDeps, intervalMs = 120_000): NodeJS.Timeout {
  const tick = async () => {
    const settled = await reconcileV4StageTwo(deps).catch((e) => {
      console.error('[v4-stage2] tick failed:', e instanceof Error ? e.message : e)
      return [] as string[]
    })
    if (settled.length > 0) console.log(`[v4-stage2] settled ${settled.length} contested game(s)`)
    const txids = await reconcileV4Refunds(deps).catch((e) => {
      console.error('[v4-refund] tick failed:', e instanceof Error ? e.message : e)
      return [] as string[]
    })
    if (txids.length > 0) console.log(`[v4-refund] reconciled ${txids.length} stalled game(s)`)
  }
  setTimeout(tick, 7_000)
  return setInterval(tick, intervalMs)
}
