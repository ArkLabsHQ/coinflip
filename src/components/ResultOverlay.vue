<template>
  <transition name="fade">
    <div v-if="result" class="overlay" @click.self="$emit('close')">
      <div class="result-card" :class="isWin ? 'win' : 'lose'">
        <div class="result-badge" :class="isWin ? 'badge-win' : 'badge-lose'">
          {{ isWin ? 'YOU WIN' : 'YOU LOSE' }}
        </div>

        <div class="result-amount mono" :class="isWin ? 'text-green' : 'text-red'">
          {{ isWin ? '+' : '-' }}{{ formatSats(isWin ? result.payout : result.payout / 2) }}
          <span class="result-unit">sats</span>
        </div>

        <div class="result-rake text-muted">
          {{ result.rake }} sats rake
        </div>

        <button class="proof-toggle" @click="showProof = !showProof">
          {{ showProof ? 'Hide' : 'Show' }} cryptographic proof
        </button>

        <div v-if="showProof" class="proof-box">
          <div class="proof-row">
            <span class="proof-label">House secret</span>
            <span class="proof-value mono">{{ result.houseSecret.substring(0, 16) }}...</span>
            <span class="proof-meta text-blue">({{ result.houseSecretSize }} bytes)</span>
          </div>
          <div class="proof-row">
            <span class="proof-label">Your secret</span>
            <span class="proof-value mono">{{ result.playerSecret.substring(0, 16) }}...</span>
            <span class="proof-meta text-blue">({{ result.playerSecretSize }} bytes)</span>
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
import { defineComponent, PropType, ref, computed } from 'vue'

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
  setup(props) {
    const showProof = ref(false)
    const isWin = computed(() => props.result?.winner === 'player')
    return { showProof, isWin }
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
  background: rgba(0, 0, 0, 0.82);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
  animation: fadeIn 0.3s ease;
  backdrop-filter: blur(4px);
}

.result-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 44px 36px;
  max-width: 420px;
  width: 100%;
  text-align: center;
  animation: slideUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.result-card.win {
  border-color: rgba(52, 211, 153, 0.25);
  box-shadow: 0 0 40px var(--green-glow), 0 8px 32px rgba(0,0,0,0.4);
}

.result-card.lose {
  border-color: rgba(248, 113, 113, 0.25);
  box-shadow: 0 0 40px var(--red-glow), 0 8px 32px rgba(0,0,0,0.4);
}

.result-badge {
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 3px;
  padding: 6px 20px;
  border-radius: 20px;
  margin-bottom: 8px;
}

.badge-win {
  background: rgba(52, 211, 153, 0.12);
  color: var(--green);
  border: 1px solid rgba(52, 211, 153, 0.2);
}

.badge-lose {
  background: rgba(248, 113, 113, 0.12);
  color: var(--red);
  border: 1px solid rgba(248, 113, 113, 0.2);
}

.result-amount {
  font-size: 2.2rem;
  font-weight: 800;
  line-height: 1.1;
}

.result-unit {
  font-size: 0.9rem;
  font-weight: 500;
  opacity: 0.6;
}

.result-rake {
  font-size: 0.8rem;
  margin-bottom: 12px;
}

.proof-toggle {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 0.78rem;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
  margin-bottom: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: color 0.2s;
}

.proof-toggle:hover {
  color: var(--text-dim);
}

.proof-box {
  background: var(--bg);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 12px;
  text-align: left;
  font-size: 0.8rem;
  width: 100%;
  animation: slideUp 0.2s ease;
}

.proof-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.proof-label {
  color: var(--text-muted);
  min-width: 85px;
  font-size: 0.75rem;
}

.proof-value {
  color: var(--text);
  word-break: break-all;
  font-size: 0.78rem;
}

.proof-meta {
  font-size: 0.7rem;
}

.proof-explanation {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 0.73rem;
  line-height: 1.5;
}

.result-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 8px;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(24px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
