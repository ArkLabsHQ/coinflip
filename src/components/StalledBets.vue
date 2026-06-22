<template>
  <div v-if="bets.length || v4Bets.length" class="stalled">
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
          <span class="penalty-note">{{ forfeitNote(b) }}</span>
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

    <!-- v0.4 joint-pot forfeits: the whole pot via the playerForfeit leaf. No
         self-refund split — v4 funds a single joint pot, so it's pot-or-nothing. -->
    <div v-for="b in v4Bets" :key="b.gameId" class="bet-row">
      <div class="bet-info">
        <span class="amount penalty-amount">Claim full pot — {{ b.potOutpoint.value.toLocaleString() }} sats (your stake + house)</span>
        <span class="state" :class="{ ready: isV4Ready(b), auto: isV4AutoClaiming(b) }">{{ v4StatusLabel(b) }}</span>
        <span class="penalty-note">{{ v4Note(b) }}</span>
      </div>
      <div class="bet-actions">
        <button
          class="claim-btn"
          :disabled="!isV4Ready(b) || isV4Claiming(b)"
          :title="isV4Ready(b) ? '' : v4StatusLabel(b)"
          @click="claimV4(b.gameId)"
        >
          {{ v4BtnLabel(b) }}
        </button>
      </div>
    </div>

    <p v-if="message" class="msg">{{ message }}</p>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onUnmounted } from 'vue'
import { useStore } from 'vuex'
import type { StashedRefund, ClaimingInfo } from '@/store/modules/ark/ark'
import { hasStashedForfeit } from '@/store/modules/ark/forfeitStash'
import type { StashedV4Forfeit } from '@/store/modules/ark/v4ForfeitStash'
import { isCltvMatured } from '@/utils/cltv'

export default defineComponent({
  name: 'StalledBets',
  setup() {
    const store = useStore()
    const bets = ref<StashedRefund[]>([])
    const v4Bets = ref<StashedV4Forfeit[]>([])
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
      v4Bets.value = await store.dispatch('ark/listV4StalledBets')
    }
    async function refreshChainTime() {
      const t = await store.dispatch('ark/getChainTipTime')
      if (typeof t === 'number') chainTime.value = t
    }

    /** True when the stash holds a complete, revealed arkade-script forfeit.
     *  Single source of truth shared with the store's claimForfeit guard and
     *  the background auto-claim poll (see forfeitStash.hasStashedForfeit). */
    const hasForfeit = (b: StashedRefund) => hasStashedForfeit(b)

    /** Forfeit claimable-at: absolute CLTV pinned in the leaf at /play time. */
    const forfeitClaimableAt = (b: StashedRefund): number => b.forfeitClaimableAt ?? Number.MAX_SAFE_INTEGER

    /** Self-refund readiness — chain time has reached the refund CLTV. */
    const isReady = (b: StashedRefund) => isCltvMatured(chainTime.value, b.finalExpiration)

    /** Forfeit readiness — chain time has reached the absolute forfeit CLTV. */
    const isForfeitReady = (b: StashedRefund) => isCltvMatured(chainTime.value, forfeitClaimableAt(b))

    function statusLabel(b: StashedRefund): string {
      if (isAutoClaiming(b)) return 'Auto-claiming…'
      if (chainTime.value === null) return 'Checking chain time…'
      if (isReady(b)) return 'Reclaimable now'
      const mins = Math.ceil((b.finalExpiration - chainTime.value) / 60)
      // Label as chain-time so a lagging regtest clock reads as expected, not a bug.
      return `Reclaimable in ~${mins} min (chain time)`
    }

    /**
     * CLTV-aware forfeit note. Before the forfeit is claimable a stalled game is
     * almost always just settling (the operator finishes it autonomously), so we
     * stay calm and frame the forfeit as the trustless backup. Once the CLTV is
     * reached and the forfeit is genuinely claimable, we explain the take-the-pot
     * outcome.
     */
    function forfeitNote(b: StashedRefund): string {
      return isForfeitReady(b)
        ? 'The house never revealed its secret. Forfeit kicks in — you take the whole pot.'
        : 'Settling — the operator completes this automatically, usually within a minute. This is your trustless backup if it stalls.'
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

    // ── v0.4 joint-pot forfeit row (whole pot, client-built claim) ──────────
    const isV4Claiming = (b: StashedV4Forfeit) => !!claimingGames.value[b.gameId]
    const isV4AutoClaiming = (b: StashedV4Forfeit) => claimingGames.value[b.gameId]?.mode === 'auto'
    // Stage 1 (publish the secret -> StageTwo) has no timelock, so it's always
    // available; stage 2 (sweep the whole pot) needs the CLTV at finalExpiration.
    const isV4Ready = (b: StashedV4Forfeit) =>
      !b.stageTwoOutpoint || isCltvMatured(chainTime.value, b.forfeitClaimableAt)

    function v4StatusLabel(b: StashedV4Forfeit): string {
      if (isV4AutoClaiming(b)) return 'Auto-claiming…'
      if (chainTime.value === null) return 'Checking chain time…'
      if (isV4Ready(b)) return b.stageTwoOutpoint ? 'Ready to sweep the pot' : 'Ready to contest the stall'
      const mins = Math.ceil((b.forfeitClaimableAt - chainTime.value) / 60)
      return `Sweepable in ~${mins} min (chain time)`
    }
    function v4Note(b: StashedV4Forfeit): string {
      if (b.stageTwoOutpoint) {
        return isV4Ready(b)
          ? 'Your secret is on-chain and the house never settled — sweep the whole pot to your wallet.'
          : 'Your secret is on-chain (contest open). The house should settle to the winner; if it keeps stalling, you sweep the whole pot after the timelock.'
      }
      return 'The server never settled. Publish your secret on-chain to contest, then sweep the whole pot if it keeps stalling.'
    }
    function v4BtnLabel(b: StashedV4Forfeit): string {
      const info = claimingGames.value[b.gameId]
      if (info) return info.mode === 'auto' ? 'Auto-claiming…' : 'Claiming…'
      return 'Claim full pot'
    }
    async function claimV4(gameId: string) {
      message.value = ''
      try {
        await store.dispatch('ark/claimV4Forfeit', { gameId, mode: 'manual' })
        message.value = 'Recovery step submitted — the whole pot returns to your wallet once the staged forfeit completes.'
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
      timer = window.setInterval(() => { if (bets.value.length || v4Bets.value.length) refreshChainTime() }, 5000)
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
      statusLabel, forfeitStatusLabel, forfeitNote, claimBtnLabel,
      reclaim, claimForfeit,
      v4Bets, isV4Claiming, isV4AutoClaiming, isV4Ready,
      v4StatusLabel, v4Note, v4BtnLabel, claimV4,
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
