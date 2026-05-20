import { Module } from 'vuex'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { bech32 } from 'bech32'

export type { WalletState }

interface WalletState {
  privateKey: string | null
  publicKey: string | null
  isInitialized: boolean
}

interface RootState {
  wallet: WalletState
}

function generatePrivateKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return hex.encode(bytes)
}

function getPublicKey(privateKeyHex: string): string {
  return hex.encode(schnorr.getPublicKey(hex.decode(privateKeyHex)))
}

function nsecEncode(privateKeyHex: string): string {
  const words = bech32.toWords(Array.from(hex.decode(privateKeyHex)))
  return bech32.encode('nsec', words, 1023)
}

function nsecDecode(nsec: string): string {
  const { prefix, words } = bech32.decode(nsec, 1023)
  if (prefix !== 'nsec') throw new Error('Invalid nsec key')
  return hex.encode(new Uint8Array(bech32.fromWords(words)))
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
    walletPrivateKeyEncoded: (state: WalletState) => state.privateKey ? nsecEncode(state.privateKey) : false,
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
        // Accept both nsec-encoded and raw hex keys
        if (nsecKey.startsWith('nsec')) {
          privateKey = nsecDecode(nsecKey)
        } else {
          if (nsecKey.length !== 64) throw new Error('Invalid key length')
          privateKey = nsecKey
        }
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
