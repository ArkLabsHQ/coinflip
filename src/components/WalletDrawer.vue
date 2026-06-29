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
        </div>
        <button v-if="dismissible" class="close-btn" @click="close" aria-label="Close">&times;</button>
        <span v-else class="must-fund-hint">Add funds to play</span>
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
        <button :class="['tab', { active: tab === 'activity' }]" @click="tab = 'activity'">Activity</button>
        <button :class="['tab', { active: tab === 'settings' }]" @click="tab = 'settings'">Settings</button>
      </div>

      <div class="drawer-body">
        <!-- ── Receive (unified BIP-21 + copy sheet) ─────────────── -->
        <section v-if="tab === 'receive'" class="section-body">
          <!-- Unified QR: encodes bitcoin:<onchain>?ark=<arkAddr>&lightning=<lnurl|bolt11>
               so a generic BIP-21 wallet pays on-chain, an Ark wallet uses
               the off-chain `ark=` leg, and a Lightning wallet pays the
               `lightning=` leg (LNURL when amountless, BOLT11 when an
               amount has been set). -->
          <div class="recv-block recv-qr-block">
            <QrCode v-if="qrValue" :value="qrValue" :size="244" @copy="copyText(qrValue)" title="Tap to copy" />
            <div v-else class="qr-skeleton">{{ ready ? 'Generating…' : 'Connecting…' }}</div>
            <div class="qr-meta">
              <!-- When an individual method is selected, the QR holds its raw
                   value — say so explicitly so it's clear this isn't the
                   unified URI. -->
              <div v-if="selectedPayload && selectedPayloadId !== 'unified'" class="qr-meta-label">
                {{ selectedPayload.label }} <span class="hint">&middot; raw value</span>
              </div>
              <template v-else>
                <div v-if="depositInvoice" class="qr-meta-label">Lightning invoice ({{ Number(depositAmount).toLocaleString() }} sats)</div>
                <div v-else-if="lnurlStatus === 'open'" class="qr-meta-label">Pay any amount &middot; on-chain + Ark + Lightning</div>
                <div v-else-if="lnurlStatus === 'opening'" class="qr-meta-label hint">Connecting to LNURL server&hellip;</div>
                <div v-else-if="lnurlStatus === 'error'" class="qr-meta-label hint error-hint" :title="lnurlError || ''">
                  Lightning receive unavailable (server error)
                </div>
                <div v-else-if="lnurlStatus === 'disabled'" class="qr-meta-label hint">Lightning receive unavailable (no LNURL server configured)</div>
              </template>
            </div>
            <div class="qr-actions">
              <!-- Deep link: only shown when the QR holds a scheme-prefixed
                   URI (the unified BIP-21). Tapping it hands the URI to the
                   OS so a mobile wallet can pick it up. -->
              <a v-if="qrIsUri" class="btn-outline btn-sm" :href="qrValue">Open in wallet</a>
              <button class="btn-outline btn-sm" @click="copySheetOpen = !copySheetOpen" :disabled="!copyOptions.length">
                Payment method &#8964;
              </button>
              <button class="btn-outline btn-sm" v-if="!depositInvoice" @click="showAmountForm = !showAmountForm" :disabled="!ready">
                {{ showAmountForm ? 'Hide' : 'Add amount (LN invoice)' }}
              </button>
            </div>

            <!-- Method picker: choosing a row swaps the QR to that payload's
                 RAW value (unified URI, ark, on-chain, LNURL, BOLT11) so
                 wallet dialects that don't parse BIP-21 can scan the exact
                 string they need. Tap the QR afterwards to copy it. -->
            <div v-if="copySheetOpen" class="copy-sheet">
              <button v-for="opt in copyOptions" :key="opt.id" class="copy-sheet-item"
                      :class="{ active: opt.id === selectedPayloadId }" @click="selectPayload(opt)">
                <span class="copy-sheet-label">{{ opt.label }}</span>
                <span class="copy-sheet-value mono">{{ opt.value.length > 36 ? opt.value.slice(0, 18) + '…' + opt.value.slice(-12) : opt.value }}</span>
              </button>
            </div>

            <!-- Amount form: only for fixed-amount BOLT11 via Boltz reverse
                 swap. Amountless LN receive is handled by the LNURL session
                 above. -->
            <div v-if="showAmountForm && !depositInvoice" class="amt-form">
              <div class="input-row">
                <input class="input" type="number" v-model.number="depositAmount" placeholder="Amount in sats"
                       :min="limits?.min" :max="limits?.max" :disabled="!ready" />
                <button class="btn-primary btn-sm" :disabled="!depositAmount || depositLoading || !ready" @click="createLnDeposit">
                  {{ depositLoading ? 'Creating…' : 'Invoice' }}
                </button>
              </div>
              <div class="hint" v-if="depositAmount && fees">
                You receive &asymp; <strong>{{ calcReceive(depositAmount).toLocaleString() }}</strong> sats after fees
              </div>
              <div class="hint" v-else-if="fees && limits">
                {{ limits.min.toLocaleString() }} &ndash; {{ limits.max.toLocaleString() }} sats
                &middot; {{ fees.reverse.percentage }}% + {{ (fees.reverse.minerFees.lockup + fees.reverse.minerFees.claim).toLocaleString() }} fee
              </div>
            </div>
            <div v-if="depositInvoice" class="amt-form">
              <div class="status-badge" :class="depositStatus">{{ depositStatusText }}</div>
              <button class="btn-outline btn-sm" @click="resetDeposit">New invoice</button>
            </div>
          </div>

          <!-- Testnet faucet still surfaced as a one-tap shortcut. -->
          <div v-if="isMutinyTestnet && ready" class="recv-block">
            <button class="btn-outline btn-sm" @click="requestFaucet">Request Testnet Faucet</button>
          </div>

          <!-- On-chain boarding — only the settle/banner block now; the
               address itself is in the unified QR + copy sheet. -->
          <div class="recv-block">
            <div class="block-label">On-chain status</div>
            <div v-if="boardingUtxos.length > 0" class="boarding-list">
              <div v-for="utxo in boardingUtxos" :key="utxo.outpoint.txid + ':' + utxo.outpoint.vout" class="boarding-item">
                <span class="boarding-dot"></span>
                <span class="mono">{{ Number(utxo.amount).toLocaleString() }} sats</span>
                <span class="text-muted boarding-conf">
                  {{ utxo.confirmations ? utxo.confirmations + ' conf' : 'unconfirmed' }}
                </span>
              </div>
            </div>
            <!-- Info banner: boarding UTXO(s) still waiting for on-chain
                 confirmation. Settling them now would fail — Ark batches
                 require ≥ 1 confirmation. -->
            <div v-if="hasUnconfirmedBoarding" class="info-banner">
              <span class="info-icon">⏳</span>
              <span class="info-text">
                {{ unconfirmedBoardingAmount.toLocaleString() }} sats deposited on-chain — waiting for confirmation before they can be settled into Ark.
              </span>
            </div>
            <!-- Info banner: recoverable VTXOs (sub-dust or expired sweeps)
                 the user can reclaim by settling. -->
            <div v-if="hasRecoverable" class="info-banner alt">
              <span class="info-icon">↺</span>
              <span class="info-text">
                {{ recoverableAmount.toLocaleString() }} sats recoverable from prior sub-dust outputs or expired sweeps — settle to reclaim them.
              </span>
            </div>
            <button v-if="hasUnsettledFunds && ready" class="btn-primary btn-sm" :disabled="settleLoading" @click="settleFunds">
              {{ settleLoading ? 'Settling…' : settleReasonLabel }}
            </button>
          </div>
        </section>

        <!-- ── Send (unified single input) ────────────────────────── -->
        <section v-if="tab === 'send'" class="section-body">
          <div v-if="sendStatus !== 'success'">
            <textarea class="input send-input" v-model="sendInput" rows="2" :disabled="!ready"
                      placeholder="Paste a Lightning invoice / address, LNURL, Ark address, or Bitcoin address"></textarea>

            <!-- Detected rail -->
            <div v-if="sendInput.trim()" class="detect-row">
              <span class="detect-chip" :class="sendDetected.kind">{{ sendKindLabel }}</span>
              <span v-if="sendDetected.kind === 'lightning' && sendDetected.amountSats > 0" class="hint">
                {{ sendDetected.amountSats.toLocaleString() }} sats
              </span>
            </div>

            <!-- Amount only when the destination needs it (Ark / on-chain) -->
            <div v-if="sendNeedsAmount" class="input-row">
              <input class="input" type="number" v-model.number="sendAmount" placeholder="Amount (sats)" min="0" :disabled="!ready" />
              <button class="btn-outline btn-sm" @click="sendSetMax">MAX</button>
            </div>

            <div v-if="sendStatus === 'pending'" class="status-badge pending">{{ sendStatusText }}</div>
            <div v-else-if="sendStatus === 'error'" class="status-badge error">{{ sendStatusText }}</div>

            <button class="btn-primary" :disabled="!canSend"
                    :title="!ready ? 'Connecting to Ark…' : ''" @click="doSend">
              {{ sendLoading ? 'Sending…' : sendButtonLabel }}
            </button>

            <div v-if="sendInput.trim() && sendDetected.kind === 'unknown'" class="hint error-hint">
              Unrecognized destination — paste a Lightning invoice/address, LNURL, Ark, or Bitcoin address.
            </div>
            <div v-else-if="sendDetected.kind === 'lightning' && sendDetected.amountSats === 0" class="hint error-hint">
              Amountless invoices aren't supported — use one with a fixed amount.
            </div>
          </div>
          <div v-else class="swap-result">
            <div class="status-badge success">{{ sendStatusText }}</div>
            <button class="btn-outline btn-sm" @click="resetSend">New Payment</button>
          </div>
        </section>

        <!-- ── Activity ───────────────────────────────────────────── -->
        <section v-if="tab === 'activity'" class="activity-section">
          <div v-if="activityHistory.length === 0" class="empty-state">
            <div class="empty-icon">&#9728;</div>
            <div class="empty-text">No activity yet</div>
            <div class="hint">Your wallet activity will appear here</div>
          </div>
          <div v-else class="tx-list">
            <div v-for="act in activityHistory" :key="act.id" class="tx-row">
              <div class="tx-dir" :class="act.amount >= 0 ? 'received' : 'sent'">
                <span v-if="act.amount >= 0">&#9660;</span>
                <span v-else>&#9650;</span>
              </div>
              <div class="tx-body">
                <div class="tx-top">
                  <span class="tx-label">
                    {{ act.intent?.label || (act.amount >= 0 ? 'Received' : 'Sent') }}
                    <span v-if="act.intent?.kind === 'boarding'" class="tx-badge boarding">Boarding</span>
                  </span>
                  <span class="tx-amount" :class="act.amount >= 0 ? 'received' : 'sent'">
                    {{ act.amount >= 0 ? '+' : '−' }}{{ Math.abs(act.amount).toLocaleString() }}
                    <span class="tx-unit">sats</span>
                  </span>
                </div>
                <div class="tx-bottom">
                  <span class="tx-time text-muted">{{ formatRelative(act.createdAt) }}</span>
                  <span class="tx-status" :class="act.settled ? 'settled' : 'pending'">
                    {{ act.settled ? 'Settled' : 'Pending' }}
                  </span>
                </div>
                <div v-if="act.txs.length > 1" class="tx-id mono">
                  {{ act.txs.length }} transactions grouped
                </div>
                <div v-else-if="act.txs[0]" class="tx-id mono" @click="copyText(act.txs[0].txid)">
                  {{ act.txs[0].txid.slice(0, 12) }}…{{ act.txs[0].txid.slice(-8) }}
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ── Settings ───────────────────────────────────────────── -->
        <section v-if="tab === 'settings'" class="settings-section">
          <button class="btn-outline" @click="showKey = true">Back Up Wallet</button>
          <button class="btn-outline" :disabled="resyncing" @click="resyncWallet">
            {{ resyncing ? 'Resyncing…' : 'Resync Wallet Data' }}
          </button>
          <p class="text-muted mono resync-hint">Clears cached balance/VTXOs and re-syncs from the server. Keeps your key — use after a node/chain reset.</p>
          <button class="btn-danger" @click="showDeleteConfirm = true">Delete Wallet</button>
          <div class="server-info text-muted mono">
            <div>Network: {{ info?.network || '—' }} <span class="net-note">(set by server)</span></div>
            <div>Ark: {{ arkServer }}</div>
            <div>Status: {{ arkStatus }}</div>
          </div>
        </section>
      </div>

      <!-- Private Key Modal -->
      <transition name="fade">
        <div v-if="showKey" class="overlay" @click.self="showKey = false">
          <div class="modal-card casino-card-glow">
            <h3 class="modal-title text-gold">Wallet Backup</h3>
            <p class="modal-desc text-muted">Your recovery phrase (or legacy key). Save it securely; never share it.</p>
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
import { defineComponent, computed, ref, watch, onUnmounted } from 'vue'
import { useStore } from 'vuex'
import { useRouter } from 'vue-router'
import { isValidArkAddress } from '@arkade-os/sdk'
import {
  getSwaps,
  createLnDeposit as doLnDeposit,
  createLnWithdraw as doLnWithdraw,
  invoiceSats,
  getFees,
  getLimits,
  type FeesResponse,
  type LimitsResponse,
} from '@/services/boltz'
import { copyToClipboard } from '@/utils/clipboard'
import { detectLnurlInput, resolveLnurlToInvoice } from '@/utils/lnurl'
import { encodeBip21 } from '@/utils/bip21'
import { getErrorMessage } from '@/utils/errors'
import { openLnurlSession, lnurlServerForNetwork, type LnurlSession } from '@/services/lnurlSession'
import QrCode from '@/components/QrCode.vue'

type SendKind = 'empty' | 'lightning' | 'lnurl' | 'ark' | 'onchain' | 'unknown'
interface SendTarget { kind: SendKind; amountSats: number; address: string }

/**
 * Classify a pasted send destination into a rail, mirroring the Arkade
 * wallet's single-input flow. Order of detection:
 *   1. BIP21 (extracts ark, lightning, amount params)
 *   2. BOLT11 invoice (lnbc / lntb / lnbcrt / lnbs prefix)
 *   3. Lightning Address (`user@host`) / LNURL (bech32) / HTTPS LNURL
 *   4. Ark address
 *   5. On-chain Bitcoin address
 */
function detectSend(raw: string): SendTarget {
  const s = (raw || '').trim()
  if (!s) return { kind: 'empty', amountSats: 0, address: '' }

  if (/^bitcoin:/i.test(s)) {
    const body = s.replace(/^bitcoin:/i, '')
    const qIdx = body.indexOf('?')
    const addr = qIdx >= 0 ? body.slice(0, qIdx) : body
    const params = new URLSearchParams(qIdx >= 0 ? body.slice(qIdx + 1) : '')
    const ark = params.get('ark')
    const ln = params.get('lightning')
    const amtBtc = params.get('amount')
    const amountSats = amtBtc ? Math.round(parseFloat(amtBtc) * 1e8) : 0
    if (ark && isValidArkAddress(ark)) return { kind: 'ark', amountSats, address: ark }
    if (ln) return { kind: 'lightning', amountSats: invoiceSats(ln), address: ln }
    if (addr) return { kind: 'onchain', amountSats, address: addr }
    return { kind: 'unknown', amountSats: 0, address: '' }
  }
  // BOLT11 — preserve as-is; if the input has a `lightning:` prefix, strip it
  // so the parser sees the raw invoice.
  const lnStripped = s.replace(/^lightning:/i, '').trim()
  if (/^ln(bc|tb|bcrt|bs)/i.test(lnStripped)) {
    return { kind: 'lightning', amountSats: invoiceSats(lnStripped), address: lnStripped }
  }
  // Lightning Address / LNURL-pay — `user@host`, `LNURL1...`, or `https://...`.
  // We don't resolve here (network call); the send flow does it on click.
  const lnurl = detectLnurlInput(s)
  if (lnurl) return { kind: 'lnurl', amountSats: 0, address: lnurl.raw }
  if (isValidArkAddress(s)) {
    return { kind: 'ark', amountSats: 0, address: s }
  }
  if (/^(bc1|tb1|bcrt1|[123mn])/.test(s)) {
    return { kind: 'onchain', amountSats: 0, address: s }
  }
  return { kind: 'unknown', amountSats: 0, address: s }
}

export default defineComponent({
  name: 'WalletDrawer',
  components: { QrCode },
  props: {
    open: { type: Boolean, default: false },
    // When false (e.g. zero balance), the drawer can't be dismissed — the close
    // button is hidden and backdrop clicks are ignored — so the user funds the
    // wallet before returning to the game.
    dismissible: { type: Boolean, default: true },
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
      if (!isOpen) {
        // Close the LNURL SSE stream when the drawer closes — we can re-open
        // it on next focus. Keeps the long-poll connection from racking up
        // on the server when the user isn't actively receiving.
        closeLnurlSession()
        return
      }
      if (arkStatus.value !== 'connected' && arkStatus.value !== 'connecting') {
        await reconnect()
      } else if (arkStatus.value === 'connected') {
        // Watcher-driven refreshes are light (balance only), so do one full
        // refresh on open to bring the drawer's vtxo list / boarding UTXOs
        // current; the heavy history loads lazily only if Activity is showing.
        store.dispatch('ark/refreshBalance').catch(() => { /* transient */ })
        loadActivityIfViewing()
      }
      // Open the LNURL session lazily once the drawer is shown. Failing
      // softly (no server / network down) lets the rest of the receive
      // panel still work — the QR just won't have a `lightning=` leg.
      ensureLnurlSession()
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
    const arkAddress = computed(() => store.getters['ark/address'])
    const arkServer = computed(() => store.state.ark.server)
    const info = computed(() => store.state.ark.info)
    // Prefer the BIP39 recovery phrase for mnemonic-backed wallets; fall back to
    // the nsec for legacy key-only wallets (both back up the same key).
    const privateKey = computed(() => store.getters.walletMnemonic || store.getters.nsecKey || store.state.wallet.privateKey)
    const boardingAddress = computed(() => store.getters['ark/boardingAddress'])
    const boardingBalance = computed(() => Number(store.getters['ark/boardingBalance'] || BigInt(0)))
    const boardingUtxos = computed(() => store.getters['ark/boardingUtxos'] || [])
    // Things that need a settle round-trip to become usable:
    //   - CONFIRMED boarding UTXOs (still on-chain — settling lifts them
    //     into a spendable VTXO via a batch round).
    //   - RECOVERABLE VTXOs (subdust outputs from a prior settle, or VTXOs
    //     swept past their batch expiry — settling claims them back).
    // Pre-confirmed VTXOs are ALREADY spendable (wallet.available counts
    // them), so showing 'Settle' for those was misleading — the user
    // doesn't gain anything by settling them mid-session.
    const hasConfirmedBoarding = computed(() => Number(store.state.ark.walletBalance?.boarding?.confirmed ?? 0) > 0)
    const hasUnconfirmedBoarding = computed(() => Number(store.state.ark.walletBalance?.boarding?.unconfirmed ?? 0) > 0)
    const hasRecoverable = computed(() => Number(store.state.ark.walletBalance?.recoverable ?? 0) > 0)
    const recoverableAmount = computed(() => Number(store.state.ark.walletBalance?.recoverable ?? 0))
    const unconfirmedBoardingAmount = computed(() => Number(store.state.ark.walletBalance?.boarding?.unconfirmed ?? 0))
    const hasUnsettledFunds = computed(() => hasConfirmedBoarding.value || hasRecoverable.value)
    const settleReasonLabel = computed(() => {
      if (hasConfirmedBoarding.value && hasRecoverable.value) return 'Settle on-chain + recoverable'
      if (hasConfirmedBoarding.value) return 'Settle Into Ark'
      if (hasRecoverable.value) return 'Claim recoverable'
      return 'Settle'
    })
    const isMutinyTestnet = computed(() => arkServer.value === 'https://mutinynet.arkade.sh')
    const txHistory = computed(() => store.getters['ark/txHistory'] || [])
    const activityHistory = computed(() => store.getters['ark/activityHistory'] || [])

    // ── LNURL session (amountless Lightning Address receive) ──────────
    // Mirrors the wallet's behaviour: open an SSE session against the
    // shared Arkade LNURL server, get back a static `lnurl1...` bech32
    // string the user can share. Server delivers any incoming LNURL pay
    // via the same SSE stream; we just refresh the balance on receipt
    // (the contract watcher picks up the VTXO arrival anyway).
    const networkName = computed<string | null>(() => store.state.ark?.info?.network ?? null)
    const lnurlServerUrl = computed(() => lnurlServerForNetwork(networkName.value))
    const lnurlSession = ref<LnurlSession | null>(null)
    const lnurlString = computed(() => lnurlSession.value?.lnurl ?? '')
    const lnurlStatus = ref<'idle' | 'opening' | 'open' | 'error' | 'disabled'>('idle')
    const lnurlError = ref<string | null>(null)
    async function ensureLnurlSession() {
      if (lnurlSession.value || lnurlStatus.value === 'opening') return
      const pk = store.state.wallet?.privateKey
      const server = lnurlServerUrl.value
      if (!pk || !server) {
        lnurlStatus.value = 'disabled'
        return
      }
      lnurlStatus.value = 'opening'
      lnurlError.value = null
      try {
        lnurlSession.value = await openLnurlSession({
          serverUrl: server,
          privateKeyHex: pk,
          onPaymentReceived: () => store.dispatch('ark/refreshBalance').catch(() => { /* transient */ }),
          onError: (err) => { lnurlError.value = err.message; lnurlStatus.value = 'error' },
        })
        lnurlStatus.value = 'open'
      } catch (e) {
        lnurlError.value = getErrorMessage(e)
        lnurlStatus.value = 'error'
      }
    }
    function closeLnurlSession() {
      try { lnurlSession.value?.close() } catch { /* ignore */ }
      lnurlSession.value = null
      lnurlStatus.value = 'idle'
    }

    // ── Unified BIP-21 receive URI ────────────────────────────────────
    // Lightning leg: when the user has set a fixed amount we hand it to
    // Boltz for a one-shot reverse swap and bake the resulting BOLT11
    // into the URI; when amountless, fall back to the static LNURL session
    // string so generic wallets can still drive a Lightning pay.
    const unifiedUri = computed(() => {
      const lightning =
        depositInvoice.value ? depositInvoice.value :
        lnurlString.value ? lnurlString.value :
        undefined
      return encodeBip21({
        btc: boardingAddress.value || undefined,
        ark: arkAddress.value || undefined,
        lightning,
        amountSats: depositInvoice.value && depositAmount.value ? Number(depositAmount.value) : undefined,
      })
    })
    const copySheetOpen = ref(false)
    // Reveal the fixed-amount BOLT11 form (Boltz reverse swap). Amountless
    // Lightning receive is always on via the LNURL session, so this stays
    // collapsed by default.
    const showAmountForm = ref(false)
    const copyOptions = computed(() => {
      const out: { id: string; label: string; value: string }[] = []
      if (unifiedUri.value) out.push({ id: 'unified', label: 'Unified BIP-21', value: unifiedUri.value })
      if (arkAddress.value) out.push({ id: 'ark', label: 'Ark address', value: arkAddress.value })
      if (boardingAddress.value) out.push({ id: 'onchain', label: 'On-chain address', value: boardingAddress.value })
      if (depositInvoice.value) out.push({ id: 'invoice', label: 'Lightning invoice', value: depositInvoice.value })
      if (lnurlString.value) out.push({ id: 'lnurl', label: 'Lightning Address (LNURL)', value: lnurlString.value })
      return out
    })

    // Which payload the QR renders. 'unified' shows the BIP-21 URI (the
    // default, scannable by any wallet); selecting an individual method
    // switches the QR to that method's RAW value (bare address / invoice /
    // lnurl) for wallets that don't parse BIP-21.
    const selectedPayloadId = ref('unified')
    // Falls back to the first available payload (the unified URI when present)
    // if the selected method disappears — e.g. an LNURL error or a reset
    // invoice removes its option from the list.
    const selectedPayload = computed(() =>
      copyOptions.value.find((o) => o.id === selectedPayloadId.value) ?? copyOptions.value[0] ?? null,
    )
    const qrValue = computed(() => selectedPayload.value?.value ?? '')
    // Only a scheme-prefixed payload (the unified BIP-21 URI) is an openable
    // deep link; raw addresses / invoices / lnurl strings are not.
    const qrIsUri = computed(() => /^(bitcoin|ark|lightning):/i.test(qrValue.value))
    function selectPayload(opt: { id: string }) {
      selectedPayloadId.value = opt.id
      copySheetOpen.value = false
    }

    function formatRelative(ts: number): string {
      const diff = Date.now() - ts
      if (diff < 60_000) return 'just now'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
      if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
      return new Date(ts).toLocaleDateString()
    }

    const tab = ref<'receive' | 'send' | 'activity' | 'settings'>('receive')

    // The Activity tab's history is heavy (the SDK re-derives it from chain —
    // an esplora /outspends per boarding tx), so load it lazily, only when that
    // tab is actually viewed. The cached list (state.txHistory) renders
    // instantly; this refreshes it. Receive / Send / Settings cost nothing.
    function loadActivityIfViewing() {
      if (tab.value === 'activity' && ready.value) {
        store.dispatch('ark/refreshHistory').catch(() => { /* transient */ })
      }
    }
    watch(tab, loadActivityIfViewing)

    // Live Activity: the SDK contract-watcher commits a new walletBalance on
    // every vtxo_received / vtxo_spent. When that happens while the Activity
    // tab is open, refresh the history in place so a settled flip appears
    // without the user reopening the tab. Other tabs / idle sessions stay
    // zero-fetch (loadActivityIfViewing is gated on tab === 'activity').
    watch(() => store.state.ark.walletBalance, loadActivityIfViewing)

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

    // ── Send state (single auto-detecting input) ──────────────────
    const sendInput = ref('')
    const sendAmount = ref<number | null>(null)
    const sendLoading = ref(false)
    const sendStatus = ref<'idle' | 'pending' | 'success' | 'error'>('idle')
    const sendStatusText = ref('')

    const sendDetected = computed<SendTarget>(() => detectSend(sendInput.value))
    const sendNeedsAmount = computed(() =>
      sendDetected.value.kind === 'ark' ||
      sendDetected.value.kind === 'onchain' ||
      sendDetected.value.kind === 'lnurl',
    )
    const sendKindLabel = computed(() => {
      switch (sendDetected.value.kind) {
        case 'lightning': return '⚡ Lightning invoice'
        case 'lnurl': return '⚡ Lightning address'
        case 'ark': return 'Ark'
        case 'onchain': return 'On-chain'
        case 'unknown': return 'Unrecognized'
        default: return ''
      }
    })
    const sendButtonLabel = computed(() => {
      const k = sendDetected.value.kind
      if (k === 'lightning') return 'Pay Invoice'
      if (k === 'lnurl') return 'Pay Lightning Address'
      return 'Send'
    })
    const canSend = computed(() => {
      if (!ready.value || sendLoading.value) return false
      const d = sendDetected.value
      if (d.kind === 'lightning') return d.amountSats > 0
      if (d.kind === 'ark' || d.kind === 'onchain' || d.kind === 'lnurl') return !!sendAmount.value && sendAmount.value > 0
      return false
    })

    function sendSetMax() {
      const balance = store.getters['ark/balance'] || BigInt(0)
      sendAmount.value = Math.max(0, Number(balance) - 300)
    }

    async function doSend() {
      const d = sendDetected.value
      if (!canSend.value) return
      sendLoading.value = true
      sendStatus.value = 'pending'
      sendStatusText.value =
        d.kind === 'lightning' ? 'Paying via Lightning…' :
        d.kind === 'lnurl' ? 'Resolving Lightning address…' :
        'Sending…'
      try {
        if (d.kind === 'lnurl') {
          // LNURL-pay: hit the recipient's endpoint, get a BOLT11 for the
          // amount we want, then send via the same Boltz Ark→LN swap as a
          // pasted invoice. The "Resolving…" → "Paying…" transition gives
          // the user feedback during the extra HTTP roundtrip.
          const input = detectLnurlInput(d.address)
          if (!input) throw new Error('Could not parse Lightning address')
          const { invoice } = await resolveLnurlToInvoice(input, sendAmount.value as number)
          sendStatusText.value = 'Paying via Lightning…'
          const result = await doLnWithdraw(invoice)
          sendStatusText.value = `Paid! Preimage ${result.preimage.slice(0, 16)}…`
        } else if (d.kind === 'lightning') {
          const result = await doLnWithdraw(d.address)
          sendStatusText.value = `Paid! Preimage ${result.preimage.slice(0, 16)}…`
        } else {
          const txid = await store.dispatch('ark/sendBitcoin', {
            address: d.address, amount: sendAmount.value,
          })
          sendStatusText.value = `Sent! TX ${txid.slice(0, 12)}…`
        }
        sendStatus.value = 'success'
        showToast('Sent!')
        store.dispatch('ark/refreshBalance')
      } catch (err) {
        sendStatus.value = 'error'
        sendStatusText.value = err instanceof Error ? err.message : 'Send failed'
        showToast(sendStatusText.value, 'error')
      } finally {
        sendLoading.value = false
      }
    }

    function resetSend() {
      sendInput.value = ''
      sendAmount.value = null
      sendStatus.value = 'idle'
      sendStatusText.value = ''
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
    const resyncing = ref(false)

    async function deleteWallet() {
      await store.dispatch('clearWallet')
      emit('update:open', false)
      router.push('/setup')
    }

    // Purge the SDK's cached local data (ghost VTXOs) and re-sync from the
    // server, keeping the key. Clears a stale balance left by a node/chain reset.
    async function resyncWallet() {
      if (resyncing.value) return
      resyncing.value = true
      try {
        // `ark` is a namespaced module — the action is `ark/resyncWallet`.
        await store.dispatch('ark/resyncWallet')
      } catch (e) {
        console.warn('resync failed:', e)
      } finally {
        resyncing.value = false
      }
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
      if (await copyToClipboard(text)) showToast('Copied!')
    }

    function close() { if (props.dismissible) emit('update:open', false) }

    // Balance updates are push-based via the SDK contract watcher (one SSE
    // stream + a 60s failsafe poll, wired in ark.ts `notifyIncomingFunds`), so
    // the drawer no longer needs its own balance poll.
    onUnmounted(() => {
      if (depositCleanup) depositCleanup()
    })

    return {
      store, close, reconnect,
      arkStatus, ready, connText, arkServer, info,
      arkAddress, privateKey, boardingAddress, boardingBalance, boardingUtxos,
      hasUnsettledFunds, settleReasonLabel,
      hasUnconfirmedBoarding, unconfirmedBoardingAmount,
      hasRecoverable, recoverableAmount,
      isMutinyTestnet, txHistory, activityHistory, formatRelative,
      tab,
      depositAmount, depositInvoice, depositLoading, depositStatus, depositStatusText,
      showAmountForm, copySheetOpen, copyOptions,
      selectPayload, selectedPayload, selectedPayloadId, qrValue, qrIsUri,
      lnurlStatus, lnurlError,
      sendInput, sendAmount, sendLoading, sendStatus, sendStatusText,
      sendDetected, sendNeedsAmount, sendKindLabel, sendButtonLabel, canSend,
      sendSetMax, doSend, resetSend,
      settleLoading,
      fees, limits, calcReceive,
      createLnDeposit, resetDeposit, settleFunds,
      showKey, showDeleteConfirm, deleteConfirmText, deleteWallet, requestFaucet,
      resyncing, resyncWallet,
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
.must-fund-hint {
  font-size: 0.7rem; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
  color: var(--gold); background: rgba(247, 201, 72, 0.1);
  border: 1px solid var(--gold); border-radius: 999px; padding: 5px 12px; align-self: center;
}

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

/* Consolidated receive: one block per rail. */
.recv-block {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-light);
  border-radius: 12px;
}
.block-label {
  font-size: 0.72rem; font-weight: 700; letter-spacing: 1px;
  text-transform: uppercase; color: var(--text-muted);
}

/* Unified receive: QR centred, caption + actions stacked beneath it. */
.recv-qr-block { align-items: center; text-align: center; gap: 12px; }
.qr-skeleton {
  width: 244px; height: 244px;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-elevated); border: 1px dashed var(--border-light);
  border-radius: 14px; color: var(--text-muted); font-size: 0.85rem;
}
.qr-meta { min-height: 1.1rem; }
.qr-meta-label { font-size: 0.78rem; color: var(--text); font-weight: 600; }
.qr-meta-label.hint { color: var(--text-muted); font-weight: 400; }
.qr-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; width: 100%; }
.qr-actions .btn-outline { flex: 1; min-width: 130px; }

/* Copy sheet: one tappable row per individual payload. */
.copy-sheet {
  display: flex; flex-direction: column; gap: 6px;
  width: 100%; margin-top: 4px;
}
.copy-sheet-item {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 12px; text-align: left;
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  border-radius: 10px; color: var(--text); cursor: pointer;
  font-family: inherit; font-size: 0.8rem;
  transition: border-color 0.15s ease, color 0.15s ease;
  &:hover { border-color: var(--blue); color: var(--blue); }
  &.active { border-color: var(--gold); color: var(--gold); background: rgba(247, 201, 72, 0.08); }
}
.copy-sheet-label { font-weight: 600; white-space: nowrap; }
.copy-sheet-value { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }

/* Fixed-amount BOLT11 form + active-invoice status block. */
.amt-form { display: flex; flex-direction: column; gap: 10px; width: 100%; }

/* Unified send input + detected-rail chip. */
.send-input {
  resize: none;
  word-break: break-all;
  line-height: 1.4;
}
.detect-row { display: flex; align-items: center; gap: 10px; }
.detect-chip {
  font-size: 0.68rem; font-weight: 700; letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 3px 10px; border-radius: 6px;
  background: var(--bg-elevated); border: 1px solid var(--border-light); color: var(--text-muted);
  &.lightning { color: var(--gold); border-color: var(--gold); background: rgba(247, 201, 72, 0.08); }
  &.ark { color: var(--blue); border-color: var(--blue); background: rgba(56, 189, 248, 0.08); }
  &.onchain { color: var(--text); border-color: var(--text-muted); }
  &.unknown { color: var(--red); border-color: var(--red); background: rgba(239, 68, 68, 0.06); }
}
.error-hint { color: var(--red); }

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

/* Info banner for boarding/unconfirmed / recoverable hints next to the
   Settle button. Two visual variants: default (yellow, "wait") + alt
   (blue, "action available"). */
.info-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 6px;
  margin-top: 10px;
  margin-bottom: 8px;
  font-size: 0.78rem;
  line-height: 1.4;
  background: rgba(234, 179, 8, 0.08);
  border: 1px solid rgba(234, 179, 8, 0.35);
  color: var(--text-dim);
}
.info-banner.alt {
  background: rgba(56, 189, 248, 0.08);
  border-color: rgba(56, 189, 248, 0.35);
}
.info-icon { font-size: 0.95rem; line-height: 1; }
.info-text { flex: 1; min-width: 0; }

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
.resync-hint { font-size: 0.68rem; line-height: 1.4; margin: -4px 0 4px; }
.net-note { opacity: 0.7; }

.activity-section { display: flex; flex-direction: column; gap: 4px; }
.empty-state {
  text-align: center; padding: 40px 20px;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  .empty-icon { font-size: 2rem; opacity: 0.4; }
  .empty-text { font-weight: 600; color: var(--text-muted); }
}
.tx-list { display: flex; flex-direction: column; gap: 6px; }
.tx-row {
  display: flex; gap: 12px; padding: 12px;
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  border-radius: 10px;
  transition: border-color 0.18s;
  &:hover { border-color: var(--blue); }
}
.tx-dir {
  width: 32px; height: 32px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%; font-size: 0.85rem; font-weight: 700;
  &.received { background: rgba(34, 197, 94, 0.12); color: var(--green, #22c55e); }
  &.sent { background: rgba(247, 201, 72, 0.12); color: var(--gold); }
}
.tx-body { flex: 1; min-width: 0; }
.tx-top {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 0.85rem; font-weight: 600;
}
.tx-label { color: var(--text); display: flex; align-items: center; gap: 8px; }
.tx-amount {
  font-family: ui-monospace, monospace;
  &.received { color: var(--green, #22c55e); }
  &.sent { color: var(--gold); }
  .tx-unit { font-size: 0.7rem; color: var(--text-muted); margin-left: 3px; }
}
.tx-bottom {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 4px; font-size: 0.72rem;
}
.tx-time { letter-spacing: 0.3px; }
.tx-status {
  padding: 2px 8px; border-radius: 6px;
  font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
  &.settled { background: rgba(34, 197, 94, 0.1); color: var(--green, #22c55e); }
  &.pending { background: rgba(56, 189, 248, 0.1); color: var(--blue); }
}
.tx-badge {
  font-size: 0.62rem; padding: 1px 6px; border-radius: 4px;
  font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
  &.boarding { background: rgba(247, 201, 72, 0.12); color: var(--gold); }
}
.tx-id {
  margin-top: 6px; font-size: 0.68rem; color: var(--text-muted);
  cursor: pointer;
  &:hover { color: var(--blue); }
}

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
