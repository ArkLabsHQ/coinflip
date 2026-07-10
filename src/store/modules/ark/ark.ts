import { Module } from 'vuex'
import { hex, base64 } from '@scure/base'
import type { State as RootState } from '@/store'
import {
  Wallet, SingleKey, VtxoScript,
  ConditionWitness, setArkPsbtField, Transaction, ArkAddress,
  RestIndexerProvider, decodeTapscript, CSVMultisigTapscript,
  type WalletBalance, type ExtendedVirtualCoin, type ArkProvider, type Identity, type ArkTxInput,
  type Activity, type NetworkName,
} from '@arkade-os/sdk'
import { commitDigit as v3CommitDigit } from 'arkade-coinflip/dist/arkade-win'
// Subpath import (not the package root) so the browser bundle doesn't pull in
// the v2 transactions module, which imports Node's `crypto`.
import { buildCofundFromPlay, buildPlayerRevealTx, buildStageTwoTakeAllTx, encodeSettleForEmulator } from 'arkade-coinflip/dist/joint-pot-tx'
import { packets as cwpPackets } from '@arklabshq/contract-workflows-prototype'
import { initSwaps, destroySwaps } from '@/services/boltz'
import { singleFlight } from '@/utils/singleFlight'
import {
  getNetwork, getGame as apiGetGame,
  v4Play, v4Cofund, v4CofundFinalize, v4Reveal, v4CooperativeExit,
  getRestoreChallenge, restoreGamesFromServer,
  type Outpoint, type V4CovenantParams,
  type GameSummary, type V4ReclaimHint,
} from '@/services/api'
import { signChallenge } from '@/utils/signChallenge'
import { resolveV4ForfeitStash, hasClaimableV4Forfeit, v4ClaimStage, type V4PotOutpoint, type StashedV4Forfeit } from './v4ForfeitStash'
import { putV4Forfeit, deleteV4Forfeit, loadV4Forfeits, saveV4Forfeits } from './v4ForfeitStashStore'
import { buildV4SelfRefund, pickV4ClaimPath, rebuildJointPot, isAlreadySpentError, isTransientSelfRefundError, rearmV4ReclaimHint } from './v4SelfRefund'
import { stepCooperativeExit } from './v4CooperativeExit'
import { makeCooperativeExitIo, V4_EXIT_FEE_SATS, V4_EXIT_BUMPER_MIN_SATS } from './v4CooperativeExitIo'
import { createHash } from '@/utils/crypto'
import { upgradeEsploraUrl } from '@/utils/esploraUrl'
import { getErrorMessage } from '@/utils/errors'
import { isCltvMatured } from '@/utils/cltv'
import { withTimeout, TIMEOUTS } from '@/utils/withTimeout'
import { gameActivityResolver } from './gameActivityResolver'

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
  saveStashes as saveAllRefunds,
  deleteStash as clearRefund,
  patchStash as updateRefundStash,
} from '@/utils/stashStore'
import { isPermanentReclaimError, hasExhaustedReclaim } from '@/utils/reclaimBackoff'

/**
 * The structural fields a forfeit-claim needs, read off a stashed-refund record.
 * A loose subset of `StashedRefund` so this predicate keeps a narrow shape.
 */
export type ForfeitClaimable = {
  revealed?: boolean
  forfeitPsbt?: string
  forfeitCheckpoints?: string[]
  forfeitEmulatorUrl?: string
  forfeitClaimableAt?: number
}

/**
 * Does this stash hold a COMPLETE, revealed forfeit ready to be claimed?
 *
 * Single source of truth shared by the StalledBets "Claim full pot" button, the
 * `claimForfeit` action's precondition guard, and the background auto-claim poll.
 * Purely STRUCTURAL — it answers "is a forfeit stashed and revealed?", NOT "is
 * the CLTV mature yet?" (that time gate is layered on by the callers). It is a
 * TYPE GUARD, so callers that pass the check may read the forfeit fields as
 * defined. Relocated here when the legacy per-party-escrow (v2/v3) creation flow
 * was removed; it still backs recovery of already-escrowed stalled bets.
 */
export function hasStashedForfeit<T extends ForfeitClaimable>(
  stash: T,
): stash is T & {
  revealed: true
  forfeitPsbt: string
  forfeitCheckpoints: string[]
  forfeitEmulatorUrl: string
  forfeitClaimableAt: number
} {
  return (
    stash.revealed === true &&
    !!stash.forfeitPsbt &&
    Array.isArray(stash.forfeitCheckpoints) && stash.forfeitCheckpoints.length > 0 &&
    !!stash.forfeitEmulatorUrl &&
    stash.forfeitClaimableAt !== undefined
  )
}

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

// Coinflip's activity resolver lives in its own module so the game-tagging
// logic is unit-testable without the Vuex store. See gameActivityResolver.ts.


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
  /** Grouped activity view from the SDK's `wallet.getActivityHistory()` — a
   *  game's co-fund + settle collapse into one "Dice game" row via the resolver
   *  registered at connect (see `gameActivityResolver`). */
  activityHistory: Activity[]
  /** Load state for the Activity tab, so a failed/slow getActivityHistory reads
   *  as an error the user can retry — not as a genuinely empty "No activity yet". */
  activityStatus: 'idle' | 'loading' | 'ready' | 'error'
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
  const { arkTxid, signedCheckpointTxs } = await withTimeout(
    arkProvider.submitTx(
      base64.encode(signed.toPSBT()),
      checkpoints.map((c) => base64.encode(c.toPSBT())),
    ),
    TIMEOUTS.submit,
    'submit transaction',
  )
  const finals: string[] = []
  for (const c of signedCheckpointTxs) {
    const tx = Transaction.fromPSBT(base64.decode(c))
    const idx: number[] = []
    for (let i = 0; i < tx.inputsLength; i++) idx.push(i)
    if (witness) for (const i of idx) setArkPsbtField(tx, i, ConditionWitness, witness)
    finals.push(base64.encode((await identity.sign(tx, idx)).toPSBT()))
  }
  await withTimeout(arkProvider.finalizeTx(arkTxid, finals), TIMEOUTS.submit, 'finalize transaction')
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

export function getSDKWallet(): Wallet | null {
  return sdkWallet
}

/**
 * After the joint pot is co-funded,
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
 * Actionable-restore re-arm: for each PENDING v4 reclaim hint, persist a no-secret
 * SELF-REFUND stash so StalledBets + auto-claim can reclaim the player's own stake.
 *
 * Pure decision in `rearmV4ReclaimHint` (unit-tested); this wrapper is the network/
 * storage glue. Best-effort and idempotent:
 *  - skips a hint we already hold as a FUNDED (secret-bearing) stash — that one can
 *    sweep the WHOLE pot, so a no-secret restore must never downgrade it;
 *  - refreshes an existing no-secret stash in place (covenant/outpoint may have moved
 *    from null→known since a pre-co-fund restore);
 *  - never throws: a re-arm failure must not break the history return, and the
 *    server's own refund timer remains the backstop.
 */
async function rearmV4ReclaimHints(
  hints: V4ReclaimHint[],
  games: GameSummary[],
  arkAddress: string | null,
): Promise<void> {
  if (!arkAddress) {
    console.info(`[restore] ${hints.length} v4 reclaim hint(s) returned, but the wallet isn't connected yet — re-arm deferred to a post-connect restore.`)
    return
  }
  let emulatorUrl: string | undefined
  try {
    emulatorUrl = (await getNetwork()).emulator?.url
  } catch (e) {
    console.warn('[restore] could not reach /api/network for the emulator URL (continuing):', getErrorMessage(e))
  }
  let expectedPayout: string
  try {
    expectedPayout = addressToPkScriptHex(arkAddress)
  } catch (e) {
    console.warn('[restore] could not derive payout pkScript — skipping v4 re-arm:', getErrorMessage(e))
    return
  }
  const statusById = new Map(games.map((g) => [g.gameId, g.status]))
  const existing = await loadV4Forfeits()
  let rearmed = 0
  for (const hint of hints) {
    // Never downgrade a funded (secret-bearing) stash to a no-secret restore.
    const prior = existing.find((s) => s.gameId === hint.gameId)
    if (prior && pickV4ClaimPath(prior) === 'forfeit') continue
    const decision = rearmV4ReclaimHint({
      hint,
      status: statusById.get(hint.gameId) ?? 'pending',
      expectedPayoutPkScriptHex: expectedPayout,
      fallbackEmulatorUrl: emulatorUrl,
    })
    if (decision.kind !== 'rearm') {
      console.info(`[restore] v4 hint ${hint.gameId} not re-armed (${decision.reason})`)
      continue
    }
    try {
      // Preserve an existing no-secret stash's stage/backoff bookkeeping across a
      // re-restore (a fresh putV4Forfeit would otherwise reset claimFailures).
      await putV4Forfeit(prior ? { ...decision.stash, claimFailures: prior.claimFailures, lastClaimError: prior.lastClaimError } : decision.stash)
      rearmed++
    } catch (e) {
      console.error(`[restore] could not persist re-armed self-refund for ${hint.gameId} (continuing):`, getErrorMessage(e))
    }
  }
  console.info(`[restore] re-armed ${rearmed}/${hints.length} pending v4 reclaim hint(s) as self-refund stashes.`)
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
    activityHistory: [],
    activityStatus: 'idle',
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
    SET_ACTIVITY_HISTORY(state, activities: Activity[]) {
      state.activityHistory = activities
    },
    SET_ACTIVITY_STATUS(state, status: ArkState['activityStatus']) {
      state.activityStatus = status
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
     * Wipe ALL local stalled-bet stashes — v3 refunds/forfeits + v4 joint-pot
     * forfeits — from the `coinflip-stashes` IndexedDB (separate from the SDK's
     * store that purgeLocalData clears). Used by the deliberate "Clear wallet"
     * (wallet/clearWallet), NOT by resyncWallet: a resync keeps the key, so its
     * recovery stashes must survive. clearWallet also drops the wallet key that
     * the reclaim path needs to sign, so these stashes are orphaned regardless —
     * leaving them only strands dead "Reclaim stalled bets" rows (which otherwise
     * survive the clear AND a page reload, since they reload from this DB).
     */
    async purgeStashes() {
      // Best-effort per store: clear BOTH stash stores even if one rejects, and
      // never throw — clearWallet must not be blocked from dropping the wallet key
      // by a single stash-store write failing. Log a rejection so a persistent
      // failure stays visible.
      const results = await Promise.allSettled([saveAllRefunds([]), saveV4Forfeits([])])
      for (const r of results) {
        if (r.status === 'rejected') console.warn('[purgeStashes] a stash store failed to clear:', r.reason)
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
     * Fetch the wallet's grouped activity history. HEAVY — the SDK re-derives
     * the flat tx history from live on-chain state (an esplora /tx/:id/outspends
     * per boarding tx + indexer lookups), then runs the registered resolvers
     * (boarding built-in + our game resolver) to collapse a dice game's co-fund
     * + settle into one "Dice game" row. Deliberately NOT part of refreshBalance;
     * loaded on demand when the Activity tab is viewed and cached in
     * state.activityHistory until the next view.
     */
    async refreshHistory({ commit, state }) {
      if (!sdkWallet || state.status !== 'connected') return
      // Keep the last successfully-loaded list on screen while refreshing; only
      // show the spinner on the first load (nothing cached yet).
      commit('SET_ACTIVITY_STATUS', state.activityHistory.length ? 'ready' : 'loading')
      try {
        const activities = await withTimeout(sdkWallet.getActivityHistory(), TIMEOUTS.api, 'load activity')
        commit('SET_ACTIVITY_HISTORY', activities)
        commit('SET_ACTIVITY_STATUS', 'ready')
      } catch (error) {
        console.error('Failed to refresh history:', error)
        commit('SET_ACTIVITY_STATUS', 'error')
      }
    },

    async sendBitcoin(_ctx, { address, amount }: { address: string; amount: number }) {
      if (!sdkWallet) throw new Error('Wallet not connected')

      const txid = await withTimeout(sdkWallet.sendBitcoin({ address, amount }), TIMEOUTS.submit, 'send')

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
     * Place a bet via the v0.4 joint-pot flow — the only trustless flow now that
     * the legacy v0.2.x / v0.3 per-party escrow has been removed. The single
     * entry point the UI dispatches.
     */
    async placeTrustlessBet(
      { dispatch },
      payload: { tier: number; side?: 'heads' | 'tails'; oddsN?: number; oddsTarget?: number; oddsLo?: number },
    ) {
      const net = await getNetwork()
      return dispatch('playV4Game', { ...payload, emulatorUrl: net.emulator?.url })
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
          signal: AbortSignal.timeout(TIMEOUTS.emulator),
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
        // (Self-refund splits the pot to BOTH payout scripts via the covenant, but
        // the same check still guarantees OUR half lands at this wallet.)
        if (!state.arkAddress) throw new Error('Wallet address unavailable for forfeit claim.')
        const expectedPayout = hex.encode(ArkAddress.decode(state.arkAddress).pkScript)
        if (stash.covenant.playerPayoutPkScript !== expectedPayout) {
          throw new Error('v0.4 forfeit refused: the stashed pot does not pay this wallet (tampered or corrupt stash).')
        }
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
          const resp = await fetch(`${stash.forfeitEmulatorUrl}/v1/tx`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(TIMEOUTS.emulator),
            body: JSON.stringify(encodeSettleForEmulator(refund)),
          })
          if (!resp.ok) {
            const text = await resp.text()
            // Already refunded/settled (the server's timer beat us, paying our own
            // payout script) → success-equivalent: drop the stash, don't retry/spam.
            if (isAlreadySpentError(text)) {
              console.info(`[v4-self-refund] ${gameId}: pot already spent (server refunded) — clearing stash.`)
              await deleteV4Forfeit(gameId)
              return
            }
            // CLTV not yet satisfied at the chain's MTP — keep the stash, retry later.
            if (/locked|too early|CLTV|locktime/i.test(text)) {
              throw new Error("Not reclaimable yet — the chain's block time hasn't reached the refund timelock. Try again shortly.")
            }
            throw new Error(`Emulator rejected v0.4 self-refund: ${text}`)
          }
          // Our stake split back to our wallet → drop the stash.
          await deleteV4Forfeit(gameId)
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
              return base64.encode(s.toPSBT())
            }),
          )
          const resp = await fetch(`${stash.forfeitEmulatorUrl}/v1/tx`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(TIMEOUTS.emulator),
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
            playerRevealBytes: hex.decode(playerSecretHex),
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
    async runAutoClaim({ state, rootState, commit, dispatch }) {
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
              indexer: new RestIndexerProvider(state.server),
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
     * ACTIONABLE v4 RECOVERY: for each PENDING v4 `reclaimHint`, re-arm a no-secret
     * SELF-REFUND stash (StashedV4Forfeit with playerSecretHex: null) so the
     * StalledBets panel + auto-claim can reclaim the player's OWN stake via the
     * covenant-only `cooperativeSpend` split-back. The server never holds the
     * take-the-pot key, so a restored hint can't sweep the whole pot — only refund
     * the stake. This is a DEFENSIVE backstop to the server's own refund timer
     * (startV4RefundTimer); the claim dedups against it (already-spent ⇒ done).
     *
     * The re-arm needs this wallet's payout pkScript (to anti-tamper-bind the pot to
     * us) + an emulator URL; both come from a connected wallet (state.arkAddress) and
     * /api/network. When the wallet isn't connected yet we skip the re-arm and just
     * return the hints — a later restore (post-connect) re-arms them. Re-arm failures
     * never break the history return (the server's refund timer remains the backstop).
     */
    async restoreFromServer(
      { state, rootState },
    ): Promise<{ games: GameSummary[]; reclaimHints: V4ReclaimHint[] }> {
      const playerPubkey = rootState.wallet.publicKey
      const privateKey = rootState.wallet.privateKey
      if (!playerPubkey || !privateKey) throw new Error('No wallet key available to restore from')
      try {
        const { nonce } = await getRestoreChallenge(playerPubkey)
        const sig = signChallenge(nonce, privateKey)
        const { games, reclaimHints } = await restoreGamesFromServer(playerPubkey, nonce, sig)
        if (reclaimHints.length > 0) {
          await rearmV4ReclaimHints(reclaimHints, games, state.arkAddress)
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
    activityHistory: (state) => state.activityHistory,
    activityStatus: (state) => state.activityStatus,
    networkPreset: (state) => state.networkPreset,
    networkPresets: () => NETWORK_PRESETS,
  }
}

export default ark
