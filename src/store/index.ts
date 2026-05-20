import { createStore } from 'vuex'
import wallet from './modules/wallet'
import { privateKeyToNsec } from '@/utils/nostr'
import ark from './modules/ark/ark'
import type { ArkServerInfo } from './modules/ark/ark'

export interface State {
  wallet: {
    privateKey: string | null
    publicKey: string | null
    isInitialized: boolean
  }
  walletBalance: number
  btcPrice: number
  ark: {
    server: string
    status: 'disconnected' | 'connecting' | 'connected' | 'error'
    lastError: Error | null
    info: ArkServerInfo | null
  }
}

export default createStore<State>({
  state: {
    wallet: {
      privateKey: localStorage.getItem('wallet_privkey'),
      publicKey: localStorage.getItem('wallet_pubkey'),
      isInitialized: !!localStorage.getItem('wallet_privkey')
    },
    walletBalance: 0,
    btcPrice: 0,
    ark: {
      server: localStorage.getItem('ark_server') || 'http://localhost:7070',
      status: 'disconnected',
      lastError: null,
      info: null
    },
  },
  modules: {
    wallet,
    ark,
  },
  getters: {
    formattedBalance: (state: State) => {
      return `${state.walletBalance.toFixed(8)} BTC`
    },
    usdBalance: (state: State) => {
      return (state.walletBalance * state.btcPrice).toFixed(2)
    },
    arkServer: (state: State) => state.ark.server,
    arkStatus: (state: State) => state.ark.status,
    nsecKey: (state: State) => {
      return state.wallet.privateKey ? privateKeyToNsec(state.wallet.privateKey) : null
    },
    serverPubkey: (state: State) => state.ark.info?.pubkey || null,
  },
  mutations: {
    SET_BALANCE(state: State, balance: number) {
      state.walletBalance = balance
    },
    SET_BTC_PRICE(state: State, price: number) {
      state.btcPrice = price
    },
    SET_ARK_STATUS(state: State, status: State['ark']['status']) {
      state.ark.status = status
    },
    SET_ARK_ERROR(state: State, error: Error | null) {
      state.ark.lastError = error
    },
    SET_ARK_SERVER(state: State, server: string) {
      state.ark.server = server
      localStorage.setItem('ark_server', server)
    },
    SET_ARK_INFO(state: State, info: ArkServerInfo) {
      state.ark.info = info
    },
  },
  actions: {
    async fetchBTCPrice({ commit }) {
      try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd')
        const data = await response.json()
        commit('SET_BTC_PRICE', data.bitcoin.usd)
      } catch (error) {
        console.error('Failed to fetch BTC price:', error)
      }
    },
    async checkArkConnection({ commit, state }) {
      try {
        commit('SET_ARK_STATUS', 'connecting')
        const response = await fetch(`${state.ark.server}/v1/info`, {
          signal: AbortSignal.timeout(5000)
        })

        if (response.ok) {
          const data = await response.json()
          commit('SET_ARK_STATUS', 'connected')
          commit('SET_ARK_ERROR', null)
          return data
        } else {
          throw new Error(`Server returned ${response.status}`)
        }
      } catch (error) {
        console.error('Failed to connect to Ark server:', error)
        commit('SET_ARK_STATUS', 'error')
        commit('SET_ARK_ERROR', error instanceof Error ? error : new Error('Connection failed'))
        return null
      }
    },
    async initializeApp({ dispatch, state }) {
      if (state.wallet.isInitialized) {
        await dispatch('fetchBTCPrice')
      }
    },
  }
})
