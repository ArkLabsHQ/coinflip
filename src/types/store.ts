import type { Sub, Relay } from 'nostr-tools'
import type { ArkServerInfo } from '@/store/modules/ark/ark'
import type { GameEvent, Game } from '@/utils/game'

export interface NostrState {
  relay: string
  status: 'disconnected' | 'connecting' | 'connected'
  lastError: Error | null
  subscription: { id: string, sub: Sub } | null
  relayInstance: Relay | null
}

export interface WalletState {
  privateKey: string | null
  publicKey: string | null
  isInitialized: boolean
}

export interface ArkState {
  server: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  lastError: Error | null
  info: ArkServerInfo | null
}

export interface RootState {
  wallet: WalletState
  games: Game[]
  currentGame: Game | null
  walletBalance: number
  btcPrice: number
  nostr: NostrState
  ark: ArkState
  gameEvents: { [gameId: string]: GameEvent[] }
  emittedEvents: { [gameId: string]: GameEvent[] }
  currentGameId: string | null
  deletedGames: string[]
} 