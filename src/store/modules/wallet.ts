import { Module } from 'vuex'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { bech32 } from 'bech32'
import {
  generateMnemonicPhrase,
  deriveKeyFromMnemonic,
  isMnemonic,
  normalizeMnemonic,
} from '@/utils/mnemonic'

export type { WalletState }

interface WalletState {
  privateKey: string | null
  publicKey: string | null
  mnemonic: string | null
  isInitialized: boolean
}

interface RootState {
  wallet: WalletState
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
    mnemonic: localStorage.getItem('wallet_mnemonic'),
    isInitialized: !!localStorage.getItem('wallet_privkey')
  },

  getters: {
    isWalletInitialized: (state: WalletState) => state.isInitialized,
    walletPrivateKey: (state: WalletState) => state.privateKey,
    walletPrivateKeyEncoded: (state: WalletState) => state.privateKey ? nsecEncode(state.privateKey) : false,
    walletPublicKey: (state: WalletState) => state.publicKey,
    // The BIP39 recovery phrase — present only for mnemonic-backed wallets (new
    // wallets + phrase imports). Legacy nsec/raw-hex wallets have no phrase, so
    // the backup UI falls back to the nsec (walletPrivateKeyEncoded) for them.
    walletMnemonic: (state: WalletState) => state.mnemonic
  },

  mutations: {
    SET_WALLET(state: WalletState, { privateKey, publicKey, mnemonic }: { privateKey: string | null, publicKey: string | null, mnemonic?: string | null }) {
      state.privateKey = privateKey
      state.publicKey = publicKey
      state.mnemonic = mnemonic ?? null
      state.isInitialized = !!privateKey
    }
  },

  actions: {
    createNewWallet({ commit }) {
      // New wallets are mnemonic-backed: generate a 12-word phrase and derive the
      // raw 32-byte key from it (BIP86 m/86'/0'/0'/0/0). The STORED key format is
      // identical to before, so SingleKey.fromHex + the whole game signing path
      // are unchanged — the phrase is purely a friendlier backup than the nsec.
      const mnemonic = generateMnemonicPhrase()
      const privateKey = deriveKeyFromMnemonic(mnemonic)
      const publicKey = getPublicKey(privateKey)

      localStorage.setItem('wallet_privkey', privateKey)
      localStorage.setItem('wallet_pubkey', publicKey)
      localStorage.setItem('wallet_mnemonic', mnemonic)

      commit('SET_WALLET', { privateKey, publicKey, mnemonic })
    },

    restoreWallet({ commit }, input: string) {
      let privateKey: string
      let mnemonic: string | null = null
      let publicKey: string
      try {
        if (isMnemonic(input)) {
          // BIP39 recovery phrase -> the same key any BIP86 wallet derives.
          mnemonic = normalizeMnemonic(input)
          privateKey = deriveKeyFromMnemonic(input)
        } else if (input.startsWith('nsec')) {
          privateKey = nsecDecode(input) // legacy nsec backup
        } else {
          if (input.length !== 64) throw new Error('Invalid key length')
          privateKey = input // legacy raw-hex backup
        }
        // Fail closed: derive the pubkey INSIDE the guard so a bad scalar (any
        // path) throws here and we never persist a half-broken wallet.
        publicKey = getPublicKey(privateKey)
      } catch (err) {
        throw new Error('Invalid recovery phrase or key', { cause: err })
      }

      localStorage.setItem('wallet_privkey', privateKey)
      localStorage.setItem('wallet_pubkey', publicKey)
      // Persist the phrase only for a phrase import; a legacy nsec/hex import has
      // no phrase, so clear any stale one (e.g. re-importing over a phrase wallet).
      if (mnemonic) localStorage.setItem('wallet_mnemonic', mnemonic)
      else localStorage.removeItem('wallet_mnemonic')

      commit('SET_WALLET', { privateKey, publicKey, mnemonic })
    },

    async clearWallet({ commit, dispatch }) {
      // Purge the SDK's persisted IndexedDB store BEFORE dropping the key, else
      // a restored same-key wallet keeps showing the old balance (the VTXO store
      // outlives the localStorage keys). `purgeLocalData` lives in the
      // namespaced `ark` module, so it must be dispatched with the `ark/` prefix
      // and `{ root: true }` from this (non-namespaced) wallet module.
      await dispatch('ark/purgeLocalData', null, { root: true })
      // Also wipe the trustless stalled-bet stashes. They live in a SEPARATE
      // IndexedDB (`coinflip-stashes`) that purgeLocalData/resyncWallet leave
      // intact on purpose — but a deliberate wallet clear should drop them too,
      // else stale "Reclaim stalled bets" rows survive the clear (and a reload).
      await dispatch('ark/purgeStashes', null, { root: true })
      localStorage.removeItem('wallet_privkey')
      localStorage.removeItem('wallet_pubkey')
      localStorage.removeItem('wallet_mnemonic')

      commit('SET_WALLET', { privateKey: null, publicKey: null, mnemonic: null })
    }
  }
}

export default wallet
