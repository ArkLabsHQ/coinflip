<template>
  <div id="app" class="app">
    <nav class="topbar" v-if="isInitialized">
      <router-link to="/" class="logo">
        <span class="logo-icon">&#x20BF;</span>
        <span class="logo-text">COINFLIP</span>
      </router-link>
      <div class="topbar-right">
        <button class="balance-pill mono" @click="walletOpen = true" :title="connTitle">
          <span class="conn-dot" :class="arkStatus"></span>
          <span class="balance-num">{{ formatSats(walletBalance) }}</span>
          <span class="balance-unit">sats</span>
        </button>
      </div>
    </nav>

    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" @open-wallet="walletOpen = true" />
      </transition>
    </router-view>

    <nav class="bottom-nav" v-if="isInitialized">
      <router-link to="/" class="bottom-link" :class="{ active: $route.path === '/' }">
        <span class="bottom-icon">&#9824;</span>
        Play
      </router-link>
      <button class="bottom-link" :class="{ active: walletOpen }" @click="walletOpen = true">
        <span class="bottom-icon">&#9830;</span>
        Wallet
      </button>
      <router-link to="/history" class="bottom-link" :class="{ active: $route.path === '/history' }">
        <span class="bottom-icon">&#9827;</span>
        History
      </router-link>
    </nav>

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

    // Strip ?wallet=open from URL when the drawer closes (so reload doesn't re-open).
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
  display: flex;
  flex-direction: column;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
  backdrop-filter: blur(12px);
  position: sticky;
  top: 0;
  z-index: 50;
}

.logo {
  display: flex; align-items: center; gap: 8px;
  text-decoration: none; color: var(--text);
  font-weight: 800; letter-spacing: 2px;
  .logo-icon { color: var(--gold); font-size: 1.3rem; }
  .logo-text { font-size: 0.9rem; }
}

.topbar-right { display: flex; align-items: center; gap: 12px; }

.balance-pill {
  display: flex; align-items: center; gap: 10px;
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  color: var(--text);
  padding: 8px 14px; border-radius: 999px;
  font-size: 0.9rem; font-weight: 600;
  cursor: pointer; transition: all 0.18s ease;
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

.bottom-nav {
  display: flex;
  justify-content: space-around;
  border-top: 1px solid var(--border);
  background: var(--bg-subtle);
  padding: 10px 0 14px;
  position: sticky; bottom: 0; z-index: 50;
}
.bottom-link {
  background: none; border: none;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  text-decoration: none; color: var(--text-muted);
  font-size: 0.72rem; font-weight: 600; letter-spacing: 1px;
  cursor: pointer; font-family: inherit;
  .bottom-icon { font-size: 1.2rem; }
  &.active, &.router-link-active { color: var(--gold); }
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
