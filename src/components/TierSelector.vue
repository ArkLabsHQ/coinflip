<template>
  <div class="tier-selector">
    <button
      v-for="tier in tiers"
      :key="tier"
      class="tier-chip"
      :class="{
        selected: tier === selectedTier,
        disabled: tier > maxAvailable || tier > playerBalance,
      }"
      :disabled="tier > maxAvailable || tier > playerBalance"
      @click="$emit('select', tier)"
    >
      {{ formatTier(tier) }}
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
    maxAvailable: { type: Number, default: Infinity },
    playerBalance: { type: Number, default: Infinity },
  },
  emits: ['select'],
  methods: {
    formatTier(n: number): string {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M'
      if (n >= 1_000) return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + 'K'
      return String(n)
    },
  },
})
</script>

<style scoped>
.tier-selector {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
}

.tier-chip {
  background: var(--bg);
  border: 2px solid var(--gold);
  color: var(--gold);
  border-radius: 28px;
  padding: 10px 24px;
  font-family: var(--font-mono);
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 80px;
}

.tier-chip:hover:not(.disabled) {
  background: rgba(255, 215, 0, 0.08);
  box-shadow: 0 0 15px var(--gold-glow);
}

.tier-chip.selected {
  background: var(--gold);
  color: var(--bg);
  transform: scale(1.08);
  box-shadow: 0 0 25px var(--gold-glow), 0 0 50px var(--gold-glow);
}

.tier-chip.disabled {
  opacity: 0.25;
  cursor: not-allowed;
  border-color: var(--text-muted);
  color: var(--text-muted);
}

@media (max-width: 640px) {
  .tier-chip {
    padding: 8px 18px;
    font-size: 0.9rem;
    min-width: 64px;
  }
}
</style>
