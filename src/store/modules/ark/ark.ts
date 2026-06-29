import { Module } from 'vuex'
import { hex, base64 } from '@scure/base'
import type { State as RootState } from '@/store'
import {
  Wallet, SingleKey, VtxoScript,
  ConditionWitness, setArkPsbtField, Transaction, ArkAddress,
  contractHandlers, RestIndexerProvider, decodeTapscript, CSVMultisigTapscript,
  type WalletBalance, type ExtendedVirtualCoin, type ArkProvider, type Identity, type ArkTxInput,
} from '@arkade-os/sdk'
import {
  COINFLIP_ESCROW_TYPE,
  COINFLIP_ESCROW_V3_TYPE,
  registerCoinflipContracts,
} from 'arkade-coinflip/contract'
import { commitDigit as v3CommitDigit } from 'arkade-coinflip/dist/arkade-win'
// Subpath import (not the package root) so the browser bundle doesn't pull in
// the v2 transactions module, which imports Node's `crypto`.
import { buildCofundFromPlay, buildPlayerRevealTx, buildStageTwoTakeAllTx } from 'arkade-coinflip/dist/joint-pot-tx'
import { CoinflipJointPotScript } from 'arkade-coinflip/dist/joint-pot'
import { packets as cwpPackets } from '@arklabshq/contract-workflows-prototype'
import { initSwaps, destroySwaps } from '@/services/boltz'
import { singleFlight } from '@/utils/singleFlight'
import {
  getNetwork, play as apiPlay, commit as apiCommit, refund as apiRefund,
  forfeit as apiForfeit, getGame as apiGetGame,
  v4Play, v4Cofund, v4CofundFinalize, v4Reveal,
  getRestoreChallenge, restoreGamesFromServer,
  type Outpoint, type ForfeitResponse, type V4CovenantParams,
  type GameSummary, type V4ReclaimHint,
} from '@/services/api'
import { signChallenge } from '@/utils/signChallenge'
import { resolveForfeitStash, hasStashedForfeit } from './forfeitStash'
import { resolveV4ForfeitStash, hasClaimableV4Forfeit, v4ClaimStage, type V4PotOutpoint, type StashedV4Forfeit } from './v4ForfeitStash'
import { putV4Forfeit, deleteV4Forfeit, loadV4Forfeits } from './v4ForfeitStashStore'
import { locateEscrowVtxo } from './locateEscrow'
import { createHash } from '@/utils/crypto'
import { upgradeEsploraUrl } from '@/utils/esploraUrl'
import { getErrorMessage } from '@/utils/errors'
import { isCltvMatured } from '@/utils/cltv'
import {
  buildActivities,
  boardingResolver,
  gameActivityResolver,
  type Activity,
  type CoinflipGameRecord,
} from '@/utils/activityHistory'

/** VtxoInput shape expected by the server's /api/play endpoint. */
export interface VtxoInput {
  vtxo: {
    outpoint: { txid: string; vout: number }
    amount: string
    tapscripts: string[]
  }
  leaf: string
}

/**
 * Convert an SDK VTXO into the lib's VtxoInput shape. Mirrors
 * `vtxoToInput` in packages/server/src/game-engine.ts — see that file for
 * the gory tap-tree / leaf-version notes.
 */
function vtxoToPlayerInput(v: ExtendedVirtualCoin): VtxoInput {
  const fullScript = VtxoScript.decode(v.tapTree)
  const tapscripts = fullScript.scripts.map((s) => hex.encode(s))
  const forfeitScript = v.forfeitTapLeafScript[1].slice(0, -1)
  return {
    vtxo: {
      outpoint: { txid: v.txid, vout: v.vout },
      amount: v.value.toString(),
      tapscripts,
    },
    leaf: hex.encode(forfeitScript),
  }
}

/**
 * Cryptographically-uniform integer in `[0, n)` via `crypto.getRandomValues`
 * (CSPRNG) with rejection sampling. The variable-odds digit the player picks is
 * encoded into its revealed secret length, so a `Math.random()`-derived digit
 * would leak the non-crypto PRNG's state across games and let an observer
 * predict the next pick. Mirrors the lib's server-side `randomUniformInt`.
 */
function uniformRandomInt(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`uniformRandomInt: n must be a positive integer (got ${n})`)
  if (n === 1) return 0
  const bytes = Math.ceil(Math.log2(n) / 8) || 1
  const max = 256 ** bytes
  const limit = max - (max % n)
  const buf = new Uint8Array(bytes)
  for (;;) {
    crypto.getRandomValues(buf)
    let x = 0
    for (const b of buf) x = x * 256 + b
    if (x < limit) return x % n
  }
}

/**
 * Stalled-bet refunds. When the player escrows a stake we immediately fetch the
 * server-built refund tx and persist it locally — BEFORE revealing/committing.
 * If the server then stalls (or the tab closes mid-game), the player still holds
 * a self-submittable refund and can reclaim the stake after the CLTV with no
 * trust in the server. The stash is cleared once the game resolves.
 */
export interface StashedRefund {
  gameId: string
  tier: number
  playerEscrow: Outpoint
  refundPsbt: string
  refundCheckpoints: string[]
  finalExpiration: number
  createdAt: number
  /** Arkade-script forfeit-claim PSBT. Submitted to the EMULATOR's /v1/tx
   *  (not arkd directly) — the emulator validates the covenant + cosigns
   *  the tweaked slot, then forwards to arkd. */
  forfeitPsbt?: string
  forfeitCheckpoints?: string[]
  /** Absolute CLTV (unix seconds) baked into the playerForfeit leaf —
   *  forfeit becomes claimable once chain time crosses this. */
  forfeitClaimableAt?: number
  /** Emulator base URL the client posts the forfeit PSBT to. */
  forfeitEmulatorUrl?: string
  /** Set true once the player has actually called /commit (revealed their
   * secret). Gates penalty (revealer-takes-all) vs self-refund (own stake).
   * If the player never revealed, only the self-refund applies. */
  revealed?: boolean
  /** Player's secret in hex — required as the condition witness when claiming
   * the penalty. Stored ONLY in the stash, never sent off-device. */
  playerSecretHex?: string
  /**
   * Serialized params of the PLAYER escrow's `coinflip-escrow` contract (from
   * /api/play). Persisted so a page reload can RE-REGISTER the escrow with the
   * SDK ContractManager and re-arm the watcher that clears this stash on the
   * sweep's `vtxo_spent`. */
  escrowContractParams?: Record<string, string>
  /** The player escrow's Ark address — its pkScript is the contract's key
   *  (and what we deactivate when the bet is done). */
  escrowAddress?: string
  /**
   * Contract version used by this game. 'v2' is the legacy length-encoded
   * predicate; 'v3' uses the arkade-script + packet-borne reveals shape.
   * Undefined means v2 (forward-compat with stashes written before this field).
   * Drives which SDK contract handler type the ContractWatcher registers.
   */
  contractVersion?: 'v2' | 'v3'
  /**
   * v3 only — the player's commit (digit + salt). Salt stored hex-encoded for
   * JSON serializability. Stored ONLY in the stash; never sent off-device
   * except as the /commit payload at reveal time.
   */
  reveal?: { digit: number; salt: string }
  /**
   * Count of consecutive PERMANENT auto-claim failures (a witness-utxo script
   * mismatch — the stashed refund no longer matches the Service's VTXO, e.g. a
   * pre-v4 or rotated-signer escrow). Auto-claim backs off once this reaches
   * MAX_RECLAIM_ATTEMPTS; the stake still recovers via the operator sweep.
   * Transient (network / CLTV-timing) failures do NOT increment it.
   */
  claimFailures?: number
  /** Last permanent auto-claim error message, for surfacing in the UI. */
  lastClaimError?: string
}

// Stash backend moved to IndexedDB via @/utils/stashStore. The shape and
// reducer semantics are unchanged from the prior localStorage version;
// these thin re-exports keep the call-site names familiar.
import {
  loadStashes as loadRefunds,
  putStash as stashRefund,
  deleteStash as clearRefund,
  patchStash as updateRefundStash,
} from '@/utils/stashStore'
import { isPermanentReclaimError, hasExhaustedReclaim } from '@/utils/reclaimBackoff'

export interface ArkServerInfo {
  pubkey: string
  network: string
  dust: string
  unilateralExitDelay: string
  boardingExitDelay?: string
  sessionDuration?: string
}

export interface ArkVTXO {
  outpoint: {
    txid: string
    vout: number
  }
  redeemTx?: string
  amount: string
  tapscripts: string[]
  isPreconfirmed?: boolean
}

export interface BoardingUtxo {
  outpoint: { txid: string; vout: number }
  amount: string
  confirmations?: number
}

/**
 * Per-game in-flight claim. Set when either the manual button or the
 * background auto-claim poll starts a forfeit/refund submission; cleared
 * in the `finally` of the same action so a failure doesn't strand the
 * lock. `mode` lets the UI distinguish "Auto-claiming…" from a click in
 * progress.
 */
export type ClaimKind = 'forfeit' | 'refund'
export type ClaimMode = 'manual' | 'auto'
export interface ClaimingInfo { kind: ClaimKind; mode: ClaimMode }

export interface TxHistoryEntry {
  /** Best txid we have — arkTxid first, then commitment, then boarding. */
  txid: string
  /** 'SENT' | 'RECEIVED' */
  type: string
  /** Net sats moved by this tx (positive for received, positive for sent — direction in `type`). */
  amount: number
  settled: boolean
  /** Unix ms */
  createdAt: number
  /** True if this entry corresponds to a boarding deposit. */
  isBoarding: boolean
}

interface ArkState {
  server: string
  esplora: string
  networkPreset: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  lastError: Error | null
  info: ArkServerInfo | null
  vtxos: ArkVTXO[]
  boardingUtxos: BoardingUtxo[]
  walletBalance: WalletBalance | null
  arkAddress: string | null
  boardingAddress: string | null
  txHistory: TxHistoryEntry[]
  /** Grouped activity view of txHistory (local engine; see utils/activityHistory). */
  activityHistory: Activity[]
  claimingGames: Record<string, ClaimingInfo>
}

/**
 * Network presets. Only the Ark server URL is strictly required — the SDK
 * derives the network from the server's /v1/info, then auto-defaults esplora
 * (ESPLORA_URL[network]) and the Boltz API (BASE_URLS[network]) when those are
 * left empty. So mutinynet just needs the server URL; regtest pins all three
 * at localhost.
 */
export interface NetworkPreset {
  label: string
  server: string
  /** Empty string → let the SDK auto-default from the detected network. */
  esplora: string
  /** Empty string → let boltz-swap auto-default from the detected network. */
  boltz: string
}

/**
 * Same-origin host for regtest defaults. When the page is loaded from
 * `localhost`, fall back to `localhost`; when it's loaded from a LAN IP
 * (phone on the same wifi hitting `http://192.168.x.x:8080`), use that
 * IP so arkd / esplora / emulator (all bound to 0.0.0.0 on the host)
 * remain reachable.
 */
function regtestHost(): string {
  if (typeof window === 'undefined') return 'localhost'
  return window.location.hostname || 'localhost'
}

/**
 * One-time migration: a browser that cached the pre-denigiri regtest esplora
 * URL holds a bare `http://<host>:3000`, which on the new stack is the mempool
 * web UI (HTML), not the Esplora REST API (now under `/api`). The `|| fallback`
 * default only applies when the key is ABSENT, so a cached bad value would
 * survive — and `syncNetworkFromServer` only re-applies the preset when the
 * network CHANGES, which it doesn't for an existing regtest user. Rewrite the
 * known-bad shape in place so the SDK's esplora calls hit JSON, not HTML.
 */
function migrateCachedEsploraUrl(): void {
  if (typeof window === 'undefined') return
  try {
    const cached = localStorage.getItem('ark_esplora')
    const upgraded = upgradeEsploraUrl(cached)
    if (upgraded && upgraded !== cached) localStorage.setItem('ark_esplora', upgraded)
  } catch {
    /* private mode / storage disabled — nothing to migrate */
  }
}
migrateCachedEsploraUrl()

export const NETWORK_PRESETS: Record<string, NetworkPreset> = {
  regtest: {
    label: 'Regtest (local)',
    server: `http://${regtestHost()}:7070`,
    // The arkade-regtest (denigiri) stack serves the Esplora REST API
    // under the mempool service's `/api` prefix on :3000 — the bare root
    // is the mempool web UI (HTML), not the REST API. Omitting `/api`
    // makes the SDK's esplora calls return HTML and fail to parse.
    esplora: `http://${regtestHost()}:3000/api`,
    boltz: `http://${regtestHost()}:9069`,
  },
  mutinynet: {
    label: 'Mutinynet',
    server: 'https://mutinynet.arkade.sh',
    esplora: '',
    boltz: '',
  },
}

/**
 * Single-party offchain submit: sign `signInputs` on the ark tx + every
 * checkpoint with `identity`, optionally attaching a condition witness (revealed
 * secrets) to the signed inputs. arkd co-signs the server leg. Mirrors the
 * server's submitOffchain (both proven by the regtest e2e). SDK-only, so it
 * bundles for the browser (the lib's tx-builders are Node-crypto bound).
 */
async function submitOffchain(
  arkProvider: ArkProvider,
  identity: Identity,
  arkTx: Transaction,
  checkpoints: Transaction[],
  signInputs: number[],
  witness?: Uint8Array[],
): Promise<string> {
  if (witness) for (const i of signInputs) setArkPsbtField(arkTx, i, ConditionWitness, witness)
  const signed = await identity.sign(arkTx, signInputs)
  const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(signed.toPSBT()),
    checkpoints.map((c) => base64.encode(c.toPSBT())),
  )
  const finals: string[] = []
  for (const c of signedCheckpointTxs) {
    const tx = Transaction.fromPSBT(base64.decode(c))
    const idx: number[] = []
    for (let i = 0; i < tx.inputsLength; i++) idx.push(i)
    if (witness) for (const i of idx) setArkPsbtField(tx, i, ConditionWitness, witness)
    finals.push(base64.encode((await identity.sign(tx, idx)).toPSBT()))
  }
  await arkProvider.finalizeTx(arkTxid, finals)
  return arkTxid
}

// SDK wallet instance (kept outside Vuex state to avoid reactivity issues with complex objects)
let sdkWallet: Wallet | null = null
// Run at most ONE boarding-settle round at a time. settlementConfig is false (see
// Wallet.create), so the client settles boarding itself — from BOTH the auto-settle
// in refreshBalance AND the manual `settle` action. Two concurrent sdkWallet.settle()
// calls register competing intents for the same boarding UTXO; arkd settles one and
// the other hangs forever (the button awaiting it never clears). singleFlight funnels
// both through one round so a second caller reuses it instead of racing.
const settleOnce = singleFlight((eventCallback?: (event: unknown) => void): Promise<string> => {
  const w = sdkWallet
  if (!w) return Promise.reject(new Error('Wallet not connected'))
  return w.settle(undefined, eventCallback as never)
})
// Auto-reconnect backoff: a failed connect (slow load, arkd blip, reconnect
// after a redeploy) schedules a retry with capped exponential backoff so the
// client heals itself instead of stranding the user on "not connected".
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
// Background poller that auto-fires stalled-bet claims once their CLTV
// matures. Lives only while the wallet is connected and the tab is open
// — see startAutoClaim / stopAutoClaim. Manual claims via StalledBets
// stay available and the two paths share the same `claimingGames` lock
// so a click during a background tick (or vice versa) can't double-spend.
let autoClaimTimer: ReturnType<typeof setInterval> | null = null
const AUTO_CLAIM_INTERVAL_MS = 15_000
// Stop fn for the SDK's incoming-funds watcher: one SSE stream over the
// wallet's active contracts + the SDK's own 60s failsafe poll. Push-based
// balance updates replace our manual refreshBalance polling.
let incomingFundsStop: (() => void) | null = null
// Stop fn for the coinflip-escrow contract-event subscription. The
// ContractManager fires `vtxo_spent` for a player escrow the instant the
// atomic sweep settles (house OR player win — both spend both escrows), so we
// clear the stalled-bet stash + refresh eagerly. The SDK's ContractWatcher
// carries its own 60s failsafe poll + auto-reconnect, so no separate getGame
// poll is needed. Lives only while the wallet is connected (see connect wiring
// and the disconnect cleanup, like incomingFundsStop).
let escrowEventStop: (() => void) | null = null
// Coalesce watcher-driven refreshes. A single settlement (e.g. a game's sweep)
// emits several vtxo_spent / vtxo_received events spread over a few seconds; a
// naive per-event refresh hammers the indexer. Leading edge fires immediately
// (snappy first update), then we collapse the rest of the burst into one
// trailing refresh after it goes quiet, capped at REFRESH_MAX_WAIT_MS so a long
// burst still updates periodically. All of these are LIGHT refreshes (balance
// only — see refreshBalance({ light })).
const REFRESH_QUIET_MS = 1200
const REFRESH_MAX_WAIT_MS = 2500
let refreshTrailing: ReturnType<typeof setTimeout> | null = null
let refreshMaxWait: ReturnType<typeof setTimeout> | null = null
let refreshQuiet = true
function scheduleRefresh(dispatch: (type: string, payload?: unknown) => Promise<unknown>): void {
  const fireLight = () => { dispatch('refreshBalance', { light: true }).catch(() => { /* transient */ }) }
  const flush = () => {
    if (refreshTrailing) { clearTimeout(refreshTrailing); refreshTrailing = null }
    if (refreshMaxWait) { clearTimeout(refreshMaxWait); refreshMaxWait = null }
    refreshQuiet = true
    fireLight()
  }
  if (refreshQuiet) { refreshQuiet = false; fireLight() } // leading edge — immediate
  if (refreshTrailing) clearTimeout(refreshTrailing)
  refreshTrailing = setTimeout(flush, REFRESH_QUIET_MS) // trailing once the burst goes quiet
  if (!refreshMaxWait) refreshMaxWait = setTimeout(flush, REFRESH_MAX_WAIT_MS) // cap for long bursts
}

export function getSDKWallet(): Wallet | null {
  return sdkWallet
}

/**
 * Register a player escrow as an ACTIVE `coinflip-escrow` contract so the SDK
 * ContractManager/ContractWatcher tracks it and emits `vtxo_spent` when the
 * atomic sweep settles. The serialized params (from /api/play) reproduce the
 * exact on-chain script; we pass the pkScript derived from the escrow address
 * as the contract key so the watcher matches the real VTXO. Labelled with the
 * gameId so the event handler can clear the right stash.
 *
 * Idempotent: a duplicate re-register (e.g. on reload) is swallowed. Entirely
 * best-effort — a failure here must NOT break play or the refund/forfeit safety
 * net; the stash + auto-claim still cover a stalled game.
 */
async function registerEscrowContract(stash: StashedRefund): Promise<void> {
  if (!sdkWallet || !stash.escrowContractParams || !stash.escrowAddress) return
  try {
    const cm = await sdkWallet.getContractManager()
    await cm.createContract({
      type: stash.contractVersion === 'v3' ? COINFLIP_ESCROW_V3_TYPE : COINFLIP_ESCROW_TYPE,
      params: stash.escrowContractParams,
      script: addressToPkScriptHex(stash.escrowAddress),
      address: stash.escrowAddress,
      state: 'active',
      label: stash.gameId,
    })
  } catch (e) {
    const msg = getErrorMessage(e)
    if (/already exists|duplicate/i.test(msg)) return // re-register is fine
    console.warn('[contract] could not register player escrow (continuing):', msg)
  }
}

/**
 * Best-effort R1 forfeit recovery, attempted ONLY after a `/commit` failure.
 *
 * Why here, why now: the joint pot the forfeit leaf sweeps exists only once the
 * house has escrowed, which — under lazy funding (v0.3.5+) — happens at the
 * START of `/commit`, before the covenant sweep. So a FAILED `/commit` is the
 * single window in which a funded-but-unswept pot can linger; that is exactly
 * the state the arkade-script `playerForfeit` leaf recovers. We probe
 * `/forfeit`: the server returns a claim PSBT iff that pot exists, otherwise it
 * refuses (surfaced here as an undefined `forfeit`) and the player still has the
 * self-refund stash for their own stake.
 *
 * The security decision — emulator present? pot present? payout bound to OUR
 * change address? — lives in the pure, unit-tested `resolveForfeitStash`; this
 * wrapper is only the network/storage glue around it. It NEVER throws: a forfeit
 * that can't be stashed must not disturb the "still settling" path that follows.
 */
async function stashForfeitRecovery(
  gameId: string,
  playerEscrow: Outpoint,
  expectedPayoutAddress: string,
  playerSecretHex: string,
): Promise<void> {
  let emulatorUrl: string | undefined
  let forfeit: ForfeitResponse | undefined
  try {
    const net = await getNetwork()
    emulatorUrl = net.emulator?.url
    // Only probe the server when an emulator exists — without the covenant
    // co-signer the forfeit leaf is unspendable, so the call would be wasted.
    if (emulatorUrl) {
      try {
        forfeit = await apiForfeit(gameId, playerEscrow)
      } catch (e) {
        // Expected whenever there is no joint pot yet (house never funded), the
        // game already resolved, or it is a legacy non-arkade game. Not an error:
        // `resolveForfeitStash` maps the undefined `forfeit` to a 'no-pot' skip.
        console.warn('[trustless] /forfeit probe found no claimable pot (continuing):', getErrorMessage(e))
      }
    }
  } catch (e) {
    console.warn('[trustless] could not reach /api/network for forfeit (continuing):', getErrorMessage(e))
  }

  const decision = resolveForfeitStash({ emulatorUrl, forfeit, expectedPayoutAddress, playerSecretHex })
  if (decision.kind === 'stash') {
    await updateRefundStash(gameId, decision.patch)
  } else {
    console.warn(`[trustless] forfeit not stashed (${decision.reason})`)
  }
}

/**
 * v0.4 analogue of `stashForfeitRecovery`. After the joint pot is co-funded,
 * persist everything the client needs to reclaim it via the `playerForfeit`
 * leaf should the server never settle. The claim is CLIENT-built from the
 * covenant params, so all we need is the pot outpoint + covenant + the emulator
 * URL — captured by the caller BEFORE the co-fund (playV4Game aborts pre-funding
 * when it's absent). Crucially this does NOT re-fetch /api/network: that
 * redundant fetch could fail transiently and, for v4 where the stash is the
 * ONLY recovery (no v3-style self-refund), silently drop recovery for an
 * already-funded pot. So a skip/write failure here is logged LOUDLY — but we
 * still proceed to reveal, which on success makes the stash moot anyway.
 */
async function stashV4ForfeitRecovery(args: {
  gameId: string
  tier: number
  potOutpoint: V4PotOutpoint
  covenant: V4CovenantParams
  expectedPayoutPkScriptHex: string
  playerSecretHex: string
  emulatorUrl: string | undefined
}): Promise<void> {
  const decision = resolveV4ForfeitStash({
    emulatorUrl: args.emulatorUrl,
    potOutpoint: args.potOutpoint,
    covenant: args.covenant,
    expectedPayoutPkScriptHex: args.expectedPayoutPkScriptHex,
    playerSecretHex: args.playerSecretHex,
  })
  if (decision.kind === 'stash') {
    try {
      await putV4Forfeit({
        ...decision.patch,
        gameId: args.gameId,
        tier: args.tier,
        createdAt: Date.now(), // ms, matches the listStalledBets grace cutoff
      })
    } catch (e) {
      console.error('[v4] CRITICAL: pot is funded but the recovery stash could not be written:', getErrorMessage(e))
    }
  } else {
    console.error(`[v4] CRITICAL: forfeit not stashed for a funded pot (${decision.reason})`)
  }
}

/**
 * Best-effort: mark a finished bet's player-escrow contract `inactive` so the
 * ContractWatcher stops watching it ("bet done → deactivate"). No-op when the
 * stash lacks an escrow address or the ContractManager is unavailable; never
 * throws.
 */
async function deactivateEscrowContract(stash: StashedRefund | undefined): Promise<void> {
  if (!sdkWallet || !stash?.escrowAddress) return
  try {
    const cm = await sdkWallet.getContractManager()
    await cm.setContractState(addressToPkScriptHex(stash.escrowAddress), 'inactive')
  } catch (e) {
    console.warn('[contract] could not deactivate player escrow (continuing):', getErrorMessage(e))
  }
}

/** Address → pkScript hex — the dense `ArkAddress.decode(...).pkScript` chain,
 *  named once so its three call sites read as intent, not bit-twiddling. */
function addressToPkScriptHex(address: string): string {
  return hex.encode(ArkAddress.decode(address).pkScript)
}

/** Load the stashed refund for a game, if any. The stash is the trustless
 *  backstop; several actions look it up by the same `gameId` find. */
async function getRefundStash(gameId: string): Promise<StashedRefund | undefined> {
  return (await loadRefunds()).find((x) => x.gameId === gameId)
}

/**
 * A bet is finished — resolved on the happy path, or claimed/reclaimed on a
 * stall: drop its stash AND stop the ContractWatcher watching its escrow. Both
 * steps are best-effort and must always run together, so they live here rather
 * than being re-paired at four call sites.
 */
async function finishBet(gameId: string, stash: StashedRefund | undefined): Promise<void> {
  await clearRefund(gameId)
  await deactivateEscrowContract(stash)
}

/**
 * Assert the wallet is connected AND the private key is available — the guard
 * every signing action (play / reclaim / forfeit-claim) opens with — and return
 * both. Returning the wallet (rather than just throwing) hands the caller a
 * NON-NULL `Wallet`, so TypeScript narrows it for the rest of the action without
 * each site re-checking the module-scoped `sdkWallet`. Stays in this module
 * because it reads that module-scoped global.
 */
function requireWalletAndKey(rootState: RootState): { wallet: Wallet; privateKey: string } {
  if (!sdkWallet) throw new Error('Wallet not connected')
  const privateKey = rootState.wallet.privateKey
  if (!privateKey) throw new Error('No wallet key available')
  return { wallet: sdkWallet, privateKey }
}

/**
 * Both claim actions accept either a bare gameId (legacy callers) or a
 * `{ gameId, mode }` object. Normalise to the object form, defaulting `mode` to
 * 'manual' (a user click) when unspecified.
 */
function parseClaimPayload(
  payload: string | { gameId: string; mode?: ClaimMode },
): { gameId: string; mode: ClaimMode } {
  return typeof payload === 'string'
    ? { gameId: payload, mode: 'manual' }
    : { gameId: payload.gameId, mode: payload.mode ?? 'manual' }
}

/** Decode an array of checkpoint PSBTs (hex) into Transactions — the shape both
 *  the refund and forfeit claim submissions need before co-signing. */
function decodeCheckpointTxs(checkpointsHex: string[]): Transaction[] {
  return checkpointsHex.map((c) => Transaction.fromPSBT(hex.decode(c)))
}

/**
 * Subscribe to the ContractManager so a player escrow being spent on-Ark clears
 * its stalled-bet stash EAGERLY — the atomic sweep (house OR player win) spends
 * both escrows, so a `vtxo_spent` on the player's `coinflip-escrow` means the
 * game settled and the stash is no longer needed. Also deactivates the contract
 * (best-effort) and refreshes the balance. The handler body is wrapped so a bad
 * event never tears down the subscription. Returns the unsubscribe fn (no-op
 * when there's no wallet).
 */
async function startEscrowContractWatch(dispatch: (type: string, payload?: unknown) => Promise<unknown>): Promise<() => void> {
  if (!sdkWallet) return () => {}
  const cm = await sdkWallet.getContractManager()
  return cm.onContractEvent((event) => {
    if (
      event.type !== 'vtxo_spent' ||
      (event.contract.type !== COINFLIP_ESCROW_TYPE && event.contract.type !== COINFLIP_ESCROW_V3_TYPE)
    ) return
    void (async () => {
      try {
        const gameId = event.contract.label
        if (gameId) await clearRefund(gameId)
        scheduleRefresh(dispatch)
        // Bet done → stop watching this escrow.
        await cm.setContractState(event.contract.script, 'inactive').catch(() => { /* best-effort */ })
      } catch (e) {
        console.error('[contract] vtxo_spent handler failed:', getErrorMessage(e))
      }
    })()
  })
}

/**
 * The chain's block time — BIP113 median-time-past of the tip block, exactly
 * what arkd enforces CLTV timelocks (escrow refunds) against. This LAGS the
 * user's wall-clock whenever blocks are sparse (idle regtest, slow networks),
 * so refund-readiness must gate on THIS, not `Date.now()`, or the UI invites a
 * reclaim arkd then rejects with FORFEIT_CLOSURE_LOCKED. Returns null when
 * unavailable (not connected / explorer unreachable) so callers can fall back.
 */
async function chainTipTime(): Promise<number | null> {
  if (!sdkWallet) return null
  try {
    const tip = await sdkWallet.onchainProvider.getChainTip()
    return tip.time
  } catch (e) {
    // A persistent failure here strands every claim button on "Checking chain
    // time…" — isCltvMatured(null, …) is always false, so a matured, claimable
    // pot stays unreachable in the UI. Surface it rather than swallowing; the
    // claim is still valid and proceeds once the read recovers.
    console.warn('[ark] chain-tip read failed; claim-readiness gating is stalled until it recovers:', getErrorMessage(e))
    return null
  }
}

const getCachedServerInfo = (): ArkServerInfo | null => {
  const cached = localStorage.getItem('ark_server_info')
  return cached ? JSON.parse(cached) : null
}

const ark: Module<ArkState, RootState> = {
  namespaced: true,

  state: {
    server: localStorage.getItem('ark_server') || `http://${regtestHost()}:7070`,
    // Esplora REST under the mempool `/api` prefix — see NETWORK_PRESETS.
    esplora: localStorage.getItem('ark_esplora') || `http://${regtestHost()}:3000/api`,
    networkPreset: localStorage.getItem('ark_network_preset') || 'regtest',
    status: 'disconnected',
    lastError: null,
    info: getCachedServerInfo(),
    vtxos: [],
    boardingUtxos: [],
    walletBalance: null,
    arkAddress: null,
    boardingAddress: null,
    txHistory: [],
    activityHistory: [],
    claimingGames: {},
  },

  mutations: {
    SET_SERVER(state, server: string) {
      state.server = server
      localStorage.setItem('ark_server', server)
    },
    SET_ESPLORA(state, esplora: string) {
      state.esplora = esplora
      if (esplora) localStorage.setItem('ark_esplora', esplora)
      else localStorage.removeItem('ark_esplora')
    },
    SET_NETWORK_PRESET(state, preset: string) {
      state.networkPreset = preset
      localStorage.setItem('ark_network_preset', preset)
    },
    SET_STATUS(state, status: ArkState['status']) {
      state.status = status
    },
    SET_ERROR(state, error: Error | null) {
      state.lastError = error
    },
    SET_INFO(state, info: ArkServerInfo | null) {
      state.info = info
      if (info) {
        localStorage.setItem('ark_server_info', JSON.stringify(info))
      } else {
        localStorage.removeItem('ark_server_info')
      }
    },
    SET_VTXOS(state, vtxos: ArkVTXO[]) {
      state.vtxos = vtxos
    },
    SET_BOARDING_UTXOS(state, utxos: BoardingUtxo[]) {
      state.boardingUtxos = utxos
    },
    SET_WALLET_BALANCE(state, balance: WalletBalance | null) {
      state.walletBalance = balance
    },
    SET_ARK_ADDRESS(state, address: string | null) {
      state.arkAddress = address
    },
    SET_BOARDING_ADDRESS(state, address: string | null) {
      state.boardingAddress = address
    },
    SET_TX_HISTORY(state, history: TxHistoryEntry[]) {
      state.txHistory = history
    },
    SET_ACTIVITY_HISTORY(state, activities: Activity[]) {
      state.activityHistory = activities
    },
    SET_CLAIMING(state, { gameId, info }: { gameId: string; info: ClaimingInfo }) {
      state.claimingGames = { ...state.claimingGames, [gameId]: info }
    },
    CLEAR_CLAIMING(state, gameId: string) {
      const next = { ...state.claimingGames }
      delete next[gameId]
      state.claimingGames = next
    },
  },

  actions: {
    updateServer({ commit }, server: string) {
      commit('SET_SERVER', server)
    },

    /**
     * Ask the coinflip server which network it's on and connect the wallet
     * aligned to it. The alignment itself lives in `checkConnection` (it runs
     * before every wallet creation), so this is just a named connect entry
     * point — the network is always the server's choice (its ARK_SERVER_URL),
     * never a client toggle.
     */
    async syncNetworkFromServer({ dispatch }) {
      await dispatch('checkConnection')
    },

    async checkConnection({ commit, state, rootState, dispatch }) {
      // A fresh attempt (manual Retry, network change, or a scheduled retry)
      // supersedes any pending auto-retry.
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      try {
        commit('SET_STATUS', 'connecting')

        // The network — and the Ark server + esplora URLs it implies — is the
        // coinflip server's choice (its ARK_SERVER_URL), surfaced via GET
        // /api/network. Resolve it on EVERY connect and derive the URLs from the
        // matching preset, so neither a stale cache nor the regtest default can
        // leak onto a public deploy. For any non-regtest network the esplora is
        // left EMPTY on purpose — the SDK derives it from the Ark server itself
        // (mutinynet → mempool.mutinynet.arkade.sh); we never hardcode it. The
        // resolved URLs (not `state.*`) feed Wallet.create + the /v1/info fetch,
        // so even a returning browser whose state still holds the bad default
        // connects correctly. Best-effort: on an unreachable server we fall back
        // to the last-known URLs.
        let arkServerUrl = state.server
        let esploraUrl = state.esplora
        try {
          const { network } = await getNetwork()
          const preset = NETWORK_PRESETS[network]
          if (preset) {
            arkServerUrl = preset.server
            esploraUrl = preset.esplora
            if (network !== state.networkPreset) commit('SET_INFO', null)
            commit('SET_NETWORK_PRESET', network)
            commit('SET_SERVER', arkServerUrl)
            commit('SET_ESPLORA', esploraUrl)
            if (preset.boltz) localStorage.setItem('boltz_api', preset.boltz)
            else localStorage.removeItem('boltz_api')
          }
        } catch {
          /* server unreachable — fall back to the current/last-known URLs */
        }

        const privateKey = rootState.wallet.privateKey
        if (!privateKey) {
          throw new Error('No wallet key available')
        }

        // Create SDK wallet. esploraUrl is omitted when empty so the SDK
        // auto-defaults it from the network it detects at the Ark server.
        const identity = SingleKey.fromHex(privateKey)
        const wallet = await Wallet.create({
          identity,
          arkServerUrl,
          ...(esploraUrl ? { esploraUrl } : {}),
          // Disable the SDK's settlement poll loop. It finalizes the game's
          // preconfirmed VTXOs (escrow change, sweep payout) into batch rounds
          // every poll, paying the per-intent fee each time — a ~5k-sats/flip
          // leak measured on regtest. We settle boarding ourselves (see
          // refreshBalance) so funding still works; preconfirmed game VTXOs
          // stay spendable off-chain without being re-settled.
          settlementConfig: false,
        })

        sdkWallet = wallet

        // Force a full VTXO re-scan when the wallet key or Ark server changes.
        // The SDK's sync cursor is GLOBAL, so a stale cursor left by a previous
        // wallet (or a different network) makes this connection skip the indexer
        // scan — a freshly restored key would then show a 0 balance. Clearing it
        // only on a context change keeps routine reconnects fast.
        const syncCtx = `${rootState.wallet.publicKey || ''}@${state.server}`
        if (syncCtx !== localStorage.getItem('ark_last_sync_ctx')) {
          await wallet.clearSyncCursor().catch((e) => console.warn('clearSyncCursor failed:', e))
          localStorage.setItem('ark_last_sync_ctx', syncCtx)
        }

        // Get server info via REST for display
        const response = await fetch(`${arkServerUrl}/v1/info`, {
          signal: AbortSignal.timeout(12000)
        })
        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`)
        }
        const raw = await response.json()
        const info: ArkServerInfo = {
          pubkey: raw.pubkey || raw.signerPubkey,
          network: raw.network,
          dust: raw.dust || raw.utxoMinAmount,
          unilateralExitDelay: raw.unilateralExitDelay,
          boardingExitDelay: raw.boardingExitDelay,
          sessionDuration: raw.sessionDuration,
        }

        commit('SET_INFO', info)

        // Get addresses from SDK
        const arkAddress = await wallet.getAddress()
        const boardingAddress = await wallet.getBoardingAddress()
        commit('SET_ARK_ADDRESS', arkAddress)
        commit('SET_BOARDING_ADDRESS', boardingAddress)

        commit('SET_STATUS', 'connected')
        commit('SET_ERROR', null)
        reconnectAttempts = 0 // connected — reset the backoff

        // Push-based balance updates. Subscribe to the SDK's contract watcher
        // (a single SSE stream over the wallet's active contracts + its own 60s
        // failsafe poll, with auto-reconnect). The callback fires the instant a
        // watched VTXO is received/spent — a faucet, an incoming payment, or the
        // game's payout sweep landing — so the UI updates without us polling
        // getBalance/getVtxos on a timer. Coalesced via scheduleRefresh. Stop
        // any prior subscription first (this runs again on every reconnect).
        if (incomingFundsStop) { try { incomingFundsStop() } catch { /* already gone */ } incomingFundsStop = null }
        try {
          incomingFundsStop = await wallet.notifyIncomingFunds(() => scheduleRefresh(dispatch))
        } catch (e) {
          console.warn('[watcher] notifyIncomingFunds unavailable; relying on action-driven refresh:', e)
        }

        // Coinflip-escrow contract tracking. Register the handler against OUR
        // SDK's contractHandlers singleton (the lib re-exports the same one,
        // but pass it explicitly to be robust to multi-copy installs), then
        // RE-REGISTER every active stash's player escrow so a page reload
        // re-arms the watcher, and start the vtxo_spent subscription that
        // clears the stash the instant the sweep settles. All best-effort —
        // the stash + auto-claim remain the trustless safety net regardless.
        // Stop any prior subscription first (this runs again on every reconnect).
        if (escrowEventStop) { try { escrowEventStop() } catch { /* already gone */ } escrowEventStop = null }
        try {
          registerCoinflipContracts(contractHandlers)
          for (const stash of await loadRefunds()) {
            if (stash.escrowContractParams && stash.escrowAddress) await registerEscrowContract(stash)
          }
          escrowEventStop = await startEscrowContractWatch(dispatch)
        } catch (e) {
          console.warn('[contract] escrow contract watch unavailable; relying on stash + auto-claim:', getErrorMessage(e))
        }

        // Background stalled-bet auto-claim. Fire once now so a stash
        // already past expiry doesn't have to wait one full tick, then
        // poll on the interval. The action itself short-circuits when
        // there are no stashes / nothing is ready.
        if (autoClaimTimer) clearInterval(autoClaimTimer)
        dispatch('runAutoClaim').catch(() => { /* logged inside */ })
        autoClaimTimer = setInterval(() => {
          dispatch('runAutoClaim').catch(() => { /* logged inside */ })
        }, AUTO_CLAIM_INTERVAL_MS)

        // Initialize swap service (Lightning + chain swaps via Boltz)
        try {
          const boltzApi = localStorage.getItem('boltz_api') || (info.network === 'regtest' ? 'http://localhost:9069' : undefined)
          await initSwaps(wallet, boltzApi)
        } catch (swapErr) {
          console.warn('Swap service unavailable:', swapErr)
        }

        await dispatch('refreshBalance')

        return info
      } catch (error) {
        console.error('Failed to connect to Ark server:', error)
        await destroySwaps().catch(() => {})
        sdkWallet = null
        if (autoClaimTimer) { clearInterval(autoClaimTimer); autoClaimTimer = null }
        if (incomingFundsStop) { try { incomingFundsStop() } catch { /* already gone */ } incomingFundsStop = null }
        if (escrowEventStop) { try { escrowEventStop() } catch { /* already gone */ } escrowEventStop = null }
        commit('SET_STATUS', 'error')
        commit('SET_ERROR', new Error(`Failed to connect: ${(error as Error).message}`))
        commit('SET_INFO', null)
        commit('SET_ARK_ADDRESS', null)
        commit('SET_BOARDING_ADDRESS', null)
        // Auto-retry with capped exponential backoff (2s, 4s, … 30s) as long as
        // a wallet key exists, so a transient failure or a slow page-load
        // connect heals itself without the user having to hit Retry.
        if (rootState.wallet.privateKey) {
          reconnectAttempts = Math.min(reconnectAttempts + 1, 6)
          const delay = Math.min(2000 * 2 ** (reconnectAttempts - 1), 30000)
          reconnectTimer = setTimeout(() => { dispatch('checkConnection') }, delay)
        }
        return null
      }
    },

    /**
     * Wipe the SDK's persisted local wallet data (the IndexedDB VTXO / UTXO /
     * tx / wallet-state / contract stores) so a stale balance from a previous
     * chain or wallet can't survive a reset. `clearSyncCursor` + reconnect don't
     * suffice: the cursor reset doesn't delete rows, and the SDK keeps VTXOs the
     * indexer no longer reports (e.g. after a regtest wipe).
     *
     * We clear the IndexedDB stores DIRECTLY (raw transaction) rather than via
     * `wallet.walletRepository.clear()` so the reset is self-contained and works
     * even when no wallet is connected (a disconnected wallet showing a stale
     * cache). NOTE: this action is namespaced (`ark/purgeLocalData`) — callers
     * outside this module must dispatch it with the `ark/` prefix, or it
     * silently no-ops in a production build.
     * (First-class SDK reset API requested upstream: arkade-os/ts-sdk#522.)
     */
    async purgeLocalData() {
      localStorage.removeItem('ark_last_sync_ctx')
      localStorage.removeItem('ark_server_info')
      // The SDK's default IndexedDB store name (no `storage` is passed to
      // Wallet.create, so it uses this default).
      const DB_NAME = 'arkade-service-worker'
      try {
        await new Promise<void>((resolve) => {
          const req = indexedDB.open(DB_NAME)
          req.onerror = () => resolve()
          req.onsuccess = () => {
            const db = req.result
            const names = Array.from(db.objectStoreNames)
            if (names.length === 0) { db.close(); resolve(); return }
            const tx = db.transaction(names, 'readwrite')
            const finish = () => { db.close(); resolve() }
            tx.oncomplete = finish
            tx.onerror = finish
            tx.onabort = finish
            for (const n of names) tx.objectStore(n).clear()
          }
        })
      } catch (e) {
        console.warn('purgeLocalData: failed to clear local wallet store:', e)
      }
    },

    /**
     * Resync the wallet against the current chain WITHOUT deleting the key:
     * purge the SDK's stale local store (ghost VTXOs from a previous chain
     * survive a regtest/chain wipe — see purgeLocalData), then reconnect so a
     * fresh sync rebuilds the balance from reality. Surfaced as the "Resync
     * wallet data" action.
     */
    async resyncWallet({ dispatch }) {
      await dispatch('purgeLocalData')
      await dispatch('checkConnection')
    },

    async refreshBalance({ commit, state, dispatch }, payload?: { light?: boolean }) {
      if (!sdkWallet || state.status !== 'connected') return

      try {
        const balance = await sdkWallet.getBalance()
        commit('SET_WALLET_BALANCE', balance)

        // settlementConfig is false, so the SDK won't auto-settle boarding.
        // Settle it ourselves once funds land (guarded against concurrency).
        // Fire-and-forget: the round is slow; the next refresh shows the result.
        if (balance.boarding.total > 0 && !settleOnce.active) {
          settleOnce()
            .then(() => dispatch('refreshBalance', { light: true }))
            .catch((e) => console.warn('boarding settle failed:', e))
        }

        // Hot-path (watcher-driven) refreshes are LIGHT: the balance is all the
        // play UI needs. The heavier vtxo / boarding / history fetch below is for
        // the wallet drawer + explicit actions, so skip it here — this is what
        // keeps a settlement burst from hammering the indexer.
        if (payload?.light) return

        // Also fetch VTXOs for detailed display
        const vtxos = await sdkWallet.getVtxos()
        commit('SET_VTXOS', vtxos
          .filter((v: ExtendedVirtualCoin) => v.virtualStatus.state !== 'spent')
          .map((v: ExtendedVirtualCoin) => ({
            outpoint: { txid: v.txid, vout: v.vout },
            amount: String(v.value),
            tapscripts: [],
            isPreconfirmed: v.virtualStatus.state === 'preconfirmed',
          }))
        )

        // Fetch boarding UTXOs
        const boardingUtxos = await sdkWallet.getBoardingUtxos()
        commit('SET_BOARDING_UTXOS', boardingUtxos.map((u) => ({
          outpoint: { txid: u.txid, vout: u.vout },
          amount: String(u.value),
          confirmations: u.status.confirmed && u.status.block_height ? u.status.block_height : 0,
        })))

      } catch (error) {
        console.error('Failed to refresh balance:', error)
      }
    },

    /**
     * Fetch the wallet's transaction history (Ark + boarding). HEAVY — the SDK
     * re-derives it from live on-chain state (an esplora /tx/:id/outspends per
     * boarding tx + indexer lookups), so it is deliberately NOT part of
     * refreshBalance. Loaded on demand when the Activity tab is viewed; the
     * result stays cached in state.txHistory until the next Activity view.
     */
    async refreshHistory({ commit, state }) {
      if (!sdkWallet || state.status !== 'connected') return
      try {
        // SDK returns ArkTransaction[] with TxKey carrying arkTxid /
        // commitmentTxid / boardingTxid — flatten to a single best-effort txid
        // and an `isBoarding` flag for the UI.
        const history = await sdkWallet.getTransactionHistory()
        const entries: TxHistoryEntry[] = history.map((tx) => ({
          txid: tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid,
          type: tx.type,
          amount: tx.amount,
          settled: tx.settled,
          createdAt: tx.createdAt,
          isBoarding: !!tx.key.boardingTxid && !tx.key.arkTxid,
        }))
        commit('SET_TX_HISTORY', entries)
        // Group the flat history into activities (a dice game's co-fund + settle
        // collapse into one "Dice game" row) via the local engine. Replace with
        // wallet.getActivityHistory() when the SDK ships it on coinflip's line.
        const games: CoinflipGameRecord[] = (() => {
          try {
            const raw = JSON.parse(localStorage.getItem('gameHistory') || '[]')
            return (Array.isArray(raw) ? raw : [])
              .filter((g) => g?.id && Array.isArray(g.txids) && g.txids.length)
              .map((g) => ({
                id: String(g.id),
                tier: Number(g.tier) || 0,
                winner: g.winner ?? null,
                txids: g.txids,
              }))
          } catch {
            return []
          }
        })()
        commit(
          'SET_ACTIVITY_HISTORY',
          await buildActivities(entries, [
            gameActivityResolver(() => games),
            boardingResolver(),
          ]),
        )
      } catch (error) {
        console.error('Failed to refresh history:', error)
      }
    },

    async sendBitcoin(_ctx, { address, amount }: { address: string; amount: number }) {
      if (!sdkWallet) throw new Error('Wallet not connected')

      const txid = await sdkWallet.sendBitcoin({ address, amount })

      // Refresh balance after send
      await _ctx.dispatch('refreshBalance')

      return txid
    },

    async settle(_ctx, params?: { eventCallback?: (event: unknown) => void }) {
      if (!sdkWallet) throw new Error('Wallet not connected')

      // Reuse an in-flight auto-settle instead of racing it (overlapping rounds hang).
      const txid = await settleOnce(params?.eventCallback)

      await _ctx.dispatch('refreshBalance')

      return txid
    },

    /**
     * Greedy-select spendable VTXOs to cover `amount` sats, returning them in
     * the VtxoInput shape the server's /api/play endpoint expects. Throws
     * if the wallet does not have enough spendable balance.
     */
    async selectPlayerVtxoInputs(_ctx, amount: number): Promise<VtxoInput[]> {
      if (!sdkWallet) throw new Error('Wallet not connected')
      const all = await sdkWallet.getVtxos()
      const spendable = all
        .filter((v: ExtendedVirtualCoin) => v.virtualStatus.state !== 'spent')
        .sort((a, b) => Number(b.value - a.value))
      const picked: ExtendedVirtualCoin[] = []
      let sum = 0n
      for (const v of spendable) {
        picked.push(v)
        sum += BigInt(v.value)
        if (sum >= BigInt(amount)) break
      }
      if (sum < BigInt(amount)) {
        throw new Error(`Insufficient balance: have ${sum}, need ${amount}`)
      }
      return picked.map(vtxoToPlayerInput)
    },

    /**
     * Play one trustless coin game end-to-end:
     *   1. POST /api/play — the house escrows its stake; returns the escrow address.
     *   2. Escrow the player's stake into that address (single-party send).
     *   3. POST /api/game/:id/commit — reveal + resolve. House win → the server
     *      already swept; player win → sign + submit the returned sweep PSBT.
     * Returns the commit result { winner, payout, houseSecret, playerSecret, proof }.
     */
    async playTrustlessGame(
      { state, rootState },
      { tier, side, oddsN, oddsTarget, oddsLo }: { tier: number; side?: 'heads' | 'tails'; oddsN?: number; oddsTarget?: number; oddsLo?: number },
    ) {
      const { wallet, privateKey } = requireWalletAndKey(rootState)
      const playerPubkey = rootState.wallet.publicKey
      if (!playerPubkey) throw new Error('No wallet public key available')
      const playerChangeAddress = state.arkAddress
      if (!playerChangeAddress) throw new Error('No Ark address available — wallet still connecting?')

      const identity = SingleKey.fromHex(privateKey)
      void identity // kept for downstream signing helpers (refund stash)
      const arkProvider = wallet.arkProvider
      const arkInfo = await arkProvider.getInfo()
      void arkInfo // ensures arkProvider is warm before /play call

      // 1. Commit a secret + start the game. The escrow version is set by the
      // server (env: ESCROW_VERSION) and published via /api/network. Generate
      // the appropriate secret format:
      //   v2 (legacy): random bytes whose LENGTH encodes the digit. Coin: 15B
      //                heads / 16B tails. Variable-odds: base16 + digit bytes.
      //   v3:          `[digitByte] ‖ salt` (= packets.encodeReveal) — a
      //                fixed-length 17-byte reveal. Coin maps to n=2, digit
      //                ∈ {0, 1}: side=heads → 0, side=tails → 1. Variable-
      //                odds: digit picked uniformly in [0, oddsN).
      const isVariable = oddsN !== undefined && oddsTarget !== undefined
      const netInfo = await getNetwork()
      const contractVersion: 'v2' | 'v3' = netInfo.escrowVersion === 'v3' ? 'v3' : 'v2'
      let secretBytes: Uint8Array
      let v3Reveal: { digit: number; salt: Uint8Array } | undefined
      if (contractVersion === 'v3') {
        // v3 coin → n=2, target=1, lo=0 (server applies the same default).
        const n = isVariable ? (oddsN as number) : 2
        const digit = isVariable
          ? uniformRandomInt(n)
          : (side === 'tails' ? 1 : 0)
        v3Reveal = v3CommitDigit(digit, n)
        secretBytes = cwpPackets.encodeReveal(v3Reveal.digit, v3Reveal.salt)
      } else {
        if (isVariable) {
          const VARIABLE_ODDS_BASE_LEN = 16 // must match arkade-coinflip's constant
          secretBytes = new Uint8Array(VARIABLE_ODDS_BASE_LEN + uniformRandomInt(oddsN as number))
        } else {
          secretBytes = new Uint8Array(side === 'tails' ? 16 : 15)
        }
        crypto.getRandomValues(secretBytes)
      }
      const playerSecretHex = hex.encode(secretBytes)
      const playerHash = await createHash(secretBytes)

      // Sanity check spendable balance BEFORE starting the game. Doing it after
      // apiPlay (which creates a pending game + reserves the house stake) would
      // strand the game on any selection failure, and stranded games count
      // against the server's per-player cap → "Too many pending games". The
      // actual VTXO selection happens inside wallet.send below.
      const spendableTotal = (await wallet.getVtxos())
        .filter((v: ExtendedVirtualCoin) => v.virtualStatus.state !== 'spent')
        .reduce((sum: number, v: ExtendedVirtualCoin) => sum + v.value, 0)
      if (spendableTotal < tier) {
        throw new Error(`Insufficient spendable balance for a ${tier}-sat bet — top up or settle to consolidate, then retry.`)
      }

      const playRes = await apiPlay(
        tier, playerPubkey, playerHash, playerChangeAddress,
        isVariable ? { oddsN: oddsN as number, oddsTarget: oddsTarget as number, oddsLo: oddsLo ?? 0 } : undefined,
      )

      // 2. Escrow the player's stake into the shared escrow address via the
      // SDK's wallet.send. The SDK handles VTXO selection, multi-input
      // funding, AND — critically — routes sub-dust change to an OP_RETURN
      // output, which arkd accepts (a non-OP_RETURN sub-dust output is
      // rejected with `AMOUNT_TOO_LOW`). Replaces the prior hand-rolled
      // buildOffchainTx + submitOffchain.
      const playerEscrowTxid = await wallet.send({ address: playRes.escrowAddress, amount: tier })
      // Find OUR output within the send tx (vout isn't guaranteed to be 0 — the
      // SDK adds anchor/metadata outputs) and wait out indexer lag. The matching
      // + poll/timeout logic lives in locateEscrowVtxo (unit-tested).
      const indexer = new RestIndexerProvider(state.server)
      const playerEscrow: Outpoint = await locateEscrowVtxo(indexer, {
        escrowPkHex: addressToPkScriptHex(playRes.escrowAddress),
        txid: playerEscrowTxid,
        amount: tier,
      })

      // 2b. Stash a self-submittable refund BEFORE revealing. If the server now
      // stalls, the player can still reclaim the escrow after finalExpiration
      // without trusting it. Best-effort: a stash failure shouldn't abort a game
      // that will almost certainly resolve, but log it loudly.
      try {
        const r = await apiRefund(playRes.gameId, playerEscrow)
        const stash: StashedRefund = {
          gameId: playRes.gameId, tier, playerEscrow,
          refundPsbt: r.refundPsbt, refundCheckpoints: r.refundCheckpoints,
          finalExpiration: r.finalExpiration, createdAt: Date.now(),
          // Persist the player escrow's contract params + address so a reload
          // can re-register it and re-arm the vtxo_spent watcher.
          escrowContractParams: playRes.escrowContractParams,
          escrowAddress: playRes.escrowAddress,
          // Persist the contract version + (for v3) the reveal so a page
          // reload reconstructs the right /commit payload.
          contractVersion: playRes.contractVersion ?? contractVersion,
          ...(v3Reveal
            ? { reveal: { digit: v3Reveal!.digit, salt: hex.encode(v3Reveal!.salt) } }
            : {}),
        }
        await stashRefund(stash)
        // Register the player escrow as a coinflip-escrow contract so the
        // ContractWatcher clears this stash the instant the sweep settles.
        // Best-effort — the stash itself is the trustless backstop.
        await registerEscrowContract(stash)
      } catch (e) {
        console.warn('[trustless] could not stash refund (continuing):', getErrorMessage(e))
      }

      // NOTE: the arkade-script forfeit is intentionally NOT stashed here. The
      // joint pot it sweeps does not exist yet — under lazy funding the house
      // only escrows at /commit. Probing /forfeit now would always be refused
      // ("no joint pot"). The forfeit is stashed instead in the /commit failure
      // path below, the one window where a funded-but-unswept pot can linger.
      // See stashForfeitRecovery().

      // 3. Reveal + resolve. The server settles via the emulator-bound
      // covenant for both win cases — no client signature needed. On
      // failure the stash is kept so the player can claim the forfeit
      // after `forfeitClaimableAt` or self-refund after `finalExpiration`.
      let result: Awaited<ReturnType<typeof apiCommit>>
      try {
        // Mark revealed BEFORE the network call: even if /commit hangs,
        // the player has revealed and a stalling server is now in the R1
        // forfeit scenario. The stash records this so the UI surfaces
        // "Claim full pot" (forfeit), not "Reclaim" (self-refund only).
        await updateRefundStash(playRes.gameId, { revealed: true })
        result = await apiCommit(playRes.gameId, playerSecretHex, playerEscrow)
      } catch (e) {
        // /commit failed AFTER the player revealed (revealed:true is stashed
        // above). Under lazy funding the house escrow is created at the START of
        // /commit (fundHouseEscrowOnce) — before the covenant sweep — so a
        // failure here can leave a funded-but-unswept joint pot. That is the one
        // state the R1 `playerForfeit` leaf recovers: probe /forfeit now (it only
        // succeeds once that pot exists) and stash the claim so the player can
        // sweep the FULL pot after the CLTV if the operator never re-settles.
        // Race-free: the forfeit's CLTV opens at finalExpiration, long after a
        // healthy operator's autonomous reconcile would have landed.
        await stashForfeitRecovery(playRes.gameId, playerEscrow, playerChangeAddress, playerSecretHex)

        // Soft messaging: a /commit failure almost always means the operator is
        // still settling (it finishes autonomously). Surface that calmly and
        // log the underlying error rather than steering the user straight at
        // the reclaim path. The stash + forfeit watcher remain the backstop.
        console.warn('[trustless] /commit failed (operator settles autonomously):', getErrorMessage(e))
        const when = new Date(playRes.finalExpiration * 1000).toLocaleString()
        throw new Error(
          `Still settling — the operator finishes this automatically and it usually lands within a minute. ` +
          `Your ${tier} sat stake is safe; if it doesn't resolve you can reclaim it after ${when} (see "Reclaim stalled bets").`,
        )
      }
      // Bet resolved → drop the stash and stop watching the escrow (best-effort).
      await finishBet(playRes.gameId, await getRefundStash(playRes.gameId))

      // No manual refresh — the contract watcher fires on the sweep's vtxo
      // events and pushes a (coalesced, light) balance update.
      return result
    },

    /**
     * Play one v0.4 JOINT-POT game end-to-end (the default; the server advertises
     * `protocolVersion: 'v4'` on /api/network). Two on-chain txs:
     *   1. POST /api/v4/play — the house reserves stake VTXO(s) and returns the
     *      joint-pot covenant params + its serialized stake inputs.
     *   2. Build the atomic co-fund (the player's stake VTXOs + the house's, both
     *      arbitrary in count, → one joint pot) with the lib's `buildCofundFromPlay`;
     *      sign our leading input vins and run the 2-round handshake — POST /cofund
     *      (server signs the trailing house vins + submits, returns our checkpoints)
     *      → sign them → POST /cofund-finalize (creates the pot).
     *   3. POST /api/v4/reveal — the server settles the WHOLE pot to the winner.
     * Returns { winner, settleTxid, payout, roll, houseSecretHex }.
     *
     * NOTE: v0.4 stake-recovery (the covenant's cooperative-refund + unilateral
     * exit leaves) has no client claim flow yet — a stalled co-fund/reveal throws
     * with guidance. Only the happy path is wired; recovery is a follow-up.
     */
    async playV4Game(
      { state, rootState },
      { tier, side, oddsN, oddsTarget, oddsLo, emulatorUrl }: { tier: number; side?: 'heads' | 'tails'; oddsN?: number; oddsTarget?: number; oddsLo?: number; emulatorUrl?: string },
    ) {
      const { wallet, privateKey } = requireWalletAndKey(rootState)
      const playerPubkey = rootState.wallet.publicKey
      if (!playerPubkey) throw new Error('No wallet public key available')
      const playerAddress = state.arkAddress
      if (!playerAddress) throw new Error('No Ark address available — wallet still connecting?')
      // v4 recovery (the playerForfeit claim) is submitted to the emulator, and
      // for v4 the forfeit stash is the ONLY recovery. Refuse to fund a pot we
      // couldn't recover: abort BEFORE any funds move if no emulator is known.
      if (!emulatorUrl) {
        throw new Error('v0.4 needs a reachable emulator for trustless recovery — aborting before any funds move.')
      }

      const identity = SingleKey.fromHex(privateKey)
      const arkInfo = await wallet.arkProvider.getInfo()
      const serverUnroll = decodeTapscript(hex.decode(arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

      // Player reveal — same `[digit] ‖ salt` shape as v3. Coin → n=2, digit
      // side=heads→0 / tails→1; variable-odds → uniform in [0, oddsN).
      const isVariable = oddsN !== undefined && oddsTarget !== undefined
      const n = isVariable ? (oddsN as number) : 2
      const digit = isVariable ? uniformRandomInt(n) : (side === 'tails' ? 1 : 0)
      const reveal = v3CommitDigit(digit, n)
      const secretBytes = cwpPackets.encodeReveal(reveal.digit, reveal.salt)
      const playerSecretHex = hex.encode(secretBytes)
      const playerHash = await createHash(secretBytes)

      // The co-fund spends the player's OWN stake inputs (the leading vins). Pick
      // enough spendable VTXOs (largest-first) to cover the tier — one or many.
      const spendable = (await wallet.getVtxos())
        .filter((v: ExtendedVirtualCoin) => v.virtualStatus.state === 'settled' || v.virtualStatus.state === 'preconfirmed')
        .sort((a: ExtendedVirtualCoin, b: ExtendedVirtualCoin) => b.value - a.value)
      const playerVtxos: ExtendedVirtualCoin[] = []
      let playerSum = 0
      for (const v of spendable) {
        if (playerSum >= tier) break
        playerVtxos.push(v)
        playerSum += v.value
      }
      if (playerSum < tier) {
        throw new Error(`Insufficient spendable balance for a ${tier}-sat bet (have ${playerSum}) — top up or settle to consolidate, then retry.`)
      }

      // 1. /play — reserve the house stake + get the covenant params.
      const playRes = await v4Play(
        tier, playerPubkey, playerHash, playerAddress, playerAddress,
        isVariable ? { oddsN: oddsN as number, oddsTarget: oddsTarget as number, oddsLo: oddsLo ?? 0 } : undefined,
      )

      // 2. Build the atomic co-fund (player inputs = our own VTXOs; house inputs
      // rebuilt from the /play response) and run the 2-round signing handshake.
      const playerInputs: ArkTxInput[] = playerVtxos.map((v) => ({
        txid: v.txid, vout: v.vout, value: v.value,
        tapLeafScript: v.forfeitTapLeafScript, tapTree: v.tapTree,
      }))
      const cof = buildCofundFromPlay({
        play: playRes,
        playerInputs,
        playerChangePkScript: ArkAddress.decode(playerAddress).pkScript,
        betAmount: tier,
        serverUnroll,
      })
      // Sign our input vins — the LEADING k.
      const k = playerInputs.length
      const arkTxSigned = await identity.sign(cof.arkTx, Array.from({ length: k }, (_, i) => i))
      const cofundRes = await v4Cofund(
        playRes.gameId,
        base64.encode(arkTxSigned.toPSBT()),
        cof.checkpoints.map((c) => base64.encode(c.toPSBT())),
      )
      // Sign each of our checkpoints (the server returns the leading k), then finalize.
      const signedPlayerCheckpoints = await Promise.all(
        cofundRes.playerCheckpoints.map(async (cpB64) => {
          const cp = Transaction.fromPSBT(base64.decode(cpB64))
          let s = cp
          try { s = await identity.sign(cp, Array.from({ length: cp.inputsLength }, (_, i) => i)) }
          catch (e) { if (!getErrorMessage(e).includes('No taproot scripts signed')) throw e }
          return base64.encode(s.toPSBT())
        }),
      )
      const finRes = await v4CofundFinalize(playRes.gameId, signedPlayerCheckpoints)

      // Stash the forfeit recovery BEFORE revealing. If the server stalls on the
      // settle, this is the player's claim to the WHOLE pot once the CLTV (the
      // game's finalExpiration) matures — player + arkd + emulator, no operator.
      await stashV4ForfeitRecovery({
        gameId: playRes.gameId,
        tier,
        potOutpoint: finRes.potOutpoint,
        covenant: playRes.covenant,
        expectedPayoutPkScriptHex: hex.encode(ArkAddress.decode(playerAddress).pkScript),
        playerSecretHex,
        emulatorUrl, // captured before the co-fund (checked non-empty above)
      })

      // 3. Reveal → the server settles the whole pot to the winner. On success
      // the pot is spent, so the recovery stash is moot; clear it best-effort
      // (the auto-claim poll GCs it anyway if this misses).
      const result = await v4Reveal(playRes.gameId, playerSecretHex)
      await deleteV4Forfeit(playRes.gameId).catch(() => { /* leave for poll GC */ })
      // Surface the on-chain txids so the activity history can collapse this
      // game's wallet transactions (co-fund + settle) into one "Dice game" row.
      return { ...result, cofundTxid: finRes.potOutpoint.txid }
    },

    /**
     * Place a bet via whichever trustless flow the server advertises — v0.4
     * joint pot (the default) or v0.3 per-party escrow when `protocolVersion`
     * is 'v3' on /api/network. The single entry point the UI dispatches; pin the
     * old flow with the server's PROTOCOL_VERSION=v3.
     */
    async placeTrustlessBet(
      { dispatch },
      payload: { tier: number; side?: 'heads' | 'tails'; oddsN?: number; oddsTarget?: number; oddsLo?: number },
    ) {
      const net = await getNetwork()
      return net.protocolVersion === 'v4'
        ? dispatch('playV4Game', { ...payload, emulatorUrl: net.emulator?.url })
        : dispatch('playTrustlessGame', payload)
    },

    /** Locally-stashed stalled bets (escrows reclaimable if the server stalled). */
    async listStalledBets(): Promise<StashedRefund[]> {
      // Hide stashes < 90 s old: a fresh stash exists from /play through /commit
      // (~1-2 s on the happy path) as the trustless backstop. Before this
      // filter, between updateRefundStash({revealed:true}) and clearRefund()
      // the StalledBets card flashed up as a "claim full pot" prompt for the
      // duration of the /commit round-trip. 90 s comfortably covers worst-
      // case /commit + arkd settlement on mutinynet without delaying the
      // recovery UI for genuinely stalled games (finalExpiration is 30 min).
      const RECENT_GRACE_MS = 90_000
      const cutoff = Date.now() - RECENT_GRACE_MS
      return (await loadRefunds()).filter((b) => b.createdAt <= cutoff)
    },

    /**
     * v0.4 joint-pot forfeits eligible for the recovery UI. Same 90 s grace as
     * listStalledBets — on the happy path the stash exists only briefly (≈100 ms
     * between co-fund and settle), so anything older is a genuine stall.
     */
    async listV4StalledBets(): Promise<StashedV4Forfeit[]> {
      const cutoff = Date.now() - 90_000
      return (await loadV4Forfeits()).filter((b) => b.createdAt <= cutoff)
    },

    /**
     * Chain block time (BIP113 MTP) so the UI can gate refund-readiness on what
     * arkd actually enforces rather than the user's wall-clock. null if the
     * chain tip can't be read (caller should fall back to a wall-clock estimate).
     */
    async getChainTipTime(): Promise<number | null> {
      return chainTipTime()
    },

    /**
     * Reclaim a stalled bet by signing + submitting its stashed refund. arkd
     * enforces the CLTV, so this only succeeds at/after finalExpiration; before
     * that we surface a clear "not yet" message. Clears the stash on success.
     */
    async reclaimStalledBet(
      { state, rootState, commit },
      payload: string | { gameId: string; mode?: ClaimMode },
    ) {
      const { gameId, mode } = parseClaimPayload(payload)
      if (state.claimingGames[gameId]) {
        throw new Error('A claim is already in progress for this game.')
      }
      const { wallet, privateKey } = requireWalletAndKey(rootState)
      const stash = await getRefundStash(gameId)
      if (!stash) throw new Error('No stashed refund for this game')
      commit('SET_CLAIMING', { gameId, info: { kind: 'refund', mode } })
      try {
        // arkd enforces the refund CLTV against the chain's block time (BIP113
        // MTP), which trails wall-clock when blocks are sparse. Gate on chain time
        // — not Date.now() — so we don't submit a refund arkd rejects. Fall back to
        // wall-clock only if the chain tip is unreadable (the catch below backstops).
        const chainTime = await chainTipTime()
        const refClock = chainTime ?? Math.floor(Date.now() / 1000)
        if (refClock < stash.finalExpiration) {
          const lifts = new Date(stash.finalExpiration * 1000).toLocaleString()
          throw new Error(
            chainTime !== null
              ? `Not reclaimable yet — the chain's block time is ${new Date(chainTime * 1000).toLocaleString()}; the timelock lifts at ${lifts} (chain time), as new blocks are mined.`
              : `Not reclaimable yet — the timelock lifts at ${lifts}.`,
          )
        }
        const identity = SingleKey.fromHex(privateKey)
        const refundArk = Transaction.fromPSBT(hex.decode(stash.refundPsbt))
        const refundCps = decodeCheckpointTxs(stash.refundCheckpoints)
        try {
          await submitOffchain(wallet.arkProvider, identity, refundArk, refundCps, [0])
        } catch (e) {
          // Race: our chain-time read passed the CLTV but arkd's tip MTP still
          // trails it. Surface a clear "wait for the next block" instead of the
          // raw FORFEIT_CLOSURE_LOCKED — the stash is kept so a retry still works.
          const msg = getErrorMessage(e)
          if (/FORFEIT_CLOSURE_LOCKED|is locked|locked/i.test(msg)) {
            throw new Error("Not reclaimable yet — the chain hasn't mined a block past the timelock. Try again shortly.")
          }
          throw e
        }
        // Own stake reclaimed → drop the stash and stop watching the escrow.
        await finishBet(gameId, stash)
        // Balance update is push-based via the contract watcher (refund vtxo event).
      } finally {
        commit('CLEAR_CLAIMING', gameId)
      }
    },

    /**
     * Submit the stashed arkade-script forfeit claim — sweeps BOTH escrows
     * to the player via the `playerForfeit` leaf (atomic-sweep covenant +
     * CLTV). PSBT goes to the emulator (`stash.forfeitEmulatorUrl /v1/tx`),
     * which validates the covenant, signs its tweaked slot, and forwards
     * to arkd. CLTV is ABSOLUTE (`forfeitClaimableAt`) — gate on
     * `chainTipTime >= forfeitClaimableAt`. Clears the stash on success.
     */
    async claimForfeit(
      { state, rootState, commit },
      payload: string | { gameId: string; mode?: ClaimMode },
    ) {
      const { gameId, mode } = parseClaimPayload(payload)
      if (state.claimingGames[gameId]) {
        throw new Error('A claim is already in progress for this game.')
      }
      const { privateKey } = requireWalletAndKey(rootState)
      const stash = await getRefundStash(gameId)
      // hasStashedForfeit folds revealed + all-fields-present into one predicate
      // shared with StalledBets and the auto-claim poll. Keep the "wasn't
      // revealed" case as a distinct message (it points the user at refund); the
      // forfeit fields are written atomically, so `forfeitPsbt && !revealed` is
      // exactly "a forfeit was built but never revealed".
      if (!stash || !hasStashedForfeit(stash)) {
        if (stash?.forfeitPsbt && stash.revealed !== true) {
          throw new Error("Can't forfeit-claim a game that wasn't revealed — use refund instead.")
        }
        throw new Error('No forfeit stashed for this game — use reclaim instead.')
      }

      commit('SET_CLAIMING', { gameId, info: { kind: 'forfeit', mode } })
      try {
        const identity = SingleKey.fromHex(privateKey)
        const arkTx = Transaction.fromPSBT(hex.decode(stash.forfeitPsbt))
        // Both inputs are 3-of-3 [player, server, emulator_tweaked]. The player
        // signs both player slots; arkd signs server slots; the emulator signs
        // the tweaked slots after running the arkade script.
        const signed = await identity.sign(arkTx, [0, 1])
        const cps = decodeCheckpointTxs(stash.forfeitCheckpoints)

        // POST to the emulator's /v1/tx with the partially-signed PSBT +
        // checkpoint PSBTs. The emulator returns the finalized PSBT once arkd
        // has co-signed (the emulator forwards it internally).
        const resp = await fetch(`${stash.forfeitEmulatorUrl}/v1/tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            arkTx: base64.encode(signed.toPSBT()),
            checkpointTxs: cps.map((c) => base64.encode(c.toPSBT())),
          }),
        })
        if (!resp.ok) {
          const text = await resp.text()
          // Mirror the FORFEIT_CLOSURE_LOCKED messaging — same root cause (CLTV
          // not yet satisfied at the chain's block time), different surface.
          if (/locked|too early|CLTV|locktime/i.test(text)) {
            throw new Error("Not claimable yet — the chain's block time hasn't reached the forfeit CLTV. Try again shortly.")
          }
          throw new Error(`Emulator rejected forfeit: ${text}`)
        }

        // Full pot claimed via forfeit → drop the stash and stop watching the escrow.
        await finishBet(gameId, stash)
        // Balance update is push-based via the contract watcher (claim vtxo event).
      } finally {
        commit('CLEAR_CLAIMING', gameId)
      }
    },

    /**
     * v0.4 recovery: reclaim the WHOLE joint pot via the playerForfeit leaf when
     * the server never settled. Unlike v3 (which submits a server-built PSBT),
     * the claim is rebuilt CLIENT-side from the stashed covenant — reconstruct
     * the pot, spend the playerForfeit leaf into payTo(player, pot), sign our
     * slot, and POST to the emulator (it co-signs the tweaked slot; arkd signs
     * its slot and forwards). Valid only once chain time crosses the CLTV — an
     * early submission is rejected, surfaced here as a friendly "not claimable yet".
     */
    async claimV4Forfeit(
      { state, rootState, commit },
      payload: string | { gameId: string; mode?: ClaimMode },
    ) {
      const { gameId, mode } = parseClaimPayload(payload)
      if (state.claimingGames[gameId]) {
        throw new Error('A claim is already in progress for this game.')
      }
      const { wallet, privateKey } = requireWalletAndKey(rootState)
      // Set the in-flight flag BEFORE the stash read so the guard above is a
      // true mutex — otherwise the 15 s auto-claim poll can slip a second
      // submission in during the await below (manual-vs-auto double-submit).
      commit('SET_CLAIMING', { gameId, info: { kind: 'forfeit', mode } })
      try {
        const stash = (await loadV4Forfeits()).find((s) => s.gameId === gameId)
        if (!stash || !hasClaimableV4Forfeit(stash)) {
          throw new Error('No v0.4 forfeit stashed for this game.')
        }
        // Re-assert the payout binding at claim time. IDB is not a trust
        // boundary and the auto-claim poll fires this without user consent, so a
        // tampered/corrupt stash must not sweep the pot to a foreign address.
        if (!state.arkAddress) throw new Error('Wallet address unavailable for forfeit claim.')
        const expectedPayout = hex.encode(ArkAddress.decode(state.arkAddress).pkScript)
        if (stash.covenant.playerPayoutPkScript !== expectedPayout) {
          throw new Error('v0.4 forfeit refused: the stashed pot does not pay this wallet (tampered or corrupt stash).')
        }
        const identity = SingleKey.fromHex(privateKey)
        const arkInfo = await wallet.arkProvider.getInfo()
        const serverUnroll = decodeTapscript(hex.decode(arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
        const cv = stash.covenant
        const pot = new CoinflipJointPotScript({
          creatorPubkey: hex.decode(cv.creatorPubkey),
          playerPubkey: hex.decode(cv.playerPubkey),
          serverPubkey: hex.decode(cv.serverPubkey),
          creatorHash: hex.decode(cv.creatorHash),
          playerHash: hex.decode(cv.playerHash),
          finalExpiration: BigInt(cv.finalExpiration),
          cancelDelay: BigInt(cv.cancelDelay),
          exitDelay: BigInt(cv.exitDelay),
          oddsN: cv.oddsN,
          oddsTarget: cv.oddsTarget,
          oddsLo: cv.oddsLo,
          emulatorPubkey: hex.decode(cv.emulatorPubkey),
          playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
          housePayoutPkScript: hex.decode(cv.housePayoutPkScript),
          playerStake: BigInt(cv.playerStake),
          houseStake: BigInt(cv.houseStake),
        })
        // The staged-forfeit contest. Each leaf is [player, arkd, emu_tweaked]:
        // sign our single player slot; arkd signs its slot; the emulator co-signs
        // the tweaked slot after running its covenant. Same per checkpoint.
        const signAndPostV4 = async (
          built: { arkTx: Transaction; checkpoints: Transaction[] },
          label: string,
        ): Promise<string> => {
          const signed = await identity.sign(built.arkTx, [0])
          const checkpointTxs = await Promise.all(
            built.checkpoints.map(async (c) => {
              let s = c
              try { s = await identity.sign(c, Array.from({ length: c.inputsLength }, (_, i) => i)) }
              catch (e) { if (!getErrorMessage(e).includes('No taproot scripts signed')) throw e }
              return base64.encode(s.toPSBT())
            }),
          )
          const resp = await fetch(`${stash.forfeitEmulatorUrl}/v1/tx`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ arkTx: base64.encode(signed.toPSBT()), checkpointTxs }),
          })
          if (!resp.ok) {
            const text = await resp.text()
            if (/locked|too early|CLTV|locktime/i.test(text)) {
              throw new Error("Not claimable yet — the chain's block time hasn't reached the takeAll CLTV. Try again shortly.")
            }
            throw new Error(`Emulator rejected v0.4 ${label}: ${text}`)
          }
          return Transaction.fromPSBT(base64.decode((await resp.json() as { signedArkTx: string }).signedArkTx)).id
        }

        if (!stash.stageTwoOutpoint) {
          // STAGE 1 — publish the player's secret on-chain (the ConditionMultisig
          // leaf's SHA256 witness), moving the pot into the StageTwo contest.
          // No timelock, so it pre-empts the house's refund. Persist the StageTwo
          // outpoint; the stash stays until stage 2 sweeps it. From here the house's
          // stage-2 poll settles to the winner, or — if the house stays dark — we
          // sweep the whole pot at finalExpiration (stage 2 below).
          const reveal = buildPlayerRevealTx({
            pot,
            cofund: stash.potOutpoint,
            playerRevealBytes: hex.decode(stash.playerSecretHex),
            serverUnroll,
          })
          // Self-heal the crash window: if a PRIOR attempt already fired stage 1 but
          // crashed before persisting stageTwoOutpoint (below), the cofund is now
          // spent and this re-POST is rejected. Rather than loop on stage 1 forever,
          // discover the StageTwo VTXO on-chain (exactly like the server's reconcile)
          // and adopt it — so recovery advances to stage 2 WITHOUT depending on the
          // server (the whole point of the client stash).
          let stageTwoOutpoint: V4PotOutpoint
          try {
            const stageTwoTxid = await signAndPostV4(reveal, 'playerReveal (stage 1)')
            stageTwoOutpoint = { txid: stageTwoTxid, vout: 0, value: stash.potOutpoint.value }
          } catch (e) {
            const indexer = new RestIndexerProvider(state.server)
            const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(pot.stageTwo.pkScript)] })
            const existing = vtxos.find((v) => v.value === stash.potOutpoint.value)
            if (!existing) throw e // no StageTwo on-chain → a genuine failure, surface it
            stageTwoOutpoint = { txid: existing.txid, vout: existing.vout, value: existing.value }
          }
          await putV4Forfeit({ ...stash, stageTwoOutpoint })
          return
        }

        // STAGE 2 — after finalExpiration (the CLTV), sweep the WHOLE pot to the
        // player via the playerTakeAll leaf.
        const takeAll = buildStageTwoTakeAllTx({
          stageTwo: pot.stageTwo,
          stageTwoOutpoint: stash.stageTwoOutpoint,
          playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
          potAmount: BigInt(stash.stageTwoOutpoint.value),
          serverUnroll,
        })
        await signAndPostV4(takeAll, 'playerTakeAll (stage 2)')
        // Whole pot swept to the player → drop the stash.
        await deleteV4Forfeit(gameId)
      } finally {
        commit('CLEAR_CLAIMING', gameId)
      }
    },

    /**
     * One pass over every stashed game: if its CLTV has matured and no
     * claim is in flight, fire the better one (forfeit > refund) with
     * `mode: 'auto'`. Backgrounded by `autoClaimTimer`; also safe to
     * dispatch manually (e.g. immediately after connect so a stash
     * past expiry doesn't wait one full tick).
     */
    async runAutoClaim({ state, dispatch }) {
      if (!sdkWallet) return
      const stashes = await loadRefunds()
      if (!stashes.length) return
      const chainTime = await chainTipTime()
      if (chainTime === null) return // can't decide; try next tick
      for (const stash of stashes) {
        if (state.claimingGames[stash.gameId]) continue
        // Back off games whose reclaim keeps failing PERMANENTLY (the stashed
        // refund no longer matches the server's VTXO — e.g. a pre-v4 or rotated
        // escrow that recovers via the operator sweep, not a cooperative reclaim).
        // Without this, auto-claim re-submits the doomed refund every tick +
        // reconnect, spamming /v1/tx/submit with 400s.
        if (hasExhaustedReclaim(stash.claimFailures)) continue
        // Thin failsafe behind the contract watcher: if the server already
        // settled this game (a vtxo_spent event was missed, or the escrow
        // contract failed to register at all), drop the stash + deactivate the
        // contract — so the panel still clears even if the event path no-ops.
        try {
          if ((await apiGetGame(stash.gameId)).status === 'resolved') {
            await finishBet(stash.gameId, stash)
            continue
          }
        } catch { /* server unreachable — fall through to the CLTV-gated claim */ }
        // Structural check (revealed + complete forfeit) is shared; CLTV
        // maturity is the auto-claim poll's own extra gate (isCltvMatured). The
        // type guard narrows forfeitClaimableAt to a number for the comparison.
        const canForfeit = hasStashedForfeit(stash) && isCltvMatured(chainTime, stash.forfeitClaimableAt)
        const canRefund = isCltvMatured(chainTime, stash.finalExpiration)
        try {
          if (canForfeit) {
            await dispatch('claimForfeit', { gameId: stash.gameId, mode: 'auto' })
          } else if (canRefund) {
            await dispatch('reclaimStalledBet', { gameId: stash.gameId, mode: 'auto' })
          }
        } catch (e) {
          const msg = getErrorMessage(e)
          // A PERMANENT failure (witness-utxo script mismatch — the stashed
          // refund no longer matches the server's VTXO, e.g. a pre-v4 / rotated
          // escrow) will never succeed on retry. Count it so auto-claim backs off
          // instead of re-submitting the doomed refund every tick + reconnect.
          // The stake still recovers via the operator sweep. Transient failures
          // (network, CLTV-timing) are NOT counted and keep retrying.
          if (isPermanentReclaimError(msg)) {
            const claimFailures = (stash.claimFailures ?? 0) + 1
            await updateRefundStash(stash.gameId, { claimFailures, lastClaimError: msg })
            if (hasExhaustedReclaim(claimFailures)) {
              console.warn(
                `[auto-claim] ${stash.gameId}: giving up after ${claimFailures} permanent failures — ` +
                  `the stashed refund no longer matches the server's VTXO (likely a pre-v4 / rotated ` +
                  `escrow). The stake recovers via the operator sweep; not retrying.`,
              )
            }
          }
          console.warn(`[auto-claim] ${stash.gameId} failed:`, msg)
        }
      }

      // v0.4 joint-pot forfeits live in their own store + claim path. The happy
      // path clears the stash on settle, so a lingering one is almost always a
      // genuine stall — fire the client-built claim once the CLTV matures.
      for (const v4 of await loadV4Forfeits()) {
        if (state.claimingGames[v4.gameId]) continue
        if (!hasClaimableV4Forfeit(v4)) continue
        // Positive GC ONLY: if the server settled this game normally, drop the
        // stale stash. We must NOT infer "settled" from a claim-error string —
        // a transient emulator rejection can carry "spent"/"not found" and would
        // otherwise delete a still-claimable pot (lost recovery). The resolved
        // check is the sole authority that removes a stash here.
        try {
          if ((await apiGetGame(v4.gameId)).status === 'resolved') {
            await deleteV4Forfeit(v4.gameId)
            continue
          }
        } catch { /* server unreachable — fall through to the CLTV-gated claim */ }
        // Two-stage timing (pure + unit-tested as v4ClaimStage): STAGE 1 fires
        // BEFORE cancelDelay (pre-empting the refund so we can sweep the WHOLE pot,
        // not just our stake), STAGE 2 at finalExpiration. claimV4Forfeit picks the
        // matching stage from the stash's stageTwoOutpoint.
        if (v4ClaimStage(v4, chainTime) === 'wait') continue
        try {
          await dispatch('claimV4Forfeit', { gameId: v4.gameId, mode: 'auto' })
        } catch (e) {
          // Keep the stash on ANY claim error and retry next tick — erring
          // toward keeping the recovery record is the only safe bias for a pot.
          console.warn(`[auto-claim:v4] ${v4.gameId} failed (will retry):`, getErrorMessage(e))
        }
      }
    },

    /**
     * "Restore Games from Server": fetch this wallet's game history back from the
     * server, proving key ownership. Used after a browser clear / new device,
     * where the key is present but the local history is gone.
     *
     * Signature-proof challenge (matches packages/server/src/restore-auth.ts):
     *   1. GET a nonce for our pubkey,
     *   2. schnorr-sign sha256(utf8(nonce)) with our private key,
     *   3. GET /api/games with (nonce, sig) → { games, reclaimHints }.
     *
     * Needs only the raw wallet key — NOT a connected SDK wallet — so it works
     * on a fresh device before the Ark connect completes (hence it reads
     * rootState.wallet directly instead of requireWalletAndKey).
     *
     * SCOPE: history display only. `reclaimHints` are returned but NOT acted on:
     * a restored v4 hint has no player secret (`playerSecretHex` is always null
     * server-side), so it can't drive a take-the-pot claim, and stalled v4
     * stakes already self-recover server-side via the refund timer. Actionable
     * v4 recovery from a restore is a deferred follow-up; we only count the hints
     * here.
     */
    async restoreFromServer(
      { rootState },
    ): Promise<{ games: GameSummary[]; reclaimHints: V4ReclaimHint[] }> {
      const playerPubkey = rootState.wallet.publicKey
      const privateKey = rootState.wallet.privateKey
      if (!playerPubkey || !privateKey) throw new Error('No wallet key available to restore from')
      try {
        const { nonce } = await getRestoreChallenge(playerPubkey)
        const sig = signChallenge(nonce, privateKey)
        const { games, reclaimHints } = await restoreGamesFromServer(playerPubkey, nonce, sig)
        if (reclaimHints.length > 0) {
          // Counted but intentionally unused — see the SCOPE note above.
          console.info(`[restore] ${reclaimHints.length} pending v4 reclaim hint(s) returned (history-only; not re-armed)`)
        }
        return { games, reclaimHints }
      } catch (e) {
        const msg = getErrorMessage(e)
        // 401 → the signature proof failed (the `request` wrapper throws the
        // server's body text, which contains "challenge signature" here).
        if (/401|challenge signature|Invalid or expired/i.test(msg)) {
          throw new Error("Couldn't verify your wallet — please try again.")
        }
        if (/429|Too many requests/i.test(msg)) {
          throw new Error('Too many restore attempts — please wait a minute and try again.')
        }
        // Network / fetch failure (offline, DNS, CORS) surfaces as a TypeError
        // with no useful body — give a friendly catch-all.
        throw new Error(`Couldn't reach the server to restore your games (${msg}).`)
      }
    },
  },

  getters: {
    claimingGames: (state) => state.claimingGames,
    serverPubkey: (state) => state.info?.pubkey || null,
    serverNetwork: (state) => state.info?.network || null,
    dust: (state) => state.info?.dust ? parseInt(state.info.dust) : null,
    address: (state) => state.arkAddress,
    boardingAddress: (state) => state.boardingAddress,
    vtxos: (state) => state.vtxos,
    balance: (state) => {
      if (state.walletBalance) {
        return BigInt(state.walletBalance.available)
      }
      return state.vtxos.reduce((sum, vtxo) => sum + BigInt(vtxo.amount), BigInt(0))
    },
    formattedBalance: (_state, getters): string => {
      const balance = getters.balance
      if (!balance) return '0'
      return Number(balance).toLocaleString()
    },
    boardingUtxos: (state) => state.boardingUtxos,
    boardingBalance: (state) => {
      if (state.walletBalance) {
        return BigInt(state.walletBalance.boarding.total)
      }
      return state.boardingUtxos.reduce((sum, u) => sum + BigInt(u.amount), BigInt(0))
    },
    walletBalance: (state) => state.walletBalance,
    txHistory: (state) => state.txHistory,
    activityHistory: (state) => state.activityHistory,
    networkPreset: (state) => state.networkPreset,
    networkPresets: () => NETWORK_PRESETS,
  }
}

export default ark
