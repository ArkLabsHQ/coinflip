<template>
  <div id="app" class="app">
    <nav class="topbar" v-if="isInitialized">
      <router-link to="/" class="logo">ARKADE COINFLIP</router-link>
      <div class="topbar-right">
        <span class="balance mono" v-if="walletBalance > 0">
          {{ formatSats(walletBalance) }} sats
        </span>
        <router-link to="/wallet" class="nav-link">Wallet</router-link>
      </div>
    </nav>

    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>

    <nav class="bottom-nav" v-if="isInitialized">
      <router-link to="/" class="bottom-link" :class="{ active: $route.path === '/' }">
        Play
      </router-link>
      <router-link to="/wallet" class="bottom-link" :class="{ active: $route.path === '/wallet' }">
        Wallet
      </router-link>
      <router-link to="/history" class="bottom-link" :class="{ active: $route.path === '/history' }">
        History
      </router-link>
    </nav>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue'
import { useStore } from 'vuex'

export default defineComponent({
  name: 'App',
  setup() {
    const store = useStore()
    const isInitialized = computed(() => store.state.wallet?.isInitialized)
    const walletBalance = computed(() => store.state.walletBalance || 0)

    function formatSats(n: number): string {
      return n.toLocaleString()
    }

    return { isInitialized, walletBalance, formatSats }
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
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
}

.logo {
  color: var(--gold);
  font-size: 0.9rem;
  font-weight: 800;
  letter-spacing: 3px;
  text-decoration: none;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

.balance {
  color: var(--gold);
  font-size: 0.85rem;
}

.nav-link {
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 500;
  transition: color 0.2s;

  &:hover { color: var(--blue); }
}

.bottom-nav {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-card);
  border-top: 1px solid var(--border);
  padding: 8px 0;
  z-index: 100;
}

.bottom-link {
  flex: 1;
  text-align: center;
  padding: 8px;
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 1px;
  transition: color 0.2s;

  &.active { color: var(--blue); }
}

@media (max-width: 640px) {
  .bottom-nav {
    display: flex;
  }

  .topbar-right .nav-link {
    display: none;
  }

  .app {
    padding-bottom: 56px;
  }
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
