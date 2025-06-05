<template>
  <div class="setup-view">
    <div class="setup-container">
      <h1>Welcome to CoinFlip</h1>
      
      <div class="setup-options">
        <div class="option-card" @click="createWallet">
          <span class="material-icons">add_circle</span>
          <h2>Create New Wallet</h2>
          <p>Generate a new wallet for playing CoinFlip</p>
        </div>
        
        <div class="option-card" @click="mode = 'restore'">
          <span class="material-icons">restore</span>
          <h2>Restore Wallet</h2>
          <p>Restore your existing wallet using private key</p>
        </div>
      </div>

      <!-- Restore Wallet -->
      <div v-if="mode === 'restore'" class="setup-form">
        <div class="form-group">
          <label>Private Key</label>
          <input 
            type="text"
            v-model="privateKey"
            placeholder="Enter your nsec private key"
          >
          <div class="error" v-if="error">
            {{ error }}
          </div>
          <div class="hint">
            Private key should start with nsec1
          </div>
        </div>
        
        <button 
          @click="restoreWallet"
          :disabled="!privateKey"
          class="restore-button"
        >
          Restore Wallet
        </button>
      </div>
    </div>

    <!-- Private Key Modal -->
    <base-modal
      v-if="showPrivateKey"
      title="Your Private Key"
      @close="onPrivateKeyConfirmed"
    >
      <div class="private-key-display">
        <p class="warning">Save this private key in a secure location.</p>
        
        <div class="key-container">
          <code>{{ newPrivateKey }}</code>
          <button @click="copyPrivateKey" class="copy-button">
            <span class="material-icons">content_copy</span>
          </button>
        </div>

        <div class="confirmation">
          <label>
            <input type="checkbox" v-model="hasBackedUp">
            I have safely stored my private key
          </label>
        </div>

        <button 
          @click="onPrivateKeyConfirmed"
          :disabled="!hasBackedUp"
          class="confirm-button"
        >
          I've Saved My Key
        </button>
      </div>
    </base-modal>
  </div>
</template>

<script>
import { ref } from 'vue'
import { useStore } from 'vuex'
import { useRouter } from 'vue-router'
import BaseModal from '@/components/BaseModal.vue'

export default {
  name: 'SetupView',
  components: {
    BaseModal
  },
  setup() {
    const store = useStore()
    const router = useRouter()
    const mode = ref('')
    const privateKey = ref('')
    const error = ref('')
    const showPrivateKey = ref(false)
    const newPrivateKey = ref('')
    const hasBackedUp = ref(false)

    const createWallet = async () => {
      await store.dispatch('createNewWallet')
      newPrivateKey.value = store.getters.walletPrivateKeyEncoded
      showPrivateKey.value = true
    }

    const restoreWallet = async () => {
      try {
        await store.dispatch('restoreWallet', privateKey.value)
        router.push('/')
      } catch (err) {
        error.value = 'Invalid private key' + (err.cause ? `: ${err.cause}` : '')
      }
    }

    const copyPrivateKey = async () => {
      try {
        await navigator.clipboard.writeText(newPrivateKey.value)
        alert('Private key copied to clipboard!')
      } catch (err) {
        console.error('Failed to copy:', err)
      }
    }

    const onPrivateKeyConfirmed = () => {
      if (hasBackedUp.value) {
        showPrivateKey.value = false
        router.push('/')
      }
    }

    return {
      mode,
      privateKey,
      error,
      showPrivateKey,
      newPrivateKey,
      hasBackedUp,
      createWallet,
      restoreWallet,
      copyPrivateKey,
      onPrivateKeyConfirmed
    }
  }
}
</script>

<style lang="scss" scoped>
.setup-view {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}

.setup-container {
  max-width: 800px;
  width: 100%;
  text-align: center;

  h1 {
    margin-bottom: 3rem;
  }
}

.setup-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 2rem;
  margin-bottom: 3rem;
}

.option-card {
  background: var(--card);
  padding: 2rem;
  border-radius: 1rem;
  cursor: pointer;
  transition: all 0.2s;
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
  }

  .material-icons {
    font-size: 3rem;
    color: var(--primary);
    margin-bottom: 1rem;
  }

  h2 {
    margin-bottom: 0.5rem;
  }

  p {
    color: var(--text-light);
  }
}

.setup-form {
  max-width: 400px;
  margin: 0 auto;
}

.warning-box {
  background: #fef3c7;
  color: #92400e;
  padding: 1rem;
  border-radius: 0.5rem;
  margin-bottom: 2rem;
  text-align: left;

  h3 {
    color: #92400e;
    margin-bottom: 0.5rem;
  }
}

.form-group {
  margin-bottom: 2rem;
  text-align: left;

  label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
  }

  input {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    font-family: monospace;
  }

  .error {
    color: var(--danger);
    margin-top: 0.5rem;
    font-size: 0.875rem;
  }

  .hint {
    margin-top: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-light);
  }
}

.private-key-display {
  .warning {
    color: #92400e;
    background: #fef3c7;
    padding: 1rem;
    border-radius: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .key-container {
    background: var(--background);
    padding: 1rem;
    border-radius: 0.5rem;
    font-family: monospace;
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
    
    code {
      flex: 1;
      word-break: break-all;
    }
  }

  .confirmation {
    margin-bottom: 1.5rem;
    
    label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
  }
}
</style> 