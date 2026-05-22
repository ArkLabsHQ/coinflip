import { Module } from 'vuex'
import { hex } from '@scure/base'
import type { State as RootState } from '@/store'
import { Wallet, SingleKey, VtxoScript, type WalletBalance, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import { initSwaps, destroySwaps } from '@/services/boltz'

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
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  lastError: Error | null
  info: ArkServerInfo | null
  vtxos: ArkVTXO[]
  boardingUtxos: BoardingUtxo[]
  walletBalance: WalletBalance | null
  arkAddress: string | null
  boardingAddress: string | null
  txHistory: TxHistoryEntry[]
}

// SDK wallet instance (kept outside Vuex state to avoid reactivity issues with complex objects)
let sdkWallet: Wallet | null = null

export function getSDKWallet(): Wallet | null {
  return sdkWallet
}

const getCachedServerInfo = (): ArkServerInfo | null => {
  const cached = localStorage.getItem('ark_server_info')
  return cached ? JSON.parse(cached) : null
}

const ark: Module<ArkState, RootState> = {
  namespaced: true,

  state: {
    server: localStorage.getItem('ark_server') || 'http://localhost:7070',
    esplora: localStorage.getItem('ark_esplora') || 'http://localhost:3000',
    status: 'disconnected',
    lastError: null,
    info: getCachedServerInfo(),
    vtxos: [],
    boardingUtxos: [],
    walletBalance: null,
    arkAddress: null,
    boardingAddress: null,
    txHistory: []
  },

  mutations: {
    SET_SERVER(state, server: string) {
      state.server = server
      localStorage.setItem('ark_server', server)
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
    }
  },

  actions: {
    updateServer({ commit }, server: string) {
      commit('SET_SERVER', server)
    },

    async checkConnection({ commit, state, rootState, dispatch }) {
      try {
        commit('SET_STATUS', 'connecting')

        const privateKey = rootState.wallet.privateKey
        if (!privateKey) {
          throw new Error('No wallet key available')
        }

        // Create SDK wallet
        const identity = SingleKey.fromHex(privateKey)
        const wallet = await Wallet.create({
          identity,
          arkServerUrl: state.server,
          esploraUrl: state.esplora,
        })

        sdkWallet = wallet

        // Get server info via REST for display
        const response = await fetch(`${state.server}/v1/info`, {
          signal: AbortSignal.timeout(5000)
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
        commit('SET_STATUS', 'error')
        commit('SET_ERROR', new Error(`Failed to connect: ${(error as Error).message}`))
        commit('SET_INFO', null)
        commit('SET_ARK_ADDRESS', null)
        commit('SET_BOARDING_ADDRESS', null)
        return null
      }
    },

    async refreshBalance({ commit, state }) {
      if (!sdkWallet || state.status !== 'connected') return

      try {
        const balance = await sdkWallet.getBalance()
        commit('SET_WALLET_BALANCE', balance)

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
  },

  getters: {
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
  }
}

export default ark
