<template>
  <div id="app" class="app">
    <!-- Floating balance pill, top-right. Single corner-anchored UI element
         that replaces the entire topbar nav. Click opens the WalletDrawer. -->
    <button v-if="isInitialized" class="float-pill mono" @click="walletOpen = true" :title="connTitle">
      <span class="conn-dot" :class="arkStatus"></span>
      <span class="balance-num">{{ formatSats(walletBalance) }}</span>
      <span class="balance-unit">sats</span>
    </button>

    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" @open-wallet="walletOpen = true" />
      </transition>
    </router-view>

    <!-- Back link only on the history page; the play page reaches history
         via the in-HUD button next to the P/L pill. -->
    <router-link v-if="isInitialized && $route.path === '/history'" to="/" class="corner-link history-corner">
      &laquo; play
    </router-link>

    <WalletDrawer v-model:open="walletOpen" />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch } from 'vue'
import { useStore } from 'vuex'
import { useRoute, useRouter } from 'vue-router'
import WalletDrawer from '@/components/WalletDrawer.vue'

export default defineComponent({
  name: 'App',
  components: { WalletDrawer },
  setup() {
    const store = useStore()
    const route = useRoute()
    const router = useRouter()
    const isInitialized = computed(() => store.state.wallet?.isInitialized)
    const walletBalance = computed(() => {
      const settled = store.getters['ark/balance']
      return settled !== undefined ? Number(settled) : (store.state.walletBalance || 0)
    })
    const arkStatus = computed(() => store.state.ark?.status as string)
    const connTitle = computed(() => {
      if (arkStatus.value === 'connected') return 'Connected to Ark'
      if (arkStatus.value === 'connecting') return 'Connecting…'
      if (arkStatus.value === 'error') return store.state.ark?.lastError?.message || 'Connection error'
      return 'Disconnected'
    })

    const walletOpen = ref(false)

    // Deep-link support: /wallet (legacy) or /?wallet=open both open the drawer.
    function maybeOpenFromRoute() {
      if (route.path === '/wallet' || route.query.wallet === 'open') {
        walletOpen.value = true
        if (route.path === '/wallet') router.replace('/')
      }
    }
    watch(() => [route.path, route.query.wallet], maybeOpenFromRoute, { immediate: true })

    watch(walletOpen, (open) => {
      if (!open && route.query.wallet) {
        const q = { ...route.query }; delete q.wallet
        router.replace({ query: q })
      }
    })

    function formatSats(n: number): string { return n.toLocaleString() }

    return { isInitialized, walletBalance, formatSats, walletOpen, arkStatus, connTitle }
  },
})
</script>

<style lang="scss">
@import '@/assets/styles/casino.scss';

.app {
  min-height: 100vh;
  position: relative;
}

.float-pill {
  position: fixed;
  top: 18px;
  right: 18px;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-light);
  color: var(--text);
  padding: 8px 14px;
  border-radius: 999px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.18s ease;
  backdrop-filter: blur(10px);
  &:hover { border-color: var(--gold); box-shadow: 0 0 12px var(--gold-glow); }
  .balance-num { color: var(--gold); }
  .balance-unit { color: var(--text-muted); font-size: 0.72rem; }
}

.conn-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-muted);
  &.connected { background: var(--green, #22c55e); box-shadow: 0 0 6px rgba(34, 197, 94, 0.6); }
  &.connecting { background: var(--blue); animation: pulse 1.4s ease-in-out infinite; }
  &.error { background: var(--red); }
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.corner-link {
  position: fixed;
  bottom: 14px;
  left: 18px;
  z-index: 40;
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.7rem;
  letter-spacing: 2px;
  text-transform: uppercase;
  padding: 4px 8px;
  border-radius: 6px;
  transition: color 0.18s;
  &:hover { color: var(--gold); }
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
