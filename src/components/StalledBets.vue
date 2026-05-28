<template>
  <div v-if="bets.length" class="stalled">
    <div class="stalled-head">
      <span class="title">⚠ Reclaim stalled bets</span>
      <span class="sub">A game didn't resolve — reclaim your escrowed stake trustlessly.</span>
    </div>
    <div v-for="b in bets" :key="b.gameId" class="bet-row">
      <!-- R1 forfeit: player revealed, server withheld — penalty path is primary -->
      <template v-if="hasPenalty(b)">
        <div class="bet-info">
          <span class="amount penalty-amount">Claim full pot — {{ b.tier.toLocaleString() }} sats (your stake + house)</span>
          <span class="state" :class="{ ready: isPenaltyReady(b) }">{{ penaltyStatusLabel(b) }}</span>
          <span class="penalty-note">The house didn't reveal its secret. Forfeit kicks in — you take everything.</span>
        </div>
        <div class="bet-actions">
          <button
            class="claim-btn"
            :disabled="!isPenaltyReady(b) || busy === b.gameId"
            @click="claimPenalty(b.gameId)"
          >
            {{ busy === b.gameId ? 'Claiming…' : 'Claim full pot' }}
          </button>
          <button
            class="reclaim-link"
            :disabled="!isReady(b) || busy === b.gameId"
            @click="reclaim(b.gameId)"
          >
            {{ busy === b.gameId ? 'Reclaiming…' : 'Reclaim principal only' }}
          </button>
        </div>
      </template>

      <!-- No penalty: game abandoned before reveal — self-refund only -->
      <template v-else>
        <div class="bet-info">
          <span class="amount">{{ b.tier.toLocaleString() }} sats</span>
          <span class="state" :class="{ ready: isReady(b) }">{{ statusLabel(b) }}</span>
        </div>
        <button
          class="reclaim-btn"
          :disabled="!isReady(b) || busy === b.gameId"
          @click="reclaim(b.gameId)"
        >
          {{ busy === b.gameId ? 'Reclaiming…' : 'Reclaim' }}
        </button>
      </template>
    </div>
    <p v-if="message" class="msg">{{ message }}</p>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onUnmounted } from 'vue'
import { useStore } from 'vuex'
import type { StashedRefund } from '@/store/modules/ark/ark'

export default defineComponent({
  name: 'StalledBets',
  setup() {
    const store = useStore()
    const bets = ref<StashedRefund[]>([])
    const busy = ref<string | null>(null)
    const message = ref('')
    // arkd releases the refund at its CLTV measured in the chain's block time
    // (BIP113 MTP), which lags wall-clock when blocks are sparse. Gate readiness
    // STRICTLY on chain time — never a wall-clock fallback, which would flash
    // "Reclaimable now" before the first chain read and invite a click arkd then
    // rejects with FORFEIT_CLOSURE_LOCKED. Until chain time is known we show
    // "Checking…" and keep the button disabled; the action backstops either way.
    const chainTime = ref<number | null>(null)
    let timer: number | undefined

    async function refresh() {
      bets.value = await store.dispatch('ark/listStalledBets')
    }
    async function refreshChainTime() {
      const t = await store.dispatch('ark/getChainTipTime')
      if (typeof t === 'number') chainTime.value = t
    }

    /** True when the stash has a penalty and the player has revealed. */
    const hasPenalty = (b: StashedRefund) =>
      b.revealed === true && !!b.penaltyPsbt && b.penaltyTimelockSeconds !== undefined

    /** Penalty claimable-at: createdAt is an upper-bound proxy for escrow confirmation. */
    const penaltyClaimableAt = (b: StashedRefund): number =>
      Math.floor(b.createdAt / 1000) + (b.penaltyTimelockSeconds ?? 0)

    /** Self-refund readiness (unchanged R4 logic). */
    const isReady = (b: StashedRefund) => chainTime.value !== null && chainTime.value >= b.finalExpiration

    /** Penalty readiness — mirrors R4 gating but uses penaltyClaimableAt. */
    const isPenaltyReady = (b: StashedRefund) =>
      chainTime.value !== null && chainTime.value >= penaltyClaimableAt(b)

    function statusLabel(b: StashedRefund): string {
      if (chainTime.value === null) return 'Checking chain time…'
      if (isReady(b)) return 'Reclaimable now'
      const mins = Math.ceil((b.finalExpiration - chainTime.value) / 60)
      // Label as chain-time so a lagging regtest clock reads as expected, not a bug.
      return `Reclaimable in ~${mins} min (chain time)`
    }

    function penaltyStatusLabel(b: StashedRefund): string {
      if (chainTime.value === null) return 'Checking chain time…'
      if (isPenaltyReady(b)) return 'Claimable now'
      const at = penaltyClaimableAt(b)
      const mins = Math.ceil((at - chainTime.value) / 60)
      return `Claimable in ~${mins} min (chain time)`
    }

    async function reclaim(gameId: string) {
      busy.value = gameId
      message.value = ''
      try {
        await store.dispatch('ark/reclaimStalledBet', gameId)
        message.value = 'Reclaimed — stake returned to your wallet.'
      } catch (e: unknown) {
        message.value = e instanceof Error ? e.message : 'Reclaim failed'
      } finally {
        busy.value = null
        await refresh()
      }
    }

    async function claimPenalty(gameId: string) {
      busy.value = gameId
      message.value = ''
      try {
        await store.dispatch('ark/claimPenalty', gameId)
        message.value = 'Full pot claimed — both stakes returned to your wallet.'
      } catch (e: unknown) {
        message.value = e instanceof Error ? e.message : 'Claim failed'
      } finally {
        busy.value = null
        await refresh()
      }
    }

    onMounted(() => {
      refresh()
      refreshChainTime()
      // Poll so "Checking…" clears soon after the wallet connects and the
      // countdown tracks the chain as blocks are mined.
      timer = window.setInterval(refreshChainTime, 5000)
    })
    onUnmounted(() => { if (timer) window.clearInterval(timer) })

    return {
      bets, busy, message,
      hasPenalty, isReady, isPenaltyReady,
      statusLabel, penaltyStatusLabel,
      reclaim, claimPenalty,
    }
  },
})
</script>

<style lang="scss" scoped>
.stalled {
  background: var(--bg-card, #111119);
  border: 1px solid var(--red, #f87171);
  border-radius: var(--radius, 14px);
  padding: 16px;
  margin: 16px 0;
}
.stalled-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; }
.stalled-head .title { color: var(--red, #f87171); font-weight: 600; font-size: 0.9rem; }
.stalled-head .sub { color: var(--text-dim, #a0a0b8); font-size: 0.75rem; }
.bet-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 0; border-top: 1px solid rgba(255, 255, 255, 0.05);
}
.bet-info { display: flex; flex-direction: column; gap: 2px; }
.bet-info .amount { font-weight: 600; color: var(--text, #eeeef4); }
.bet-info .penalty-amount { color: var(--green, #34d399); font-size: 0.95rem; }
.bet-info .state { font-size: 0.72rem; color: var(--text-muted, #5c5c78); }
.bet-info .state.ready { color: var(--green, #34d399); }
.bet-info .penalty-note { font-size: 0.70rem; color: var(--text-dim, #a0a0b8); margin-top: 2px; }
.bet-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.reclaim-btn {
  background: var(--gold, #f7c948); color: #08080d; border: none;
  border-radius: 8px; padding: 6px 16px; font-weight: 600; cursor: pointer;
}
.reclaim-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.claim-btn {
  background: var(--green, #34d399); color: #08080d; border: none;
  border-radius: 8px; padding: 6px 18px; font-weight: 700; cursor: pointer;
  font-size: 0.9rem;
}
.claim-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.reclaim-link {
  background: none; border: none; color: var(--text-dim, #a0a0b8);
  font-size: 0.72rem; cursor: pointer; padding: 2px 4px; text-decoration: underline;
}
.reclaim-link:disabled { opacity: 0.45; cursor: not-allowed; }
.msg { margin-top: 10px; font-size: 0.78rem; color: var(--text-dim, #a0a0b8); }
</style>
