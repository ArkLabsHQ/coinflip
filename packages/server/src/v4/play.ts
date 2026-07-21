/**
 * v4 joint-pot game — the /play endpoint plus the game-creation helpers (protocol
 * version selector, odds/tier config, and the terminal-roll display helper).
 *
 * handleV4Play reserves a house stake VTXO, derives the joint-pot covenant,
 * persists the game, and returns the covenant params for the client to co-fund.
 * No signing happens here; the co-fund is the next handshake step (see cofund.ts).
 */

import { hex } from '@scure/base'
import { ArkAddress, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import {
  CoinflipJointPotScript, commitDigit, randomUniformInt, computeRollV3,
  serializeTapLeaf, tapLeafHasKey, foldSubDustStake,
  type SerializedHouseInput,
} from 'arkade-coinflip'
import { packets } from '@arklabshq/contract-workflows-prototype'
import { v4 as uuidv4 } from 'uuid'
import { hashSecret, networkHrpFromArkInfo } from '../house-wallet.js'
import { reservations, selectionMutex, outpointKey, houseVtxoCache, HouseBusyError, BetExceedsCapacityError } from '../vtxo-pool.js'
import { loadEmulatorConfig } from '../emulator.js'
import { computeHouseStake } from '../house-economics.js'
import type { AppDeps } from '../deps.js'
import { toXOnly } from './shared.js'
import type { V4PlayRequest, V4PlayResult, V4CovenantParams, V4State } from './types.js'

/** The coin (no client odds) maps to n=2,target=1,lo=0 — player wins iff roll==0. */
const COIN_ODDS = { oddsN: 2, oddsTarget: 1, oddsLo: 0 } as const

/**
 * The display roll for a terminal v3/v4 game — `(digitHouse + digitPlayer) mod n`,
 * or null when a secret is missing/malformed/out-of-range (a cheat-penalty
 * decided the winner, not a fair roll). Reveals are `[digit] || salt`
 * (packets.encodeReveal), so byte 0 is the digit; the coin (no client odds)
 * maps to n=2. v2 encoded the digit in the reveal LENGTH — no roll here. This
 * mirrors the reveal-time computation in handleV4Reveal so /details can echo
 * the same value from the persisted secrets.
 */
export function computeGameRoll(
  houseSecretHex: string | null,
  playerSecretHex: string | null,
  oddsN: number | null,
): number | null {
  if (!houseSecretHex || !playerSecretHex) return null
  try {
    const hs = hex.decode(houseSecretHex)
    const ps = hex.decode(playerSecretHex)
    return computeRollV3(
      { digit: hs[0], salt: hs.slice(1) },
      { digit: ps[0], salt: ps.slice(1) },
      oddsN ?? COIN_ODDS.oddsN,
    )
  } catch {
    return null
  }
}

/**
 * Which protocol NEW games use — 'v4' (joint pot, the default) or 'v3'
 * (per-party escrow). v0.4 is the default; set PROTOCOL_VERSION=v3 to fall back
 * to the per-party-escrow flow. The client reads the result from /api/network
 * and routes to /api/v4 (or the v3 commit flow) accordingly.
 */
export function newGameProtocolVersion(): 'v3' | 'v4' {
  return (process.env.PROTOCOL_VERSION ?? 'v4').trim().toLowerCase() === 'v3' ? 'v3' : 'v4'
}

async function getTiers(deps: AppDeps): Promise<number[]> {
  return JSON.parse((await deps.repos.config.get('tiers')) || '[1000,5000,10000,50000]')
}
async function getOddsEdgeBps(deps: AppDeps): Promise<number> {
  return parseInt((await deps.repos.config.get('variable_odds_edge_bps')) || '300', 10)
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

  // House stake: (folded) player stake for the coin, a house-edged multiple for
  // variable odds. Both scale with the player stake, so folding keeps the game fair.
  const dust = Number(deps.arkInfo.dust ?? 546n)
  // Fold a sub-dust player-change "top-up" into the stake. The client sends topUp
  // when its VTXOs would leave a change ≤ dust — a dust output can't exist, so the
  // remainder MUST be staked or the co-fund can't balance (input != output). All of
  // pot/houseStake/refund key off playerStake, so the game stays fair at the player's
  // ACTUAL contribution. Guarded to (0, dust] so a client can't inflate the stake.
  const stakeTopUp = req.stakeTopUp ?? 0
  if (stakeTopUp !== 0 && (!Number.isInteger(stakeTopUp) || stakeTopUp < 0 || stakeTopUp > dust)) {
    throw new Error(`Invalid stakeTopUp ${stakeTopUp}: must be an integer in (0, ${dust}]`)
  }
  const playerStake = req.tier + stakeTopUp
  const isVariable = req.oddsN !== undefined && req.oddsTarget !== undefined
  let houseStake = playerStake
  let odds: { oddsN: number; oddsTarget: number; oddsLo: number } = { ...COIN_ODDS }
  if (isVariable) {
    const n = req.oddsN as number, target = req.oddsTarget as number, lo = req.oddsLo ?? 0
    if (!Number.isInteger(n) || n < 2 || !Number.isInteger(target) || !Number.isInteger(lo) || lo < 0 || target <= lo || target > n) {
      throw new Error(`Invalid odds: need oddsN>=2 and 0<=oddsLo<oddsTarget<=oddsN (got n=${n}, target=${target}, lo=${lo})`)
    }
    houseStake = computeHouseStake(playerStake, n, target, lo, await getOddsEdgeBps(deps))
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

  const gameId = uuidv4()

  // Reserve enough SPECIFIC house stake VTXOs to cover houseStake (one or many).
  // Unlike v3's liability-only reservation, v4 pins the exact outpoints the
  // co-fund spends. Greedy largest-first keeps the input count small; the house
  // change (Hsum − houseStake) returns to the house in the co-fund.
  let houseInputs: SerializedHouseInput[] = []
  // Fetch the house VTXO set BEFORE taking the selection lock so concurrent /play
  // calls collapse onto ONE inflight getVtxos() (HouseVtxoCache.refresh de-dupes by
  // inflight promise). Under the lock this fetch serializes — N cold plays = N
  // sequential ≤45s syncs and the collapse never fires. Still a FRESH fetch (not the
  // cached get()): v4 pins exact outpoints. Fetching pre-lock only grows the staleness
  // window, which stays safe by construction (vtxo-pool.ts): the under-lock isReserved
  // re-check excludes a coin another game just reserved, and a coin spent before the
  // co-fund only fails the escrow submit (caught + retried), never a double-spend.
  const vtxos = await houseVtxoCache.refresh(deps)
  await selectionMutex.runExclusive(async () => {
    const choose = (vtxos: ExtendedVirtualCoin[]): ExtendedVirtualCoin[] | null => {
      const free = vtxos
        .filter((v) => settledOrPre(v) && !reservations.isReserved(outpointKey(v.txid, v.vout)))
        .sort((a, b) => b.value - a.value)
      // Only contribute coins the HOUSE can actually co-sign. A coin whose forfeit
      // leaf doesn't carry the CURRENT house key (e.g. a prior-payout coin that landed
      // in the pool owned by another key) is unsignable, so arkd rejects the whole
      // co-fund at finalize with INVALID_SIGNATURE. Skip it (and log — it's stuck, needs recovery).
      const signable = free.filter((v) => tapLeafHasKey(v.forfeitTapLeafScript, housePubkey))
      if (signable.length < free.length) {
        const stuck = free.filter((v) => !tapLeafHasKey(v.forfeitTapLeafScript, housePubkey))
        console.warn(
          `[v4/play] skipping ${stuck.length} house VTXO(s) the current key can't co-sign ` +
          `(stuck funds, needs recovery): ${stuck.map((v) => outpointKey(v.txid, v.vout)).join(', ')}`,
        )
      }
      const picked: ExtendedVirtualCoin[] = []
      let sum = 0
      for (const v of signable) {
        if (sum >= houseStake) break
        picked.push(v)
        sum += v.value
      }
      return sum >= houseStake ? picked : null
    }
    const picked = choose(vtxos)
    if (!picked) {
      const freeTotal = vtxos
        .filter((v) => settledOrPre(v) && !reservations.isReserved(outpointKey(v.txid, v.vout)))
        .reduce((s, v) => s + v.value, 0)
      if (freeTotal < houseStake) throw new BetExceedsCapacityError(`Bet exceeds house capacity: needs ${houseStake} sat, free house balance is ${freeTotal}.`)
      throw new HouseBusyError('House is busy (insufficient free stake VTXOs). Try again shortly.')
    }
    // Fold a sub-dust house-change overshoot into the stake (the house-side twin of the
    // player's stakeTopUp fold). The reserved coins sum to Hsum ≥ houseStake; if the change
    // (Hsum − houseStake) is ≤ dust it can't be its own output, and DROPPING it unbalances
    // the co-fund (arkd: "input amount is not equal to output amount"). Staking the whole
    // coin — the pot grows to match — keeps it balanced; bounded by dust, so the house
    // over-stakes ≤ dust sat. MUST precede the pot/covenant build below.
    const Hsum = picked.reduce((s, v) => s + v.value, 0)
    houseStake = foldSubDustStake(houseStake, Hsum, dust)
    houseInputs = picked.map((v) => ({
      txid: v.txid, vout: v.vout, value: v.value,
      leaf: serializeTapLeaf(v.forfeitTapLeafScript), tapTree: hex.encode(v.tapTree),
    }))
    reservations.reserve(gameId, picked.map((v) => outpointKey(v.txid, v.vout)), houseStake)
  })
  if (houseInputs.length === 0) throw new HouseBusyError('House is busy. Try again shortly.')

  // Pot + covenant are derived AFTER the fold so the covenant embeds the (possibly
  // folded) houseStake and output 0 matches the agreed pot in Guard 1.
  const pot = playerStake + houseStake
  const covenantScript = new CoinflipJointPotScript({
    creatorPubkey: housePubkey, playerPubkey, serverPubkey,
    creatorHash: houseHashBytes, playerHash: playerHashBytes,
    finalExpiration: BigInt(finalExpiration), cancelDelay: BigInt(cancelDelay), exitDelay: BigInt(exitDelay),
    oddsN: odds.oddsN, oddsTarget: odds.oddsTarget, oddsLo: odds.oddsLo,
    emulatorPubkey: emulator.signerPubkey,
    playerPayoutPkScript, housePayoutPkScript,
    playerStake: BigInt(playerStake), houseStake: BigInt(houseStake),
  })
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)
  const potAddress = covenantScript.address(networkHrp, serverPubkey).encode()

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
    playerStake, houseStake,
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
