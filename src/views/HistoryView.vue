<template>
  <div class="page history-page">
    <h2 class="page-title">Game History</h2>
    <div class="casino-card-glow history-card">
      <GameHistoryList :games="games" />
    </div>
    <router-link to="/" class="btn-outline back-btn">Back to Play</router-link>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted } from 'vue'
import GameHistoryList from '@/components/GameHistoryList.vue'
import type { GameHistoryItem } from '@/components/GameHistoryList.vue'

export default defineComponent({
  name: 'HistoryView',
  components: { GameHistoryList },
  setup() {
    const games = ref<GameHistoryItem[]>([])

    onMounted(() => {
      const stored = localStorage.getItem('gameHistory')
      if (stored) {
        games.value = JSON.parse(stored)
      }
    })

    return { games }
  },
})
</script>

<style scoped>
.history-page {
  max-width: 600px;
  margin: 0 auto;
  gap: 20px;
}

.page-title {
  color: var(--gold);
  font-size: 1.2rem;
  letter-spacing: 2px;
  text-align: center;
}

.history-card {
  width: 100%;
}

.back-btn {
  margin-top: 8px;
}
</style>
