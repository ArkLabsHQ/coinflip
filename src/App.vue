<template>
  <div id="app" class="app">
    <!-- Floating balance pill, top-right. Single corner-anchored UI element
         that replaces the entire topbar nav. Click opens the WalletDrawer. -->
    <button v-if="isInitialized" class="float-pill mono" @click="walletOpen = true" :title="connTitle">
      <span class="conn-dot" :class="arkStatus"></span>
      <span class="wallet-ico" aria-hidden="true">👛</span>
      <span class="balance-num">{{ formatSats(walletBalance) }}</span>
      <span class="balance-unit">sats</span>
      <span class="pill-caret" aria-hidden="true">›</span>
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

    <WalletDrawer v-model:open="walletOpen" :dismissible="!forceWalletOpen" />
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

    // A connected wallet with a zero balance can't play — force the drawer open
    // (and non-dismissible, via :dismissible below) so the user funds it first.
    // Gated on 'connected' so a transient 0 during connect/error doesn't trap them.
    const forceWalletOpen = computed(() =>
      isInitialized.value && arkStatus.value === 'connected' && walletBalance.value === 0,
    )
    watch(forceWalletOpen, (force) => { if (force) walletOpen.value = true }, { immediate: true })

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

    return { isInitialized, walletBalance, formatSats, walletOpen, forceWalletOpen, arkStatus, connTitle }
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
  gap: 8px;
  background: var(--bg-elevated);
  /* Stronger, always-on affordance so it reads as a tappable wallet button. */
  border: 1px solid var(--gold-dim, #d4a530);
  color: var(--text);
  padding: 8px 12px 8px 14px;
  border-radius: 999px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.18s ease;
  backdrop-filter: blur(10px);
  box-shadow: 0 0 0 1px rgba(247, 201, 72, 0.08), 0 4px 14px rgba(0, 0, 0, 0.35);
  &:hover {
    border-color: var(--gold);
    box-shadow: 0 0 16px var(--gold-glow);
    transform: translateY(-1px);
    .pill-caret { transform: translateX(2px); color: var(--gold); }
  }
  .wallet-ico { font-size: 0.95rem; line-height: 1; }
  .balance-num { color: var(--gold); }
  .balance-unit { color: var(--text-muted); font-size: 0.72rem; }
  .pill-caret { color: var(--text-muted); font-size: 1.1rem; line-height: 1; transition: transform 0.18s ease, color 0.18s ease; }
}

/* Widescreen: the top-right corner is far from the centered content column and
   easy to miss — align the pill to the middle-top, matching the layout container. */
@media (min-width: 768px) {
  .float-pill {
    left: 50%;
    right: auto;
    transform: translateX(-50%);
    &:hover { transform: translateX(-50%) translateY(-1px); }
  }
}

.mode-switch {
  position: fixed;
  top: 18px;
  left: 18px;
  z-index: 50;
  display: flex;
  gap: 2px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-light);
  border-radius: 999px;
  padding: 3px;
  backdrop-filter: blur(10px);

  .mode-link {
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 1px;
    padding: 5px 14px;
    border-radius: 999px;
    transition: all 0.18s ease;
    &:hover { color: var(--text); }
    &.active {
      background: rgba(247, 201, 72, 0.14);
      color: var(--gold);
      box-shadow: 0 0 8px var(--gold-glow);
    }
  }
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
