<template>
  <div class="history-list">
    <div v-if="games.length === 0" class="empty-state">
      <div class="empty-icon">&#9824;</div>
      <div class="empty-text">No games yet</div>
      <div class="empty-sub">Go flip some coins!</div>
    </div>
    <div v-else>
      <button
        v-for="game in games"
        :key="game.id"
        class="history-row"
        type="button"
        :aria-label="`View details for game ${game.id}`"
        @click="$emit('select', game.id)"
      >
        <div class="row-left">
          <span class="badge" :class="badgeClass(game)">
            {{ badgeText(game) }}
          </span>
          <span class="tier mono">{{ formatSats(game.tier) }}</span>
        </div>
        <div class="row-right">
          <span class="payout mono" :class="payoutClass(game)">
            {{ payoutText(game) }}
          </span>
          <span class="time">{{ timeAgo(game.createdAt) }}</span>
          <span class="chev" aria-hidden="true">›</span>
        </div>
      </button>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

export interface GameHistoryItem {
  id: string
  tier: number
  playerChoice: string
  winner: string | null
  rakeAmount: number
  payoutAmount: number | null
  status: string
  createdAt: string
  resolvedAt: string | null
}

export default defineComponent({
  name: 'GameHistoryList',
  props: {
    games: { type: Array as PropType<GameHistoryItem[]>, required: true },
  },
  emits: ['select'],
  methods: {
    formatSats(n: number): string {
      return n.toLocaleString()
    },
    timeAgo(dateStr: string): string {
      const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z')
      const s = Math.floor((Date.now() - d.getTime()) / 1000)
      if (s < 60) return `${s}s ago`
      if (s < 3600) return `${Math.floor(s / 60)}m ago`
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`
      return `${Math.floor(s / 86400)}d ago`
    },
    badgeClass(game: GameHistoryItem): string {
      if (game.winner === 'player') return 'badge-win'
      if (game.winner === 'house') return 'badge-loss'
      return 'badge-pending'
    },
    badgeText(game: GameHistoryItem): string {
      if (game.winner === 'player') return 'WIN'
      if (game.winner === 'house') return 'LOSS'
      return game.status.toUpperCase()
    },
    payoutClass(game: GameHistoryItem): string {
      if (game.winner === 'player') return 'payout-win'
      if (game.winner === 'house') return 'payout-loss'
      return 'payout-pending'
    },
    payoutText(game: GameHistoryItem): string {
      if (game.winner === 'player') return `+${this.formatSats(game.payoutAmount || 0)}`
      if (game.winner === 'house') return `-${this.formatSats(game.tier)}`
      return 'pending'
    },
  },
})
</script>

<style scoped>
.history-list {
  width: 100%;
}

.empty-state {
  text-align: center;
  padding: 48px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.empty-icon {
  font-size: 2rem;
  color: var(--text-muted);
  opacity: 0.4;
  margin-bottom: 8px;
}

.empty-text {
  color: var(--text-dim);
  font-weight: 600;
  font-size: 0.95rem;
}

.empty-sub {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.history-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  transition: background 0.15s;
  /* Button reset (the row IS a button now, for clickable details). */
  background: transparent;
  border-left: none;
  border-right: none;
  border-top: none;
  width: 100%;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

.chev {
  margin-left: 4px;
  color: var(--text-muted);
  font-size: 1.1rem;
  line-height: 1;
}

.history-row:last-child {
  border-bottom: none;
}

.history-row:hover {
  background: rgba(255, 255, 255, 0.015);
}

.row-left, .row-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.badge-win {
  background: rgba(52, 211, 153, 0.10);
  color: var(--green);
}

.badge-loss {
  background: rgba(248, 113, 113, 0.10);
  color: var(--red);
}

.badge-pending {
  background: rgba(56, 189, 248, 0.10);
  color: var(--blue);
}

.tier {
  font-size: 0.88rem;
  color: var(--text-dim);
}

.payout {
  font-size: 0.88rem;
  font-weight: 600;
}

.payout-win { color: var(--green); }
.payout-loss { color: var(--red); }
.payout-pending { color: var(--text-muted); }

.time {
  font-size: 0.73rem;
  color: var(--text-muted);
  min-width: 52px;
  text-align: right;
}

@media (max-width: 640px) {
  .history-row { padding: 12px 14px; }
  .tier, .payout { font-size: 0.82rem; }
}
</style>
