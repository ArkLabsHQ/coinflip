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

import { hex } from '@scure/base'
import { ArkAddress, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import { CoinflipJointPotScript, commitDigit, randomUniformInt } from 'arkade-coinflip'
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
    reservations.reserve(gameId, [outpointKey(candidate.txid, candidate.vout)], houseStake)
  })
  if (!houseVtxo) throw new HouseBusyError('House is busy. Try again shortly.')

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
    houseVtxo, housePubkey: hex.encode(housePubkey), houseHash,
    serverPubkey: hex.encode(serverPubkey), emulatorPubkey: hex.encode(emulator.signerPubkey),
    finalExpiration, oddsN: odds.oddsN, oddsTarget: odds.oddsTarget, oddsLo: odds.oddsLo,
    covenant,
  }
}
