import { Module } from 'vuex'
import type { State as RootState } from '@/store'
import { ArkAddress } from './address'
import { defaultVtxoTapscripts } from '@/utils/taproot'
import { hex } from '@scure/base'

export interface ArkServerInfo {
  pubkey: string
  roundLifetime: string
  unilateralExitDelay: string
  roundInterval: string
  network: string
  dust: string
  boardingDescriptorTemplate: string
  vtxoDescriptorTemplates: string[]
  forfeitAddress: string
}

export interface ArkVTXO {
  outpoint: {
    txid: string
    vout: number
  }
  redeemTx?: string;
  amount: string;
  tapscripts: string[];
}

interface ArkState {
  server: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  lastError: Error | null
  info: ArkServerInfo | null
  vtxos: ArkVTXO[]
}

// Get cached server info from localStorage
const getCachedServerInfo = (): ArkServerInfo | null => {
  const cached = localStorage.getItem('ark_server_info')
  return cached ? JSON.parse(cached) : null
}

const ark: Module<ArkState, RootState> = {
  namespaced: true,

  state: {
    server: localStorage.getItem('ark_server') || 'https://mutinynet.arkade.sh',
    status: 'disconnected',
    lastError: null,
    info: getCachedServerInfo(),
    vtxos: []
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
    SET_INFO(state, info: ArkServerInfo) {
      state.info = info
      // Cache the server info
      localStorage.setItem('ark_server_info', JSON.stringify(info))
    },
    SET_VTXOS(state, vtxos: ArkVTXO[]) {
      state.vtxos = vtxos
    }
  },

  actions: {
    updateServer({ commit }, server: string) {
      commit('SET_SERVER', server)
    },

    async checkConnection({ commit, state, dispatch }) {
      try {
        commit('SET_STATUS', 'connecting')
        const response = await fetch(`${state.server}/v1/info`, {
          signal: AbortSignal.timeout(5000)
        })
        if (response.ok) {
          const info = await response.json()
          
          if (!info.pubkey || !info.network) {
            throw new Error('Invalid server info: missing required fields')
          }

          commit('SET_STATUS', 'connected')
          commit('SET_ERROR', null)
          commit('SET_INFO', info)

          await dispatch('fetchVTXOs')

          return info
        } else {
          const errorText = await response.text()
          throw new Error(`Server returned ${response.status}: ${errorText}`)
        }
      } catch (error) {
        console.error('Failed to connect to Ark server:', error)
        commit('SET_STATUS', 'error')
        commit('SET_ERROR', new Error(`Failed to connect to Ark server: ${(error as Error).message}`))
        commit('SET_INFO', null)
        localStorage.removeItem('ark_server_info')
        return null
      }
    },

    async fetchVTXOs({ commit, state, getters }) {
      const address = getters.address
      if (!address || state.status !== 'connected') return;
      
      try {
        const response = await fetch(`${state.server}/v1/vtxos/${address}`);
        if (response.ok) {
          const data = await response.json();
          const spendable = data['spendableVtxos']

          const defaultTapscripts = defaultVtxoTapscripts(getters.walletPublicKey, hex.decode(state.info!.pubkey.slice(2)))

          const vtxos = spendable.map((vtxo: ArkVTXO) => ({
            outpoint: vtxo.outpoint,
            amount: vtxo.amount,
            tapscripts: vtxo.tapscripts || defaultTapscripts
          }))

          commit('SET_VTXOS', vtxos);
          return spendable;
        } else {
          const errorText = await response.text();
          throw new Error(`Server returned ${response.status}: ${errorText}`);
        }
      } catch (error) {
        console.error('Failed to fetch VTXOs:', error);
        return null;
      }
    },

    async broadcastRedeemTx({ state, dispatch }, { redeemTx }: { redeemTx: string }) {
      try {
        const response = await fetch(`${state.server}/v1/redeem-tx`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ redeemTx })
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Server returned ${response.status}: ${errorText}`)
        }

        const data = await response.json()

        // Optionally update VTXOs after successful broadcast
        await dispatch('fetchVTXOs')

        return data.txid as string

      } catch (error: unknown) {
        if (error instanceof Error) {
          throw new Error(`Failed to broadcast transaction: ${error.message}`)
        }
        throw new Error('Failed to broadcast transaction')
      }
    }
  },

  getters: {
    serverPubkey: (state) => state.info?.pubkey || null,
    serverNetwork: (state) => state.info?.network || null,
    roundLifetime: (state) => {
      if (!state.info?.roundLifetime) return null
      const seconds = parseInt(state.info.roundLifetime)
      const hours = Math.floor(seconds / 3600)
      return `${hours} hours`
    },
    unilateralExitDelay: (state) => {
      if (!state.info?.unilateralExitDelay) return null
      const seconds = parseInt(state.info.unilateralExitDelay)
      const minutes = Math.floor(seconds / 60)
      return `${minutes} minutes`
    },
    roundInterval: (state) => {
      if (!state.info?.roundInterval) return null
      const seconds = parseInt(state.info.roundInterval)
      const minutes = Math.floor(seconds / 60)
      return `${minutes} minutes`
    },
    dust: (state) => state.info?.dust ? parseInt(state.info.dust) : null,
    walletPublicKey: (state, getters, rootState) => hex.decode(rootState.wallet.publicKey!),
    address: (state, getters, rootState) => {
      const publicKey = rootState.wallet.publicKey
      const serverPubkey = state.info?.pubkey

      if (!publicKey || !serverPubkey) {
        return null
      }

      try {
        const pubkeyBuffer = Buffer.from(publicKey, 'hex')
        const serverPubkeyBuffer = Buffer.from(serverPubkey.slice(2), 'hex')
        const address = ArkAddress.fromPubKey(pubkeyBuffer, serverPubkeyBuffer, 'testnet')
        return address.encode()
      } catch (err) {
        console.error('Failed to generate address:', err)
        return null
      }
    },
    vtxos: (state) => state.vtxos,
    balance: (state) => {
      return state.vtxos.reduce((sum, vtxo) => {
        return sum + BigInt(vtxo.amount);
      }, BigInt(0));
    },
    formattedBalance: (state, getters): string => {
      const balance = getters.balance
      if (balance === null) return '0'
      
      const btc = Number(balance) / 100_000_000
      return btc.toFixed(8)
    }
  }
}

export default ark 