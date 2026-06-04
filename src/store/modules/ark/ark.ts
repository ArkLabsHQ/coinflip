import { Module } from 'vuex'
import { hex, base64 } from '@scure/base'
import type { State as RootState } from '@/store'
import {
  Wallet, SingleKey, VtxoScript,
  buildOffchainTx, decodeTapscript, CSVMultisigTapscript, ConditionWitness, setArkPsbtField, Transaction, ArkAddress,
  type WalletBalance, type ExtendedVirtualCoin, type ArkTxInput, type ArkProvider, type Identity,
} from '@arkade-os/sdk'
import { initSwaps, destroySwaps } from '@/services/boltz'
import {
  getNetwork, play as apiPlay, commit as apiCommit, refund as apiRefund,
  forfeit as apiForfeit,
  type Outpoint,
} from '@/services/api'
import { createHash } from '@/utils/crypto'
import { upgradeEsploraUrl } from '@/utils/esploraUrl'

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
// Guards the manual boarding settle so concurrent refreshBalance calls don't
// fire overlapping settlement rounds (settlementConfig is false — see Wallet.create).
let settling = false
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

export function getSDKWallet(): Wallet | null {
  return sdkWallet
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
  } catch {
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

    async refreshBalance({ commit, state, dispatch }) {
      if (!sdkWallet || state.status !== 'connected') return

      try {
        const balance = await sdkWallet.getBalance()
        commit('SET_WALLET_BALANCE', balance)

        // settlementConfig is false, so the SDK won't auto-settle boarding.
        // Settle it ourselves once funds land (guarded against concurrency).
        // Fire-and-forget: the round is slow; the next refresh shows the result.
        if (balance.boarding.total > 0 && !settling) {
          settling = true
          const w = sdkWallet
          w.settle()
            .then(() => dispatch('refreshBalance'))
            .catch((e) => console.warn('boarding settle failed:', e))
            .finally(() => { settling = false })
        }

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

        // Fetch wallet transaction history (Ark + boarding combined).
        // SDK returns ArkTransaction[] with TxKey carrying arkTxid /
        // commitmentTxid / boardingTxid — flatten to a single best-effort
        // txid and a `isBoarding` flag for the UI.
        const history = await sdkWallet.getTransactionHistory()
        commit('SET_TX_HISTORY', history.map((tx) => ({
          txid: tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid,
          type: tx.type,
          amount: tx.amount,
          settled: tx.settled,
          createdAt: tx.createdAt,
          isBoarding: !!tx.key.boardingTxid && !tx.key.arkTxid,
        })))
      } catch (error) {
        console.error('Failed to refresh balance:', error)
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

      const txid = await sdkWallet.settle(undefined, params?.eventCallback as never)

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
      { state, rootState, dispatch },
      { tier, side, oddsN, oddsTarget, oddsLo }: { tier: number; side?: 'heads' | 'tails'; oddsN?: number; oddsTarget?: number; oddsLo?: number },
    ) {
      if (!sdkWallet) throw new Error('Wallet not connected')
      const privateKey = rootState.wallet.privateKey
      if (!privateKey) throw new Error('No wallet key available')
      const playerPubkey = rootState.wallet.publicKey
      if (!playerPubkey) throw new Error('No wallet public key available')
      const playerChangeAddress = state.arkAddress
      if (!playerChangeAddress) throw new Error('No Ark address available — wallet still connecting?')

      const identity = SingleKey.fromHex(privateKey)
      const arkProvider = sdkWallet.arkProvider
      const arkInfo = await arkProvider.getInfo()
      const serverUnroll = decodeTapscript(hex.decode(arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

      // 1. Commit a secret + start the game. Coin: 15B heads / 16B tails.
      // Variable-odds: encode a uniform digit in [0, oddsN) as the secret LENGTH
      // (base 16 = the lib's VARIABLE_ODDS_BASE_LEN), so the summed roll is fair.
      const isVariable = oddsN !== undefined && oddsTarget !== undefined
      let secretBytes: Uint8Array
      if (isVariable) {
        const VARIABLE_ODDS_BASE_LEN = 16 // must match arkade-coinflip's constant
        secretBytes = new Uint8Array(VARIABLE_ODDS_BASE_LEN + uniformRandomInt(oddsN as number))
      } else {
        secretBytes = new Uint8Array(side === 'tails' ? 16 : 15)
      }
      crypto.getRandomValues(secretBytes)
      const playerSecretHex = Array.from(secretBytes).map((b) => b.toString(16).padStart(2, '0')).join('')
      const playerHash = await createHash(secretBytes)

      const playRes = await apiPlay(
        tier, playerPubkey, playerHash, playerChangeAddress,
        isVariable ? { oddsN: oddsN as number, oddsTarget: oddsTarget as number, oddsLo: oddsLo ?? 0 } : undefined,
      )

      // 2. Escrow the player's stake into the shared escrow address (single-party).
      const escrowPk = ArkAddress.decode(playRes.escrowAddress).pkScript
      const dust = state.info?.dust ? parseInt(state.info.dust) : 546
      const candidates = (await sdkWallet.getVtxos())
        .filter((v: ExtendedVirtualCoin) => v.virtualStatus.state !== 'spent' && v.value >= tier)
        .sort((a, b) => Number(b.value - a.value))
      if (candidates.length === 0) throw new Error(`No spendable VTXO covering ${tier} sats`)
      // Avoid minting a sub-dust change VTXO (unspendable): the escrow tx must
      // leave either exact change or >= dust. Mirrors the server's
      // pickEscrowVtxo. If every candidate would leave dust, refuse rather than
      // burn the change — the player consolidates (settles) and retries.
      const pv = candidates.find((v) => { const c = v.value - tier; return c === 0 || c >= dust })
      if (!pv) {
        throw new Error(
          `No dust-safe VTXO for ${tier} sats — every candidate would leave sub-dust change (< ${dust}). ` +
          `Consolidate your balance (settle) and try again.`,
        )
      }
      const change = pv.value - tier
      const outputs: { script: Uint8Array; amount: bigint }[] = [{ script: escrowPk, amount: BigInt(tier) }]
      if (change > 0) outputs.push({ script: ArkAddress.decode(playerChangeAddress).pkScript, amount: BigInt(change) })
      const escrowInput: ArkTxInput = { txid: pv.txid, vout: pv.vout, value: pv.value, tapLeafScript: pv.forfeitTapLeafScript, tapTree: pv.tapTree }
      const escrowTx = buildOffchainTx([escrowInput], outputs, serverUnroll)
      const playerEscrowTxid = await submitOffchain(arkProvider, identity, escrowTx.arkTx, escrowTx.checkpoints, [0])
      const playerEscrow: Outpoint = { txid: playerEscrowTxid, vout: 0, value: tier }

      // 2b. Stash a self-submittable refund BEFORE revealing. If the server now
      // stalls, the player can still reclaim the escrow after finalExpiration
      // without trusting it. Best-effort: a stash failure shouldn't abort a game
      // that will almost certainly resolve, but log it loudly.
      try {
        const r = await apiRefund(playRes.gameId, playerEscrow)
        await stashRefund({
          gameId: playRes.gameId, tier, playerEscrow,
          refundPsbt: r.refundPsbt, refundCheckpoints: r.refundCheckpoints,
          finalExpiration: r.finalExpiration, createdAt: Date.now(),
        })
      } catch (e) {
        console.warn('[trustless] could not stash refund (continuing):', e instanceof Error ? e.message : e)
      }

      // 2c. Stash the arkade-script forfeit tx. The emulator URL comes from
      // /api/network (the server publishes the browser-reachable one). The
      // PSBT goes to the emulator's /v1/tx — the emulator validates the
      // covenant, co-signs the tweaked slot, and forwards to arkd.
      // VERIFY before stashing: payoutAddress must equal our own change address.
      try {
        const { emulator } = await getNetwork()
        if (!emulator) {
          throw new Error('Server reports no emulator configured — required for forfeit stash')
        }
        const f = await apiForfeit(playRes.gameId, playerEscrow)
        if (f.payoutAddress !== playerChangeAddress) {
          console.warn('[trustless] forfeit payoutAddress mismatch — refusing to stash')
        } else {
          await updateRefundStash(playRes.gameId, {
            forfeitPsbt: f.forfeitPsbt,
            forfeitCheckpoints: f.forfeitCheckpoints,
            forfeitClaimableAt: f.forfeitClaimableAt,
            forfeitEmulatorUrl: emulator.url,
            playerSecretHex,
          })
        }
      } catch (e) {
        console.warn('[trustless] could not stash forfeit (continuing):', e instanceof Error ? e.message : e)
      }

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
        const when = new Date(playRes.finalExpiration * 1000).toLocaleString()
        throw new Error(
          `${e instanceof Error ? e.message : 'Game failed to resolve'} — your ${tier} sat stake is safe and reclaimable after ${when} (see "Reclaim stalled bets").`,
        )
      }
      await clearRefund(playRes.gameId)

      await dispatch('refreshBalance').catch(() => { /* deferred for indexer lag */ })
      return result
    },

    /** Locally-stashed stalled bets (escrows reclaimable if the server stalled). */
    async listStalledBets(): Promise<StashedRefund[]> {
      return loadRefunds()
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
      { state, rootState, dispatch, commit },
      payload: string | { gameId: string; mode?: ClaimMode },
    ) {
      const { gameId, mode = 'manual' } =
        typeof payload === 'string' ? { gameId: payload, mode: 'manual' as ClaimMode } : payload
      if (state.claimingGames[gameId]) {
        throw new Error('A claim is already in progress for this game.')
      }
      if (!sdkWallet) throw new Error('Wallet not connected')
      const privateKey = rootState.wallet.privateKey
      if (!privateKey) throw new Error('No wallet key available')
      const stash = (await loadRefunds()).find((x) => x.gameId === gameId)
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
        const refundCps = stash.refundCheckpoints.map((c) => Transaction.fromPSBT(hex.decode(c)))
        try {
          await submitOffchain(sdkWallet.arkProvider, identity, refundArk, refundCps, [0])
        } catch (e) {
          // Race: our chain-time read passed the CLTV but arkd's tip MTP still
          // trails it. Surface a clear "wait for the next block" instead of the
          // raw FORFEIT_CLOSURE_LOCKED — the stash is kept so a retry still works.
          const msg = e instanceof Error ? e.message : String(e)
          if (/FORFEIT_CLOSURE_LOCKED|is locked|locked/i.test(msg)) {
            throw new Error("Not reclaimable yet — the chain hasn't mined a block past the timelock. Try again shortly.")
          }
          throw e
        }
        await clearRefund(gameId)
        await dispatch('refreshBalance').catch(() => { /* deferred for indexer lag */ })
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
      { state, rootState, dispatch, commit },
      payload: string | { gameId: string; mode?: ClaimMode },
    ) {
      const { gameId, mode = 'manual' } =
        typeof payload === 'string' ? { gameId: payload, mode: 'manual' as ClaimMode } : payload
      if (state.claimingGames[gameId]) {
        throw new Error('A claim is already in progress for this game.')
      }
      if (!sdkWallet) throw new Error('Wallet not connected')
      const privateKey = rootState.wallet.privateKey
      if (!privateKey) throw new Error('No wallet key available')
      const stash = (await loadRefunds()).find((x) => x.gameId === gameId)
      if (
        !stash || !stash.forfeitPsbt || !stash.forfeitCheckpoints ||
        !stash.forfeitEmulatorUrl || stash.forfeitClaimableAt === undefined
      ) {
        throw new Error('No forfeit stashed for this game — use reclaim instead.')
      }
      if (!stash.revealed) {
        throw new Error("Can't forfeit-claim a game that wasn't revealed — use refund instead.")
      }

      commit('SET_CLAIMING', { gameId, info: { kind: 'forfeit', mode } })
      try {
        const identity = SingleKey.fromHex(privateKey)
        const arkTx = Transaction.fromPSBT(hex.decode(stash.forfeitPsbt))
        // Both inputs are 3-of-3 [player, server, emulator_tweaked]. The player
        // signs both player slots; arkd signs server slots; the emulator signs
        // the tweaked slots after running the arkade script.
        const signed = await identity.sign(arkTx, [0, 1])
        const cps = stash.forfeitCheckpoints.map((c) => Transaction.fromPSBT(hex.decode(c)))

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

        await clearRefund(gameId)
        await dispatch('refreshBalance').catch(() => { /* indexer lag */ })
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
        const canForfeit =
          stash.revealed === true &&
          !!stash.forfeitPsbt &&
          !!stash.forfeitEmulatorUrl &&
          stash.forfeitClaimableAt !== undefined &&
          chainTime >= stash.forfeitClaimableAt
        const canRefund = chainTime >= stash.finalExpiration
        try {
          if (canForfeit) {
            await dispatch('claimForfeit', { gameId: stash.gameId, mode: 'auto' })
          } else if (canRefund) {
            await dispatch('reclaimStalledBet', { gameId: stash.gameId, mode: 'auto' })
          }
        } catch (e) {
          // Transient — next tick retries. Log once so a persistent
          // failure shows up in console.
          console.warn(
            `[auto-claim] ${stash.gameId} failed:`,
            e instanceof Error ? e.message : e,
          )
        }
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
    networkPreset: (state) => state.networkPreset,
    networkPresets: () => NETWORK_PRESETS,
  }
}

export default ark
