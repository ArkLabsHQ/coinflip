import { Module } from 'vuex'
import { generatePrivateKey, getPublicKey, nip19 } from 'nostr-tools'

export type { WalletState }

interface WalletState {
  privateKey: string | null
  publicKey: string | null
  isInitialized: boolean
}

interface RootState {
  wallet: WalletState
}

const wallet: Module<WalletState, RootState> = {
  state: {
    privateKey: localStorage.getItem('wallet_privkey'),
    publicKey: localStorage.getItem('wallet_pubkey'),
    isInitialized: !!localStorage.getItem('wallet_privkey')
  },

  getters: {
    isWalletInitialized: (state: WalletState) => state.isInitialized,
    walletPrivateKey: (state: WalletState) => state.privateKey,
    walletPrivateKeyEncoded: (state: WalletState) => !!state.privateKey && nip19.nsecEncode(state.privateKey),
    walletPublicKey: (state: WalletState) => state.publicKey
  },

  mutations: {
    SET_WALLET(state: WalletState, { privateKey, publicKey }: { privateKey: string | null, publicKey: string | null }) {
      state.privateKey = privateKey
      state.publicKey = publicKey
      state.isInitialized = !!privateKey
    }
  },

  actions: {
    createNewWallet({ commit }) {
      const privateKey = generatePrivateKey()
      const publicKey = getPublicKey(privateKey)
      
      localStorage.setItem('wallet_privkey', privateKey)
      localStorage.setItem('wallet_pubkey', publicKey)
      
      commit('SET_WALLET', { privateKey, publicKey })
    },

    restoreWallet({ commit }, nsecKey: string) {
      let privateKey: string
      try {
        const { type, data } = nip19.decode(nsecKey)
        if (type !== 'nsec') throw new Error('Invalid nsec key')
        privateKey = data
      } catch (err) {
        throw new Error('Invalid private key format', { cause: err })
      }

      const publicKey = getPublicKey(privateKey)
      
      localStorage.setItem('wallet_privkey', privateKey)
      localStorage.setItem('wallet_pubkey', publicKey)
      
      commit('SET_WALLET', { privateKey, publicKey })
    },

    clearWallet({ commit }) {
      localStorage.removeItem('wallet_privkey')
      localStorage.removeItem('wallet_pubkey')
      
      commit('SET_WALLET', { privateKey: null, publicKey: null })
    }
  }
}

export default wallet 