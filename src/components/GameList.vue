<template>
  <div class="game-list">
    <div v-if="!games.length" class="no-games">
      No games available
    </div>
    
    <div v-else class="game-cards">
      <div 
        v-for="game in games" 
        :key="game.gameId" 
        class="game-card" 
        :class="{ 'available': !game.player }"
        @click="navigateToGame(game.gameId)"
      >
        <div class="card-header">
          <StatusBadge :status="getGameStatus(game)" />
          <div class="actions">
            <div class="expiry" v-if="game.finalExpiration">
              <span class="material-icons">schedule</span>
            </div>
            <button 
              class="remove-button" 
              @click.stop="removeGame(game.gameId)"
              :title="'Remove game'"
            >
              <span class="material-icons">close</span>
            </button>
          </div>
        </div>
        
        <div class="game-info">
          <div class="game-id">
            <span class="label">Game ID</span>
            <div class="hash">
              <span class="material-icons">tag</span>
              {{ formatGameId(game.gameId) }}
            </div>
          </div>
          
          <div class="bet-info">
            <h4>Bet Amount</h4>
            <div class="amount">{{ formatBTC(game.betAmount) }} BTC</div>
            <div class="pot">
              Pot: {{ formatPotAmount(game) }} BTC
            </div>
          </div>
          
          <div class="players-info">
            <div class="player creator">
              <span class="label">
                Creator
                <span v-if="getWinner(game) === 'creator'" class="winner-badge">Winner!</span>
              </span>
              <div class="address">
                <span class="material-icons">person</span>
                {{ formatPubkey(game.creator?.pubkey) }}
              </div>
            </div>
            <div v-if="game.player?.pubkey" class="player opponent">
              <span class="label">
                Opponent
                <span v-if="getWinner(game) === 'player'" class="winner-badge">Winner!</span>
              </span>
              <div class="address">
                <span class="material-icons">person</span>
                {{ formatPubkey(game.player.pubkey) }}
              </div>
            </div>
            <div v-else class="player opponent empty">
              <span class="label">Opponent</span>
              <div class="address">
                <span class="material-icons">person_add</span>
                Waiting for player
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useRouter } from 'vue-router'
import { useStore } from 'vuex'
import { Game, GameStatus, getPotAmount } from '@/utils/game'
import { hex } from '@scure/base'
import StatusBadge from '@/components/StatusBadge.vue'
import { toast } from '@/utils/toast'

export default defineComponent({
  name: 'GameList',
  components: {
    StatusBadge
  },
  props: {
    games: {
      type: Array as () => Game[],
      required: true
    }
  },
  setup() {
    const router = useRouter()
    const store = useStore()

    const formatExpiry = (expiryDate: string) => {
      const expiry = new Date(expiryDate)
      const now = new Date()
      const diffMs = expiry.getTime() - now.getTime()
      const diffMins = Math.round(diffMs / 60000)
      
      if (diffMins < 0) {
        return 'Expired'
      } else if (diffMins < 60) {
        return `${diffMins} minutes`
      } else {
        const hours = Math.floor(diffMins / 60)
        const mins = diffMins % 60
        return `${hours}h ${mins}m`
      }
    }

    const formatBTC = (amount: bigint | undefined) => {
      if (!amount) return '0'
      return (Number(amount) / 100_000_000).toFixed(8)
    }

    const formatPubkey = (pubkey: Uint8Array | undefined) => {
      if (!pubkey) return 'Unknown'
      const hexPubkey = hex.encode(pubkey)
      return `${hexPubkey.slice(0, 8)}...${hexPubkey.slice(-6)}`
    }

    const formatGameId = (gameId: string | undefined) => {
      if (!gameId) return 'Unknown'
      return `${gameId.slice(0, 8)}...${gameId.slice(-6)}`
    }

    const getGameStatus = (game: Game) => {
      if (!game.player) return 'PENDING'
      if (game.creator?.revealedSecret || game.player?.revealedSecret) return 'COMPLETED'
      return 'ACTIVE'
    }

    const navigateToGame = (gameId: string | undefined) => {
      if (!gameId) return
      router.push({ name: 'game', params: { id: gameId }})
    }

    const formatPotAmount = (game: Game) => {
      try {
        return formatBTC(getPotAmount(game))
      } catch (error) {
        console.error('Failed to get pot amount:', error)
        return '0'
      }
    }

    const removeGame = async (gameId: string | undefined) => {
      if (!gameId) return
      try {
        await store.dispatch('removeGame', gameId)
        toast.success('Game removed')
      } catch (error) {
        console.error('Failed to remove game:', error)
        toast.error(`Failed to remove game: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    const getWinner = (game: Game) => {
      if (game.status !== GameStatus.Resolved) return null
      return localStorage.getItem(`game_${game.gameId}_win`) || null
    }

    return {
      formatExpiry,
      formatBTC,
      formatPubkey,
      formatGameId,
      getGameStatus,
      navigateToGame,
      formatPotAmount,
      removeGame,
      getWinner,
    }
  }
})
</script>

<style lang="scss" scoped>
.game-list {
  margin: 1.5rem 0;
}

.no-games {
  text-align: center;
  padding: 3rem;
  background: var(--card);
  border-radius: 1rem;
  color: var(--text-light);
  border: 2px dashed var(--border);
}

.game-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1.5rem;
}

.game-card {
  background: var(--card);
  border-radius: 1rem;
  padding: 1.5rem;
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1);
  transition: transform 0.2s, box-shadow 0.2s;
  cursor: pointer;
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
  }

  &.available {
    border: 2px solid var(--primary);
    
    .player.opponent.empty .address {
      color: var(--primary);
      font-weight: 500;
      
      .material-icons {
        opacity: 1;
        color: var(--primary);
      }
    }
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;

    .actions,
    .expiry {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .remove-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: 50%;
      background: var(--background);
      color: var(--text-light);
      border: none;
      cursor: pointer;
      transition: all 0.2s;
      
      .material-icons {
        font-size: 18px;
      }
      
      &:hover {
        background: var(--danger);
        color: white;
      }
    }
  }

  .game-info {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .game-id {
    .label {
      display: block;
      font-size: 0.75rem;
      color: var(--text-light);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.25rem;
    }

    .hash {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-family: monospace;
      padding: 0.5rem;
      background: var(--background);
      border-radius: 0.25rem;
      font-size: 0.875rem;
      color: var(--primary);
      letter-spacing: 0.025em;

      .material-icons {
        font-size: 1rem;
        opacity: 0.5;
      }

      &:hover {
        background: var(--border);
      }
    }
  }

  .bet-info {
    text-align: center;
    padding: 1rem;
    background: var(--background);
    border-radius: 0.5rem;

    h4 {
      margin: 0 0 0.5rem;
      font-size: 0.875rem;
      color: var(--text-light);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .amount {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 0.25rem;
    }

    .pot {
      font-size: 0.875rem;
      color: var(--text-light);
    }
  }

  .players-info {
    display: flex;
    flex-direction: column;
    gap: 1rem;

    .player {
      .label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.75rem;
        color: var(--text-light);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 0.25rem;

        .winner-badge {
          background: var(--primary);
          color: white;
          padding: 0.125rem 0.5rem;
          border-radius: 1rem;
          font-size: 0.625rem;
          font-weight: 600;
        }
      }

      .address {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-family: monospace;
        padding: 0.5rem;
        background: var(--background);
        border-radius: 0.25rem;
        font-size: 1rem;
        letter-spacing: 0.025em;

        .material-icons {
          font-size: 1rem;
          opacity: 0.5;
        }

        &:hover {
          background: var(--border);
        }
      }

      &.empty .address {
        color: var(--text-light);
        font-style: italic;
        font-size: 0.875rem;
      }
    }
  }
}

.winner-badge {
  background: var(--success);
  color: white;
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style> 