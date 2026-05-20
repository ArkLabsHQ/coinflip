<template>
  <div id="app" class="app">
    <nav class="topbar" v-if="isInitialized">
      <router-link to="/" class="logo">
        <span class="logo-icon">&#x20BF;</span>
        <span class="logo-text">COINFLIP</span>
      </router-link>
      <div class="topbar-right">
        <span class="balance mono" v-if="walletBalance > 0">
          {{ formatSats(walletBalance) }}
          <span class="balance-unit">sats</span>
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
        <span class="bottom-icon">&#9824;</span>
        Play
      </router-link>
      <router-link to="/wallet" class="bottom-link" :class="{ active: $route.path === '/wallet' }">
        <span class="bottom-icon">&#9830;</span>
        Wallet
      </router-link>
      <router-link to="/history" class="bottom-link" :class="{ active: $route.path === '/history' }">
        <span class="bottom-icon">&#9827;</span>
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
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
  backdrop-filter: blur(12px);
  position: sticky;
  top: 0;
  z-index: 50;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
}

.logo-icon {
  color: var(--gold);
  font-size: 1.25rem;
  font-weight: 800;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(247, 201, 72, 0.10);
  border-radius: 8px;
  border: 1px solid rgba(247, 201, 72, 0.15);
}

.logo-text {
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 2.5px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 20px;
}

.balance {
  color: var(--gold);
  font-size: 0.85rem;
  font-weight: 600;
  padding: 6px 14px;
  background: rgba(247, 201, 72, 0.06);
  border: 1px solid rgba(247, 201, 72, 0.10);
  border-radius: 20px;
}

.balance-unit {
  color: var(--text-muted);
  font-weight: 400;
  font-size: 0.75rem;
  margin-left: 2px;
}

.nav-link {
  color: var(--text-dim);
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 6px;
  transition: all 0.2s;

  &:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
}

.bottom-nav {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border);
  padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
  z-index: 100;
  backdrop-filter: blur(12px);
}

.bottom-link {
  flex: 1;
  text-align: center;
  padding: 6px 8px;
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.5px;
  transition: color 0.2s;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;

  &.active {
    color: var(--gold);
  }
}

.bottom-icon {
  font-size: 1.1rem;
  line-height: 1;
}

@media (max-width: 640px) {
  .bottom-nav {
    display: flex;
  }

  .topbar-right .nav-link {
    display: none;
  }

  .app {
    padding-bottom: 64px;
  }
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
