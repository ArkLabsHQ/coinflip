import type { ActionContext } from 'vuex'
import { hex, base64 } from '@scure/base'
import type { State as RootState } from '@/store'
import {
  Wallet, SingleKey,
  Transaction, ArkAddress,
  RestArkProvider, RestIndexerProvider, EsploraProvider, decodeTapscript, CSVMultisigTapscript, isVtxoSpent, resolveEmulatorPubkey,
  type ExtendedVirtualCoin, type ArkTxInput,
  type NetworkName,
} from '@arkade-os/sdk'
import { commitDigit } from 'arkade-coinflip/dist/arkade-win.js'
import { buildCofundFromPlay, buildPlayerRevealTx, buildStageTwoTakeAllTx, prepareSettleForEmulator, tapLeafHasKey } from 'arkade-coinflip/dist/joint-pot-tx.js'
import { encodeReveal } from 'arkade-coinflip/dist/packets.js'
import { initSwaps, destroySwaps } from '@/services/swaps'
import { singleFlight } from '@/utils/singleFlight'
import {
  v4Play, v4Cofund, v4CofundFinalize, v4Reveal, v4CooperativeExit,
} from '@/services/api'
import { hasClaimableV4Forfeit, v4ClaimStage, type StashedV4Forfeit } from './v4ForfeitStash'
import { putV4Forfeit, loadV4Forfeits } from './v4ForfeitStashStore'
import { buildV4SelfRefund, pickV4ClaimPath, rebuildJointPot, isAlreadySpentError, isTransientSelfRefundError } from './v4SelfRefund'
import { stepCooperativeExit } from './v4CooperativeExit'
import { makeCooperativeExitIo, V4_EXIT_FEE_SATS, V4_EXIT_BUMPER_MIN_SATS } from './v4CooperativeExitIo'
import { isSyncConfirmed, type SyncSnapshot } from './balanceReady'
import { createHash } from '@/utils/crypto'
import { getErrorMessage } from '@/utils/errors'
import { logDiag } from '@/utils/diagnosticsLog'
import { isCltvMatured } from '@/utils/cltv'
import { withTimeout, TIMEOUTS } from '@/utils/withTimeout'
import { gameActivityResolver } from './gameActivityResolver'
import { stashV4ForfeitRecovery } from './v4Recovery'
import { validatePlay } from './validatePlay'
import { signPlayerCheckpoints, assertFinalizedPot } from './authorizeCofund'
import { reconcileRecovery as reconcileIndexedRecovery, type RecoveryStatus } from './recoveryStatus'
import { computeHouseStake } from 'arkade-coinflip/dist/stake-math.js'
import {
  uniformRandomInt, addressToPkScriptHex, parseClaimPayload,
} from './arkHelpers'
import type { ArkServerInfo, ClaimMode, ArkState } from './arkTypes'

import { hasExhaustedReclaim } from '@/utils/reclaimBackoff'
import { getWalletNetwork, rememberWalletNetwork } from '@/services/walletNetwork'

/** The ark module's live ActionContext — the `ark.ts` wrappers pass it straight through. */
type ArkCtx = ActionContext<ArkState, RootState>

/** Local explorer defaults; the game's published operator URL controls the connection. */
export interface NetworkPreset {
  label: string
  server: string
  /** Empty string → let the SDK auto-default from the detected network. */
  esplora: string
}

/**
 * Same-origin host for regtest defaults. When the page is loaded from
 * `localhost`, fall back to `localhost`; when it's loaded from a LAN IP
 * (phone on the same wifi hitting `http://192.168.x.x:8080`), use that
 * IP so arkd / esplora / emulator (all bound to 0.0.0.0 on the host)
 * remain reachable.
 */
export function regtestHost(): string {
  if (typeof window === 'undefined') return 'localhost'
  return window.location.hostname || 'localhost'
}

export const NETWORK_PRESETS: Record<string, NetworkPreset> = {
  regtest: {
    label: 'Regtest (local)',
    server: `http://${regtestHost()}:7070`,
    // The arkade-regtest (denigiri) stack serves the Esplora REST API
    // under the mempool service's `/api` prefix on :3000 — the bare root
    // is the mempool web UI (HTML), not the REST API. Omitting `/api`
    // makes the SDK's esplora calls return HTML and fail to parse.
    esplora: `http://${regtestHost()}:3000/api`,
  },
  mutinynet: {
    label: 'Mutinynet',
    server: 'https://mutinynet.arkade.sh',
    esplora: '',
  },
}

// SDK wallet instance (kept outside Vuex state to avoid reactivity issues with complex objects)
let sdkWallet: Wallet | null = null
let walletGeneration = 0
// Run at most ONE boarding-settle round at a time. settlementConfig is false (see
// Wallet.create), so the client settles boarding itself — from BOTH the auto-settle
// in refreshBalance AND the manual `settle` action. Two concurrent sdkWallet.settle()
// calls register competing intents for the same boarding UTXO; arkd settles one and
// the other hangs forever (the button awaiting it never clears). singleFlight funnels
// both through one round so a second caller reuses it instead of racing.
const settleOnce = singleFlight(async (eventCallback?: (event: unknown) => void): Promise<string> => {
  const w = sdkWallet
  if (!w) throw new Error('Wallet not connected')
  // Mirror the server's renewal guard (game-engine `migrateDeprecatedSigners`):
  // after the operator rotates its signing key, settle() rejects deprecated-signer
  // inputs with INVALID_VTXO_SCRIPT and a client boarding-settle would jam. Migrate
  // them first — best-effort and a no-op when nothing is deprecated, so a hiccup
  // here must never block a normal settle.
  try {
    // Bound BOTH awaits — getVtxoManager() memoizes but its first call still
    // hits the network, and it's the one un-timed await that could otherwise
    // wedge this singleFlight slot before we even reach settle().
    await withTimeout(
      (async () => {
        const vm = await w.getVtxoManager()
        await vm.migrateDeprecatedSignerVtxos()
      })(),
      TIMEOUTS.submit,
      'signer migration',
    )
  } catch (e) {
    console.warn('pre-settle deprecated-signer migration failed (continuing):', e)
  }
  // Bound the settle: a known SDK edge (settle(undefined) re-selecting a swept
  // boarding coin) can hang 90s+. Without a ceiling the singleFlight slot never
  // frees, wedging BOTH the manual "Settle" button and every future auto-settle
  // for the session. The timeout rejects → the slot frees → the next attempt
  // (or the SDK's own coalesce, once upstream) can proceed.
  return withTimeout(w.settle(undefined, eventCallback as never), TIMEOUTS.settle, 'settle')
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

// Feature flag (build-time): the emulator-free ON-CHAIN cooperative-exit escalation
// in runAutoClaim ships DORMANT. Its multi-tick unroll is not yet verified against a
// live regtest/browser, so it stays off unless the operator explicitly opts in by
// building the client with VUE_APP_COOPERATIVE_EXIT_ENABLED=true. Off ⇒ the exhausted
// self-refund path behaves exactly as before (give up; the stake still recovers via
// the server's own refund timer). See v4CooperativeExitIo.
const COOPERATIVE_EXIT_ENABLED = process.env.VUE_APP_COOPERATIVE_EXIT_ENABLED === 'true'
// Stop fn for the SDK's incoming-funds watcher: one SSE stream over the
// wallet's active contracts + the SDK's own 60s failsafe poll. Push-based
// balance updates replace our manual refreshBalance polling.
let incomingFundsStop: (() => void) | null = null
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

/** Stop key-bearing clients before clearing wallet data or reconnecting. */
export async function disconnect(): Promise<void> {
  walletGeneration++
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (autoClaimTimer) { clearInterval(autoClaimTimer); autoClaimTimer = null }
  if (refreshTrailing) { clearTimeout(refreshTrailing); refreshTrailing = null }
  if (refreshMaxWait) { clearTimeout(refreshMaxWait); refreshMaxWait = null }
  if (incomingFundsStop) { incomingFundsStop(); incomingFundsStop = null }
  const wallet = sdkWallet
  sdkWallet = null
  await destroySwaps()
  await wallet?.dispose()
}

export function getSDKWallet(): Wallet | null {
  return sdkWallet
}

export function selectPlainGameInputs(coins: readonly ExtendedVirtualCoin[], target: number): ExtendedVirtualCoin[] {
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error('Game stake must be a positive whole number of sats')
  const inputs: ExtendedVirtualCoin[] = []
  let total = 0
  for (const coin of coins.filter(coin => !coin.assets?.length).sort((a, b) => b.value - a.value)) {
    if (total >= target) break
    inputs.push(coin)
    total += coin.value
  }
  if (total < target) throw new Error(`Insufficient plain spendable balance for a ${target}-sat bet (have ${total})`)
  return inputs
}

async function reconcileRecovery(stash: StashedV4Forfeit, wallet: Wallet): Promise<RecoveryStatus> {
  return reconcileIndexedRecovery(stash, wallet.indexerProvider, wallet.onchainProvider)
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
 * The chain's block time — BIP113 median-time-past of the tip block, exactly
 * what arkd enforces CLTV timelocks (escrow refunds) against. This LAGS the
 * user's wall-clock whenever blocks are sparse (idle regtest, slow networks),
 * so refund-readiness must gate on THIS, not `Date.now()`, or the UI invites a
 * reclaim arkd then rejects with FORFEIT_CLOSURE_LOCKED. Returns null when
 * unavailable (not connected / explorer unreachable) so callers can fall back.
 */
export async function chainTipTime(): Promise<number | null> {
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

export const checkConnection = singleFlight(connectWallet)

async function connectWallet({ commit, state, rootState, dispatch }: ArkCtx) {
  const generation = ++walletGeneration
  // A fresh attempt (manual Retry, network change, or a scheduled retry)
  // supersedes any pending auto-retry.
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  try {
    commit('SET_STATUS', 'connecting')
    await destroySwaps()
    if (incomingFundsStop) { incomingFundsStop(); incomingFundsStop = null }
    await sdkWallet?.dispose()
    sdkWallet = null

    const networkConfig = await getWalletNetwork(rootState.wallet.publicKey || '', state.server)
    const arkServerUrl = networkConfig.operatorUrl
    const esploraUrl = networkConfig.esploraUrl || NETWORK_PRESETS[networkConfig.network]?.esplora || ''
    if (networkConfig.network !== state.networkPreset) commit('SET_INFO', null)
    commit('SET_NETWORK_PRESET', networkConfig.network)
    commit('SET_SERVER', arkServerUrl)
    commit('SET_ESPLORA', esploraUrl)

    const privateKey = rootState.wallet.privateKey
    if (!privateKey) {
      throw new Error('No wallet key available')
    }

    // Create SDK wallet. esploraUrl is omitted when empty so the SDK
    // auto-defaults it from the network it detects at the Ark server.
    const identity = SingleKey.fromHex(privateKey)
    const wallet = await Wallet.create({
      identity,
      operatorProvider: new RestArkProvider(arkServerUrl),
      indexerProvider: new RestIndexerProvider(arkServerUrl),
      ...(esploraUrl ? { onchainProvider: new EsploraProvider(esploraUrl) } : {}),
      // Disable the SDK's settlement poll loop. It finalizes the game's
      // preconfirmed VTXOs (escrow change, sweep payout) into batch rounds
      // every poll, paying the per-intent fee each time — a ~5k-sats/flip
      // leak measured on regtest. We settle boarding ourselves (see
      // refreshBalance) so funding still works; preconfirmed game VTXOs
      // stay spendable off-chain without being re-settled.
      settlementConfig: false,
      concurrentSpending: true,
    })

    if (generation !== walletGeneration || rootState.wallet.privateKey !== privateKey) {
      await wallet.dispose()
      throw new Error('Wallet changed while connecting')
    }
    try {
      const { restorePoolHolds } = await import('@/services/fundedPoolJournal')
      await restorePoolHolds(wallet, {
        publicKey: hex.encode(await wallet.identity.xOnlyPublicKey()), network: networkConfig.network,
        operatorUrl: new URL(arkServerUrl).toString().replace(/\/+$/, ''),
      })
      if (generation !== walletGeneration || rootState.wallet.privateKey !== privateKey) throw new Error('Wallet changed while restoring pool holds')
    } catch (error) {
      await wallet.dispose()
      throw error
    }
    sdkWallet = wallet

    // Register the coinflip game activity resolver so getActivityHistory()
    // collapses a dice game's co-fund + settle txs into one "Dice game" row.
    // Idempotent — `use()` overwrites by id, so reconnects don't stack
    // duplicates. Boarding deposits are already labeled by the SDK's default
    // registry, so this is the only resolver we add.
    wallet.activity.use(gameActivityResolver())

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
    if (raw.network !== networkConfig.network) throw new Error('Wallet operator does not match the game network')
    rememberWalletNetwork(rootState.wallet.publicKey || '', networkConfig)
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
    try {
      incomingFundsStop = await wallet.notifyIncomingFunds(() => scheduleRefresh(dispatch))
    } catch (e) {
      console.warn('[watcher] notifyIncomingFunds unavailable; relying on action-driven refresh:', e)
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

    // Restore and drive persisted swaps with discovered solvers.
    try {
      await initSwaps(wallet)
    } catch (swapErr) {
      console.warn('Swap service unavailable:', swapErr)
    }

    await dispatch('refreshBalance')

    return info
  } catch (error) {
    console.error('Failed to connect to Ark server:', error)
    await destroySwaps().catch(() => {})
    await sdkWallet?.dispose().catch(() => {})
    sdkWallet = null
    if (autoClaimTimer) { clearInterval(autoClaimTimer); autoClaimTimer = null }
    if (incomingFundsStop) { try { incomingFundsStop() } catch { /* already gone */ } incomingFundsStop = null }
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
}

/**
 * The SDK's contract-sync freshness, or null if it can't be read. Never throws:
 * this only decides whether we TRUST the balance, so a failure here must not
 * take down the refresh that produced it.
 */
async function readSyncState(): Promise<SyncSnapshot | null> {
  try {
    const manager = await sdkWallet!.getContractManager()
    return manager.getSyncState()
  } catch {
    return null
  }
}

export async function refreshBalance({ commit, state, dispatch }: ArkCtx, payload?: { light?: boolean }) {
  const wallet = sdkWallet
  if (!wallet || state.status !== 'connected') return

  try {
    const balance = await wallet.getBalance()
    if (wallet !== sdkWallet) return
    commit('SET_WALLET_BALANCE', balance)
    // getBalance() drives a real sync on its way through (getVtxos ->
    // getContractsWithVtxos -> syncContracts), so the sync state read here
    // describes THAT sync — which is what makes a zero balance believable.
    commit('SET_BALANCE_SYNCED', isSyncConfirmed(await readSyncState()))

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
      .filter((v: ExtendedVirtualCoin) => !isVtxoSpent(v))
      .map((v: ExtendedVirtualCoin) => ({
        outpoint: { txid: v.txid, vout: v.vout },
        amount: String(v.value),
        tapscripts: [],
        isPreconfirmed: v.isPreconfirmed === true,
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
}

/**
 * Fetch the wallet's grouped activity history. HEAVY — the SDK re-derives
 * the flat tx history from live on-chain state (an esplora /tx/:id/outspends
 * per boarding tx + indexer lookups), then runs the registered resolvers
 * (boarding built-in + our game resolver) to collapse a dice game's co-fund
 * + settle into one "Dice game" row. Deliberately NOT part of refreshBalance;
 * loaded on demand when the Activity tab is viewed and cached in
 * state.activityHistory until the next view.
 */
export async function refreshHistory({ commit, state }: ArkCtx) {
  const wallet = sdkWallet
  if (!wallet || state.status !== 'connected') return
  // Keep the last successfully-loaded list on screen while refreshing; only
  // show the spinner on the first load (nothing cached yet).
  commit('SET_ACTIVITY_STATUS', state.activityHistory.length ? 'ready' : 'loading')
  try {
    const activities = await withTimeout(wallet.getActivityHistory(), TIMEOUTS.api, 'load activity')
    if (wallet !== sdkWallet) return
    commit('SET_ACTIVITY_HISTORY', activities)
    commit('SET_ACTIVITY_STATUS', 'ready')
  } catch (error) {
    console.error('Failed to refresh history:', error)
    commit('SET_ACTIVITY_STATUS', 'error')
  }
}

export async function sendBitcoin(_ctx: ArkCtx, { address, amount }: { address: string; amount: number }) {
  if (!sdkWallet) throw new Error('Wallet not connected')

  const txid = await withTimeout(sdkWallet.send({ address, amount }), TIMEOUTS.submit, 'send')

  // Refresh balance after send
  await _ctx.dispatch('refreshBalance')

  return txid
}

export async function settle(_ctx: ArkCtx, params?: { eventCallback?: (event: unknown) => void }) {
  if (!sdkWallet) throw new Error('Wallet not connected')

  // Reuse an in-flight auto-settle instead of racing it (overlapping rounds hang).
  const txid = await settleOnce(params?.eventCallback)

  await _ctx.dispatch('refreshBalance')

  return txid
}

/** Reserve inputs, persist recovery, co-fund the verified pot, then reveal. */
export async function playV4Game(
  { state, rootState, commit }: ArkCtx,
  { tier, side, oddsN, oddsTarget, oddsLo, oddsEdgeBps, emulatorUrl }: { oddsEdgeBps?: number; tier: number; side?: 'heads' | 'tails'; oddsN?: number; oddsTarget?: number; oddsLo?: number; emulatorUrl?: string },
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
    throw new Error('Game recovery needs a reachable emulator. Reconnect before placing this bet.')
  }

  const emulatorPubkey = resolveEmulatorPubkey(wallet.network, process.env.VUE_APP_EMULATOR_PUBKEY?.trim() || undefined)
  const identity = SingleKey.fromHex(privateKey)
  const arkInfo = await wallet.arkProvider.getInfo()
  const serverUnroll = decodeTapscript(hex.decode(arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

  // Player reveal is `[digit] ‖ salt`. Coin → n=2, digit
  // side=heads→0 / tails→1; variable-odds → uniform in [0, oddsN).
  const isVariable = oddsN !== undefined && oddsTarget !== undefined
  const n = isVariable ? (oddsN as number) : 2
  const digit = isVariable ? uniformRandomInt(n) : (side === 'tails' ? 1 : 0)
  const reveal = commitDigit(digit, n)
  const secretBytes = encodeReveal(reveal.digit, reveal.salt)
  const playerSecretHex = hex.encode(secretBytes)
  const playerHash = await createHash(secretBytes)

  // The co-fund spends the player's OWN stake inputs (the leading vins). Pick
  // enough spendable VTXOs (largest-first) to cover the tier — one or many.
  const playerXOnly = hex.decode(playerPubkey)
  const allSpendable = await wallet.getSpendableVtxos()
  // Only spend coins WE can co-sign: a coin whose forfeit leaf doesn't carry our
  // key (e.g. a prior-payout coin that landed here owned by another key) is
  // unsignable, so arkd would reject the co-fund at finalize (INVALID_SIGNATURE).
  const spendable = allSpendable
    .filter((v: ExtendedVirtualCoin) => tapLeafHasKey(v.forfeitTapLeafScript, playerXOnly))
    .sort((a: ExtendedVirtualCoin, b: ExtendedVirtualCoin) => b.value - a.value)
  if (spendable.length < allSpendable.length) {
    const stuck = allSpendable.filter((v: ExtendedVirtualCoin) => !tapLeafHasKey(v.forfeitTapLeafScript, playerXOnly))
    logDiag('warn', 'v4play', `skipping ${stuck.length} VTXO(s) this wallet can't co-sign: ${stuck.map((v) => `${v.txid}:${v.vout}`).join(', ')}`)
  }
  const playerVtxos = selectPlainGameInputs(spendable, tier)
  const playerSum = playerVtxos.reduce((sum, coin) => sum + coin.value, 0)

  // Fold a sub-dust change into the stake. If our selected VTXOs would leave a
  // change ≤ dust — a dust output can't exist, so the co-fund can't balance and
  // arkd rejects it — stake the whole remainder instead: the server folds
  // `stakeTopUp` into playerStake, the pot grows to match, and our change becomes 0.
  const dust = state.info?.dust ? parseInt(state.info.dust, 10) : 546
  const change = playerSum - tier
  const stakeTopUp = change > 0 && change <= dust ? change : 0
  const betAmount = tier + stakeTopUp // == playerSum when folding, else the tier

  const hold = wallet.reserveVtxos(playerVtxos)
  try {
  // 1. /play — reserve the house stake + get the covenant params. Measured at
  // ~5s median in production, so this is the leg the player spends most of the
  // wait inside; naming it is most of what stops the flip reading as hung.
  commit('SET_FLIP_STAGE', 'placing')
  const playRes = await v4Play(
    tier, playerPubkey, playerHash, playerAddress, playerAddress,
    isVariable ? { oddsN: oddsN as number, oddsTarget: oddsTarget as number, oddsLo: oddsLo ?? 0 } : undefined,
    stakeTopUp,
  )

  const expectedTerms = {
    playerPubkey, playerHash,
    payoutPkScript: addressToPkScriptHex(playerAddress),
    serverPubkey: arkInfo.signerPubkey,
    emulatorPubkey,
    playerStake: betAmount,
    minimumHouseStake: isVariable && oddsEdgeBps !== undefined
      ? computeHouseStake(betAmount, n, oddsTarget!, oddsLo ?? 0, oddsEdgeBps)
      : isVariable ? undefined : betAmount,
    oddsN: n, oddsTarget: isVariable ? oddsTarget! : 1, oddsLo: oddsLo ?? 0,
  }
  const validateFunding = async () => {
    const tip = await wallet.onchainProvider.getChainTip()
    validatePlay(playRes, { ...expectedTerms, chainTime: tip.time, wallTime: Math.floor(Date.now() / 1000) })
  }
  await validateFunding()

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
    betAmount,
    serverUnroll,
  })
  // Persist the secret and exact pot before any funding can be finalized.
  // Stash the forfeit recovery BEFORE revealing. If the server stalls on the
  // settle, this is the player's claim to the WHOLE pot once the CLTV (the
  // game's finalExpiration) matures — player + arkd + emulator, no operator.
  await stashV4ForfeitRecovery({
    gameId: playRes.gameId,
    tier,
    potOutpoint: { txid: cof.arkTx.id, vout: 0, value: playRes.pot },
    covenant: playRes.covenant,
    expectedPayoutPkScriptHex: hex.encode(ArkAddress.decode(playerAddress).pkScript),
    playerSecretHex,
    emulatorUrl, // captured before the co-fund (checked non-empty above)
  })

  // Sign our input vins — the LEADING k.
  const k = playerInputs.length
  commit('SET_FLIP_STAGE', 'funding')
  await validateFunding()
  const arkTxSigned = await identity.sign(cof.arkTx, Array.from({ length: k }, (_, i) => i))
  const cofundRes = await v4Cofund(
    playRes.gameId,
    base64.encode(arkTxSigned.toPSBT()),
    cof.checkpoints.map((c) => base64.encode(c.toPSBT())),
  ).catch((e) => {
    // Capture the gameId in the client diagnostics so it correlates with the
    // server's [v4/cofund]/[v4/finalize] log for the same game. Log + re-throw.
    logDiag('error', 'v4cofund', `game ${playRes.gameId} co-fund submit failed: ${getErrorMessage(e)}`)
    throw e
  })
  await validateFunding()
  const playerOutpoints = new Set(playerInputs.map(input => `${input.txid}:${input.vout}`))
  const expectedCheckpoints = cof.checkpoints.filter(checkpoint => {
    const input = checkpoint.getInput(0)
    return !!input.txid && playerOutpoints.has(`${hex.encode(input.txid)}:${input.index}`)
  })
  if (expectedCheckpoints.length !== k) throw new Error('Locally built checkpoints do not cover every player input')
  const signedPlayerCheckpoints = await signPlayerCheckpoints(cofundRes, cof.arkTx, expectedCheckpoints, identity)
  commit('SET_FLIP_STAGE', 'signing')
  const finRes = await v4CofundFinalize(playRes.gameId, signedPlayerCheckpoints).catch((e) => {
    logDiag('error', 'v4cofund', `game ${playRes.gameId} finalize failed: ${getErrorMessage(e)}`)
    throw e
  })

  assertFinalizedPot(finRes, cof.arkTx)

  // Request settlement; keep recovery until the operator confirms the actual pot spend.
  commit('SET_FLIP_STAGE', 'settling')
  const result = await v4Reveal(playRes.gameId, playerSecretHex)
  const recovery = (await loadV4Forfeits()).find(stash => stash.gameId === playRes.gameId)
  if (recovery) void reconcileRecovery({ ...recovery, confirmationPending: true }, wallet).catch(error => console.warn('[recovery] confirmation pending:', error))
  // Surface the on-chain txids so the activity history can collapse this
  // game's wallet transactions (co-fund + settle) into one "Dice game" row.
  return { ...result, cofundTxid: finRes.potOutpoint.txid }
  } finally { hold.release() }
}

/**
 * v0.4 recovery from a stashed joint pot. Two mutually-exclusive paths,
 * selected by whether we hold the player's secret (pickV4ClaimPath):
 *
 *  - FORFEIT (we have the secret): reclaim the WHOLE pot via the staged
 *    contest. Reconstruct the pot, spend playerReveal → (later) playerTakeAll,
 *    sign our player slot, and POST to the emulator (it co-signs the tweaked
 *    slot; arkd signs its slot). Gated on finalExpiration.
 *
 *  - SELF-REFUND (no secret — a RESTORED stash from a server reclaimHint):
 *    reclaim only OUR OWN stake via the covenant-only `cooperativeSpend`
 *    split-back. The leaf has NO player slot, so we sign NOTHING and POST the
 *    built tx as-is (identical to the server's broadcastV4Refund). Gated on
 *    cancelDelay (NOT finalExpiration — that gates the take-all leaf). If the
 *    pot is already spent (the server's refund timer beat us, paying our own
 *    payout script), that IS success: we clear the stash, never retry.
 *
 * Either way an early submission (before the CLTV) is rejected and surfaced as
 * a friendly "not claimable yet".
 */
export async function claimV4Forfeit(
  { state, rootState, commit }: ArkCtx,
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
    let stash = (await loadV4Forfeits()).find((s) => s.gameId === gameId)
    if (!stash || !hasClaimableV4Forfeit(stash)) {
      throw new Error('No v0.4 forfeit stashed for this game.')
    }
    // Re-assert the payout binding at claim time. IDB is not a trust
    // boundary and the auto-claim poll fires this without user consent, so a
    // tampered/corrupt stash must not sweep the pot to a foreign address.
    // (Self-refund splits the pot to BOTH payout scripts via the covenant, but
    // the same check still guarantees OUR half lands at this wallet.)
    if (!state.arkAddress) throw new Error('Wallet address unavailable for forfeit claim.')
    const expectedPayout = hex.encode(ArkAddress.decode(state.arkAddress).pkScript)
    if (stash.covenant.playerPayoutPkScript !== expectedPayout) {
      throw new Error('v0.4 forfeit refused: the stashed pot does not pay this wallet (tampered or corrupt stash).')
    }
    const current = await reconcileRecovery(stash, wallet)
    if (current.kind === 'spent') return
    if (current.kind === 'staged') stash = { ...stash, stageTwoOutpoint: current.outpoint }
    const identity = SingleKey.fromHex(privateKey)
    const arkInfo = await wallet.arkProvider.getInfo()
    const serverUnroll = decodeTapscript(hex.decode(arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
    const cv = stash.covenant

    // SELF-REFUND path (no player secret — a restored stash). Covenant-only
    // split-back of OUR stake; gate on cancelDelay; treat already-spent as done.
    if (pickV4ClaimPath(stash) === 'self-refund') {
      const chainTime = await chainTipTime()
      // Gate on the cooperativeSpend CLTV (cancelDelay), which arkd enforces
      // against the chain's MTP. Before it, show "recovering", not an error.
      if (!isCltvMatured(chainTime, cv.cancelDelay)) {
        const lifts = new Date(cv.cancelDelay * 1000).toLocaleString()
        throw new Error(
          chainTime !== null
            ? `Recovering — the refund timelock lifts at ${lifts} (chain time, as new blocks are mined).`
            : `Recovering — waiting for the chain tip before the refund can be submitted (timelock lifts at ${lifts}).`,
        )
      }
      const refund = buildV4SelfRefund(stash, serverUnroll)
      const body = await prepareSettleForEmulator(refund, wallet.indexerProvider, wallet.onchainProvider)
      const resp = await fetch(`${stash.forfeitEmulatorUrl}/v1/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUTS.emulator),
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const text = await resp.text()
        if (isAlreadySpentError(text)) {
          const status = await reconcileRecovery(stash, wallet)
          if (status.kind === 'spent' || status.kind === 'staged') return
          throw new Error('Waiting for the operator to confirm the spend; recovery data is kept.')
        }
        // CLTV not yet satisfied at the chain's MTP — keep the stash, retry later.
        if (/locked|too early|CLTV|locktime/i.test(text)) {
          throw new Error("Not reclaimable yet — the chain's block time hasn't reached the refund timelock. Try again shortly.")
        }
        throw new Error(`Emulator rejected v0.4 self-refund: ${text}`)
      }
      await reconcileRecovery({ ...stash, confirmationPending: true }, wallet)
      return
    }

    // FORFEIT path (we hold the secret) — pickV4ClaimPath narrows it to truthy,
    // but assert for the type and to fail closed on a corrupt empty secret.
    if (!stash.playerSecretHex) throw new Error('v0.4 forfeit refused: missing player secret.')
    const playerSecretHex = stash.playerSecretHex
    const pot = rebuildJointPot(cv)
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
          return s
        }),
      )
      const body = await prepareSettleForEmulator({ arkTx: signed, checkpoints: checkpointTxs }, wallet.indexerProvider, wallet.onchainProvider)
      const resp = await fetch(`${stash.forfeitEmulatorUrl}/v1/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUTS.emulator),
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const text = await resp.text()
        if (/locked|too early|CLTV|locktime/i.test(text)) {
          throw new Error("Not claimable yet — the chain's block time hasn't reached the takeAll CLTV. Try again shortly.")
        }
        throw new Error(`Emulator rejected v0.4 ${label}: ${text}`)
      }
      const returned = Transaction.fromPSBT(base64.decode((await resp.json() as { signedArkTx: string }).signedArkTx))
      if (returned.id !== built.arkTx.id) throw new Error('Emulator response does not match the submitted recovery transaction')
      return returned.id
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
        playerRevealBytes: hex.decode(playerSecretHex),
        serverUnroll,
      })
      try {
        await signAndPostV4(reveal, 'playerReveal (stage 1)')
      } catch (error) {
        const status = await reconcileRecovery(stash, wallet)
        if (status.kind !== 'spent' && status.kind !== 'staged') throw error
        return
      }
      await reconcileRecovery({ ...stash, confirmationPending: true }, wallet)
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
    await reconcileRecovery({ ...stash, confirmationPending: true }, wallet)
  } finally {
    commit('CLEAR_CLAIMING', gameId)
  }
}

/**
 * One pass over every stashed game: if its CLTV has matured and no
 * claim is in flight, fire the better one (forfeit > refund) with
 * `mode: 'auto'`. Backgrounded by `autoClaimTimer`; also safe to
 * dispatch manually (e.g. immediately after connect so a stash
 * past expiry doesn't wait one full tick).
 */
export async function runAutoClaim({ state, rootState, commit, dispatch }: ArkCtx) {
  const wallet = sdkWallet
  if (!wallet) return
  const v4Forfeits = await loadV4Forfeits()
  if (!v4Forfeits.length) return
  const chainTime = await chainTipTime()
  if (chainTime === null) return
  for (let v4 of v4Forfeits) {
    if (state.claimingGames[v4.gameId]) continue
    if (!hasClaimableV4Forfeit(v4) || v4.covenant.playerPubkey !== rootState.wallet.publicKey) continue
    const current = await reconcileRecovery(v4, wallet)
    if (current.kind === 'spent') continue
    if (current.kind === 'staged') v4 = { ...v4, stageTwoOutpoint: current.outpoint }
    const selfRefund = pickV4ClaimPath(v4) === 'self-refund'
    // SELF-REFUND ONLY: back off a restored stash whose covenant the emulator
    // keeps rejecting (it can never succeed) so we don't spam /v1/tx. The
    // already-spent case clears the stash inside claimV4Forfeit; this catches
    // OTHER permanent failures. The staged-forfeit path is intentionally never
    // backed off (keep retrying a take-the-whole-pot claim).
    if (selfRefund && hasExhaustedReclaim(v4.claimFailures)) {
      // Gated OFF by default (COOPERATIVE_EXIT_ENABLED) — when disabled we give up
      // on the exhausted self-refund exactly as before (the stake still recovers via
      // the server's refund timer). Only when the operator opts in does the on-chain
      // escalation below run. Keeps the not-yet-live-verified path dormant in prod.
      if (!COOPERATIVE_EXIT_ENABLED) continue
      // ESCALATION: the emulator-based self-refund has permanently failed (the
      // emulator is unreachable / the covenant keeps getting rejected). Fall to
      // the EMULATOR-FREE on-chain cooperative exit (leaf 7): unroll the pot
      // on-chain, then spend `cooperativeSpendExit`, the house co-signing via
      // POST /api/v4/game/:id/cooperative-exit. Fail-safe by construction
      // (stepCooperativeExit moves NOTHING until the player funds the on-chain
      // bumper AND the exit CSV matures AND the house co-signs); it re-derives its
      // stage from the chain each tick, so we just step it once per pass. Only
      // reached AFTER the cheaper self-refund is exhausted, so it can't regress it.
      // ⚠️ The unroll's multi-tick browser stepping is LIVE-UNVERIFIED — see
      // v4CooperativeExitIo. Any glue bug stalls the flow visibly, never mis-sends.
      //
      // Hold the per-game claim mutex for the duration of the step — same as the
      // sibling claim paths (claimV4Forfeit etc). The 15s auto-claim interval does
      // NOT await the prior tick, and a single step fans out to several network
      // round-trips (balance / tx-status / unroll broadcast / co-sign), so without
      // this two overlapping ticks could double-unroll / double-broadcast the exit
      // for the same game. The loop-top `claimingGames` guard + this SET make it a
      // true cross-tick mutex; it's cleared each tick so it never holds across the
      // multi-tick wait.
      commit('SET_CLAIMING', { gameId: v4.gameId, info: { kind: 'forfeit', mode: 'auto' } })
      try {
        const { wallet, privateKey } = requireWalletAndKey(rootState)
        const io = makeCooperativeExitIo({
          identity: SingleKey.fromHex(privateKey),
          explorer: wallet.onchainProvider,
          indexer: wallet.indexerProvider,
          network: state.networkPreset as NetworkName,
          gameId: v4.gameId,
          stash: v4,
          exitFeeSats: V4_EXIT_FEE_SATS,
          cosign: v4CooperativeExit,
        })
        const progress = await stepCooperativeExit({
          exitDelaySeconds: Number(v4.covenant.exitDelay),
          minFeeSats: V4_EXIT_BUMPER_MIN_SATS,
          io,
        })
        console.info(`[auto-claim:v4-exit] ${v4.gameId}: ${progress.stage}${progress.detail ? ` — ${progress.detail}` : ''}`)
      } catch (e) {
        console.warn(`[auto-claim:v4-exit] ${v4.gameId} exit step failed (will retry):`, getErrorMessage(e))
      } finally {
        commit('CLEAR_CLAIMING', v4.gameId)
      }
      continue
    }
    // Timing gate. A restored, no-secret stash can ONLY self-refund its own
    // stake (no secret to reveal), which arkd allows once chain time passes the
    // cooperativeSpend CLTV (cancelDelay). A secret-bearing stash runs the
    // two-stage forfeit (v4ClaimStage: stage 1 before cancelDelay to pre-empt the
    // refund and sweep the WHOLE pot, stage 2 at finalExpiration).
    if (selfRefund) {
      if (!isCltvMatured(chainTime, v4.covenant.cancelDelay)) continue
    } else if (v4ClaimStage(v4, chainTime) === 'wait') {
      continue
    }
    try {
      await dispatch('claimV4Forfeit', { gameId: v4.gameId, mode: 'auto' })
    } catch (e) {
      const msg = getErrorMessage(e)
      // For a self-refund, count PERMANENT failures so auto-claim backs off
      // (the stake still recovers via the server's own refund timer). Transient
      // (network / CLTV-timing "not reclaimable yet") failures are NOT counted.
      // For the staged forfeit, keep the stash on ANY error and retry — erring
      // toward keeping the recovery record is the only safe bias for the pot.
      if (selfRefund && !isTransientSelfRefundError(msg)) {
        const claimFailures = (v4.claimFailures ?? 0) + 1
        await putV4Forfeit({ ...v4, claimFailures, lastClaimError: msg })
        if (hasExhaustedReclaim(claimFailures)) {
          console.warn(
            `[auto-claim:v4] ${v4.gameId}: giving up on self-refund after ${claimFailures} permanent ` +
              `failures. The stake still recovers via the server's refund timer; not retrying.`,
          )
        }
      }
      console.warn(`[auto-claim:v4] ${v4.gameId} failed (will retry):`, msg)
    }
  }
}
