<template>
  <div id="app">
    <nav>
      <div class="nav-content">
        <div class="nav-left">
          <button 
            @click="refreshAll" 
            class="refresh-button"
            v-if="!isSetupRoute"
            :disabled="!isWalletInitialized"
          >
            <span class="material-icons" :class="{ 'rotating': isRefreshing }">refresh</span>
          </button>
          <router-link to="/" class="logo">CoinFlip</router-link>
          <div class="relay-groups desktop-only">
            <div class="relay-group">
              <span class="relay-label">nostr</span>
              <div 
                class="relay-status" 
                @click="isWalletInitialized && (showRelaySettings = true)"
                :class="{ disabled: !isWalletInitialized }"
                v-if="!isSetupRoute"
              >
                <span class="status-indicator" :class="nostrStatus"></span>
                <span class="relay-url">{{ nostrRelay }}</span>
              </div>
            </div>
            <div class="relay-group">
              <span class="relay-label">ark</span>
              <div 
                class="relay-status" 
                @click="isWalletInitialized && (showArkSettings = true)"
                :class="{ disabled: !isWalletInitialized }"
                v-if="!isSetupRoute"
              >
                <span class="status-indicator" :class="arkStatus"></span>
                <span class="relay-url">{{ arkServer }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="nav-links desktop-only">
          <template v-if="!isSetupRoute">
            <router-link 
              to="/" 
              class="nav-button"
              :class="{ disabled: !isWalletInitialized }"
              @click="!isWalletInitialized && $event.preventDefault()"
            >
              <span class="material-icons">casino</span>
              Games
            </router-link>
            <div class="wallet-group">
              <router-link 
                to="/wallet" 
                class="nav-button"
                :class="{ disabled: !isWalletInitialized }"
                @click="!isWalletInitialized && $event.preventDefault()"
              >
                <span class="material-icons">account_balance_wallet</span>
                Wallet
              </router-link>
              <div class="wallet-balance" :class="{ disabled: !isWalletInitialized }">
                ₿ {{ formattedBalance }}
              </div>
            </div>
          </template>
          <button @click="toggleTheme" class="theme-toggle">
            <span class="material-icons">{{ isDark ? 'light_mode' : 'dark_mode' }}</span>
          </button>
        </div>
        <button @click="toggleMobileMenu" class="mobile-menu-button mobile-only">
          <span class="material-icons">{{ showMobileMenu ? 'close' : 'menu' }}</span>
        </button>
      </div>
    </nav>
    <div class="mobile-menu" :class="{ 'show': showMobileMenu }" v-if="!isSetupRoute">
      <div class="mobile-menu-content">
        <router-link 
          to="/" 
          class="nav-button"
          :class="{ disabled: !isWalletInitialized }"
          @click="closeMobileMenu"
        >
          <span class="material-icons">casino</span>
          Games
        </router-link>
        <router-link 
          to="/wallet" 
          class="nav-button"
          :class="{ disabled: !isWalletInitialized }"
          @click="closeMobileMenu"
        >
          <span class="material-icons">account_balance_wallet</span>
          Wallet
        </router-link>
        <router-link 
          to="/how-it-works" 
          class="nav-button"
          @click="closeMobileMenu"
        >
          <span class="material-icons">help_outline</span>
          How It Works
        </router-link>
        <div class="wallet-balance" :class="{ disabled: !isWalletInitialized }">
          ₿ {{ formattedBalance }}
        </div>
        <div class="relay-groups">
          <div class="relay-group">
            <span class="relay-label">nostr</span>
            <div 
              class="relay-status" 
              @click="openRelaySettings"
              :class="{ disabled: !isWalletInitialized }"
            >
              <span class="status-indicator" :class="nostrStatus"></span>
              <span class="relay-url">{{ nostrRelay }}</span>
            </div>
          </div>
          <div class="relay-group">
            <span class="relay-label">ark</span>
            <div 
              class="relay-status" 
              @click="openArkSettings"
              :class="{ disabled: !isWalletInitialized }"
            >
              <span class="status-indicator" :class="arkStatus"></span>
              <span class="relay-url">{{ arkServer }}</span>
            </div>
          </div>
        </div>
        <button @click="toggleTheme" class="theme-toggle">
          <span class="material-icons">{{ isDark ? 'light_mode' : 'dark_mode' }}</span>
          {{ isDark ? 'Light Mode' : 'Dark Mode' }}
        </button>
      </div>
    </div>
    <router-view/>
    <relay-settings
      v-if="showRelaySettings"
      @close="showRelaySettings = false"
    />
    <ark-settings
      v-if="showArkSettings"
      @close="showArkSettings = false"
    />
    <base-footer/>
  </div>
</template>

<script>
import { computed, onMounted, ref } from 'vue'
import { useStore } from 'vuex'
import { useRoute } from 'vue-router'
import RelaySettings from '@/components/RelaySettings.vue'
import ArkSettings from '@/components/ArkSettings.vue'
import BaseFooter from '@/components/BaseFooter.vue'

const truncateUrl = (url, maxLength = 30) => {
  if (url.length <= maxLength) return url
  const start = url.substring(0, maxLength / 2)
  const end = url.substring(url.length - maxLength / 2)
  return `${start}...${end}`
}

export default {
  components: {
    RelaySettings,
    ArkSettings,
    BaseFooter
  },
  setup() {
    const store = useStore()
    const route = useRoute()
    
    const isRefreshing = ref(false)
    const isDark = ref(localStorage.getItem('theme') === 'dark')
    const nostrStatus = computed(() => store.getters.nostrStatus)
    const nostrRelay = computed(() => truncateUrl(store.getters.nostrRelay))
    const showRelaySettings = ref(false)
    const showArkSettings = ref(false)
    const isWalletInitialized = computed(() => store.getters.isWalletInitialized)
    const isSetupRoute = computed(() => route.name === 'setup')
    const arkStatus = computed(() => store.getters.arkStatus)
    const arkServer = computed(() => truncateUrl(store.getters.arkServer))
    const formattedBalance = computed(() => store.getters['ark/formattedBalance'])
    const showMobileMenu = ref(false)

    const toggleTheme = () => {
      isDark.value = !isDark.value
      localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
      document.documentElement.classList.toggle('dark', isDark.value)
    }

    const refreshAll = async () => {
      isRefreshing.value = true
      await Promise.all([
        store.dispatch('ark/checkConnection'),
        store.dispatch('fetchBTCPrice'),
        store.dispatch('connectNostr')
      ])
      setTimeout(() => {
        isRefreshing.value = false
      }, 1000) // Keep spinning for at least 1 second
    }

    const toggleMobileMenu = () => {
      showMobileMenu.value = !showMobileMenu.value
    }

    const closeMobileMenu = () => {
      showMobileMenu.value = false
    }

    const openRelaySettings = () => {
      if (isWalletInitialized.value) {
        showRelaySettings.value = true
        closeMobileMenu()
      }
    }

    const openArkSettings = () => {
      if (isWalletInitialized.value) {
        showArkSettings.value = true
        closeMobileMenu()
      }
    }

    onMounted(() => {
      refreshAll()
      document.documentElement.classList.toggle('dark', isDark.value)
      store.dispatch('connectNostr')
      store.dispatch('checkArkConnection')
    })

    return {
      formattedBalance,
      refreshAll,
      isRefreshing,
      isDark,
      toggleTheme,
      nostrStatus,
      nostrRelay,
      showRelaySettings,
      showArkSettings,
      isWalletInitialized,
      isSetupRoute,
      arkStatus,
      arkServer,
      showMobileMenu,
      toggleMobileMenu,
      closeMobileMenu,
      openRelaySettings,
      openArkSettings
    }
  }
}
</script>

<style lang="scss">
:root {
  --primary: #6366f1;
  --primary-dark: #4f46e5;
  --secondary: #64748b;
  --success: #22c55e;
  --danger: #ef4444;
  --background: #f8fafc;
  --card: #ffffff;
  --text: #1e293b;
  --text-light: #64748b;
  --border: #e2e8f0;

  &.dark {
    --background: #0f172a;
    --card: #1e293b;
    --text: #f1f5f9;
    --text-light: #94a3b8;
    --border: #334155;
  }
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background-color: var(--background);
  color: var(--text);
  line-height: 1.5;
}

#app {
  min-height: 100vh;
}

router-view {
  flex: 1;
}

nav {
  background: var(--card);
  border-bottom: 1px solid var(--border);
  padding: 1rem 0;
  position: sticky;
  top: 0;
  z-index: 100;
  
  .nav-content {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;

    .nav-left {
      display: flex;
      align-items: center;
      gap: 1rem;

      .refresh-button {
        background: transparent;
        color: var(--text-light);
        padding: 0.5rem;
        min-width: auto;
        font-size: 1.25rem;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.2s;

        &:hover {
          color: var(--primary);
        }

        .material-icons {
          transition: transform 1s ease;

          &.rotating {
            transform: rotate(360deg);
          }
        }
      }

      .logo {
        font-size: 1.5rem;
        font-weight: 700;
        color: var(--primary);
        text-decoration: none;
      }

      .relay-groups {
        display: flex;
        gap: 1rem;
      }

      .relay-group {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;

        .relay-label {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-light);
          padding-left: 0.75rem;
        }
      }

      .relay-status {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.25rem 0.75rem;
        background: var(--background);
        border-radius: 0.5rem;
        font-size: 0.875rem;
        color: var(--text-light);
        cursor: pointer;
        transition: background-color 0.2s;

        &:hover {
          background: var(--border);
        }

        .status-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          
          &.connected {
            background: var(--success);
            box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.2);
          }
          
          &.connecting {
            background: #fbbf24;
            box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.2);
            animation: pulse 1s infinite;
          }
          
          &.disconnected {
            background: var(--danger);
            box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
          }
        }

        .relay-url {
          font-family: monospace;
          max-width: 200px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }
    }

    .nav-links {
      display: flex;
      gap: 1rem;
      align-items: center;

      .wallet-group {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .nav-button {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        border-radius: 0.5rem;
        transition: background-color 0.2s;
        
        &:hover {
          background: var(--background);
        }
        
        &.router-link-active {
          background: var(--background);
        }
        
        .material-icons {
          font-size: 1.25rem;
        }

        &.disabled {
          opacity: 0.5;
          cursor: not-allowed;
          pointer-events: none;
          background: var(--text-light);
          color: var(--text);
        }
      }

      .wallet-balance {
        display: flex;
        align-items: center;
        color: var(--text);
        font-weight: 500;
        padding: 0.25rem 0.75rem;
        background: var(--background);
        border-radius: 0.5rem;

        &.disabled {
          opacity: 0.5;
          background: var(--text-light);
        }
      }

      a, .nav-button {
        text-decoration: none;
        color: var(--text);
        font-weight: 500;
      }

      .theme-toggle {
        background: transparent;
        color: var(--text-light);
        padding: 0.5rem;
        min-width: auto;
        font-size: 1.25rem;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.2s;

        &:hover {
          color: var(--primary);
        }

        .material-icons {
          font-size: 1.25rem;
        }
      }
    }
  }
}

button {
  background: var(--primary);
  color: white;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 0.5rem;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s;

  &:hover {
    background: var(--primary-dark);
  }

  &:disabled {
    background: var(--text-light);
    cursor: not-allowed;
    opacity: 0.5;
    pointer-events: none;
  }
}

h1 {
  font-size: 2rem;
  font-weight: 700;
  margin-bottom: 2rem;
}

h2 {
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

@keyframes pulse {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
  100% {
    opacity: 1;
  }
}

.desktop-only {
  @media (max-width: 768px) {
    display: none !important;
  }
}

.mobile-only {
  display: none !important;
  @media (max-width: 768px) {
    display: flex !important;
  }
}

.mobile-menu-button {
  background: transparent;
  color: var(--text);
  padding: 0.5rem;
  min-width: auto;
  border-radius: 0.75rem;
  transition: all 0.2s ease;

  &:active {
    background: var(--background);
    transform: scale(0.95);
  }

  .material-icons {
    font-size: 1.75rem;
  }
}

.mobile-menu {
  position: fixed;
  top: 73px;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--background);
  z-index: 100;
  transform: translateX(100%);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow-y: auto;
  backdrop-filter: blur(8px);
  
  &.show {
    transform: translateX(0);
    box-shadow: 0 0 15px rgba(0, 0, 0, 0.1);
  }

  .mobile-menu-content {
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 500px;
    margin: 0 auto;

    .nav-button {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      padding: 0.875rem 1.25rem;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 1rem;
      font-size: 1rem;
      gap: 1rem;
      font-weight: 500;
      transition: all 0.2s ease;

      .material-icons {
        font-size: 1.4rem;
        color: var(--primary);
      }

      &:active {
        transform: scale(0.98);
        background: var(--background);
      }

      &.router-link-active {
        background: var(--primary);
        border-color: var(--primary);
        color: white;

        .material-icons {
          color: white;
        }
      }
    }

    .wallet-balance {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.875rem 1.25rem;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 1rem;
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--primary);
    }

    .relay-groups {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      background: var(--card);
      padding: 1.25rem;
      border-radius: 1rem;
      border: 1px solid var(--border);

      .relay-group {
        .relay-label {
          font-size: 0.75rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-light);
          margin-bottom: 0.5rem;
        }

        .relay-status {
          background: var(--background);
          padding: 0.75rem 1rem;
          border-radius: 0.75rem;
          width: 100%;
          border: 1px solid var(--border);
          transition: all 0.2s ease;

          &:active {
            transform: scale(0.98);
            background: var(--card);
          }

          .status-indicator {
            width: 10px;
            height: 10px;
          }

          .relay-url {
            font-size: 0.9rem;
          }
        }
      }
    }

    .theme-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 1rem;
      color: var(--text);
      background: var(--card);
      padding: 0.875rem 1.25rem;
      border: 1px solid var(--border);
      border-radius: 1rem;
      font-size: 1rem;
      font-weight: 500;
      transition: all 0.2s ease;

      .material-icons {
        font-size: 1.4rem;
        color: var(--primary);
      }

      &:active {
        transform: scale(0.98);
        background: var(--background);
      }
    }
  }
}
</style> 