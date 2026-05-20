<template>
  <div class="page play-page">
    <div class="coin-area">
      <CoinFlip :state="coinState" />
    </div>

    <div class="controls">
      <div class="control-group">
        <div class="control-label">BET AMOUNT</div>
        <TierSelector
          :tiers="tiers"
          :selected-tier="selectedTier"
          :max-available="maxAvailable"
          :player-balance="playerBalance"
          @select="selectedTier = $event"
        />
      </div>

      <div class="control-group">
        <div class="control-label">YOUR CALL</div>
        <div class="side-selector">
          <button
            class="side-btn"
            :class="{ selected: selectedSide === 'heads' }"
            @click="selectedSide = 'heads'"
          >
            <span class="side-icon">&#x20BF;</span>
            HEADS
          </button>
          <button
            class="side-btn"
            :class="{ selected: selectedSide === 'tails' }"
            @click="selectedSide = 'tails'"
          >
            <span class="side-icon flipped">&#x20BF;</span>
            TAILS
          </button>
        </div>
      </div>

      <button
        class="flip-btn"
        :class="{ active: canFlip }"
        :disabled="!canFlip || isFlipping"
        @click="doFlip"
      >
        {{ isFlipping ? 'FLIPPING...' : 'FLIP IT' }}
      </button>
    </div>

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
        const secretLen = selectedSide.value === 'heads' ? 15 : 16
        const secretBytes = new Uint8Array(secretLen)
        crypto.getRandomValues(secretBytes)
        const secretHex = Array.from(secretBytes).map(b => b.toString(16).padStart(2, '0')).join('')
        const playerHash = await createHash(secretBytes)

        const playResult = await play(
          selectedTier.value,
          selectedSide.value,
          pubkey,
          playerHash,
        )

        const signResult = await sign(
          playResult.gameId,
          [],
          '',
          secretHex,
        )

        coinState.value = signResult.winner === 'player' ? selectedSide.value : (selectedSide.value === 'heads' ? 'tails' : 'heads')
        gameResult.value = signResult

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
  gap: 0;
  max-width: 520px;
  margin: 0 auto;
  padding-top: 20px;
}

.coin-area {
  padding: 24px 0 20px;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 28px;
  width: 100%;
}

.control-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.control-label {
  color: var(--text-muted);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 2px;
  text-transform: uppercase;
}

.side-selector {
  display: flex;
  gap: 12px;
  justify-content: center;
  width: 100%;
  max-width: 340px;
}

.side-btn {
  flex: 1;
  background: var(--bg-elevated);
  border: 1.5px solid var(--border-light);
  color: var(--text-dim);
  border-radius: 14px;
  padding: 18px 16px;
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: 1.5px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.side-icon {
  font-size: 1.6rem;
  line-height: 1;
  color: var(--gold);
  opacity: 0.5;
  transition: opacity 0.2s;
}

.side-icon.flipped {
  transform: scaleX(-1);
  filter: brightness(0.8);
}

.side-btn:hover {
  border-color: var(--blue);
  color: var(--text);
}

.side-btn:hover .side-icon {
  opacity: 0.8;
}

.side-btn.selected {
  border-color: var(--blue);
  background: rgba(56, 189, 248, 0.08);
  color: var(--blue);
  box-shadow: 0 0 20px var(--blue-glow), inset 0 0 20px rgba(56, 189, 248, 0.03);
}

.side-btn.selected .side-icon {
  opacity: 1;
  color: var(--blue);
}

.flip-btn {
  width: 100%;
  max-width: 340px;
  align-self: center;
  background: var(--bg-elevated);
  border: 2px solid var(--border-light);
  color: var(--text-muted);
  border-radius: 14px;
  padding: 18px 48px;
  font-size: 1.1rem;
  font-weight: 800;
  letter-spacing: 3px;
  cursor: not-allowed;
  transition: all 0.25s ease;
  margin-top: 4px;
}

.flip-btn.active {
  border-color: var(--gold);
  color: var(--gold);
  cursor: pointer;
  background: rgba(247, 201, 72, 0.06);
  box-shadow: 0 0 20px var(--gold-glow);
}

.flip-btn.active:hover {
  background: linear-gradient(135deg, var(--gold) 0%, var(--gold-dim) 100%);
  color: var(--bg);
  box-shadow: 0 4px 32px var(--gold-glow), 0 0 60px var(--gold-glow);
  transform: translateY(-1px);
}

.flip-btn.active:active {
  transform: translateY(0) scale(0.99);
}

.flip-btn:disabled {
  opacity: 0.4;
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
  border-radius: 10px;
  font-size: 0.85rem;
  font-weight: 600;
  z-index: 999;
  animation: slideUp 0.3s ease;
  box-shadow: 0 4px 20px var(--red-glow);
}

@media (max-width: 640px) {
  .side-btn { padding: 14px 12px; font-size: 0.85rem; }
  .flip-btn { padding: 16px 36px; font-size: 1rem; }
  .side-icon { font-size: 1.3rem; }
}
</style>
