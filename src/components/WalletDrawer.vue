<template>
  <transition name="drawer-overlay">
    <div v-if="open" class="drawer-backdrop" @click.self="close" />
  </transition>
  <transition name="drawer">
    <aside v-if="open" class="wallet-drawer" role="dialog" aria-label="Wallet">
      <header class="drawer-header">
        <div>
          <div class="balance-eyebrow">YOUR BALANCE</div>
          <div class="balance-amount mono">
            {{ store.getters['ark/formattedBalance'] || '0' }}
            <span class="balance-unit">sats</span>
          </div>
          <div class="balance-fiat text-muted mono">&#8776; ${{ usdBalance }}</div>
        </div>
        <button class="close-btn" @click="close" aria-label="Close">&times;</button>
      </header>

      <!-- Connection state banner — gates all action buttons so we can't
           hit the "Swap service not initialized" race again. -->
      <div v-if="arkStatus !== 'connected'" class="conn-banner" :class="arkStatus">
        <span class="spinner" v-if="arkStatus === 'connecting'" />
        <span class="dot" v-else :class="arkStatus" />
        <span class="conn-text">{{ connText }}</span>
        <button v-if="arkStatus === 'error' || arkStatus === 'disconnected'" class="btn-outline btn-xs" @click="reconnect">
          Retry
        </button>
      </div>

      <div v-if="boardingBalance > 0" class="boarding-status">
        <span class="boarding-dot"></span>
        {{ boardingBalance.toLocaleString() }} sats boarding
        <span class="text-muted">&mdash; settling into Ark</span>
      </div>

      <div class="drawer-tabs">
        <button :class="['tab', { active: tab === 'receive' }]" @click="tab = 'receive'">Receive</button>
        <button :class="['tab', { active: tab === 'send' }]" @click="tab = 'send'">Send</button>
        <button :class="['tab', { active: tab === 'settings' }]" @click="tab = 'settings'">Settings</button>
      </div>

      <div class="drawer-body">
        <!-- ── Receive ────────────────────────────────────────────── -->
        <section v-if="tab === 'receive'">
          <div class="method-tabs">
            <button :class="['tab', { active: depositMethod === 'lightning' }]" @click="depositMethod = 'lightning'">&#9889; Lightning</button>
            <button :class="['tab', { active: depositMethod === 'ark' }]" @click="depositMethod = 'ark'">Ark</button>
            <button :class="['tab', { active: depositMethod === 'onchain' }]" @click="depositMethod = 'onchain'">On-chain</button>
          </div>

          <!-- Lightning -->
          <div v-if="depositMethod === 'lightning'" class="section-body">
            <div v-if="!depositInvoice">
              <div class="hint" v-if="fees && limits">
                {{ limits.min.toLocaleString() }} &ndash; {{ limits.max.toLocaleString() }} sats
                &middot; {{ fees.reverse.percentage }}% + {{ (fees.reverse.minerFees.lockup + fees.reverse.minerFees.claim).toLocaleString() }} fee
              </div>
              <div class="input-row">
                <input class="input" type="number" v-model.number="depositAmount" placeholder="Amount in sats"
                       :min="limits?.min" :max="limits?.max" :disabled="!ready" />
                <button class="btn-primary" :disabled="!depositAmount || depositLoading || !ready"
                        :title="!ready ? 'Connecting to Ark…' : ''" @click="createLnDeposit">
                  {{ depositLoading ? 'Creating…' : 'Generate Invoice' }}
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

          <!-- Ark -->
          <div v-if="depositMethod === 'ark'" class="section-body">
            <div class="hint">Share this Ark address to receive directly from another wallet.</div>
            <div class="address-box" @click="copyText(arkAddress)">
              <code class="mono">{{ arkAddress || (ready ? '—' : 'Connecting…') }}</code>
              <span class="address-action" v-if="arkAddress">Click to copy</span>
            </div>
            <button v-if="isMutinyTestnet && ready" class="btn-primary" @click="requestFaucet">
              Request Testnet Faucet
            </button>
          </div>

          <!-- On-chain -->
          <div v-if="depositMethod === 'onchain'" class="section-body">
            <div class="hint">
              Send BTC on-chain to your boarding address. After 1 confirmation the funds settle into Ark.
            </div>
            <div class="address-box" @click="copyText(boardingAddress)">
              <code class="mono">{{ boardingAddress || (ready ? '—' : 'Connecting…') }}</code>
              <span class="address-action" v-if="boardingAddress">Click to copy</span>
            </div>
            <div v-if="boardingUtxos.length > 0" class="boarding-list">
              <div v-for="utxo in boardingUtxos" :key="utxo.outpoint.txid + ':' + utxo.outpoint.vout" class="boarding-item">
                <span class="boarding-dot"></span>
                <span class="mono">{{ Number(utxo.amount).toLocaleString() }} sats</span>
                <span class="text-muted boarding-conf">
                  {{ utxo.confirmations ? utxo.confirmations + ' conf' : 'unconfirmed' }}
                </span>
              </div>
            </div>
            <button v-if="hasUnsettledFunds && ready" class="btn-primary" :disabled="settleLoading" @click="settleFunds">
              {{ settleLoading ? 'Settling…' : 'Settle Into Ark' }}
            </button>
          </div>
        </section>

        <!-- ── Send ───────────────────────────────────────────────── -->
        <section v-if="tab === 'send'">
          <div class="method-tabs">
            <button :class="['tab', { active: withdrawMethod === 'lightning' }]" @click="withdrawMethod = 'lightning'">&#9889; Lightning</button>
            <button :class="['tab', { active: withdrawMethod === 'ark' }]" @click="withdrawMethod = 'ark'">Ark</button>
            <button :class="['tab', { active: withdrawMethod === 'onchain' }]" @click="withdrawMethod = 'onchain'">On-chain</button>
          </div>

          <!-- Lightning -->
          <div v-if="withdrawMethod === 'lightning'" class="section-body">
            <div v-if="withdrawStatus === 'idle'">
              <div class="hint" v-if="fees && limits">
                {{ limits.min.toLocaleString() }} &ndash; {{ limits.max.toLocaleString() }} sats
                &middot; {{ fees.submarine.percentage }}% + {{ fees.submarine.minerFees.toLocaleString() }} fee
              </div>
              <input class="input" type="text" v-model="withdrawInvoice"
                     placeholder="Paste Lightning invoice (lnbc…)" :disabled="!ready" />
              <button class="btn-primary" :disabled="!withdrawInvoice || withdrawLoading || !ready"
                      :title="!ready ? 'Connecting to Ark…' : ''" @click="createLnWithdraw">
                {{ withdrawLoading ? 'Paying…' : 'Pay via Lightning' }}
              </button>
            </div>
            <div v-else class="swap-result">
              <div class="status-badge" :class="withdrawStatus">{{ withdrawStatusText }}</div>
              <button class="btn-outline btn-sm" @click="resetWithdraw">New Payment</button>
            </div>
          </div>

          <!-- Ark -->
          <div v-if="withdrawMethod === 'ark'" class="section-body">
            <input class="input" type="text" v-model="withdrawAddress" placeholder="Destination Ark address" :disabled="!ready" />
            <div class="input-row">
              <input class="input" type="number" v-model.number="withdrawAmount" placeholder="Amount (sats)" min="0" :disabled="!ready" />
              <button class="btn-outline btn-sm" @click="setMaxAmount">MAX</button>
            </div>
            <button class="btn-primary" :disabled="!withdrawAddress || !withdrawAmount || !ready" @click="withdrawFunds">Send</button>
          </div>

          <!-- On-chain -->
          <div v-if="withdrawMethod === 'onchain'" class="section-body">
            <div class="hint">Withdraw via collaborative redeem through the Ark server.</div>
            <input class="input" type="text" v-model="onchainWithdrawAddress" placeholder="Bitcoin address (bc1…)" :disabled="!ready" />
            <div class="input-row">
              <input class="input" type="number" v-model.number="onchainWithdrawAmount" placeholder="Amount (sats)" min="0" :disabled="!ready" />
              <button class="btn-outline btn-sm" @click="onchainSetMax">MAX</button>
            </div>
            <button class="btn-primary" :disabled="!onchainWithdrawAddress || !onchainWithdrawAmount || !ready" @click="withdrawOnchain">
              Withdraw On-chain
            </button>
          </div>
        </section>

        <!-- ── Settings ───────────────────────────────────────────── -->
        <section v-if="tab === 'settings'" class="settings-section">
          <button class="btn-outline" @click="showKey = true">Back Up Private Key</button>
          <button class="btn-danger" @click="showDeleteConfirm = true">Delete Wallet</button>
          <div class="server-info text-muted mono">
            <div>Ark: {{ arkServer }}</div>
            <div>Status: {{ arkStatus }}</div>
            <div v-if="info">Network: {{ info.network }}</div>
          </div>
        </section>
      </div>

      <!-- Private Key Modal -->
      <transition name="fade">
        <div v-if="showKey" class="overlay" @click.self="showKey = false">
          <div class="modal-card casino-card-glow">
            <h3 class="modal-title text-gold">Private Key</h3>
            <p class="modal-desc text-muted">Never share this with anyone.</p>
            <div class="key-display" @click="copyText(privateKey)">
              <code class="mono">{{ privateKey }}</code>
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
              <button class="btn-danger" :disabled="deleteConfirmText !== 'DELETE'" @click="deleteWallet">Delete</button>
            </div>
          </div>
        </div>
      </transition>

      <transition name="toast">
        <div v-if="toastMsg" class="toast" :class="toastType">{{ toastMsg }}</div>
      </transition>
    </aside>
  </transition>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, onMounted, onUnmounted } from 'vue'
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

export default defineComponent({
  name: 'WalletDrawer',
  props: {
    open: { type: Boolean, default: false },
  },
  emits: ['update:open'],
  setup(props, { emit }) {
    const store = useStore()
    const router = useRouter()

    // Connection state
    const arkStatus = computed(() => store.state.ark.status as string)
    const ready = computed(() => arkStatus.value === 'connected')
    const connText = computed(() => {
      switch (arkStatus.value) {
        case 'connecting': return 'Connecting to Ark server…'
        case 'error': return store.state.ark.lastError?.message || 'Connection error'
        case 'disconnected': return 'Disconnected'
        default: return ''
      }
    })

    async function reconnect() {
      try { await store.dispatch('ark/checkConnection') } catch { /* shown via banner */ }
    }

    // Auto-trigger connection when the drawer opens and we're not yet connected.
    // Also fetch fees+limits once we are.
    watch(() => props.open, async (isOpen) => {
      if (!isOpen) return
      if (arkStatus.value !== 'connected' && arkStatus.value !== 'connecting') {
        await reconnect()
      }
    })

    // Re-fetch fees once swap service comes online
    const fees = ref<FeesResponse | null>(null)
    const limits = ref<LimitsResponse | null>(null)
    async function loadFeesLimits() {
      try {
        const [f, l] = await Promise.all([getFees(), getLimits()])
        fees.value = f
        limits.value = l
      } catch { /* swap service offline */ }
    }
    watch(ready, (isReady) => { if (isReady && !fees.value) loadFeesLimits() })

    // Computed bindings to store
    const usdBalance = computed(() => store.getters.usdBalance)
    const arkAddress = computed(() => store.getters['ark/address'])
    const arkServer = computed(() => store.state.ark.server)
    const info = computed(() => store.state.ark.info)
    const privateKey = computed(() => store.getters.nsecKey || store.state.wallet.privateKey)
    const boardingAddress = computed(() => store.getters['ark/boardingAddress'])
    const boardingBalance = computed(() => Number(store.getters['ark/boardingBalance'] || BigInt(0)))
    const boardingUtxos = computed(() => store.getters['ark/boardingUtxos'] || [])
    const hasUnsettledFunds = computed(() => {
      const wb = store.state.ark.walletBalance
      if (!wb) return false
      return (wb.preconfirmed > 0) || ((wb.boarding?.confirmed ?? 0) > 0)
    })
    const isMutinyTestnet = computed(() => arkServer.value === 'https://mutinynet.arkade.sh')

    // Tabs + method selectors
    const tab = ref<'receive' | 'send' | 'settings'>('receive')
    const depositMethod = ref<'lightning' | 'ark' | 'onchain'>('lightning')
    const withdrawMethod = ref<'lightning' | 'ark' | 'onchain'>('lightning')

    // ── Deposit state ─────────────────────────────────────────────
    const depositAmount = ref<number | null>(null)
    const depositInvoice = ref('')
    const depositLoading = ref(false)
    const depositStatus = ref<'pending' | 'success' | 'expired' | 'error'>('pending')
    const depositStatusText = ref('Waiting for payment…')
    let depositCleanup: (() => void) | null = null

    function calcReceive(amount: number): number {
      if (!fees.value) return 0
      const { percentage, minerFees } = fees.value.reverse
      const boltzFee = Math.ceil((amount * percentage) / 100)
      return amount - boltzFee - minerFees.lockup - minerFees.claim
    }

    async function createLnDeposit() {
      if (!depositAmount.value) return
      depositLoading.value = true
      try {
        const result = await doLnDeposit(depositAmount.value)
        depositInvoice.value = result.invoice
        depositStatus.value = 'pending'
        depositStatusText.value = 'Waiting for payment…'

        const arkadeSwaps = getSwaps()
        if (arkadeSwaps) {
          arkadeSwaps.waitAndClaim(result.pendingSwap).then(({ txid }) => {
            depositStatus.value = 'success'
            depositStatusText.value = `Claimed! TX: ${txid.slice(0, 12)}…`
            showToast('Lightning deposit complete!')
            store.dispatch('ark/refreshBalance')
          }).catch((err) => {
            if (depositStatus.value !== 'success') {
              depositStatus.value = 'error'
              depositStatusText.value = err instanceof Error ? err.message : 'Claim failed'
            }
          })
          const manager = arkadeSwaps.getSwapManager()
          if (manager) {
            manager.subscribeToSwapUpdates(result.pendingSwap.id, (swap) => {
              if (swap.status === 'transaction.mempool' || swap.status === 'transaction.confirmed') {
                depositStatus.value = 'pending'
                depositStatusText.value = 'Payment received, claiming…'
              } else if (swap.status === 'invoice.expired' || swap.status === 'swap.expired') {
                depositStatus.value = 'expired'
                depositStatusText.value = 'Invoice expired'
              }
            }).then((unsub) => { depositCleanup = unsub })
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
      depositStatusText.value = 'Waiting for payment…'
      if (depositCleanup) { depositCleanup(); depositCleanup = null }
    }

    // ── Withdraw state ────────────────────────────────────────────
    const withdrawAddress = ref('')
    const withdrawAmount = ref<number | null>(null)
    const onchainWithdrawAddress = ref('')
    const onchainWithdrawAmount = ref<number | null>(null)
    const withdrawInvoice = ref('')
    const withdrawLoading = ref(false)
    const withdrawStatus = ref<'idle' | 'pending' | 'success' | 'error'>('idle')
    const withdrawStatusText = ref('')

    async function createLnWithdraw() {
      if (!withdrawInvoice.value) return
      withdrawLoading.value = true
      withdrawStatus.value = 'pending'
      withdrawStatusText.value = 'Creating swap and sending…'
      try {
        const result = await doLnWithdraw(withdrawInvoice.value)
        withdrawStatus.value = 'success'
        withdrawStatusText.value = `Paid! Preimage: ${result.preimage.slice(0, 16)}…`
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
      const balance = store.getters['ark/balance'] || BigInt(0)
      withdrawAmount.value = Math.max(0, Number(balance) - 300)
    }
    function onchainSetMax() {
      const balance = store.getters['ark/balance'] || BigInt(0)
      onchainWithdrawAmount.value = Math.max(0, Number(balance) - 300)
    }

    async function withdrawFunds() {
      if (!withdrawAddress.value || !withdrawAmount.value) return
      try {
        const txid = await store.dispatch('ark/sendBitcoin', {
          address: withdrawAddress.value, amount: withdrawAmount.value,
        })
        showToast(`Sent! TX: ${txid.slice(0, 12)}…`)
        withdrawAddress.value = ''
        withdrawAmount.value = null
      } catch (err) {
        showToast(`Send failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
      }
    }
    async function withdrawOnchain() {
      if (!onchainWithdrawAddress.value || !onchainWithdrawAmount.value) return
      try {
        const txid = await store.dispatch('ark/sendBitcoin', {
          address: onchainWithdrawAddress.value, amount: onchainWithdrawAmount.value,
        })
        showToast(`Sent on-chain! TX: ${txid.slice(0, 12)}…`)
        onchainWithdrawAddress.value = ''
        onchainWithdrawAmount.value = null
      } catch (err) {
        showToast(`On-chain send failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
      }
    }

    const settleLoading = ref(false)
    async function settleFunds() {
      settleLoading.value = true
      try {
        const txid = await store.dispatch('ark/settle')
        showToast(`Settled! TX: ${txid.slice(0, 12)}…`)
      } catch (err) {
        showToast(`Settle failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
      } finally {
        settleLoading.value = false
      }
    }

    // ── Settings ──────────────────────────────────────────────────
    const showKey = ref(false)
    const showDeleteConfirm = ref(false)
    const deleteConfirmText = ref('')

    function deleteWallet() {
      store.dispatch('clearWallet')
      emit('update:open', false)
      router.push('/setup')
    }

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

    // ── Toast ─────────────────────────────────────────────────────
    const toastMsg = ref('')
    const toastType = ref<'success' | 'error'>('success')
    function showToast(msg: string, type: 'success' | 'error' = 'success') {
      toastMsg.value = msg
      toastType.value = type
      setTimeout(() => { toastMsg.value = '' }, 3000)
    }

    async function copyText(text: string) {
      if (!text) return
      try { await navigator.clipboard.writeText(text); showToast('Copied!') } catch { /* ignore */ }
    }

    function close() { emit('update:open', false) }

    // Background poll for boarding UTXOs while the drawer is open.
    let pollInterval: ReturnType<typeof setInterval> | null = null
    onMounted(() => {
      pollInterval = setInterval(() => {
        if (props.open && ready.value) store.dispatch('ark/refreshBalance')
      }, 15_000)
    })
    onUnmounted(() => {
      if (pollInterval) clearInterval(pollInterval)
      if (depositCleanup) depositCleanup()
    })

    return {
      store, close, reconnect,
      arkStatus, ready, connText, arkServer, info,
      usdBalance, arkAddress, privateKey, boardingAddress, boardingBalance, boardingUtxos,
      hasUnsettledFunds, isMutinyTestnet,
      tab, depositMethod, withdrawMethod,
      depositAmount, depositInvoice, depositLoading, depositStatus, depositStatusText,
      withdrawAddress, withdrawAmount, onchainWithdrawAddress, onchainWithdrawAmount,
      withdrawInvoice, withdrawLoading, withdrawStatus, withdrawStatusText,
      settleLoading,
      fees, limits, calcReceive,
      createLnDeposit, resetDeposit, createLnWithdraw, resetWithdraw,
      setMaxAmount, onchainSetMax, withdrawFunds, withdrawOnchain, settleFunds,
      showKey, showDeleteConfirm, deleteConfirmText, deleteWallet, requestFaucet,
      copyText, toastMsg, toastType,
    }
  },
})
</script>

<style scoped lang="scss">
.drawer-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 200;
}
.drawer-overlay-enter-active, .drawer-overlay-leave-active { transition: opacity 0.25s ease; }
.drawer-overlay-enter-from, .drawer-overlay-leave-to { opacity: 0; }

.wallet-drawer {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: min(440px, 100vw);
  background: var(--bg);
  border-left: 1px solid var(--border);
  z-index: 201;
  display: flex; flex-direction: column;
  overflow-y: auto;
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.4);
}
.drawer-enter-active, .drawer-leave-active { transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1); }
.drawer-enter-from, .drawer-leave-to { transform: translateX(100%); }

.drawer-header {
  padding: 22px 24px 18px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: flex-start; justify-content: space-between;
}
.balance-eyebrow { color: var(--text-muted); font-size: 0.65rem; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; }
.balance-amount { font-size: 1.8rem; font-weight: 700; color: var(--gold); margin-top: 4px; }
.balance-unit { font-size: 0.7rem; color: var(--text-muted); margin-left: 6px; }
.balance-fiat { font-size: 0.85rem; margin-top: 2px; }
.close-btn {
  background: none; border: none; color: var(--text-muted);
  font-size: 1.8rem; cursor: pointer; line-height: 1; padding: 4px 8px;
}
.close-btn:hover { color: var(--text); }

.conn-banner {
  margin: 12px 16px 0;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 0.8rem;
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--border);

  &.connecting { background: rgba(56, 189, 248, 0.06); border-color: rgba(56, 189, 248, 0.3); color: var(--blue); }
  &.error { background: rgba(239, 68, 68, 0.06); border-color: rgba(239, 68, 68, 0.3); color: var(--red); }
  &.disconnected { background: rgba(148, 163, 184, 0.06); color: var(--text-muted); }
}
.spinner {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.conn-text { flex: 1; }

.boarding-status {
  margin: 12px 16px 0;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 0.78rem;
  background: rgba(247, 201, 72, 0.06);
  color: var(--gold);
  display: flex; align-items: center; gap: 8px;
}
.boarding-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gold); animation: pulse 1.8s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.drawer-tabs {
  display: flex; gap: 4px;
  padding: 16px 16px 0;
}
.drawer-tabs .tab {
  flex: 1;
  background: transparent; border: 1px solid var(--border-light);
  color: var(--text-muted);
  padding: 10px 12px; font-size: 0.85rem; font-weight: 600;
  border-radius: 10px; cursor: pointer;
  transition: all 0.18s;
  &:hover { color: var(--text); border-color: var(--blue); }
  &.active { background: rgba(56, 189, 248, 0.12); border-color: var(--blue); color: var(--blue); }
}

.drawer-body { padding: 18px 16px 24px; flex: 1; }

.method-tabs { display: flex; gap: 4px; margin-bottom: 14px; }
.method-tabs .tab {
  flex: 1;
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  color: var(--text-muted);
  padding: 8px 10px; font-size: 0.78rem; font-weight: 600;
  border-radius: 8px; cursor: pointer;
  &.active { background: rgba(247, 201, 72, 0.1); border-color: var(--gold); color: var(--gold); }
}

.section-body { display: flex; flex-direction: column; gap: 12px; }
.hint { font-size: 0.75rem; color: var(--text-muted); }
.input {
  width: 100%;
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  color: var(--text); padding: 12px 14px;
  border-radius: 10px; font-size: 0.95rem; font-family: inherit;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}
.input-row { display: flex; gap: 8px; .input { flex: 1; } }

.btn-primary, .btn-outline, .btn-danger {
  border-radius: 10px; padding: 12px 18px; font-size: 0.9rem; font-weight: 700;
  cursor: pointer; border: 1.5px solid; letter-spacing: 0.5px;
  transition: all 0.18s;
}
.btn-primary { background: var(--gold); color: var(--bg); border-color: var(--gold); &:hover:not(:disabled) { box-shadow: 0 0 16px var(--gold-glow); } }
.btn-outline { background: transparent; color: var(--text); border-color: var(--border-light); &:hover:not(:disabled) { border-color: var(--blue); color: var(--blue); } }
.btn-danger { background: transparent; color: var(--red); border-color: var(--red); &:hover:not(:disabled) { background: var(--red); color: #fff; } }
.btn-sm { padding: 8px 14px; font-size: 0.8rem; }
.btn-xs { padding: 6px 10px; font-size: 0.72rem; }
button:disabled { opacity: 0.4; cursor: not-allowed; }

.address-box {
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  border-radius: 10px; padding: 12px 14px;
  cursor: pointer; transition: border-color 0.18s;
  &:hover { border-color: var(--blue); }
  code { font-size: 0.72rem; word-break: break-all; display: block; color: var(--text); }
  .address-action { font-size: 0.66rem; color: var(--text-muted); margin-top: 6px; display: block; }
}

.status-badge {
  display: inline-block; padding: 6px 12px; border-radius: 8px;
  font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
  &.pending { background: rgba(56, 189, 248, 0.12); color: var(--blue); }
  &.success { background: rgba(34, 197, 94, 0.12); color: var(--green); }
  &.expired, &.error { background: rgba(239, 68, 68, 0.12); color: var(--red); }
}

.swap-result { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.boarding-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.boarding-item { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; }
.boarding-conf { font-size: 0.72rem; margin-left: auto; }

.settings-section { display: flex; flex-direction: column; gap: 12px; }
.server-info {
  margin-top: 16px; padding: 12px; border-radius: 10px;
  background: var(--bg-elevated); font-size: 0.72rem; line-height: 1.6;
}

.overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65);
  display: flex; align-items: center; justify-content: center;
  z-index: 300; padding: 24px;
}
.modal-card { background: var(--bg); border: 1px solid var(--border); border-radius: 14px; padding: 24px; max-width: 420px; width: 100%; }
.modal-title { margin: 0 0 8px; font-size: 1.2rem; }
.modal-desc { font-size: 0.85rem; margin: 0 0 16px; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.key-display {
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  border-radius: 10px; padding: 12px; cursor: pointer; margin: 12px 0;
  code { font-size: 0.75rem; word-break: break-all; }
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.toast {
  position: fixed; bottom: 24px; right: 24px;
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  border-radius: 10px; padding: 10px 16px; font-size: 0.85rem;
  z-index: 400;
  &.error { border-color: var(--red); color: var(--red); }
  &.success { border-color: var(--green); color: var(--green); }
}
.toast-enter-active, .toast-leave-active { transition: all 0.3s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(20px); }
</style>
