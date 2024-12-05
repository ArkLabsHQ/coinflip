<template>
  <div class="home">
    <div class="games-section">
      <div class="section-header">
        <h2>My Games</h2>
        <button @click="showCreateGame = true" class="create-button">
          <span class="material-icons">add_circle</span>
          Create New Game
        </button>
      </div>
      <game-list
        :games="myGames"
        :show-join="false"
      />
    </div>

    <div class="games-section">
      <h2>Available Games</h2>
      <game-list
        :games="availableGames"
        @join="joinGame"
      />
    </div>

    <create-game-modal
      v-if="showCreateGame"
      @close="showCreateGame = false"
      @created="onGameCreated"
    />
  </div>
</template>

<script lang="ts">
import { ref, computed } from 'vue'
import { useStore } from 'vuex'
import CreateGameModal from '@/components/CreateGameModal.vue'
import GameList from '@/components/GameList.vue'
import { useRouter } from 'vue-router'
import { hex } from '@scure/base'
import type { State } from '@/store'
import { Game, JoinEvent } from '@/utils/game'
import { VtxoInput } from '@/utils/psbt'

export default {
  name: 'HomeView',
  components: {
    CreateGameModal,
    GameList
  },
  setup() {
    const store = useStore<State>()
    const router = useRouter()
    const showCreateGame = ref(false)
    
    // Get the public key from the wallet state
    const playerPubkey = computed(() => {
      const pubkey = store.state.wallet.publicKey
      return pubkey ? hex.decode(pubkey) : null
    })

    // Use the store getters with proper typing
    const availableGames = computed(() => store.getters.availableGames)
    const myGames = computed(() => 
      playerPubkey.value ? store.getters.myGames(hex.encode(playerPubkey.value)) : []
    )

    const onGameCreated = () => {
      showCreateGame.value = false
    }

    const joinGame = async (gameId: string) => {
      if (!playerPubkey.value) {
        throw new Error('Wallet not initialized')
      }

      // Get the player's VTXOs for funding the bet
      const game = store.getters.games.find((g: Game) => g.gameId === gameId)
      if (!game || !game.betAmount) {
        throw new Error('Invalid game')
      }

      // TODO: Implement VTXO selection logic
      const playerVtxos: VtxoInput[] = []
      
      // Create join event
      const joinEvent: JoinEvent = {
        type: 'join',
        gameId,
        playerPubkey: hex.encode(playerPubkey.value),
        playerVtxos,
        playerChangeAddress: '', // TODO: Get change address from wallet
        playerHash: '' // TODO: Generate player hash
      }

      // Push the join event
      await store.dispatch('pushGameEvent', joinEvent)
      router.push({ name: 'game', params: { id: gameId }})
    }

    return {
      showCreateGame,
      availableGames,
      myGames,
      onGameCreated,
      joinGame
    }
  }
}
</script>

<style lang="scss" scoped>
.home {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.games-section {
  margin-bottom: 3rem;

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    
    h2 {
      color: var(--text);
      border-bottom: none;
      padding-bottom: 0;
      margin-bottom: 0;
    }

    .create-button {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--success);
      padding: 0.75rem 1.5rem;
      font-size: 1rem;
      transition: all 0.2s ease;
      
      &:hover {
        background: #16a34a;
        transform: translateY(-1px);
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }
      
      .material-icons {
        font-size: 1.25rem;
      }
    }
  }

  h2:not(.section-header h2) {
    color: var(--text);
    border-bottom: 2px solid var(--border);
    padding-bottom: 0.5rem;
    margin-bottom: 1.5rem;
  }
}
</style> 