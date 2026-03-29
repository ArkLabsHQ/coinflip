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

    <!-- DEPOSIT -->
    <div class="casino-card deposit-card">
      <h3 class="section-title text-blue">DEPOSIT</h3>
      <div class="method-tabs">
        <button :class="['tab', { active: depositMethod === 'lightning' }]" @click="depositMethod = 'lightning'">
          &#9889; Lightning
        </button>
        <button :class="['tab', { active: depositMethod === 'ark' }]" @click="depositMethod = 'ark'">
          Ark Address
        </button>
      </div>

      <!-- Lightning Deposit (Boltz Reverse Swap) -->
      <div v-if="depositMethod === 'lightning'">
        <div v-if="!depositInvoice">
          <div class="fee-info text-muted" v-if="reversePair">
            Min {{ reversePair.limits.minimal.toLocaleString() }} &ndash; Max {{ reversePair.limits.maximal.toLocaleString() }} sats
            &middot; {{ reversePair.fees.percentage }}% + {{ (reversePair.fees.minerFees.lockup + reversePair.fees.minerFees.claim).toLocaleString() }} sats fee
          </div>
          <input
            class="input"
            type="number"
            v-model.number="depositAmount"
            placeholder="Amount (sats)"
            :min="reversePair?.limits.minimal"
            :max="reversePair?.limits.maximal"
          />
          <div class="fee-info text-muted" v-if="depositAmount && reversePair">
            You receive ≈ {{ calcReceive(depositAmount).toLocaleString() }} sats after fees
          </div>
          <button
            class="btn-primary"
            :disabled="!depositAmount || depositLoading"
            @click="createLnDeposit"
            style="width:100%;margin-top:8px"
          >
            {{ depositLoading ? 'Creating...' : 'Generate Invoice' }}
          </button>
        </div>
        <div v-else class="invoice-display">
          <div class="swap-status" :class="depositStatus">{{ depositStatusText }}</div>
          <div class="address-box" @click="copyText(depositInvoice)">
            <code class="mono">{{ depositInvoice }}</code>
            <span class="copy-label text-muted">click to copy</span>
          </div>
          <button class="btn-outline" @click="resetDeposit" style="width:100%;margin-top:8px">
            New Deposit
          </button>
        </div>
      </div>

      <!-- Ark Deposit -->
      <div v-if="depositMethod === 'ark'">
        <div class="address-box" @click="copyText(arkAddress)">
          <code class="mono">{{ arkAddress || 'Generating...' }}</code>
          <span class="copy-label text-muted">click to copy</span>
        </div>
        <div v-if="isMutinyTestnet" class="faucet-row">
          <button class="btn-primary" @click="requestFaucet" style="width:100%">
            Request Faucet
          </button>
        </div>
      </div>
    </div>

    <!-- WITHDRAW -->
    <div class="casino-card withdraw-card">
      <h3 class="section-title text-blue">WITHDRAW</h3>
      <div class="method-tabs">
        <button :class="['tab', { active: withdrawMethod === 'lightning' }]" @click="withdrawMethod = 'lightning'">
          &#9889; Lightning
        </button>
        <button :class="['tab', { active: withdrawMethod === 'ark' }]" @click="withdrawMethod = 'ark'">
          Ark Address
        </button>
      </div>

      <!-- Lightning Withdraw (Boltz Submarine Swap) -->
      <div v-if="withdrawMethod === 'lightning'">
        <div v-if="!withdrawSwapAddress">
          <div class="fee-info text-muted" v-if="submarinePair">
            Min {{ submarinePair.limits.minimal.toLocaleString() }} &ndash; Max {{ submarinePair.limits.maximal.toLocaleString() }} sats
            &middot; {{ submarinePair.fees.percentage }}% + {{ (submarinePair.fees.minerFees.lockup + submarinePair.fees.minerFees.claim).toLocaleString() }} sats fee
          </div>
          <input
            class="input"
            type="text"
            v-model="withdrawInvoice"
            placeholder="Paste Lightning invoice (lnbc...)"
          />
          <button
            class="btn-primary"
            :disabled="!withdrawInvoice || withdrawLoading"
            @click="createLnWithdraw"
            style="width:100%;margin-top:8px"
          >
            {{ withdrawLoading ? 'Creating...' : 'Withdraw via Lightning' }}
          </button>
        </div>
        <div v-else>
          <div class="swap-status" :class="withdrawStatus">{{ withdrawStatusText }}</div>
          <div class="fee-info text-muted">
            Send {{ withdrawExpectedAmount.toLocaleString() }} sats to this address:
          </div>
          <div class="address-box" @click="copyText(withdrawSwapAddress)">
            <code class="mono">{{ withdrawSwapAddress }}</code>
            <span class="copy-label text-muted">click to copy</span>
          </div>
          <button class="btn-outline" @click="resetWithdraw" style="width:100%;margin-top:8px">
            New Withdrawal
          </button>
        </div>
      </div>

      <!-- Ark Withdraw -->
      <div v-if="withdrawMethod === 'ark'">
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
    </div>

    <!-- SETTINGS -->
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
        <div class="key-display" @click="copyText(privateKey)">
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
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useStore } from 'vuex'
import { useRouter } from 'vue-router'
import {
  getReversePairs,
  getSubmarinePairs,
  createReverseSwap,
  createSubmarineSwap,
  streamSwapStatus,
  calcReverseReceiveAmount,
  type ReversePairInfo,
  type SubmarinePairInfo,
} from '@/services/boltz'

export default {
  name: 'WalletView',
  setup() {
    const store = useStore()
    const router = useRouter()
    const usdBalance = computed(() => store.getters.usdBalance)
    const arkAddress = computed(() => store.getters['ark/address'])
    const privateKey = computed(() => store.getters.nsecKey || store.state.wallet.privateKey)

    // Tab state
    const depositMethod = ref<'lightning' | 'ark'>('lightning')
    const withdrawMethod = ref<'lightning' | 'ark'>('lightning')

    // Ark withdraw
    const withdrawAddress = ref('')
    const withdrawAmount = ref<number | null>(null)

    // Boltz pair info
    const reversePair = ref<ReversePairInfo | null>(null)
    const submarinePair = ref<SubmarinePairInfo | null>(null)

    // LN Deposit state
    const depositAmount = ref<number | null>(null)
    const depositInvoice = ref('')
    const depositLoading = ref(false)
    const depositStatus = ref('pending')
    const depositStatusText = ref('Waiting for payment...')
    let depositCleanup: (() => void) | null = null

    // LN Withdraw state
    const withdrawInvoice = ref('')
    const withdrawSwapAddress = ref('')
    const withdrawExpectedAmount = ref(0)
    const withdrawLoading = ref(false)
    const withdrawStatus = ref('pending')
    const withdrawStatusText = ref('Waiting for on-chain payment...')
    let withdrawCleanup: (() => void) | null = null

    // Settings
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

    async function copyText(text: string) {
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        showToast('Copied!')
      } catch { /* ignore */ }
    }

    function calcReceive(amount: number): number {
      if (!reversePair.value) return 0
      return calcReverseReceiveAmount(amount, reversePair.value)
    }

    // ---------- Lightning Deposit (Reverse Swap) ----------

    async function createLnDeposit() {
      if (!depositAmount.value || !reversePair.value) return
      depositLoading.value = true
      try {
        // Generate a random preimage and hash it
        const preimage = new Uint8Array(32)
        crypto.getRandomValues(preimage)
        const hashBuffer = await crypto.subtle.digest('SHA-256', preimage)
        const preimageHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

        // Use wallet pubkey as claim key (simplified — real impl would use a dedicated key)
        const claimPublicKey = store.state.wallet.publicKey || store.getters['ark/pubkey'] || ''

        const swap = await createReverseSwap(depositAmount.value, preimageHash, claimPublicKey)
        depositInvoice.value = swap.invoice
        depositStatus.value = 'pending'
        depositStatusText.value = 'Waiting for payment...'

        // Store preimage for claiming later
        localStorage.setItem(`boltz_preimage_${swap.id}`, Array.from(preimage).map(b => b.toString(16).padStart(2, '0')).join(''))

        // Stream status updates
        depositCleanup = streamSwapStatus(swap.id, (status) => {
          if (status.status === 'transaction.mempool' || status.status === 'transaction.confirmed') {
            depositStatus.value = 'success'
            depositStatusText.value = 'Payment received! Funds arriving...'
            showToast('Lightning deposit received!')
          } else if (status.status === 'transaction.claimed') {
            depositStatus.value = 'success'
            depositStatusText.value = 'Claimed! Balance updated.'
          } else if (status.status === 'invoice.expired' || status.status === 'swap.expired') {
            depositStatus.value = 'expired'
            depositStatusText.value = 'Invoice expired'
          } else if (status.status === 'transaction.failed') {
            depositStatus.value = 'error'
            depositStatusText.value = 'Swap failed'
          }
        })
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to create swap', 'error')
      } finally {
        depositLoading.value = false
      }
    }

    function resetDeposit() {
      depositInvoice.value = ''
      depositAmount.value = null
      depositStatus.value = 'pending'
      depositStatusText.value = 'Waiting for payment...'
      if (depositCleanup) { depositCleanup(); depositCleanup = null }
    }

    // ---------- Lightning Withdraw (Submarine Swap) ----------

    async function createLnWithdraw() {
      if (!withdrawInvoice.value) return
      withdrawLoading.value = true
      try {
        const refundPublicKey = store.state.wallet.publicKey || store.getters['ark/pubkey'] || ''

        const swap = await createSubmarineSwap(withdrawInvoice.value, refundPublicKey)
        withdrawSwapAddress.value = swap.address
        withdrawExpectedAmount.value = swap.expectedAmount
        withdrawStatus.value = 'pending'
        withdrawStatusText.value = 'Send the amount below to complete the swap'

        // Stream status updates
        withdrawCleanup = streamSwapStatus(swap.id, (status) => {
          if (status.status === 'transaction.claim.pending') {
            withdrawStatus.value = 'pending'
            withdrawStatusText.value = 'Boltz claiming, invoice being paid...'
          } else if (status.status === 'invoice.paid') {
            withdrawStatus.value = 'success'
            withdrawStatusText.value = 'Invoice paid! Withdrawal complete.'
            showToast('Lightning withdrawal complete!')
          } else if (status.status === 'transaction.mempool' || status.status === 'transaction.confirmed') {
            withdrawStatus.value = 'pending'
            withdrawStatusText.value = 'Payment detected, processing...'
          } else if (status.status === 'swap.expired') {
            withdrawStatus.value = 'expired'
            withdrawStatusText.value = 'Swap expired'
          } else if (status.status === 'transaction.failed') {
            withdrawStatus.value = 'error'
            withdrawStatusText.value = 'Swap failed'
          }
        })
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to create swap', 'error')
      } finally {
        withdrawLoading.value = false
      }
    }

    function resetWithdraw() {
      withdrawInvoice.value = ''
      withdrawSwapAddress.value = ''
      withdrawExpectedAmount.value = 0
      withdrawStatus.value = 'pending'
      withdrawStatusText.value = 'Waiting for on-chain payment...'
      if (withdrawCleanup) { withdrawCleanup(); withdrawCleanup = null }
    }

    // ---------- Ark Withdraw ----------

    function setMaxAmount() {
      const balanceSats = store.getters['ark/balance'] || BigInt(0)
      withdrawAmount.value = Math.max(0, Number(balanceSats) - 300)
    }

    async function withdrawFunds() {
      showToast('Ark withdrawal not yet implemented', 'error')
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

      // Load Boltz pair info
      try {
        const [rev, sub] = await Promise.all([getReversePairs(), getSubmarinePairs()])
        reversePair.value = rev
        submarinePair.value = sub
      } catch {
        // Boltz unavailable — LN tabs will show no limits
      }
    })

    onUnmounted(() => {
      if (depositCleanup) depositCleanup()
      if (withdrawCleanup) withdrawCleanup()
    })

    return {
      store, usdBalance, arkAddress, privateKey,
      depositMethod, withdrawMethod,
      reversePair, submarinePair,
      depositAmount, depositInvoice, depositLoading, depositStatus, depositStatusText,
      withdrawInvoice, withdrawSwapAddress, withdrawExpectedAmount, withdrawLoading, withdrawStatus, withdrawStatusText,
      withdrawAddress, withdrawAmount,
      showKey, showDeleteConfirm, deleteConfirmText, toastMsg, toastType,
      copyText, calcReceive,
      createLnDeposit, resetDeposit,
      createLnWithdraw, resetWithdraw,
      setMaxAmount, withdrawFunds, deleteWallet,
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

.method-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.tab {
  flex: 1;
  padding: 10px 0;
  background: var(--bg);
  border: none;
  color: var(--muted);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.tab + .tab {
  border-left: 1px solid var(--border);
}

.tab.active {
  background: var(--card);
  color: var(--blue);
}

.tab:hover:not(.active) {
  color: var(--text);
}

.fee-info {
  font-size: 0.75rem;
  margin: 6px 0 10px;
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

.invoice-display {
  animation: slideUp 0.3s ease;
}

.swap-status {
  font-size: 0.8rem;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 6px;
  margin-bottom: 10px;
  text-align: center;
}

.swap-status.pending {
  background: rgba(0, 212, 255, 0.1);
  color: var(--blue);
}

.swap-status.success {
  background: rgba(0, 255, 136, 0.1);
  color: var(--green);
}

.swap-status.expired, .swap-status.error {
  background: rgba(255, 68, 68, 0.1);
  color: var(--red);
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
