import { createStore } from 'vuex'
import wallet from './modules/wallet'
import { privateKeyToNsec } from '@/utils/nostr'
import ark from './modules/ark/ark'
import type { ArkServerInfo } from './modules/ark/ark'
import { GameEvent, Game, gameFromEvents, isCreateEvent, isJoinEvent, isFinalizeEvent, isSetupStartedEvent, isSetupFinalizedEvent, isResolveEvent } from '@/utils/game'
import { hex } from '@scure/base'
import { toast } from '@/utils/toast'
import { getEventHash, getSignature, UnsignedEvent, nip04, Filter, relayInit, Relay, getPublicKey, Sub } from 'nostr-tools'
import type { RootState } from '@/types/store'

// NIP-04 direct message kind
const CREATE_GAME_KIND = 400000
const GAME_KIND = 4

// Add this helper function at the top of the file
function normalizeRelayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
      return url
    }
    // Convert http/https to ws/wss
    return url.replace(/^http(s?):\/\//, (_, s) => `ws${s}://`)
  } catch {
    // If URL parsing fails, assume it's a hostname and prepend wss://
    return `wss://${url}`
  }
}

// Add helper functions at the top of the file
function loadEmittedEvents(): { [gameId: string]: GameEvent[] } {
  try {
    const saved = localStorage.getItem('emitted_game_events')
    return saved ? JSON.parse(saved) : {}
  } catch (error) {
    console.error('Failed to load emitted events:', error)
    return {}
  }
}

function saveEmittedEvents(events: { [gameId: string]: GameEvent[] }) {
  try {
    localStorage.setItem('emitted_game_events', JSON.stringify(events))
  } catch (error) {
    console.error('Failed to save emitted events:', error)
  }
}

// Add helper functions for deleted games persistence
function loadDeletedGames(): string[] {
  try {
    const saved = localStorage.getItem('deleted_games')
    return saved ? JSON.parse(saved) : []
  } catch (error) {
    console.error('Failed to load deleted games:', error)
    return []
  }
}

function saveDeletedGames(gameIds: string[]) {
  try {
    localStorage.setItem('deleted_games', JSON.stringify(gameIds))
  } catch (error) {
    console.error('Failed to save deleted games:', error)
  }
}

export type State = RootState

async function encryptGameEvent(event: GameEvent, privateKey: string, game: Game | null): Promise<[string, string | null]> {
  if (event.type === 'create') {
    return [JSON.stringify(event), null]
  }

  let recipientPubkey: string | null = null
  
  if (event.type === 'join') {
    if (!game?.creator?.pubkey) {
      throw new Error('Cannot encrypt join event: creator pubkey not found')
    }
    recipientPubkey = hex.encode(game.creator.pubkey)
  } else {
    if (!game?.creator?.pubkey || !game?.player?.pubkey) {
      throw new Error('Cannot encrypt event: missing player pubkeys')
    }
    
    const senderPubkey = getPublicKey(privateKey)
    recipientPubkey = senderPubkey === hex.encode(game.creator.pubkey) 
      ? hex.encode(game.player.pubkey) 
      : hex.encode(game.creator.pubkey) 
  }

  const encrypted = await nip04.encrypt(privateKey, recipientPubkey, JSON.stringify(event))
  return [encrypted, recipientPubkey]
}

export default createStore<State>({
  state: {
    wallet: {
      privateKey: localStorage.getItem('wallet_privkey'),
      publicKey: localStorage.getItem('wallet_pubkey'),
      isInitialized: !!localStorage.getItem('wallet_privkey')
    },
    games: [],
    currentGame: null,
    walletBalance: 0,
    btcPrice: 0,
    nostr: {
      relay: normalizeRelayUrl(localStorage.getItem('nostr_relay') || 'nostr.arkade.sh'),
      status: 'disconnected',
      lastError: null,
      subscription: null,
      relayInstance: null
    },
    ark: {
      server: localStorage.getItem('ark_server') || 'https:/master.mutinynet.arklabs.to',
      status: 'disconnected',
      lastError: null,
      info: null
    },
    gameEvents: {},
    emittedEvents: loadEmittedEvents(),
    currentGameId: null,
    deletedGames: loadDeletedGames(),
  },
  modules: {
    wallet,
    ark
  },
  getters: {
    games: (state: State): Game[] => {
      // Combine received and emitted events
      const allEvents: { [gameId: string]: GameEvent[] } = { ...state.gameEvents }
      
      // Merge emitted events
      Object.entries(state.emittedEvents).forEach(([gameId, events]) => {
        if (!allEvents[gameId]) {
          allEvents[gameId] = []
        }
        allEvents[gameId].push(...events)
      })

      return Object.entries(allEvents).map(([gameId, events]) => {
        try {
          return gameFromEvents(...events)
        } catch (e) {
          console.error(`Failed to build game ${gameId}:`, e)
          return null
        }
      }).filter((game): game is Game => game !== null)
    },
    
    currentGame: (state: State, getters) => {
      if (!state.currentGameId) return null
      return getters.games.find((g: Game) => g.gameId === state.currentGameId) || null
    },
    
    availableGames: (state: State, getters) => {
      return getters.games.filter((game: Game) => !game.player)
    },
    
    myGames: (_, getters) => (pubkey: string) => {
      return getters.games.filter((game: Game) => 
        game.creator?.pubkey && (hex.encode(game.creator.pubkey) === pubkey ||
          (game.player?.pubkey && hex.encode(game.player.pubkey) === pubkey))
      )
    },
    
    formattedBalance: (state: State) => {
      return `${state.walletBalance.toFixed(8)} BTC`
    },
    usdBalance: (state: State) => {
      return (state.walletBalance * state.btcPrice).toFixed(2)
    },
    nostrStatus: (state: State) => state.nostr.status,
    nostrRelay: (state: State) => state.nostr.relay,
    arkServer: (state: State) => state.ark.server,
    arkStatus: (state: State) => state.ark.status,
    nsecKey: (state: State) => {
      return state.wallet.privateKey ? privateKeyToNsec(state.wallet.privateKey) : null
    },
    serverPubkey: (state: State) => state.ark.info?.pubkey || null
  },
  mutations: {
    SET_GAMES(state: State, games: Game[]) {
      state.games = games
    },
    ADD_GAME(state: State, game: Game) {
      state.games.push(game)
    },
    SET_CURRENT_GAME(state: State, gameId: string | null) {
      state.currentGameId = gameId
    },
    SET_BALANCE(state: State, balance: number) {
      state.walletBalance = balance
    },
    SET_BTC_PRICE(state: State, price: number) {
      state.btcPrice = price
    },
    SET_NOSTR_STATUS(state: State, status: State['nostr']['status']) {
      state.nostr.status = status
    },
    SET_NOSTR_ERROR(state: State, error: Error | null) {
      state.nostr.lastError = error
    },
    SET_NOSTR_SUBSCRIPTION(state: State, subscription: { id: string, sub: Sub } | null) {
      state.nostr.subscription = subscription
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
    SET_NOSTR_RELAY(state: State, relay: string) {
      const normalizedRelay = normalizeRelayUrl(relay)
      state.nostr.relay = normalizedRelay
      localStorage.setItem('nostr_relay', relay)
    },
    SET_ARK_INFO(state: State, info: ArkServerInfo) {
      state.ark.info = info
    },
    ADD_GAME_EVENT(state: State, event: GameEvent) {
      if (!state.gameEvents[event.gameId]) {
        state.gameEvents[event.gameId] = []
      }
      state.gameEvents[event.gameId].push(event)
    },
    SET_RELAY_INSTANCE(state: State, relay: Relay | null) {
      state.nostr.relayInstance = relay
    },
    ADD_EMITTED_EVENT(state: State, event: GameEvent) {
      if (!state.emittedEvents[event.gameId]) {
        state.emittedEvents[event.gameId] = []
      }
      state.emittedEvents[event.gameId].push(event)
      saveEmittedEvents(state.emittedEvents)
    },
    REMOVE_GAME_EVENTS(state: State, gameId: string) {
      delete state.gameEvents[gameId]
      delete state.emittedEvents[gameId]
      saveEmittedEvents(state.emittedEvents)
    },
    ADD_DELETED_GAME(state: State, gameId: string) {
      if (!state.deletedGames.includes(gameId)) {
        state.deletedGames.push(gameId)
        saveDeletedGames(state.deletedGames)
      }
    },
  },
  actions: {
    async pushEvent({ state }, event) {
      if (!state.nostr.relayInstance) {
        throw new Error('Nostr relay not initialized')
      }

      try {
        console.log('Pushing Nostr event:', event)
        const pub = state.nostr.relayInstance.publish(event)
        await pub
        return event
      } catch (err) {
        throw new Error(`Failed to send event: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
    },
    async connectNostr({ commit, dispatch, state }) {
      try {
        // Close existing subscription if any
        if (state.nostr.subscription) {
          state.nostr.subscription.sub.unsub()
          commit('SET_NOSTR_SUBSCRIPTION', null)
        }

        // Close existing relay connection if any
        if (state.nostr.relayInstance) {
          await state.nostr.relayInstance.close()
          commit('SET_RELAY_INSTANCE', null)
        }

        commit('SET_NOSTR_STATUS', 'connecting')
        
        // Initialize new relay
        const relay = relayInit(state.nostr.relay)
        commit('SET_RELAY_INSTANCE', relay)

        relay.on('connect', () => {
          console.log('Nostr relay connected')
          commit('SET_NOSTR_STATUS', 'connected')
          commit('SET_NOSTR_ERROR', null)
          dispatch('subscribeToGames')
        })

        relay.on('disconnect', () => {
          console.log('Nostr relay disconnected')
          commit('SET_NOSTR_STATUS', 'disconnected')
        })

        relay.on('error', () => {
          console.error('Nostr relay error')
          commit('SET_NOSTR_STATUS', 'disconnected')
        })

        await relay.connect()
        
      } catch (error) {
        console.error('Failed to connect to Nostr:', error)
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
        toast.error(`Failed to connect to Nostr: ${errorMessage}`)
        commit('SET_NOSTR_ERROR', error instanceof Error ? error : new Error(errorMessage))
        commit('SET_NOSTR_STATUS', 'disconnected')
      }
    },
    subscribeToGames({ commit, state, dispatch }) {
      if (!state.nostr.relayInstance || state.nostr.status !== 'connected') return

      const currentPubkey = state.wallet.publicKey
      console.log('Current pubkey:', currentPubkey)


      const since = Math.floor(Date.now() / 1000) - (24 * 60 * 60) // Last 24h

      const filters: Filter[] = [
        {
          kinds: [CREATE_GAME_KIND],
          since,
        },
        {
          kinds: [GAME_KIND],
          '#p': [currentPubkey || ''],
          since,
        },
        {
          kinds: [5],
          since,
        }
      ]

      // Close existing subscription if any
      if (state.nostr.subscription) {
        state.nostr.subscription.sub.unsub()
        commit('SET_NOSTR_SUBSCRIPTION', null)
      }

      const subId = Math.random().toString(36).substring(2)
      const sub = state.nostr.relayInstance.sub(filters, { id: subId })


      sub.on('event', async (event) => {
        try {
          if (event.kind === CREATE_GAME_KIND) {
            const gameEvent = JSON.parse(event.content)
            if (!isCreateEvent(gameEvent)) {
              console.warn('Unrecognized create event format')
              return
            }

            if (gameEvent && 'gameId' in gameEvent && !state.deletedGames.includes(gameEvent.gameId)) {
              commit('ADD_GAME_EVENT', gameEvent)
            }
          } else if (event.kind === GAME_KIND) {
            if (!state.wallet.privateKey) {
              console.warn('Cannot decrypt event: wallet not initialized')
              return
            }

            const decrypted = await nip04.decrypt(
              state.wallet.privateKey,
              event.pubkey,
              event.content
            )

            console.log('Decrypted event:', decrypted)
            const gameEvent = JSON.parse(decrypted)
            if (
              !isJoinEvent(gameEvent)
              && !isSetupStartedEvent(gameEvent)
              && !isSetupFinalizedEvent(gameEvent)
              && !isFinalizeEvent(gameEvent)
              && !isResolveEvent(gameEvent)
            ) {
              console.warn('Unrecognized game event format')
              return
            }

            if (gameEvent && 'gameId' in gameEvent && !state.deletedGames.includes(gameEvent.gameId)) {
              commit('ADD_GAME_EVENT', gameEvent)

              // If this is a join event, delete the corresponding create event
              if (isJoinEvent(gameEvent)) {
                // Find and delete the create event for this game
                const createEvents = await state.nostr.relayInstance?.list([{
                  kinds: [CREATE_GAME_KIND],
                  '#g': [gameEvent.gameId]
                }])

                if (createEvents && createEvents.length > 0) {
                  try {
                    await dispatch('deleteEvent', { eventId: createEvents[0].id, gameId: gameEvent.gameId })
                  } catch (err) {
                    console.error('Failed to delete create event:', err)
                  }
                }
              }
            }
          } else if (event.kind === 5) {
            // delete event
            console.log('Delete event:', event)
            const gameId = event.tags.find((tag) => tag[0] === 'g')?.[1]
            console.log('Game ID:', gameId)
            if (gameId) {
              const gameEvents = state.gameEvents[gameId]
              console.log('Game events:', gameEvents)
              if (gameEvents && gameEvents.length == 1) {
                console.log('Removing game events:', gameId)
                commit('REMOVE_GAME_EVENTS', gameId)
                return
              }
            }
          } else {
            console.warn('Unrecognized event format')
            return
          }


          
        } catch (e) {
          console.error('Failed to parse game event:', e)
          toast.error(`Failed to parse game event: ${(e as Error).message}`)
        }
      })

      sub.on('eose', () => {
        console.log('Subscription caught up with all past events')
      })

      commit('SET_NOSTR_SUBSCRIPTION', { id: subId, sub })
    },
    async fetchBTCPrice({ commit }) {
      try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd')
        const data = await response.json()
        commit('SET_BTC_PRICE', data.bitcoin.usd)
      } catch (error) {
        console.error('Failed to fetch BTC price:', error)
        // You might want to commit an error state here
      }
    },
    async checkArkConnection({ commit, state }) {
      try {
        commit('SET_ARK_STATUS', 'connecting')
        const response = await fetch(`${state.ark.server}/v1/info`, {
          signal: AbortSignal.timeout(5000) // 5 second timeout
        })
        
        if (response.ok) {
          const data = await response.json()
          commit('SET_ARK_STATUS', 'connected')
          commit('SET_ARK_ERROR', null)
          return data
        } else {
          const errorText = await response.text()
          throw new Error(`Server returned ${response.status}: ${errorText}`)
        }
      } catch (error) {
        console.error('Failed to connect to Ark server:', error)
        commit('SET_ARK_STATUS', 'error')
        
        // Create user-friendly error message
        let errorMessage = 'Failed to connect to Ark server: '
        if (error instanceof TypeError && error.message === 'Failed to fetch') {
          errorMessage += 'Server is unreachable'
        } else if (error instanceof DOMException && error.name === 'AbortError') {
          errorMessage += 'Connection timed out'
        } else {
          errorMessage += (error as Error).message
        }
        
        commit('SET_ARK_ERROR', new Error(errorMessage))
        return null // Return null instead of throwing
      }
    },
    async updateNostrRelay({ commit, dispatch, state }, relay: string) {
      // Close existing subscription if any
      if (state.nostr.subscription) {
        state.nostr.subscription.sub.unsub()
        commit('SET_NOSTR_SUBSCRIPTION', null)
      }

      commit('SET_NOSTR_RELAY', relay)
      await dispatch('connectNostr')
    },
    async pushGameEvent({ commit, dispatch, rootState, state, getters }, event: GameEvent) {
      if (!rootState.wallet.privateKey) {
        throw new Error('Wallet not initialized')
      }

      // Get current game state for encryption
      const game = getters.games.find((g: Game) => g.gameId === event.gameId)

      // Encrypt event content except for create events
      const [encryptedContent, recipientPubkey] = await encryptGameEvent(
        event,
        rootState.wallet.privateKey,
        game
      )

      const created_at = Math.floor(Date.now() / 1000)

      const isCreate = isCreateEvent(event)

      // Get expiration from game state or use default
      const expiration = isCreate
        ? event.finalExpiration
        : game?.finalExpiration || (created_at + (24 * 60 * 60))

      // Build tags array
      const tags: string[][] = [
        ['expiration', expiration.toString()],  // Add expiration tag
      ]

      // Add recipient tag for encrypted events
      if (recipientPubkey) {
        tags.push(['p', recipientPubkey])
      }

      // Add event ID tag for create events
      if (isCreate) {
        tags.push(['g', event.gameId])
      }

      // Convert GameEvent to NostrEvent and push it
      const nostrEvent: UnsignedEvent<typeof CREATE_GAME_KIND | typeof GAME_KIND> = {
        kind: isCreate ? CREATE_GAME_KIND : GAME_KIND,
        content: encryptedContent,
        created_at,
        tags,
        pubkey: getPublicKey(rootState.wallet.privateKey),
      }

      // Generate event hash (id)
      const id = getEventHash(nostrEvent)
      
      // Sign the event
      const sig = getSignature(nostrEvent, rootState.wallet.privateKey)
      
      const signedEvent = {
        ...nostrEvent,
        id,
        sig,
      }
      // Push to nostr
      await dispatch('pushEvent', signedEvent)

      // Add the event to both stores
      commit('ADD_GAME_EVENT', event)
      commit('ADD_EMITTED_EVENT', event)

      if (isJoinEvent(event)) {
        const currentGameEvents = state.gameEvents[event.gameId]
        const createEvent = currentGameEvents
        .find((e: GameEvent) => isCreateEvent(e))
        // if we are joining a game, add the create event to the emitted events to persist it
        commit('ADD_EMITTED_EVENT', createEvent)
      }

      return signedEvent
    },
    async initializeApp({ dispatch, state }) {
      try {

        console.log(state.wallet.privateKey)
        console.log(state.wallet.isInitialized)
        // Connect to Nostr if we have a wallet
        if (state.wallet.isInitialized) {
          await dispatch('connectNostr')
        }

        // Fetch BTC price regardless of wallet status
        await dispatch('fetchBTCPrice')
      } catch (error) {
        console.error('Failed to initialize app:', error)
        toast.error(`Failed to initialize app: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    },
    removeGame({ commit }, gameId: string) {
      commit('ADD_DELETED_GAME', gameId)
      commit('REMOVE_GAME_EVENTS', gameId)
    },
    async deleteEvent({ state }, { eventId, gameId }: { eventId: string, gameId: string }) {
      console.log('Deleting event:', eventId)
      if (!state.nostr.relayInstance || !state.wallet.privateKey) {
        throw new Error('Nostr relay not initialized or wallet not available')
      }

      const deleteEvent: UnsignedEvent<5> = {
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [['e', eventId], ['g', gameId]],
        pubkey: getPublicKey(state.wallet.privateKey)
      }

      const id = getEventHash(deleteEvent)
      const sig = getSignature(deleteEvent, state.wallet.privateKey)

      const signedEvent = {
        ...deleteEvent,
        id,
        sig,
      }

      try {
        const pub = state.nostr.relayInstance.publish(signedEvent)
        await pub
        console.log('Successfully deleted event:', eventId)
      } catch (err) {
        console.error('Failed to delete event:', err)
        throw new Error(`Failed to delete event: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
    },
  }
}) 