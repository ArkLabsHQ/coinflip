<template>
  <transition name="fade">
    <div v-if="result" class="overlay" @click.self="$emit('close')">
      <div class="result-card" :class="result.winner === 'player' ? 'win' : 'lose'">
        <div class="result-icon">{{ result.winner === 'player' ? '&#127881;' : '&#128148;' }}</div>

        <h2 v-if="result.winner === 'player'" class="result-title win-text">
          YOU WIN!
        </h2>
        <h2 v-else class="result-title lose-text">
          YOU LOSE
        </h2>

        <div class="result-amount mono">
          <span v-if="result.winner === 'player'">+{{ formatSats(result.payout) }} sats</span>
          <span v-else>-{{ formatSats(result.payout / 2) }} sats</span>
        </div>

        <div class="result-rake text-muted">
          ({{ result.rake }} sats rake)
        </div>

        <button class="proof-toggle" @click="showProof = !showProof">
          {{ showProof ? 'Hide' : 'Show' }} cryptographic proof
        </button>

        <div v-if="showProof" class="proof-box">
          <div class="proof-row">
            <span class="proof-label">House secret:</span>
            <span class="proof-value mono">{{ result.houseSecret.substring(0, 16) }}...</span>
            <span class="proof-size">({{ result.houseSecretSize }} bytes)</span>
          </div>
          <div class="proof-row">
            <span class="proof-label">Your secret:</span>
            <span class="proof-value mono">{{ result.playerSecret.substring(0, 16) }}...</span>
            <span class="proof-size">({{ result.playerSecretSize }} bytes)</span>
          </div>
          <div class="proof-explanation text-muted">
            {{ result.proof }}
          </div>
        </div>

        <div class="result-actions">
          <button class="btn-gold btn-lg" @click="$emit('playAgain')">
            PLAY AGAIN
          </button>
          <button class="btn-outline" @click="$emit('viewHistory')">
            HISTORY
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script lang="ts">
import { defineComponent, PropType, ref } from 'vue'

export interface GameResult {
  winner: 'player' | 'house'
  houseSecret: string
  playerSecret: string
  houseSecretSize: number
  playerSecretSize: number
  payout: number
  rake: number
  proof: string
}

export default defineComponent({
  name: 'ResultOverlay',
  props: {
    result: { type: Object as PropType<GameResult | null>, default: null },
  },
  emits: ['playAgain', 'viewHistory', 'close'],
  setup() {
    const showProof = ref(false)
    return { showProof }
  },
  methods: {
    formatSats(n: number): string {
      return n.toLocaleString()
    },
  },
})
</script>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
  animation: fadeIn 0.3s ease;
}

.result-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 40px 32px;
  max-width: 440px;
  width: 100%;
  text-align: center;
  animation: slideUp 0.4s ease;
}

.result-card.win {
  border-color: var(--green);
  box-shadow: 0 0 40px var(--green-glow);
}

.result-card.lose {
  border-color: var(--red);
  box-shadow: 0 0 40px var(--red-glow);
}

.result-icon {
  font-size: 3rem;
  margin-bottom: 16px;
}

.result-title {
  font-size: 2rem;
  font-weight: 800;
  letter-spacing: 2px;
  margin-bottom: 8px;
}

.win-text { color: var(--green); }
.lose-text { color: var(--red); }

.result-amount {
  font-size: 1.5rem;
  font-weight: 700;
  margin-bottom: 4px;
}

.result-card.win .result-amount { color: var(--green); }
.result-card.lose .result-amount { color: var(--red); }

.result-rake {
  font-size: 0.85rem;
  margin-bottom: 20px;
}

.proof-toggle {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 0.8rem;
  cursor: pointer;
  text-decoration: underline;
  margin-bottom: 16px;
  display: block;
  width: 100%;
}

.proof-box {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 24px;
  text-align: left;
  font-size: 0.8rem;
}

.proof-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.proof-label { color: var(--text-muted); min-width: 90px; }
.proof-value { color: var(--text); word-break: break-all; }
.proof-size { color: var(--blue); font-size: 0.75rem; }

.proof-explanation {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 0.75rem;
  line-height: 1.5;
}

.result-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(30px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
