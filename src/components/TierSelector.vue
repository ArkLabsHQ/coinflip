<template>
  <div class="tier-selector">
    <button
      v-for="tier in tiers"
      :key="tier"
      class="tier-chip"
      :class="{ selected: tier === selectedTier, disabled: isDisabled(tier) }"
      :disabled="isDisabled(tier)"
      :title="disabledReason(tier)"
      @click="$emit('select', tier)"
    >
      <span class="tier-amount">{{ formatTier(tier) }}</span>
      <span class="tier-unit">sats</span>
    </button>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

export default defineComponent({
  name: 'TierSelector',
  props: {
    tiers: { type: Array as PropType<number[]>, required: true },
    selectedTier: { type: Number, default: null },
    // Tiers the house can currently cover (some odds step fits the bankroll).
    // Empty array = nothing affordable; defaults to "all affordable".
    affordableTiers: { type: Array as PropType<number[]>, default: null },
    playerBalance: { type: Number, default: Infinity },
  },
  emits: ['select'],
  methods: {
    formatTier(n: number): string {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M'
      if (n >= 1_000) return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + 'K'
      return String(n)
    },
    affordableByHouse(tier: number): boolean {
      // null = caller hasn't computed affordability yet → don't block.
      return this.affordableTiers === null || this.affordableTiers.includes(tier)
    },
    isDisabled(tier: number): boolean {
      return !this.affordableByHouse(tier) || tier > this.playerBalance
    },
    disabledReason(tier: number): string {
      if (tier > this.playerBalance) return 'More than your wallet balance'
      if (!this.affordableByHouse(tier)) return "House can't cover a bet this size right now"
      return ''
    },
  },
})
</script>

<style scoped>
.tier-selector {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
}

.tier-chip {
  background: var(--bg-elevated);
  border: 1.5px solid var(--border-light);
  color: var(--text-dim);
  border-radius: 12px;
  padding: 12px 22px;
  font-family: var(--font-mono);
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 90px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.tier-unit {
  font-size: 0.65rem;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.tier-chip:hover:not(.disabled) {
  border-color: var(--gold);
  color: var(--gold);
  background: rgba(247, 201, 72, 0.06);
  box-shadow: 0 0 16px var(--gold-glow);
}

.tier-chip.selected {
  background: linear-gradient(135deg, var(--gold) 0%, var(--gold-dim) 100%);
  color: var(--bg);
  border-color: var(--gold);
  transform: scale(1.06);
  box-shadow: 0 4px 20px var(--gold-glow), 0 0 40px var(--gold-glow);
}

.tier-chip.selected .tier-unit {
  color: rgba(8, 8, 13, 0.6);
}

.tier-chip.disabled {
  opacity: 0.2;
  cursor: not-allowed;
  border-color: var(--border);
  color: var(--text-muted);
}

@media (max-width: 640px) {
  .tier-chip {
    padding: 10px 16px;
    font-size: 0.9rem;
    min-width: 72px;
  }
}
</style>
