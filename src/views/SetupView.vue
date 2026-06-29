<template>
  <div class="splash-page">
    <!-- Hero — value-prop and big tagline. Replaces the previous bare
         "Arkade Coinflip" + Create/Restore wall. -->
    <div v-if="!mode" class="splash-hero">
      <div class="splash-badge">
        <span class="badge-dot"></span>
        <span class="badge-text">POWERED&nbsp;BY&nbsp;ARKADE</span>
      </div>
      <h1 class="splash-title">
        The trustless<br />
        <span class="title-accent">Bitcoin casino.</span>
      </h1>
      <p class="splash-tagline">
        Non-custodial. No accounts. No KYC. Every flip is settled by Bitcoin
        script + an Arkade-script covenant — the operator can&rsquo;t cheat you,
        can&rsquo;t hold your funds, and can&rsquo;t stall you out.
      </p>

      <ul class="splash-points">
        <li>
          <span class="point-icon">&#x26A1;</span>
          <span>
            <strong>Lightning-fast offchain play.</strong>
            Funds live on Ark — flips settle in seconds without touching the chain.
          </span>
        </li>
        <li>
          <span class="point-icon">&#x1F512;</span>
          <span>
            <strong>You hold the keys.</strong>
            Your wallet stays in your browser. The house never sees your secret.
          </span>
        </li>
        <li>
          <span class="point-icon">&#x1F3B2;</span>
          <span>
            <strong>Provably fair on-chain.</strong>
            The win is decided by a covenant arkd & the emulator both verify — no trust required.
          </span>
        </li>
      </ul>

      <div class="splash-cta">
        <button class="btn-gold btn-lg" @click="mode = 'create'">
          Create wallet to play
        </button>
        <button class="btn-text" @click="mode = 'restore'">
          I already have a key
        </button>
      </div>

      <div class="splash-footer">
        <router-link to="/how-it-works" class="link-muted">How it works</router-link>
        <span class="dot">&middot;</span>
        <a href="https://github.com/ArkLabsHQ/coinflip" target="_blank" rel="noopener" class="link-muted">Open source</a>
      </div>
    </div>

    <!-- The two existing flows (create / restore) live in their own card
         when picked, so the splash hero gets the full canvas. -->
    <div v-else class="setup-card casino-card-glow">
      <div class="setup-brand">
        <span class="brand-icon">&#x20BF;</span>
      </div>
      <h1 class="setup-title">{{ mode === 'create' ? 'Create wallet' : 'Restore wallet' }}</h1>
      <p class="setup-subtitle text-muted">
        {{ mode === 'create' ? 'A fresh keypair, stored in your browser only.' : 'Paste your recovery phrase (or nsec) to recover an existing wallet.' }}
      </p>

      <!-- Create flow -->
      <div v-if="mode === 'create'" class="setup-form">
        <div class="warning-box">
          Your recovery phrase will be shown once. Save it securely!
        </div>
        <button class="btn-gold btn-lg" @click="createWallet" style="width:100%">
          Generate Wallet
        </button>
        <button class="btn-outline" @click="mode = ''" style="width:100%">Back</button>
      </div>

      <!-- Restore flow -->
      <div v-if="mode === 'restore'" class="setup-form">
        <input class="input" type="text" v-model="privateKey" placeholder="Recovery phrase or nsec…" />
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
          <h2 class="modal-title text-gold">Your Recovery Phrase</h2>
          <p class="modal-desc text-muted">Save these 12 words securely, in order. They are the only way to recover your wallet!</p>
          <div class="key-box" @click="copyKey">
            <ol class="mnemonic-grid">
              <li v-for="(word, i) in phraseWords" :key="i" class="mnemonic-word">{{ word }}</li>
            </ol>
            <span class="key-hint">Click to copy all</span>
          </div>
          <label class="checkbox-label">
            <input type="checkbox" v-model="hasBackedUp" />
            I have safely stored my recovery phrase
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
import { defineComponent, ref, computed } from 'vue'
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
    // The recovery phrase split into words for the numbered backup grid.
    const phraseWords = computed(() => newPrivateKey.value.trim().split(/\s+/).filter(Boolean))

    async function createWallet() {
      await store.dispatch('createNewWallet')
      // New wallets are mnemonic-backed; show the recovery phrase as the backup.
      newPrivateKey.value = store.getters.walletMnemonic
      showPrivateKey.value = true
    }

    async function restoreWallet() {
      try {
        await store.dispatch('restoreWallet', privateKey.value)
        router.push('/')
      } catch {
        error.value = 'Invalid recovery phrase or key'
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
      showPrivateKey, newPrivateKey, hasBackedUp, phraseWords,
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

/* ─── Splash hero ─────────────────────────────────────────────── */
.splash-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px 56px;
  background:
    radial-gradient(ellipse 80% 60% at 50% 0%, rgba(247, 201, 72, 0.06) 0%, transparent 60%),
    radial-gradient(ellipse 60% 50% at 80% 100%, rgba(56, 189, 248, 0.04) 0%, transparent 60%);
}
.splash-hero {
  max-width: 560px;
  width: 100%;
  text-align: center;
}
.splash-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(56, 189, 248, 0.06);
  border: 1px solid rgba(56, 189, 248, 0.25);
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 1.5px;
  color: var(--blue);
  margin-bottom: 28px;
}
.badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--blue);
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.7);
  animation: badge-pulse 1.8s ease-in-out infinite;
}
@keyframes badge-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.splash-title {
  font-size: 2.6rem;
  line-height: 1.05;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text);
  margin: 0 0 18px;
}
.title-accent {
  background: linear-gradient(135deg, var(--gold) 0%, #ffd66d 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.splash-tagline {
  font-size: 1rem;
  line-height: 1.55;
  color: var(--text-dim);
  margin: 0 auto 32px;
  max-width: 460px;
}
.splash-points {
  list-style: none;
  padding: 0;
  margin: 0 0 36px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  text-align: left;
}
.splash-points li {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px 16px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  font-size: 0.88rem;
  line-height: 1.5;
  color: var(--text-dim);
}
.splash-points strong { color: var(--text); font-weight: 700; }
.point-icon {
  font-size: 1.15rem;
  line-height: 1;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(247, 201, 72, 0.08);
  border: 1px solid rgba(247, 201, 72, 0.18);
  flex-shrink: 0;
}
.splash-cta {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  margin-bottom: 22px;
}
.splash-cta .btn-gold {
  width: 100%;
  max-width: 340px;
  font-size: 1rem;
  padding: 15px 24px;
}
.btn-text {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 0.85rem;
  cursor: pointer;
  padding: 6px 10px;
  font-family: inherit;
}
.btn-text:hover { color: var(--gold); }
.splash-footer {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 10px;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.splash-footer .dot { color: var(--text-muted); opacity: 0.5; }
.link-muted {
  color: var(--text-muted);
  text-decoration: none;
}
.link-muted:hover { color: var(--gold); }

@media (max-width: 560px) {
  .splash-title { font-size: 2.1rem; }
  .splash-tagline { font-size: 0.92rem; }
  .splash-points li { font-size: 0.82rem; padding: 12px 14px; gap: 12px; }
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

.mnemonic-grid {
  list-style: none;
  counter-reset: word;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px 10px;
  margin: 0 0 10px;
  padding: 0;
  text-align: left;
}
.mnemonic-word {
  counter-increment: word;
  font-family: monospace;
  font-size: 0.8rem;
  color: var(--text);
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.mnemonic-word::before {
  content: counter(word);
  color: var(--text-muted);
  font-size: 0.65rem;
  min-width: 14px;
  text-align: right;
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
