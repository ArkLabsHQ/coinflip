<template>
  <transition name="modal-fade">
    <div v-if="open" class="modal-backdrop" @click.self="$emit('close')">
      <div class="modal-card casino-card" role="dialog" aria-modal="true" :aria-labelledby="`game-detail-${gameId}`">
        <header class="modal-head">
          <h3 :id="`game-detail-${gameId}`">Game details</h3>
          <button class="modal-close" @click="$emit('close')" aria-label="Close">&times;</button>
        </header>

        <div v-if="loading" class="modal-loading">Loading…</div>
        <div v-else-if="error" class="modal-error">
          <div class="error-msg">{{ error }}</div>
          <button class="retry" @click="reload">Retry</button>
        </div>
        <div v-else-if="details" class="modal-body">
          <!-- Status -->
          <section class="section">
            <h4>Outcome</h4>
            <dl>
              <div><dt>Status</dt><dd><span class="badge" :class="statusClass">{{ details.status }}</span></dd></div>
              <div v-if="details.winner"><dt>Winner</dt><dd class="mono">{{ details.winner }}</dd></div>
              <div><dt>Tier (your stake)</dt><dd class="mono">{{ formatSats(details.tier) }} sats</dd></div>
              <div v-if="details.houseStake !== null"><dt>House stake</dt><dd class="mono">{{ formatSats(details.houseStake) }} sats</dd></div>
              <div><dt>Pot</dt><dd class="mono">{{ formatSats(potValue) }} sats</dd></div>
              <div v-if="details.payoutAmount !== null"><dt>Payout</dt><dd class="mono">{{ formatSats(details.payoutAmount) }} sats</dd></div>
              <div v-if="details.rakeAmount > 0"><dt>Rake</dt><dd class="mono">{{ formatSats(details.rakeAmount) }} sats</dd></div>
              <div v-if="details.roll !== null && details.roll !== undefined"><dt>Roll</dt><dd class="mono">{{ details.roll }}</dd></div>
            </dl>
          </section>

          <!-- Parameters -->
          <section class="section">
            <h4>Parameters</h4>
            <dl>
              <div><dt>Contract version</dt><dd class="mono">{{ details.contractVersion }}</dd></div>
              <div v-if="details.oddsN !== null"><dt>Odds range</dt><dd class="mono">[{{ details.oddsLo }}, {{ details.oddsTarget }}) / {{ details.oddsN }}</dd></div>
              <div v-if="details.finalExpiration"><dt>finalExpiration</dt><dd class="mono">{{ formatTime(details.finalExpiration) }}</dd></div>
              <div v-if="details.exitDelay"><dt>Exit delay</dt><dd class="mono">{{ details.exitDelay }}s</dd></div>
              <div v-if="details.emulatorPubkey"><dt>Emulator pubkey</dt><dd><CopyableHex :value="details.emulatorPubkey" /></dd></div>
            </dl>
          </section>

          <!-- Commitments + reveals -->
          <section class="section">
            <h4>Commitments</h4>
            <dl>
              <div><dt>Player hash</dt><dd><CopyableHex :value="details.playerHash" /></dd></div>
              <div v-if="details.playerSecret"><dt>Player preimage</dt><dd><CopyableHex :value="details.playerSecret" /></dd></div>
              <div v-if="details.houseSecret"><dt>House preimage</dt><dd><CopyableHex :value="details.houseSecret" /></dd></div>
              <div v-if="terminalState && (!details.playerSecret || !details.houseSecret)">
                <dt>Reveals</dt>
                <dd class="muted">Not yet recorded (pre-/commit failure or stalled)</dd>
              </div>
              <div v-if="!terminalState">
                <dt>Reveals</dt>
                <dd class="muted">Hidden until the game resolves or expires — both secrets become public knowledge in the on-chain sweep at that point.</dd>
              </div>
            </dl>
          </section>

          <!-- Transactions -->
          <section class="section">
            <h4>Transactions</h4>
            <dl class="tx-list">
              <div v-if="details.playerEscrow"><dt>Player escrow</dt><dd><TxLink :outpoint="details.playerEscrow" :network="network" /></dd></div>
              <div v-if="details.houseEscrow"><dt>House escrow</dt><dd><TxLink :outpoint="details.houseEscrow" :network="network" /></dd></div>
              <div v-if="details.resolveTxid"><dt>Sweep (resolve)</dt><dd><TxLink :outpoint="{ txid: details.resolveTxid }" :network="network" /></dd></div>
              <div v-if="details.houseRefundTxid"><dt>House refund</dt><dd><TxLink :outpoint="{ txid: details.houseRefundTxid }" :network="network" /></dd></div>
              <div v-if="!hasAnyTx" class="muted">No transactions recorded yet.</div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  </transition>
</template>

<script lang="ts">
import { defineComponent, PropType, ref, watch, computed } from 'vue'
import { getGameDetails, type GameDetailsResponse } from '@/services/api'
import { explorerTxUrl } from '@/utils/explorerUrl'
import { copyToClipboard } from '@/utils/clipboard'
import { getErrorMessage } from '@/utils/errors'

// Tiny inline components — keeping this file standalone since they're not
// reused elsewhere.
const CopyableHex = defineComponent({
  name: 'CopyableHex',
  props: { value: { type: String, required: true } },
  setup(props) {
    const copied = ref(false)
    async function copy() {
      const ok = await copyToClipboard(props.value)
      if (ok) { copied.value = true; setTimeout(() => { copied.value = false }, 1500) }
    }
    const short = computed(() => props.value.length > 24 ? `${props.value.slice(0, 10)}…${props.value.slice(-10)}` : props.value)
    return { copy, copied, short }
  },
  template: `
    <button class="hex-pill" @click="copy" :title="copied ? 'Copied!' : 'Click to copy'">
      <span class="mono hex-short">{{ short }}</span>
      <span class="hex-icon" :class="{ ok: copied }">{{ copied ? '✓' : '⧉' }}</span>
    </button>
  `,
})

const TxLink = defineComponent({
  name: 'TxLink',
  components: { CopyableHex },
  props: {
    outpoint: { type: Object as PropType<{ txid: string; vout?: number; value?: number }>, required: true },
    network: { type: String as PropType<string | null>, default: null },
  },
  computed: {
    url(): string | null { return explorerTxUrl(this.outpoint.txid, this.network) },
  },
  template: `
    <div class="tx-row">
      <CopyableHex :value="outpoint.txid" />
      <a v-if="url" :href="url" target="_blank" rel="noopener" class="explorer-link" title="Open in explorer">↗</a>
      <span v-if="outpoint.vout !== undefined" class="mono tx-meta">vout {{ outpoint.vout }}</span>
      <span v-if="outpoint.value !== undefined" class="mono tx-meta">{{ outpoint.value.toLocaleString() }} sats</span>
    </div>
  `,
})

export default defineComponent({
  name: 'GameDetailsModal',
  components: { CopyableHex, TxLink },
  props: {
    open: { type: Boolean, default: false },
    gameId: { type: String, default: '' },
    playerPubkey: { type: String, default: '' },
    network: { type: String as PropType<string | null>, default: null },
  },
  emits: ['close'],
  setup(props) {
    const details = ref<GameDetailsResponse | null>(null)
    const loading = ref(false)
    const error = ref<string | null>(null)

    async function reload() {
      if (!props.gameId) return
      if (!props.playerPubkey) {
        error.value = 'Wallet not connected — connect to view game details.'
        return
      }
      loading.value = true
      error.value = null
      try {
        details.value = await getGameDetails(props.gameId, props.playerPubkey)
      } catch (e) {
        const raw = getErrorMessage(e)
        // Server returns 404 + body `{"error":"Game not found"}` for BOTH
        // truly-missing IDs and pubkey-mismatch (auth shield). Surface a
        // friendlier message that hints at the most common cause for a
        // legitimate user clicking a row that fails: the game was created
        // on a different server deployment (DATA_DIR isn't the same as the
        // one that holds this game's row).
        if (/Game not found/i.test(raw)) {
          error.value =
            "This game's record isn't on the current server. It may have been " +
            'played against a different deployment, or the server data was reset.'
        } else {
          error.value = raw
        }
      } finally {
        loading.value = false
      }
    }

    watch(() => [props.open, props.gameId, props.playerPubkey], ([isOpen]) => {
      if (isOpen) { details.value = null; reload() }
    }, { immediate: true })

    const statusClass = computed(() => {
      const s = details.value?.status
      if (s === 'resolved') return details.value?.winner === 'player' ? 'badge-win' : 'badge-loss'
      if (s === 'expired') return 'badge-loss'
      return 'badge-pending'
    })
    const terminalState = computed(() => details.value?.status === 'resolved' || details.value?.status === 'expired')
    const potValue = computed(() => (details.value?.tier ?? 0) + (details.value?.houseStake ?? 0))
    const hasAnyTx = computed(() =>
      !!(details.value?.playerEscrow || details.value?.houseEscrow || details.value?.resolveTxid || details.value?.houseRefundTxid),
    )

    function formatSats(n: number | null | undefined): string {
      return (n ?? 0).toLocaleString()
    }
    function formatTime(unixSecs: number): string {
      const d = new Date(unixSecs * 1000)
      return `${d.toLocaleString()} (${unixSecs})`
    }

    return { details, loading, error, reload, statusClass, terminalState, potValue, hasAnyTx, formatSats, formatTime }
  },
})
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  /* Above the history drawer (z-index 300). Layered children: history → details. */
  z-index: 400;
}
.modal-card {
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  padding: 22px 24px 28px;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.modal-head h3 { margin: 0; font-size: 1.1rem; }
.modal-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1.6rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}
.modal-close:hover { color: var(--text); }
.modal-loading, .modal-error { padding: 24px 8px; text-align: center; color: var(--text-dim); }
.error-msg { color: var(--red); margin-bottom: 10px; }
.retry { background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text); padding: 6px 14px; border-radius: 6px; cursor: pointer; }

.section { margin-bottom: 18px; }
.section h4 { margin: 0 0 8px; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; color: var(--text); }
.section dl { display: flex; flex-direction: column; gap: 8px; margin: 0; }
.section dl > div { display: grid; grid-template-columns: 130px 1fr; gap: 12px; align-items: center; }
.section dt { font-size: 0.78rem; color: var(--text-muted); }
.section dd { margin: 0; font-size: 0.85rem; color: var(--text); min-width: 0; }
.section dd.muted { color: var(--text-muted); font-size: 0.78rem; line-height: 1.4; }
.section dd.mono { font-family: var(--font-mono); font-size: 0.8rem; }

.badge {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 6px;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.badge-win { background: rgba(52, 211, 153, 0.10); color: var(--green); }
.badge-loss { background: rgba(248, 113, 113, 0.10); color: var(--red); }
.badge-pending { background: rgba(56, 189, 248, 0.10); color: var(--blue); }

/* Copyable hex pill */
.hex-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--text-dim);
  font-family: inherit;
  max-width: 100%;
}
.hex-pill:hover { border-color: var(--gold); color: var(--text); }
.hex-short { font-size: 0.75rem; word-break: break-all; }
.hex-icon { font-size: 0.85rem; color: var(--text-muted); }
.hex-icon.ok { color: var(--green); }

/* Tx list */
.tx-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.explorer-link {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  color: var(--blue);
  text-decoration: none;
  font-size: 0.85rem;
}
.explorer-link:hover { border-color: var(--blue); }
.tx-meta { font-size: 0.72rem; color: var(--text-muted); }

@media (max-width: 480px) {
  .modal-card { padding: 18px 16px 24px; }
  .section dl > div { grid-template-columns: 100px 1fr; gap: 8px; }
}

/* Transition */
.modal-fade-enter-active, .modal-fade-leave-active { transition: opacity 0.18s; }
.modal-fade-enter-from, .modal-fade-leave-to { opacity: 0; }
</style>
