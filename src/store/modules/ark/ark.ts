import { Module } from 'vuex'
import type { State as RootState } from '@/store'
import type { WalletBalance, Activity } from '@arkade-os/sdk'
import {
  getNetwork,
  getRestoreChallenge, restoreGamesFromServer,
  type GameSummary, type V4ReclaimHint,
} from '@/services/api'
import { signChallenge } from '@/utils/signChallenge'
import type { StashedV4Forfeit } from './v4ForfeitStash'
import { loadV4Forfeits, saveV4Forfeits } from './v4ForfeitStashStore'
import { getErrorMessage } from '@/utils/errors'
import { rearmV4ReclaimHints } from './v4Recovery'
// The module-mutable SDK-wallet runtime — the `sdkWallet` handle, its timers/
// flags, and every action that touches them — lives in walletRuntime.ts. The
// wrapper actions below delegate there with the live ActionContext.
import * as walletRuntime from './walletRuntime'
import type {
  StashedRefund, ArkServerInfo, ArkVTXO, BoardingUtxo, ClaimMode, ClaimingInfo, ArkState,
} from './arkTypes'

// Stash backend moved to IndexedDB via @/utils/stashStore. The shape and
// reducer semantics are unchanged from the prior localStorage version;
// these thin re-exports keep the call-site names familiar.
import {
  loadStashes as loadRefunds,
  saveStashes as saveAllRefunds,
} from '@/utils/stashStore'

const getCachedServerInfo = (): ArkServerInfo | null => {
  const cached = localStorage.getItem('ark_server_info')
  return cached ? JSON.parse(cached) : null
}

const ark: Module<ArkState, RootState> = {
  namespaced: true,

  state: {
    server: localStorage.getItem('ark_server') || `http://${walletRuntime.regtestHost()}:7070`,
    // Esplora REST under the mempool `/api` prefix — see NETWORK_PRESETS.
    esplora: localStorage.getItem('ark_esplora') || `http://${walletRuntime.regtestHost()}:3000/api`,
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

    /** Connect the SDK wallet — impl in walletRuntime.ts (the sole `sdkWallet` writer). */
    checkConnection(ctx) {
      return walletRuntime.checkConnection(ctx)
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

    /** Refresh balance (+ boarding auto-settle) — impl in walletRuntime.ts. */
    refreshBalance(ctx, payload?: { light?: boolean }) {
      return walletRuntime.refreshBalance(ctx, payload)
    },

    /** Load the grouped activity history — impl in walletRuntime.ts. */
    refreshHistory(ctx) {
      return walletRuntime.refreshHistory(ctx)
    },

    /** Send sats — impl in walletRuntime.ts. */
    sendBitcoin(ctx, payload: { address: string; amount: number }) {
      return walletRuntime.sendBitcoin(ctx, payload)
    },

    /** Manual settle (shares the boarding-settle singleFlight) — impl in walletRuntime.ts. */
    settle(ctx, params?: { eventCallback?: (event: unknown) => void }) {
      return walletRuntime.settle(ctx, params)
    },

    /** Play one v0.4 joint-pot game end-to-end — impl in walletRuntime.ts. */
    playV4Game(ctx, payload: { tier: number; side?: 'heads' | 'tails'; oddsN?: number; oddsTarget?: number; oddsLo?: number; emulatorUrl?: string }) {
      return walletRuntime.playV4Game(ctx, payload)
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
      return walletRuntime.chainTipTime()
    },

    /** Reclaim a stalled bet's stashed refund — impl in walletRuntime.ts. */
    reclaimStalledBet(ctx, payload: string | { gameId: string; mode?: ClaimMode }) {
      return walletRuntime.reclaimStalledBet(ctx, payload)
    },

    /** Submit the stashed arkade-script forfeit claim — impl in walletRuntime.ts. */
    claimForfeit(ctx, payload: string | { gameId: string; mode?: ClaimMode }) {
      return walletRuntime.claimForfeit(ctx, payload)
    },

    /** v0.4 joint-pot recovery (staged forfeit / self-refund) — impl in walletRuntime.ts. */
    claimV4Forfeit(ctx, payload: string | { gameId: string; mode?: ClaimMode }) {
      return walletRuntime.claimV4Forfeit(ctx, payload)
    },

    /** Background auto-claim pass over every stashed game — impl in walletRuntime.ts. */
    runAutoClaim(ctx) {
      return walletRuntime.runAutoClaim(ctx)
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
    networkPresets: () => walletRuntime.NETWORK_PRESETS,
  }
}

// Re-export the previously-public types + guard so external import paths
// (`@/store/modules/ark/ark`) keep resolving unchanged after the split.
export type { StashedRefund, ArkServerInfo, ArkVTXO, BoardingUtxo, ClaimMode, ClaimingInfo }
export type { ClaimKind } from './arkTypes'
export type { ForfeitClaimable } from './arkHelpers'
export { hasStashedForfeit } from './arkHelpers'
// The SDK-wallet accessor + network presets moved to walletRuntime.ts with the
// connect flow that owns them; re-exported so this module's surface is unchanged.
export { getSDKWallet, NETWORK_PRESETS } from './walletRuntime'
export type { NetworkPreset } from './walletRuntime'

export default ark
