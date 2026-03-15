<template>
  <div class="history-list">
    <div v-if="games.length === 0" class="empty-state">
      No games yet. Go flip some coins!
    </div>
    <div v-else>
      <div
        v-for="game in games"
        :key="game.id"
        class="history-row"
        :class="game.winner === 'player' ? 'row-win' : game.winner === 'house' ? 'row-loss' : 'row-pending'"
      >
        <div class="row-left">
          <span class="badge" :class="badgeClass(game)">
            {{ badgeText(game) }}
          </span>
          <span class="tier mono">{{ formatSats(game.tier) }} sats</span>
        </div>
        <div class="row-right">
          <span
            v-if="game.winner === 'player'"
            class="payout mono text-green"
          >+{{ formatSats(game.payoutAmount || 0) }}</span>
          <span
            v-else-if="game.winner === 'house'"
            class="payout mono text-red"
          >-{{ formatSats(game.tier) }}</span>
          <span v-else class="payout mono text-muted">pending</span>
          <span class="time text-muted">{{ timeAgo(game.createdAt) }}</span>
        </div>
      </div>
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
  },
})
</script>

<style scoped>
.history-list {
  width: 100%;
}

.empty-state {
  text-align: center;
  color: var(--text-muted);
  padding: 48px 16px;
  font-style: italic;
}

.history-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  transition: background 0.15s;
}

.history-row:hover {
  background: rgba(255, 255, 255, 0.02);
}

.row-left, .row-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.badge-win { background: rgba(0, 255, 136, 0.12); color: var(--green); }
.badge-loss { background: rgba(255, 68, 68, 0.12); color: var(--red); }
.badge-pending { background: rgba(0, 212, 255, 0.12); color: var(--blue); }

.tier {
  font-size: 0.9rem;
  color: var(--text);
}

.payout {
  font-size: 0.9rem;
  font-weight: 600;
}

.time {
  font-size: 0.75rem;
  min-width: 60px;
  text-align: right;
}

@media (max-width: 640px) {
  .history-row { padding: 10px 12px; }
  .tier, .payout { font-size: 0.8rem; }
}
</style>
