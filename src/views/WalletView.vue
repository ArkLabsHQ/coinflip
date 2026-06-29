<template>
  <div class="page wallet-page">
    <!-- Balance Hero -->
    <div class="balance-hero">
      <div class="balance-eyebrow">YOUR BALANCE</div>
      <div class="balance-amount mono">
        {{ store.getters['ark/formattedBalance'] || '0' }}
        <span class="balance-unit">sats</span>
      </div>
      <div class="balance-fiat text-muted mono">&#8776; ${{ usdBalance }}</div>
      <div v-if="boardingBalance > 0" class="boarding-status">
        <span class="boarding-dot"></span>
        {{ boardingBalance.toLocaleString() }} sats boarding
        <span class="text-muted">&mdash; settling into Ark</span>
      </div>
    </div>

    <!-- Deposit -->
    <div class="casino-card section-card">
      <div class="section-header">
        <h3 class="section-title">Deposit</h3>
        <div class="method-tabs">
          <button :class="['tab', { active: depositMethod === 'lightning' }]" @click="depositMethod = 'lightning'">
            &#9889; Lightning
          </button>
          <button :class="['tab', { active: depositMethod === 'ark' }]" @click="depositMethod = 'ark'">
            Ark
          </button>
          <button :class="['tab', { active: depositMethod === 'onchain' }]" @click="depositMethod = 'onchain'">
            On-chain
          </button>
        </div>
      </div>

      <!-- Lightning Deposit -->
      <div v-if="depositMethod === 'lightning'" class="section-body">
        <div v-if="!depositInvoice">
          <div class="hint" v-if="fees && limits">
            {{ limits.min.toLocaleString() }} &ndash; {{ limits.max.toLocaleString() }} sats
            &middot; {{ fees.reverse.percentage }}% + {{ (fees.reverse.minerFees.lockup + fees.reverse.minerFees.claim).toLocaleString() }} fee
          </div>
          <div class="input-row">
            <input
              class="input"
              type="number"
              v-model.number="depositAmount"
              placeholder="Amount in sats"
              :min="limits?.min"
              :max="limits?.max"
            />
            <button
              class="btn-primary"
              :disabled="!depositAmount || depositLoading"
              @click="createLnDeposit"
            >
              {{ depositLoading ? 'Creating...' : 'Generate Invoice' }}
            </button>
          </div>
          <div class="hint" v-if="depositAmount && fees">
            You receive &asymp; <strong>{{ calcReceive(depositAmount).toLocaleString() }}</strong> sats after fees
          </div>
        </div>
        <div v-else class="swap-result">
          <div class="status-badge" :class="depositStatus">{{ depositStatusText }}</div>
          <div class="address-box" @click="copyText(depositInvoice)">
            <code class="mono">{{ depositInvoice }}</code>
            <span class="address-action">Click to copy</span>
          </div>
          <button class="btn-outline btn-sm" @click="resetDeposit">New Deposit</button>
        </div>
      </div>

      <!-- Ark Deposit -->
      <div v-if="depositMethod === 'ark'" class="section-body">
        <div class="address-box" @click="copyText(arkAddress)">
          <code class="mono">{{ arkAddress || 'Generating...' }}</code>
          <span class="address-action">Click to copy</span>
        </div>
        <button v-if="isMutinyTestnet" class="btn-primary" @click="requestFaucet">
          Request Testnet Faucet
        </button>
      </div>

      <!-- On-chain Deposit -->
      <div v-if="depositMethod === 'onchain'" class="section-body">
        <div class="hint">
          Send BTC on-chain to your boarding address. Funds need to confirm, then settle into Ark.
        </div>
        <div class="address-box" @click="copyText(boardingAddress)">
          <code class="mono">{{ boardingAddress || 'Generating...' }}</code>
          <span class="address-action">Click to copy</span>
        </div>
        <div v-if="boardingUtxos.length > 0" class="boarding-list">
          <div v-for="utxo in boardingUtxos" :key="utxo.outpoint.txid + ':' + utxo.outpoint.vout" class="boarding-item">
            <span class="boarding-dot"></span>
            <span class="mono">{{ Number(utxo.amount).toLocaleString() }} sats</span>
            <span class="text-muted boarding-conf">
              {{ utxo.confirmations ? utxo.confirmations + ' conf' : 'unconfirmed' }}
              &mdash; {{ utxo.confirmations >= 1 ? 'settling into Ark' : 'waiting for confirmation' }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Withdraw -->
    <div class="casino-card section-card">
      <div class="section-header">
        <h3 class="section-title">Withdraw</h3>
        <div class="method-tabs">
          <button :class="['tab', { active: withdrawMethod === 'lightning' }]" @click="withdrawMethod = 'lightning'">
            &#9889; Lightning
          </button>
          <button :class="['tab', { active: withdrawMethod === 'ark' }]" @click="withdrawMethod = 'ark'">
            Ark
          </button>
          <button :class="['tab', { active: withdrawMethod === 'onchain' }]" @click="withdrawMethod = 'onchain'">
            On-chain
          </button>
        </div>
      </div>

      <!-- Lightning Withdraw -->
      <div v-if="withdrawMethod === 'lightning'" class="section-body">
        <div v-if="withdrawStatus === 'idle'">
          <div class="hint" v-if="fees && limits">
            {{ limits.min.toLocaleString() }} &ndash; {{ limits.max.toLocaleString() }} sats
            &middot; {{ fees.submarine.percentage }}% + {{ fees.submarine.minerFees.toLocaleString() }} fee
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
          >
            {{ withdrawLoading ? 'Paying...' : 'Pay via Lightning' }}
          </button>
        </div>
        <div v-else class="swap-result">
          <div class="status-badge" :class="withdrawStatus">{{ withdrawStatusText }}</div>
          <button class="btn-outline btn-sm" @click="resetWithdraw">New Withdrawal</button>
        </div>
      </div>

      <!-- Ark Withdraw -->
      <div v-if="withdrawMethod === 'ark'" class="section-body">
        <input
          class="input"
          type="text"
          v-model="withdrawAddress"
          placeholder="Destination Ark address"
        />
        <div class="input-row">
          <input
            class="input"
            type="number"
            v-model="withdrawAmount"
            placeholder="Amount (sats)"
            min="0"
          />
          <button class="btn-outline btn-sm" @click="setMaxAmount">MAX</button>
        </div>
        <button
          class="btn-primary"
          :disabled="!withdrawAddress || !withdrawAmount"
          @click="withdrawFunds"
        >
          Send
        </button>
      </div>

      <!-- On-chain Withdraw -->
      <div v-if="withdrawMethod === 'onchain'" class="section-body">
        <div class="hint">
          Withdraw to a Bitcoin address on-chain. This triggers a collaborative redeem via the Ark server.
        </div>
        <input
          class="input"
          type="text"
          v-model="onchainWithdrawAddress"
          placeholder="Bitcoin address (bc1...)"
        />
        <div class="input-row">
          <input
            class="input"
            type="number"
            v-model.number="onchainWithdrawAmount"
            placeholder="Amount (sats)"
            min="0"
          />
          <button class="btn-outline btn-sm" @click="onchainWithdrawAmount = Math.max(0, Number(store.getters['ark/balance'] || 0) - 300)">MAX</button>
        </div>
        <button
          class="btn-primary"
          :disabled="!onchainWithdrawAddress || !onchainWithdrawAmount"
          @click="withdrawOnchain"
        >
          Withdraw On-chain
        </button>
      </div>
    </div>

    <!-- Settle -->
    <div class="casino-card section-card" v-if="hasUnsettledFunds">
      <div class="section-header">
        <h3 class="section-title">Settle Funds</h3>
      </div>
      <div class="section-body">
        <div class="hint">
          You have unsettled funds (boarding or preconfirmed). Settle them into the Ark round to make them spendable.
        </div>
        <button
          class="btn-primary"
          :disabled="settleLoading"
          @click="settleFunds"
        >
          {{ settleLoading ? 'Settling...' : 'Settle Now' }}
        </button>
      </div>
    </div>

    <!-- Settings -->
    <div class="casino-card section-card settings-card">
      <h3 class="section-title">Settings</h3>
      <div class="settings-row">
        <button class="btn-outline" @click="showKey = true">Back Up Wallet</button>
        <button class="btn-danger" @click="showDeleteConfirm = true">Delete Wallet</button>
      </div>
    </div>

    <!-- Private Key Modal -->
    <transition name="fade">
      <div v-if="showKey" class="overlay" @click.self="showKey = false">
        <div class="modal-card casino-card-glow">
          <h3 class="modal-title text-gold">Wallet Backup</h3>
          <p class="modal-desc text-muted">Your recovery phrase (or legacy key). Save it securely; never share it.</p>
          <div class="key-display" @click="copyText(privateKey)">
            <ol v-if="phraseWords.length" class="mnemonic-grid">
              <li v-for="(word, i) in phraseWords" :key="i" class="mnemonic-word">{{ word }}</li>
            </ol>
            <code v-else class="mono">{{ privateKey }}</code>
            <span class="address-action">Click to copy</span>
          </div>
          <button class="btn-outline" @click="showKey = false">Close</button>
        </div>
      </div>
    </transition>

    <!-- Delete Confirm Modal -->
    <transition name="fade">
      <div v-if="showDeleteConfirm" class="overlay" @click.self="showDeleteConfirm = false">
        <div class="modal-card casino-card-glow">
          <h3 class="modal-title text-red">Delete Wallet</h3>
          <p class="modal-desc text-muted">This cannot be undone. Type DELETE to confirm.</p>
          <input class="input" type="text" v-model="deleteConfirmText" placeholder="DELETE" />
          <div class="modal-actions">
            <button class="btn-outline" @click="showDeleteConfirm = false">Cancel</button>
            <button class="btn-danger" :disabled="deleteConfirmText !== 'DELETE'" @click="deleteWallet">
              Delete
            </button>
          </div>
        </div>
      </div>
    </transition>

    <!-- Toast -->
    <transition name="toast">
      <div v-if="toastMsg" class="toast" :class="toastType">{{ toastMsg }}</div>
    </transition>
  </div>
</template>

<script lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useStore } from 'vuex'
import { useRouter } from 'vue-router'
import {
  getSwaps,
  createLnDeposit as doLnDeposit,
  createLnWithdraw as doLnWithdraw,
  getFees,
  getLimits,
  type FeesResponse,
  type LimitsResponse,
} from '@/services/boltz'
import { copyToClipboard } from '@/utils/clipboard'

export default {
  name: 'WalletView',
  setup() {
    const store = useStore()
    const router = useRouter()
    const usdBalance = computed(() => store.getters.usdBalance)
    const arkAddress = computed(() => store.getters['ark/address'])
    // Prefer the BIP39 recovery phrase for mnemonic-backed wallets; fall back to
    // the nsec for legacy key-only wallets (both back up the same key).
    const privateKey = computed(() => store.getters.walletMnemonic || store.getters.nsecKey || store.state.wallet.privateKey)
    // Render a 12/24-word recovery phrase as a numbered grid; legacy nsec/hex
    // (any other word count) falls back to the plain code display.
    const phraseWords = computed(() => {
      const w = (privateKey.value || '').trim().split(/\s+/).filter(Boolean)
      return w.length === 12 || w.length === 24 ? w : []
    })

    const boardingAddress = computed(() => store.getters['ark/boardingAddress'])
    const boardingBalance = computed(() => Number(store.getters['ark/boardingBalance'] || BigInt(0)))
    const boardingUtxos = computed(() => store.getters['ark/boardingUtxos'] || [])

    const depositMethod = ref<'lightning' | 'ark' | 'onchain'>('lightning')
    const withdrawMethod = ref<'lightning' | 'ark' | 'onchain'>('lightning')

    const withdrawAddress = ref('')
    const onchainWithdrawAddress = ref('')
    const onchainWithdrawAmount = ref<number | null>(null)
    const withdrawAmount = ref<number | null>(null)

    const fees = ref<FeesResponse | null>(null)
    const limits = ref<LimitsResponse | null>(null)

    const depositAmount = ref<number | null>(null)
    const depositInvoice = ref('')
    const depositLoading = ref(false)
    const depositStatus = ref('pending')
    const depositStatusText = ref('Waiting for payment...')
    let depositCleanup: (() => void) | null = null

    const settleLoading = ref(false)
    const hasUnsettledFunds = computed(() => {
      const wb = store.state.ark.walletBalance
      if (!wb) return false
      return (wb.preconfirmed > 0) || (wb.boarding?.confirmed > 0)
    })

    const withdrawInvoice = ref('')
    const withdrawLoading = ref(false)
    const withdrawStatus = ref('idle')
    const withdrawStatusText = ref('')
    let boardingPollInterval: ReturnType<typeof setInterval> | null = null

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
      if (await copyToClipboard(text)) showToast('Copied!')
    }

    function calcReceive(amount: number): number {
      if (!fees.value) return 0
      const { percentage, minerFees } = fees.value.reverse
      const boltzFee = Math.ceil(amount * percentage / 100)
      return amount - boltzFee - minerFees.lockup - minerFees.claim
    }

    async function createLnDeposit() {
      if (!depositAmount.value) return
      depositLoading.value = true
      try {
        const result = await doLnDeposit(depositAmount.value)
        depositInvoice.value = result.invoice
        depositStatus.value = 'pending'
        depositStatusText.value = 'Waiting for payment...'

        // Wait for claim in background (SwapManager handles the VHTLC claim)
        const arkadeSwaps = getSwaps()
        if (arkadeSwaps) {
          arkadeSwaps.waitAndClaim(result.pendingSwap).then(({ txid }) => {
            depositStatus.value = 'success'
            depositStatusText.value = `Claimed! TX: ${txid.slice(0, 12)}...`
            showToast('Lightning deposit complete!')
            store.dispatch('ark/refreshBalance')
          }).catch((err) => {
            if (depositStatus.value !== 'success') {
              depositStatus.value = 'error'
              depositStatusText.value = err instanceof Error ? err.message : 'Claim failed'
            }
          })

          // Also subscribe to status updates for intermediate states
          const manager = arkadeSwaps.getSwapManager()
          if (manager) {
            manager.subscribeToSwapUpdates(result.pendingSwap.id, (swap) => {
              if (swap.status === 'transaction.mempool' || swap.status === 'transaction.confirmed') {
                depositStatus.value = 'pending'
                depositStatusText.value = 'Payment received, claiming...'
              } else if (swap.status === 'invoice.expired' || swap.status === 'swap.expired') {
                depositStatus.value = 'expired'
                depositStatusText.value = 'Invoice expired'
              }
            }).then((unsub) => {
              depositCleanup = unsub
            })
          }
        }
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

    async function createLnWithdraw() {
      if (!withdrawInvoice.value) return
      withdrawLoading.value = true
      withdrawStatus.value = 'pending'
      withdrawStatusText.value = 'Creating swap and sending...'
      try {
        // sendLightningPayment handles: create submarine swap → send VTXOs → wait for settlement
        const result = await doLnWithdraw(withdrawInvoice.value)
        withdrawStatus.value = 'success'
        withdrawStatusText.value = `Paid! Preimage: ${result.preimage.slice(0, 16)}...`
        showToast('Lightning withdrawal complete!')
        store.dispatch('ark/refreshBalance')
      } catch (err) {
        withdrawStatus.value = 'error'
        withdrawStatusText.value = err instanceof Error ? err.message : 'Swap failed'
        showToast(err instanceof Error ? err.message : 'Failed to pay invoice', 'error')
      } finally {
        withdrawLoading.value = false
      }
    }

    function resetWithdraw() {
      withdrawInvoice.value = ''
      withdrawStatus.value = 'idle'
      withdrawStatusText.value = ''
    }

    function setMaxAmount() {
      const balanceSats = store.getters['ark/balance'] || BigInt(0)
      withdrawAmount.value = Math.max(0, Number(balanceSats) - 300)
    }

    async function withdrawFunds() {
      if (!withdrawAddress.value || !withdrawAmount.value) return
      try {
        const txid = await store.dispatch('ark/sendBitcoin', {
          address: withdrawAddress.value,
          amount: withdrawAmount.value,
        })
        showToast(`Sent! TX: ${txid}`)
        withdrawAddress.value = ''
        withdrawAmount.value = null
      } catch (err: unknown) {
        showToast(`Send failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
      }
    }

    async function withdrawOnchain() {
      if (!onchainWithdrawAddress.value || !onchainWithdrawAmount.value) return
      try {
        const txid = await store.dispatch('ark/sendBitcoin', {
          address: onchainWithdrawAddress.value,
          amount: onchainWithdrawAmount.value,
        })
        showToast(`Sent on-chain! TX: ${txid}`)
        onchainWithdrawAddress.value = ''
        onchainWithdrawAmount.value = null
      } catch (err: unknown) {
        showToast(`On-chain send failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
      }
    }

    async function settleFunds() {
      settleLoading.value = true
      try {
        const txid = await store.dispatch('ark/settle')
        showToast(`Settled! TX: ${txid}`)
      } catch (err: unknown) {
        showToast(`Settle failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
      } finally {
        settleLoading.value = false
      }
    }

    async function deleteWallet() {
      await store.dispatch('clearWallet')
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
        await store.dispatch('ark/refreshBalance')
      } catch {
        showToast('Faucet request failed', 'error')
      }
    }

    onMounted(async () => {
      if (!store.state.ark.info) {
        await store.dispatch('ark/checkConnection')
      }
      await store.dispatch('fetchBTCPrice')

      try {
        const [f, l] = await Promise.all([getFees(), getLimits()])
        fees.value = f
        limits.value = l
      } catch {
        // Lightning swap service unavailable
      }

      // Poll for boarding UTXO updates every 15s
      boardingPollInterval = setInterval(() => {
        if (store.state.ark.status === 'connected') {
          store.dispatch('ark/refreshBalance')
        }
      }, 15000)
    })

    onUnmounted(() => {
      if (depositCleanup) depositCleanup()
      if (boardingPollInterval) clearInterval(boardingPollInterval)
    })

    return {
      store, usdBalance, arkAddress, privateKey, phraseWords,
      boardingAddress, boardingBalance, boardingUtxos,
      depositMethod, withdrawMethod,
      fees, limits,
      depositAmount, depositInvoice, depositLoading, depositStatus, depositStatusText,
      withdrawInvoice, withdrawLoading, withdrawStatus, withdrawStatusText,
      withdrawAddress, withdrawAmount,
      onchainWithdrawAddress, onchainWithdrawAmount,
      showKey, showDeleteConfirm, deleteConfirmText, toastMsg, toastType,
      copyText, calcReceive, showToast,
      createLnDeposit, resetDeposit,
      createLnWithdraw, resetWithdraw,
      setMaxAmount, withdrawFunds, withdrawOnchain, deleteWallet,
      settleFunds, settleLoading, hasUnsettledFunds,
      isMutinyTestnet, requestFaucet,
    }
  },
}
</script>

<style scoped>
.mnemonic-grid {
  list-style: none;
  counter-reset: word;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px 10px;
  margin: 0;
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
.wallet-page {
  max-width: 500px;
  margin: 0 auto;
  gap: 20px;
}

/* ── Balance Hero ── */
.balance-hero {
  text-align: center;
  padding: 36px 24px 28px;
  background:
    radial-gradient(ellipse 70% 50% at 50% 40%, rgba(247, 201, 72, 0.06) 0%, transparent 70%);
}

.balance-eyebrow {
  color: var(--text-muted);
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.balance-amount {
  font-size: 2.6rem;
  font-weight: 800;
  color: var(--text);
  line-height: 1.1;
}

.balance-unit {
  font-size: 1rem;
  font-weight: 500;
  color: var(--text-muted);
  margin-left: 4px;
}

.balance-fiat {
  font-size: 0.9rem;
  margin-top: 6px;
}

/* ── Boarding Status ── */
.boarding-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 0.8rem;
  color: var(--text-dim);
}

.boarding-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gold, #f7c948);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.85); }
}

.boarding-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.boarding-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--border-light);
  border-radius: 8px;
}

.boarding-conf {
  font-size: 0.72rem;
}

/* ── Section Cards ── */
.section-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-title {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text);
}

.section-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── Method Tabs ── */
.method-tabs {
  display: flex;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.tab {
  padding: 7px 16px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.tab + .tab {
  border-left: 1px solid var(--border);
}

.tab.active {
  background: var(--bg-elevated);
  color: var(--blue);
}

.tab:hover:not(.active) {
  color: var(--text-dim);
}

/* ── Hints ── */
.hint {
  font-size: 0.75rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.hint strong {
  color: var(--text-dim);
}

/* ── Input Row ── */
.input-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.input-row .input {
  flex: 1;
}

.input-row .btn-primary,
.input-row .btn-outline {
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── Address Box ── */
.address-box {
  background: var(--bg);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 14px;
  cursor: pointer;
  transition: all 0.2s;
  word-break: break-all;
  font-size: 0.78rem;
  line-height: 1.5;
}

.address-box:hover {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px var(--blue-glow);
}

.address-action {
  display: block;
  margin-top: 8px;
  font-size: 0.7rem;
  color: var(--text-muted);
  font-family: var(--font-sans);
}

/* ── Swap Status ── */
.swap-result {
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: slideUp 0.3s ease;
}

.status-badge {
  font-size: 0.8rem;
  font-weight: 600;
  padding: 8px 14px;
  border-radius: 8px;
  text-align: center;
}

.status-badge.pending {
  background: rgba(56, 189, 248, 0.08);
  color: var(--blue);
  border: 1px solid rgba(56, 189, 248, 0.12);
}

.status-badge.success {
  background: rgba(52, 211, 153, 0.08);
  color: var(--green);
  border: 1px solid rgba(52, 211, 153, 0.12);
}

.status-badge.expired,
.status-badge.error {
  background: rgba(248, 113, 113, 0.08);
  color: var(--red);
  border: 1px solid rgba(248, 113, 113, 0.12);
}

/* ── Settings ── */
.settings-card {
  border-color: rgba(248, 113, 113, 0.08);
}

.settings-row {
  display: flex;
  gap: 10px;
}

.settings-row button {
  flex: 1;
  white-space: nowrap;
}

/* ── Modal ── */
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
  max-width: 420px;
  width: 100%;
  animation: slideUp 0.3s ease;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-title {
  font-size: 1.1rem;
  font-weight: 700;
}

.modal-desc {
  font-size: 0.85rem;
}

.modal-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

.modal-actions button {
  flex: 1;
}

/* ── Key Display ── */
.key-display {
  background: var(--bg);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 14px;
  cursor: pointer;
  word-break: break-all;
  font-size: 0.75rem;
  transition: all 0.2s;
}

.key-display:hover {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px var(--blue-glow);
}

/* ── Toast ── */
.toast {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 24px;
  border-radius: 10px;
  font-size: 0.85rem;
  font-weight: 600;
  z-index: 999;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

.toast.success {
  background: var(--green);
  color: var(--bg);
}

.toast.error {
  background: var(--red);
  color: #fff;
}

.toast-enter-active {
  animation: slideUp 0.3s ease;
}

.toast-leave-active {
  transition: all 0.2s ease;
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
