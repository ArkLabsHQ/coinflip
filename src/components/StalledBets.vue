<template>
  <div v-if="bets.length" class="stalled">
    <div class="stalled-head">
      <span class="title">⚠ Reclaim stalled bets</span>
      <span class="sub">A game didn't resolve — reclaim your escrowed stake trustlessly. Auto-claims at expiry; manual buttons stay as a backup.</span>
    </div>
    <div v-for="b in bets" :key="b.gameId" class="bet-row">
      <!-- R1 forfeit, arkade-script path: execution bucket, no unilateral exit.
           Preferred when present (CSV penalty stays in stash as silent fallback). -->
      <template v-if="hasForfeit(b)">
        <div class="bet-info">
          <span class="amount penalty-amount">Claim full pot — {{ b.tier.toLocaleString() }} sats (your stake + house)</span>
          <span class="state" :class="{ ready: isForfeitReady(b), auto: isAutoClaiming(b) }">{{ forfeitStatusLabel(b) }}</span>
          <span class="penalty-note">The house didn't reveal its secret. Forfeit kicks in — you take everything.</span>
        </div>
        <div class="bet-actions">
          <button
            class="claim-btn"
            :disabled="!isForfeitReady(b) || isClaiming(b)"
            :title="isForfeitReady(b) ? '' : forfeitStatusLabel(b)"
            @click="claimForfeit(b.gameId)"
          >
            {{ claimBtnLabel(b, 'forfeit') }}
          </button>
          <button
            class="reclaim-link"
            :disabled="!isReady(b) || isClaiming(b)"
            :title="isReady(b) ? '' : statusLabel(b)"
            @click="reclaim(b.gameId)"
          >
            {{ claimBtnLabel(b, 'refund-link') }}
          </button>
        </div>
      </template>

      <!-- No forfeit stashed (pre-reveal abandonment): self-refund only -->
      <template v-else>
        <div class="bet-info">
          <span class="amount">{{ b.tier.toLocaleString() }} sats</span>
          <span class="state" :class="{ ready: isReady(b), auto: isAutoClaiming(b) }">{{ statusLabel(b) }}</span>
        </div>
        <button
          class="reclaim-btn"
          :disabled="!isReady(b) || isClaiming(b)"
          :title="isReady(b) ? '' : statusLabel(b)"
          @click="reclaim(b.gameId)"
        >
          {{ claimBtnLabel(b, 'refund') }}
        </button>
      </template>
    </div>
    <p v-if="message" class="msg">{{ message }}</p>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onUnmounted } from 'vue'
import { useStore } from 'vuex'
import type { StashedRefund, ClaimingInfo } from '@/store/modules/ark/ark'

export default defineComponent({
  name: 'StalledBets',
  setup() {
    const store = useStore()
    const bets = ref<StashedRefund[]>([])
    const message = ref('')
    // Store-backed in-flight map — populated by BOTH the manual buttons
    // here and the background auto-claim poll in the ark store. Reading
    // it (rather than a local `busy` ref) means a background tick that
    // fires between renders also disables this row, preventing a manual
    // click from racing the poll.
    const claimingGames = computed<Record<string, ClaimingInfo>>(
      () => store.getters['ark/claimingGames'] || {},
    )
    const isClaiming = (b: StashedRefund) => !!claimingGames.value[b.gameId]
    const isAutoClaiming = (b: StashedRefund) =>
      claimingGames.value[b.gameId]?.mode === 'auto'
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

    /** True when the stash has an arkade-script forfeit and the player has revealed. */
    const hasForfeit = (b: StashedRefund) =>
      b.revealed === true && !!b.forfeitPsbt && !!b.forfeitEmulatorUrl && b.forfeitClaimableAt !== undefined

    /** Forfeit claimable-at: absolute CLTV pinned in the leaf at /play time. */
    const forfeitClaimableAt = (b: StashedRefund): number => b.forfeitClaimableAt ?? Number.MAX_SAFE_INTEGER

    /** Self-refund readiness. */
    const isReady = (b: StashedRefund) => chainTime.value !== null && chainTime.value >= b.finalExpiration

    /** Forfeit readiness — chain time has reached the absolute CLTV. */
    const isForfeitReady = (b: StashedRefund) =>
      chainTime.value !== null && chainTime.value >= forfeitClaimableAt(b)

    function statusLabel(b: StashedRefund): string {
      if (isAutoClaiming(b)) return 'Auto-claiming…'
      if (chainTime.value === null) return 'Checking chain time…'
      if (isReady(b)) return 'Reclaimable now'
      const mins = Math.ceil((b.finalExpiration - chainTime.value) / 60)
      // Label as chain-time so a lagging regtest clock reads as expected, not a bug.
      return `Reclaimable in ~${mins} min (chain time)`
    }

    function forfeitStatusLabel(b: StashedRefund): string {
      if (isAutoClaiming(b)) return 'Auto-claiming…'
      if (chainTime.value === null) return 'Checking chain time…'
      if (isForfeitReady(b)) return 'Claimable now (arkade)'
      const at = forfeitClaimableAt(b)
      const mins = Math.ceil((at - chainTime.value) / 60)
      return `Claimable in ~${mins} min (arkade, chain time)`
    }

    /** Per-button label. `kind` distinguishes the three button slots so each gets a fitting verb. */
    function claimBtnLabel(b: StashedRefund, kind: 'forfeit' | 'refund' | 'refund-link'): string {
      const info = claimingGames.value[b.gameId]
      if (info) {
        if (info.mode === 'auto') return 'Auto-claiming…'
        return kind === 'forfeit' ? 'Claiming…' : 'Reclaiming…'
      }
      if (kind === 'forfeit') return 'Claim full pot'
      if (kind === 'refund-link') return 'Reclaim principal only'
      return 'Reclaim'
    }

    async function reclaim(gameId: string) {
      message.value = ''
      try {
        await store.dispatch('ark/reclaimStalledBet', { gameId, mode: 'manual' })
        message.value = 'Reclaimed — stake returned to your wallet.'
      } catch (e: unknown) {
        message.value = e instanceof Error ? e.message : 'Reclaim failed'
      } finally {
        await refresh()
      }
    }

    async function claimForfeit(gameId: string) {
      message.value = ''
      try {
        await store.dispatch('ark/claimForfeit', { gameId, mode: 'manual' })
        message.value = 'Full pot claimed via arkade — both stakes returned to your wallet.'
      } catch (e: unknown) {
        message.value = e instanceof Error ? e.message : 'Forfeit failed'
      } finally {
        await refresh()
      }
    }

    let listTimer: number | undefined
    onMounted(() => {
      refresh()
      refreshChainTime()
      // Track the chain tip for the CLTV countdown + claim readiness — but only
      // while there's actually a stalled bet (the panel only renders then), so
      // idle/no-stall sessions make zero /blocks/tip calls. 5s keeps it
      // responsive: chain time gates EVERY claim button, so a slow poll strands
      // them on "Checking chain time…" (and a failed first read on a cold wallet
      // would otherwise take a full cycle to recover).
      timer = window.setInterval(() => { if (bets.value.length) refreshChainTime() }, 5000)
      // Re-read the stash list periodically so an auto-claim that
      // succeeded in the background removes its row without the user
      // having to refresh. Cheap (localStorage read) so 5s is fine.
      listTimer = window.setInterval(refresh, 5000)
    })
    onUnmounted(() => {
      if (timer) window.clearInterval(timer)
      if (listTimer) window.clearInterval(listTimer)
    })

    return {
      bets, message,
      hasForfeit, isReady, isForfeitReady,
      isClaiming, isAutoClaiming,
      statusLabel, forfeitStatusLabel, claimBtnLabel,
      reclaim, claimForfeit,
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
.bet-info .state.auto { color: var(--gold, #f7c948); font-style: italic; }
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
