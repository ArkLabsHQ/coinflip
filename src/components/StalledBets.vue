<template>
  <div v-if="bets.length" class="stalled">
    <div class="stalled-head">
      <span class="title">⚠ Reclaim stalled bets</span>
      <span class="sub">A game didn't resolve — reclaim your escrowed stake trustlessly.</span>
    </div>
    <div v-for="b in bets" :key="b.gameId" class="bet-row">
      <div class="bet-info">
        <span class="amount">{{ b.tier.toLocaleString() }} sats</span>
        <span class="state" :class="{ ready: isReady(b) }">{{ statusLabel(b) }}</span>
      </div>
      <button
        class="reclaim-btn"
        :disabled="!isReady(b) || busy === b.gameId"
        @click="reclaim(b.gameId)"
      >
        {{ busy === b.gameId ? 'Reclaiming…' : 'Reclaim' }}
      </button>
    </div>
    <p v-if="message" class="msg">{{ message }}</p>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onUnmounted } from 'vue'
import { useStore } from 'vuex'
import type { StashedRefund } from '@/store/modules/ark/ark'

export default defineComponent({
  name: 'StalledBets',
  setup() {
    const store = useStore()
    const bets = ref<StashedRefund[]>([])
    const busy = ref<string | null>(null)
    const message = ref('')
    const now = ref(Math.floor(Date.now() / 1000))
    let timer: number | undefined

    async function refresh() {
      bets.value = await store.dispatch('ark/listStalledBets')
    }
    const isReady = (b: StashedRefund) => now.value >= b.finalExpiration
    function statusLabel(b: StashedRefund): string {
      if (isReady(b)) return 'Reclaimable now'
      const secs = b.finalExpiration - now.value
      const mins = Math.ceil(secs / 60)
      return `Reclaimable in ~${mins} min`
    }

    async function reclaim(gameId: string) {
      busy.value = gameId
      message.value = ''
      try {
        await store.dispatch('ark/reclaimStalledBet', gameId)
        message.value = 'Reclaimed — stake returned to your wallet.'
      } catch (e: unknown) {
        message.value = e instanceof Error ? e.message : 'Reclaim failed'
      } finally {
        busy.value = null
        await refresh()
      }
    }

    onMounted(() => {
      refresh()
      // Tick so countdowns update and a bet flips to "reclaimable" on time.
      timer = window.setInterval(() => { now.value = Math.floor(Date.now() / 1000) }, 1000)
    })
    onUnmounted(() => { if (timer) window.clearInterval(timer) })

    return { bets, busy, message, isReady, statusLabel, reclaim }
  },
})
</script>

<style lang="scss" scoped>
.stalled {
  background: var(--bg-card, #111119);
  border: 1px solid var(--red, #f87171);
  border-radius: var(--radius, 14px);
  padding: 16px;
  margin: 16px 0;
}
.stalled-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; }
.stalled-head .title { color: var(--red, #f87171); font-weight: 600; font-size: 0.9rem; }
.stalled-head .sub { color: var(--text-dim, #a0a0b8); font-size: 0.75rem; }
.bet-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 0; border-top: 1px solid rgba(255, 255, 255, 0.05);
}
.bet-info { display: flex; flex-direction: column; gap: 2px; }
.bet-info .amount { font-weight: 600; color: var(--text, #eeeef4); }
.bet-info .state { font-size: 0.72rem; color: var(--text-muted, #5c5c78); }
.bet-info .state.ready { color: var(--green, #34d399); }
.reclaim-btn {
  background: var(--gold, #f7c948); color: #08080d; border: none;
  border-radius: 8px; padding: 6px 16px; font-weight: 600; cursor: pointer;
}
.reclaim-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.msg { margin-top: 10px; font-size: 0.78rem; color: var(--text-dim, #a0a0b8); }
</style>
