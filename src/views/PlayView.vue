<template>
  <div class="page play-page">
    <h1 class="title">ARKADE COINFLIP</h1>

    <CoinFlip :state="coinState" />

    <div class="section-label">PICK YOUR BET</div>
    <TierSelector
      :tiers="tiers"
      :selected-tier="selectedTier"
      :max-available="maxAvailable"
      :player-balance="playerBalance"
      @select="selectedTier = $event"
    />

    <div class="section-label">PICK YOUR SIDE</div>
    <div class="side-selector">
      <button
        class="side-btn"
        :class="{ selected: selectedSide === 'heads' }"
        @click="selectedSide = 'heads'"
      >
        HEADS
      </button>
      <button
        class="side-btn"
        :class="{ selected: selectedSide === 'tails' }"
        @click="selectedSide = 'tails'"
      >
        TAILS
      </button>
    </div>

    <button
      class="flip-btn"
      :class="{ active: canFlip }"
      :disabled="!canFlip || isFlipping"
      @click="doFlip"
    >
      {{ isFlipping ? 'FLIPPING...' : 'FLIP IT' }}
    </button>

    <div v-if="error" class="error-toast">{{ error }}</div>

    <ResultOverlay
      :result="gameResult"
      @play-again="resetGame"
      @view-history="$router.push('/history')"
      @close="gameResult = null"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted } from 'vue'
import { useStore } from 'vuex'
import CoinFlip from '@/components/CoinFlip.vue'
import TierSelector from '@/components/TierSelector.vue'
import ResultOverlay from '@/components/ResultOverlay.vue'
import { GameResult } from '@/components/ResultOverlay.vue'
import { getTiers, play, sign } from '@/services/api'
import { createHash } from '@/utils/crypto'

export default defineComponent({
  name: 'PlayView',
  components: { CoinFlip, TierSelector, ResultOverlay },
  setup() {
    const store = useStore()

    const tiers = ref<number[]>([1000, 5000, 10000, 50000])
    const maxAvailable = ref(50000)
    const houseReady = ref(false)
    const selectedTier = ref<number | null>(null)
    const selectedSide = ref<'heads' | 'tails' | null>(null)
    const coinState = ref<'idle' | 'flipping' | 'heads' | 'tails'>('idle')
    const isFlipping = ref(false)
    const error = ref<string | null>(null)
    const gameResult = ref<GameResult | null>(null)

    const playerBalance = computed(() => store.state.walletBalance || Infinity)
    const canFlip = computed(() => selectedTier.value !== null && selectedSide.value !== null && !isFlipping.value)

    async function loadTiers() {
      try {
        const data = await getTiers()
        tiers.value = data.tiers
        maxAvailable.value = data.maxAvailable
        houseReady.value = data.houseReady
      } catch (e) {
        console.warn('Failed to load tiers:', e)
      }
    }

    async function doFlip() {
      if (!selectedTier.value || !selectedSide.value) return

      isFlipping.value = true
      coinState.value = 'flipping'
      error.value = null

      try {
        const pubkey = store.state.wallet.publicKey
        // Generate player secret: 15 bytes for heads, 16 bytes for tails
        const secretLen = selectedSide.value === 'heads' ? 15 : 16
        const secretBytes = new Uint8Array(secretLen)
        crypto.getRandomValues(secretBytes)
        const secretHex = Array.from(secretBytes).map(b => b.toString(16).padStart(2, '0')).join('')
        const playerHash = await createHash(secretBytes)

        // Step 1: Create game
        const playResult = await play(
          selectedTier.value,
          selectedSide.value,
          pubkey,
          playerHash,
        )

        // Step 2: Sign and resolve
        const signResult = await sign(
          playResult.gameId,
          [],
          '',
          secretHex,
        )

        // Show result
        coinState.value = signResult.winner === 'player' ? selectedSide.value : (selectedSide.value === 'heads' ? 'tails' : 'heads')
        gameResult.value = signResult

        // Save to local history
        const history = JSON.parse(localStorage.getItem('gameHistory') || '[]')
        history.unshift({
          id: playResult.gameId,
          tier: selectedTier.value,
          playerChoice: selectedSide.value,
          winner: signResult.winner,
          rakeAmount: signResult.rake,
          payoutAmount: signResult.payout,
          status: 'resolved',
          createdAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
        })
        localStorage.setItem('gameHistory', JSON.stringify(history.slice(0, 100)))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Something went wrong'
        error.value = msg
        coinState.value = 'idle'
        setTimeout(() => { error.value = null }, 4000)
      } finally {
        isFlipping.value = false
      }
    }

    function resetGame() {
      gameResult.value = null
      coinState.value = 'idle'
      selectedTier.value = null
      selectedSide.value = null
      loadTiers()
    }

    onMounted(loadTiers)

    return {
      tiers, maxAvailable, houseReady,
      selectedTier, selectedSide,
      coinState, isFlipping, canFlip,
      error, gameResult, playerBalance,
      doFlip, resetGame,
    }
  },
})
</script>

<style scoped>
.play-page {
  gap: 24px;
  max-width: 500px;
  margin: 0 auto;
  padding-top: 32px;
}

.title {
  color: var(--gold);
  font-size: 1.3rem;
  letter-spacing: 4px;
  text-align: center;
  margin-bottom: 8px;
}

.section-label {
  color: var(--text-muted);
  font-size: 0.75rem;
  letter-spacing: 2px;
  text-transform: uppercase;
  text-align: center;
}

.side-selector {
  display: flex;
  gap: 16px;
  justify-content: center;
}

.side-btn {
  background: var(--bg-card);
  border: 2px solid var(--border);
  color: var(--text);
  border-radius: 12px;
  padding: 16px 40px;
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.side-btn:hover {
  border-color: var(--blue);
}

.side-btn.selected {
  border-color: var(--blue);
  background: rgba(0, 212, 255, 0.1);
  color: var(--blue);
  box-shadow: 0 0 20px var(--blue-glow);
}

.flip-btn {
  background: var(--bg-card);
  border: 2px solid var(--text-muted);
  color: var(--text-muted);
  border-radius: 12px;
  padding: 18px 56px;
  font-size: 1.2rem;
  font-weight: 800;
  letter-spacing: 3px;
  cursor: not-allowed;
  transition: all 0.3s ease;
  margin-top: 8px;
}

.flip-btn.active {
  border-color: var(--blue);
  color: var(--blue);
  cursor: pointer;
  box-shadow: 0 0 20px var(--blue-glow);
}

.flip-btn.active:hover {
  background: var(--blue);
  color: var(--bg);
  box-shadow: 0 0 40px var(--blue-glow), 0 0 80px var(--blue-glow);
}

.flip-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error-toast {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--red);
  color: #fff;
  padding: 10px 24px;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  z-index: 999;
  animation: slideUp 0.3s ease;
}

@media (max-width: 640px) {
  .side-btn { padding: 12px 28px; font-size: 1rem; }
  .flip-btn { padding: 14px 40px; font-size: 1rem; }
}
</style>
