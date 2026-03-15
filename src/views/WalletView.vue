<template>
  <div class="page wallet-page">
    <div class="casino-card-glow balance-card">
      <div class="balance-label text-muted">BALANCE</div>
      <div class="balance-value text-gold mono">
        {{ store.getters['ark/formattedBalance'] || '0' }}
      </div>
      <div class="balance-btc text-muted mono">
        ~ ${{ usdBalance }}
      </div>
    </div>

    <div class="casino-card deposit-card">
      <h3 class="section-title text-blue">DEPOSIT</h3>
      <div class="address-box" @click="copyAddress">
        <code class="mono">{{ arkAddress || 'Generating...' }}</code>
        <span class="copy-label text-muted">click to copy</span>
      </div>
      <div v-if="isMutinyTestnet" class="faucet-row">
        <button class="btn-primary" @click="requestFaucet" style="width:100%">
          Request Faucet
        </button>
      </div>
    </div>

    <div class="casino-card withdraw-card">
      <h3 class="section-title text-blue">WITHDRAW</h3>
      <input
        class="input"
        type="text"
        v-model="withdrawAddress"
        placeholder="Ark address..."
      />
      <div class="withdraw-row">
        <input
          class="input"
          type="number"
          v-model="withdrawAmount"
          placeholder="Amount (sats)"
          min="0"
        />
        <button class="btn-outline" @click="setMaxAmount">MAX</button>
      </div>
      <button
        class="btn-primary"
        :disabled="!withdrawAddress || !withdrawAmount"
        @click="withdrawFunds"
        style="width:100%;margin-top:8px"
      >
        Send
      </button>
    </div>

    <div class="casino-card danger-card">
      <h3 class="section-title text-red">SETTINGS</h3>
      <div class="settings-buttons">
        <button class="btn-outline" @click="showKey = true">
          Back Up Key
        </button>
        <button class="btn-danger" @click="showDeleteConfirm = true">
          Delete Wallet
        </button>
      </div>
    </div>

    <!-- Private Key Modal -->
    <div v-if="showKey" class="overlay" @click.self="showKey = false">
      <div class="casino-card-glow modal-card">
        <h3 class="text-gold" style="margin-bottom:12px">Private Key</h3>
        <p class="text-muted" style="font-size:0.8rem;margin-bottom:12px">Never share this with anyone!</p>
        <div class="key-display" @click="copyPrivateKey">
          <code class="mono">{{ privateKey }}</code>
        </div>
        <button class="btn-outline" @click="showKey = false" style="width:100%;margin-top:12px">Close</button>
      </div>
    </div>

    <!-- Delete Confirm Modal -->
    <div v-if="showDeleteConfirm" class="overlay" @click.self="showDeleteConfirm = false">
      <div class="casino-card-glow modal-card">
        <h3 class="text-red" style="margin-bottom:12px">Delete Wallet</h3>
        <p class="text-muted" style="font-size:0.85rem;margin-bottom:16px">
          This cannot be undone. Type DELETE to confirm.
        </p>
        <input class="input" type="text" v-model="deleteConfirmText" placeholder="DELETE" />
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn-outline" @click="showDeleteConfirm = false" style="flex:1">Cancel</button>
          <button class="btn-danger" :disabled="deleteConfirmText !== 'DELETE'" @click="deleteWallet" style="flex:1">
            Delete
          </button>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <div v-if="toastMsg" class="toast-msg" :class="toastType">{{ toastMsg }}</div>
  </div>
</template>

<script lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useStore } from 'vuex'
import { useRouter } from 'vue-router'

export default {
  name: 'WalletView',
  setup() {
    const store = useStore()
    const router = useRouter()
    const usdBalance = computed(() => store.getters.usdBalance)
    const arkAddress = computed(() => store.getters['ark/address'])
    const privateKey = computed(() => store.getters.nsecKey || store.state.wallet.privateKey)

    const withdrawAddress = ref('')
    const withdrawAmount = ref<number | null>(null)
    const showKey = ref(false)
    const showDeleteConfirm = ref(false)
    const deleteConfirmText = ref('')
    const toastMsg = ref('')
    const toastType = ref('success')

    function showToast(msg: string, type = 'success') {
      toastMsg.value = msg
      toastType.value = type
      setTimeout(() => { toastMsg.value = '' }, 3000)
    }

    async function copyAddress() {
      if (!arkAddress.value) return
      try {
        await navigator.clipboard.writeText(arkAddress.value)
        showToast('Address copied!')
      } catch { /* ignore */ }
    }

    async function copyPrivateKey() {
      try {
        await navigator.clipboard.writeText(privateKey.value)
        showToast('Key copied!')
      } catch { /* ignore */ }
    }

    function setMaxAmount() {
      const balanceSats = store.getters['ark/balance'] || BigInt(0)
      withdrawAmount.value = Math.max(0, Number(balanceSats) - 300)
    }

    async function withdrawFunds() {
      // TODO: implement withdrawal using Ark SDK
      showToast('Withdrawal not yet implemented', 'error')
    }

    function deleteWallet() {
      store.dispatch('clearWallet')
      router.push('/setup')
    }

    const isMutinyTestnet = computed(() =>
      store.state.ark.server === 'https://mutinynet.arkade.sh'
    )

    async function requestFaucet() {
      if (!arkAddress.value) return
      try {
        const response = await fetch('https://faucet.mutinynet.arkade.sh/faucet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: arkAddress.value, amount: 1000 }),
        })
        if (!response.ok) throw new Error('Failed')
        showToast('Faucet request sent!')
        await store.dispatch('ark/fetchVTXOs')
      } catch {
        showToast('Faucet request failed', 'error')
      }
    }

    onMounted(async () => {
      if (!store.state.ark.info) {
        await store.dispatch('ark/checkConnection')
      }
      await store.dispatch('fetchBTCPrice')
    })

    return {
      store, usdBalance, arkAddress, privateKey,
      withdrawAddress, withdrawAmount, showKey,
      showDeleteConfirm, deleteConfirmText,
      toastMsg, toastType,
      copyAddress, copyPrivateKey, setMaxAmount,
      withdrawFunds, deleteWallet,
      isMutinyTestnet, requestFaucet,
    }
  },
}
</script>

<style scoped>
.wallet-page {
  max-width: 480px;
  margin: 0 auto;
  gap: 16px;
}

.balance-card {
  text-align: center;
  padding: 32px 24px;
}

.balance-label {
  font-size: 0.75rem;
  letter-spacing: 2px;
  text-transform: uppercase;
}

.balance-value {
  font-size: 2.2rem;
  font-weight: 800;
  margin: 8px 0 4px;
}

.balance-btc {
  font-size: 0.9rem;
}

.section-title {
  font-size: 0.75rem;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  margin-bottom: 12px;
}

.address-box {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  cursor: pointer;
  transition: border-color 0.2s;
  word-break: break-all;
  font-size: 0.8rem;
}

.address-box:hover {
  border-color: var(--blue);
}

.copy-label {
  display: block;
  margin-top: 6px;
  font-size: 0.7rem;
}

.faucet-row {
  margin-top: 12px;
}

.withdraw-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.withdraw-row .input {
  flex: 1;
}

.settings-buttons {
  display: flex;
  gap: 8px;
}

.settings-buttons button {
  flex: 1;
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
  max-width: 400px;
  width: 100%;
  animation: slideUp 0.3s ease;
}

.key-display {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  cursor: pointer;
  word-break: break-all;
  font-size: 0.75rem;
  transition: border-color 0.2s;
}

.key-display:hover {
  border-color: var(--blue);
}

.toast-msg {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 24px;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  z-index: 999;
  animation: slideUp 0.3s ease;
}

.toast-msg.success {
  background: var(--green);
  color: var(--bg);
}

.toast-msg.error {
  background: var(--red);
  color: #fff;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
