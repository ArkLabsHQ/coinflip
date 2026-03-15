<template>
  <div class="page-centered">
    <div class="setup-card casino-card-glow">
      <h1 class="setup-title">Welcome to <span class="text-gold">Arkade Coinflip</span></h1>
      <p class="setup-subtitle text-muted">Trustless Bitcoin coin flips on Ark</p>

      <div class="setup-options" v-if="!mode">
        <button class="option-btn" @click="mode = 'create'">
          <span class="option-icon">+</span>
          <span class="option-label">Create New Wallet</span>
          <span class="option-desc text-muted">Generate a fresh keypair</span>
        </button>
        <button class="option-btn" @click="mode = 'restore'">
          <span class="option-icon">&#8634;</span>
          <span class="option-label">Restore Wallet</span>
          <span class="option-desc text-muted">Import from nsec key</span>
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
        <button class="btn-outline" @click="mode = ''" style="width:100%;margin-top:8px">Back</button>
      </div>

      <!-- Restore flow -->
      <div v-if="mode === 'restore'" class="setup-form">
        <input
          class="input"
          type="text"
          v-model="privateKey"
          placeholder="nsec1..."
        />
        <div v-if="error" class="error-msg">{{ error }}</div>
        <button
          class="btn-primary btn-lg"
          :disabled="!privateKey"
          @click="restoreWallet"
          style="width:100%;margin-top:12px"
        >
          Restore
        </button>
        <button class="btn-outline" @click="mode = ''" style="width:100%;margin-top:8px">Back</button>
      </div>
    </div>

    <!-- Private Key Modal -->
    <div v-if="showPrivateKey" class="overlay">
      <div class="setup-card casino-card-glow modal-card">
        <h2 class="text-gold" style="margin-bottom:16px">Your Private Key</h2>
        <p class="text-muted" style="font-size:0.85rem;margin-bottom:16px">
          Save this key securely. It cannot be recovered!
        </p>
        <div class="key-box" @click="copyKey">
          <code class="mono">{{ newPrivateKey }}</code>
          <span class="copy-hint text-muted">click to copy</span>
        </div>
        <label class="checkbox-label">
          <input type="checkbox" v-model="hasBackedUp" />
          I have safely stored my private key
        </label>
        <button
          class="btn-gold btn-lg"
          :disabled="!hasBackedUp"
          @click="onConfirm"
          style="width:100%;margin-top:16px"
        >
          Continue
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue'
import { useStore } from 'vuex'
import { useRouter } from 'vue-router'

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
      try {
        await navigator.clipboard.writeText(newPrivateKey.value)
      } catch { /* ignore */ }
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
  max-width: 420px;
  width: 100%;
  text-align: center;
  padding: 40px 32px;
}

.setup-title {
  font-size: 1.4rem;
  margin-bottom: 8px;
}

.setup-subtitle {
  font-size: 0.9rem;
  margin-bottom: 32px;
}

.setup-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.option-btn {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
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
  box-shadow: 0 0 15px var(--gold-glow);
}

.option-icon {
  font-size: 1.5rem;
  color: var(--gold);
  width: 40px;
  text-align: center;
}

.option-label {
  font-weight: 600;
  display: block;
}

.option-desc {
  font-size: 0.8rem;
  display: block;
  margin-top: 2px;
}

.setup-form {
  margin-top: 20px;
}

.warning-box {
  background: rgba(255, 215, 0, 0.08);
  border: 1px solid rgba(255, 215, 0, 0.2);
  color: var(--gold);
  padding: 14px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 0.85rem;
}

.error-msg {
  color: var(--red);
  font-size: 0.8rem;
  margin-top: 8px;
}

.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
}

.modal-card {
  animation: slideUp 0.3s ease;
}

.key-box {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  cursor: pointer;
  transition: border-color 0.2s;
  word-break: break-all;
}

.key-box:hover {
  border-color: var(--blue);
}

.key-box code {
  font-size: 0.8rem;
  display: block;
  margin-bottom: 8px;
}

.copy-hint {
  font-size: 0.7rem;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  color: var(--text-muted);
  justify-content: center;
}

.checkbox-label input {
  accent-color: var(--gold);
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
