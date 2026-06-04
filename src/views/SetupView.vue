<template>
  <div class="page-centered">
    <div class="setup-card casino-card-glow">
      <div class="setup-brand">
        <span class="brand-icon">&#x20BF;</span>
      </div>
      <h1 class="setup-title">Arkade Coinflip</h1>
      <p class="setup-subtitle text-muted">Trustless Bitcoin coin flips on Ark</p>

      <div class="setup-options" v-if="!mode">
        <button class="option-btn" @click="mode = 'create'">
          <div class="option-icon-wrap">
            <span class="option-icon">+</span>
          </div>
          <div class="option-text">
            <span class="option-label">Create New Wallet</span>
            <span class="option-desc">Generate a fresh keypair</span>
          </div>
        </button>
        <button class="option-btn" @click="mode = 'restore'">
          <div class="option-icon-wrap">
            <span class="option-icon">&#8634;</span>
          </div>
          <div class="option-text">
            <span class="option-label">Restore Wallet</span>
            <span class="option-desc">Import from nsec key</span>
          </div>
        </button>
      </div>

      <!-- Create flow -->
      <div v-if="mode === 'create'" class="setup-form">
        <div class="warning-box">
          Your private key will be shown once. Save it securely!
        </div>
        <button class="btn-gold btn-lg" @click="createWallet" style="width:100%">
          Generate Wallet
        </button>
        <button class="btn-outline" @click="mode = ''" style="width:100%">Back</button>
      </div>

      <!-- Restore flow -->
      <div v-if="mode === 'restore'" class="setup-form">
        <input class="input" type="text" v-model="privateKey" placeholder="nsec1..." />
        <div v-if="error" class="error-msg">{{ error }}</div>
        <button class="btn-primary btn-lg" :disabled="!privateKey" @click="restoreWallet" style="width:100%">
          Restore
        </button>
        <button class="btn-outline" @click="mode = ''" style="width:100%">Back</button>
      </div>
    </div>

    <!-- Private Key Modal -->
    <transition name="fade">
      <div v-if="showPrivateKey" class="overlay">
        <div class="setup-card casino-card-glow modal-card">
          <h2 class="modal-title text-gold">Your Private Key</h2>
          <p class="modal-desc text-muted">Save this key securely. It cannot be recovered!</p>
          <div class="key-box" @click="copyKey">
            <code class="mono">{{ newPrivateKey }}</code>
            <span class="key-hint">Click to copy</span>
          </div>
          <label class="checkbox-label">
            <input type="checkbox" v-model="hasBackedUp" />
            I have safely stored my private key
          </label>
          <button class="btn-gold btn-lg" :disabled="!hasBackedUp" @click="onConfirm" style="width:100%">
            Continue
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue'
import { useStore } from 'vuex'
import { useRouter } from 'vue-router'
import { copyToClipboard } from '@/utils/clipboard'

export default defineComponent({
  name: 'SetupView',
  setup() {
    const store = useStore()
    const router = useRouter()
    const mode = ref('')
    const privateKey = ref('')
    const error = ref('')
    const showPrivateKey = ref(false)
    const newPrivateKey = ref('')
    const hasBackedUp = ref(false)

    async function createWallet() {
      await store.dispatch('createNewWallet')
      newPrivateKey.value = store.getters.walletPrivateKeyEncoded
      showPrivateKey.value = true
    }

    async function restoreWallet() {
      try {
        await store.dispatch('restoreWallet', privateKey.value)
        router.push('/')
      } catch {
        error.value = 'Invalid private key'
      }
    }

    async function copyKey() {
      await copyToClipboard(newPrivateKey.value)
    }

    function onConfirm() {
      if (hasBackedUp.value) {
        showPrivateKey.value = false
        router.push('/')
      }
    }

    return {
      mode, privateKey, error,
      showPrivateKey, newPrivateKey, hasBackedUp,
      createWallet, restoreWallet, copyKey, onConfirm,
    }
  },
})
</script>

<style scoped>
.setup-card {
  max-width: 440px;
  width: 100%;
  text-align: center;
  padding: 44px 36px;
}

.setup-brand {
  margin-bottom: 20px;
}

.brand-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  font-size: 1.8rem;
  font-weight: 800;
  color: var(--gold);
  background: rgba(247, 201, 72, 0.08);
  border: 1.5px solid rgba(247, 201, 72, 0.15);
  border-radius: 16px;
}

.setup-title {
  font-size: 1.5rem;
  font-weight: 700;
  margin-bottom: 6px;
  color: var(--text);
}

.setup-subtitle {
  font-size: 0.9rem;
  margin-bottom: 36px;
}

.setup-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.option-btn {
  background: var(--bg);
  border: 1px solid var(--border-light);
  border-radius: 14px;
  padding: 18px 20px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--text);
}

.option-btn:hover {
  border-color: var(--gold);
  background: rgba(247, 201, 72, 0.03);
  box-shadow: 0 0 16px var(--gold-glow);
}

.option-icon-wrap {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(247, 201, 72, 0.08);
  border-radius: 10px;
  flex-shrink: 0;
}

.option-icon {
  font-size: 1.3rem;
  color: var(--gold);
}

.option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.option-label {
  font-weight: 600;
  font-size: 0.95rem;
}

.option-desc {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.setup-form {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.warning-box {
  background: rgba(247, 201, 72, 0.06);
  border: 1px solid rgba(247, 201, 72, 0.12);
  color: var(--gold);
  padding: 14px 16px;
  border-radius: 10px;
  font-size: 0.85rem;
  line-height: 1.4;
}

.error-msg {
  color: var(--red);
  font-size: 0.8rem;
}

.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.80);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
  backdrop-filter: blur(4px);
}

.modal-card {
  animation: slideUp 0.3s ease;
}

.modal-title {
  font-size: 1.15rem;
  font-weight: 700;
  margin-bottom: 4px;
}

.modal-desc {
  font-size: 0.85rem;
  margin-bottom: 16px;
}

.key-box {
  background: var(--bg);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 16px;
  cursor: pointer;
  transition: all 0.2s;
  word-break: break-all;
}

.key-box:hover {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px var(--blue-glow);
}

.key-box code {
  font-size: 0.8rem;
  display: block;
  margin-bottom: 8px;
  line-height: 1.5;
}

.key-hint {
  font-size: 0.7rem;
  color: var(--text-muted);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  color: var(--text-muted);
  justify-content: center;
  margin-bottom: 4px;
}

.checkbox-label input {
  accent-color: var(--gold);
  width: 16px;
  height: 16px;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
