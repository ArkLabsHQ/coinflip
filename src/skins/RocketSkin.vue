<template>
  <div class="rocket-skin" :class="gaugeClass">
    <div class="gauge">
      <div class="gauge-mult mono">{{ gaugeText }}</div>
      <div class="gauge-sub">{{ gaugeSub }}</div>
    </div>

    <div class="rocket-controls">
      <button
        v-if="state.phase === 'idle' || state.phase === 'resolved'"
        class="rocket-btn launch"
        :disabled="!canLaunch"
        @click="onLaunch"
      >
        {{ state.phase === 'resolved' ? 'LAUNCH AGAIN' : 'LAUNCH 🚀' }}
      </button>

      <button
        v-else-if="state.phase === 'climbing'"
        class="rocket-btn cashout"
        :class="{ armed: canCashOut }"
        :disabled="!canCashOut"
        @click="onCashOut"
      >
        CASH OUT @ {{ displayMult.toFixed(2) }}×
        <span v-if="cashoutSats !== null" class="rocket-cashout-sats mono">
          {{ cashoutSats.toLocaleString() }} sats
        </span>
      </button>

      <div v-else-if="state.phase === 'settling' || state.phase === 'flipping'" class="rocket-settling">
        LOCKING IN @ {{ lockedMult.toFixed(2) }}×
      </div>
    </div>

    <div v-if="state.phase === 'climbing'" class="rocket-hint">
      <span v-if="!canCashOut">arming at {{ minMult.toFixed(2) }}×…</span>
      <span v-else-if="state.odds">auto cash-out at {{ targetMult.toFixed(2) }}×</span>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, onUnmounted, type PropType } from 'vue'
import type { SkinState, OddsBet } from './types'
import { ROCKET_ODDS_N, rocketHouseStake } from '@/rocket'

const CLIMB_RATE = 0.18 // exp(rate·t): reaches ~2× in 3.9s, ~10× in 12.8s

export default defineComponent({
  name: 'RocketSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
    /** Player's bet size in sats — needed for the live cashout-sats readout. */
    tier: { type: Number as PropType<number | null>, default: null },
    /** Per-leg house-edge bps — for cashout sats math (mirror server's edge). */
    oddsEdgeBps: { type: Number, default: 300 },
    /**
     * House dust threshold (sats). Cash-out is disabled below the multiplier
     * whose house stake clears this floor, so a committed bet can never be
     * sub-dust (which the server / on-chain escrow would reject).
     */
    dust: { type: Number, default: 546 },
  },
  emits: {
    launch: () => true,
    cashout: (bet: OddsBet) => bet.n > 0 && bet.target > bet.lo && bet.lo >= 0,
  },
  setup(props, { emit }) {
    const rawMult = ref(1)
    const lockedWin = ref(1)
    const lockedMult = ref(1)
    let rafId: number | null = null
    let climbStart = 0

    /** Integer winning-roll count for a target M, snapped to an achievable threshold. */
    function winForMult(m: number): number {
      return Math.min(ROCKET_ODDS_N - 1, Math.max(1, Math.round(ROCKET_ODDS_N / m)))
    }

    /** Achievable threshold for an OddsBet's lo (range = [lo, n) → win = n - lo). */
    function multForBet(b: OddsBet): number {
      const win = b.target - b.lo
      return win > 0 ? b.n / win : Infinity
    }

    // The parent's slider position is the auto-cashout TARGET.
    const targetBet = computed<OddsBet | null>(() => props.state.odds)
    const targetMult = computed(() => (targetBet.value ? multForBet(targetBet.value) : Infinity))
    // Snap the continuous climb to an integer winning-roll count so the cashout
    // band is byte-equal to the on-chain commit.
    const liveWin = computed(() =>
      Math.min(ROCKET_ODDS_N - 1, Math.max(1, Math.floor(ROCKET_ODDS_N / Math.min(rawMult.value, ROCKET_ODDS_N)))),
    )
    const displayMult = computed(() => ROCKET_ODDS_N / liveWin.value)
    // Lowest multiplier the player may cash out at. The house stake at a
    // multiplier M is exactly floor(tier·(M−1)·(1−edge)); since dust is an
    // integer, floor(x) ≥ dust ⟺ x ≥ dust, so this threshold is the EXACT
    // dust-safe floor (not an approximation). Below it the CASH OUT button stays
    // disabled, so a manual cash-out can never commit a sub-dust house side.
    const minMult = computed(() => {
      const tier = props.tier
      if (!tier) return 1.01
      const dustSafe = 1 + props.dust / (tier * (1 - props.oddsEdgeBps / 10000))
      return Math.max(1.01, dustSafe)
    })
    const canCashOut = computed(() => props.state.phase === 'climbing' && displayMult.value >= minMult.value)
    const canLaunch = computed(() => targetBet.value !== null && (props.state.phase === 'idle' || props.state.phase === 'resolved'))

    /** Live cashout sats = tier + houseStakeForCurrentWin (mirrors PlayView's math). */
    const cashoutSats = computed<number | null>(() => {
      if (!props.tier || !targetBet.value) return null
      // rocketHouseStake takes RocketOdds {oddsN, oddsTarget, oddsLo} —
      // remap from the skin's OddsBet {n, target, lo} field names.
      const n = targetBet.value.n
      const lo = n - liveWin.value
      return props.tier + rocketHouseStake(props.tier, { oddsN: n, oddsTarget: n, oddsLo: lo }, props.oddsEdgeBps)
    })

    function tick(now: number) {
      rawMult.value = Math.exp(CLIMB_RATE * ((now - climbStart) / 1000))
      // Auto cash-out the moment the snapped display reaches the chosen ceiling.
      if (displayMult.value >= targetMult.value) {
        commitCashOut(true)
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    function onLaunch() {
      if (!canLaunch.value) return
      rawMult.value = 1
      climbStart = performance.now()
      emit('launch')
      rafId = requestAnimationFrame(tick)
    }

    function onCashOut() {
      if (!canCashOut.value) return
      commitCashOut(false)
    }

    function commitCashOut(isAuto: boolean) {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
      const bet = targetBet.value
      if (!bet) return
      // Auto fires at the target; manual locks the current display.
      lockedWin.value = isAuto ? winForMult(targetMult.value) : liveWin.value
      lockedMult.value = ROCKET_ODDS_N / lockedWin.value
      // Build the bet committed to chain — same n/target as parent's slider,
      // lo = n − lockedWin so the win band is exactly [lo, n).
      emit('cashout', { n: bet.n, lo: bet.n - lockedWin.value, target: bet.n })
    }

    // Reset the rocket when a new game starts (parent transitions phase to idle).
    watch(() => props.state.phase, (p) => {
      if (p === 'idle') {
        rawMult.value = 1
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
      }
    })
    onUnmounted(() => { if (rafId !== null) cancelAnimationFrame(rafId) })

    // ── Gauge presentation ────────────────────────────────────────────
    const gaugeClass = computed(() => {
      if (props.state.phase === 'climbing') return 'climbing'
      if (props.state.phase === 'settling' || props.state.phase === 'flipping') return 'settling'
      if (props.state.phase === 'resolved') return props.state.outcome?.won ? 'won' : 'lost'
      return 'idle'
    })
    const gaugeText = computed(() => {
      if (props.state.phase === 'climbing') return `${displayMult.value.toFixed(2)}×`
      if (props.state.phase === 'settling' || props.state.phase === 'flipping') return `${lockedMult.value.toFixed(2)}×`
      if (props.state.phase === 'resolved' && props.state.outcome) {
        if (props.state.outcome.won) return `${lockedMult.value.toFixed(2)}×`
        // Lost — show the revealed crash point.
        if (props.state.outcome.roll != null) {
          const c = ROCKET_ODDS_N / Math.max(1, ROCKET_ODDS_N - props.state.outcome.roll)
          return `${c.toFixed(2)}×`
        }
        return '—'
      }
      return '1.00×'
    })
    const gaugeSub = computed(() => {
      if (props.state.phase === 'climbing') return 'HOLDING…'
      if (props.state.phase === 'settling' || props.state.phase === 'flipping') return 'locking in'
      if (props.state.phase === 'resolved') return props.state.outcome?.won ? 'cashed out' : 'crashed'
      return 'launch when ready'
    })

    return {
      gaugeClass, gaugeText, gaugeSub,
      displayMult, lockedMult, minMult, targetMult, cashoutSats,
      canLaunch, canCashOut,
      onLaunch, onCashOut,
    }
  },
})
</script>

<style lang="scss" scoped>
.rocket-skin {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 100%;
}
.gauge {
  width: 100%;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 20px;
  border: 1.5px solid var(--border-light);
  background: radial-gradient(circle at 50% 120%, rgba(56, 189, 248, 0.08) 0%, transparent 65%), var(--bg-elevated);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.gauge-mult {
  font-size: 3.4rem;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 1px;
  font-family: ui-monospace, monospace;
  color: var(--text);
}
.gauge-sub {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--text-muted);
}
.rocket-skin.idle .gauge { opacity: 0.85; }
.rocket-skin.climbing .gauge {
  border-color: var(--blue, #38bdf8);
  box-shadow: 0 0 24px rgba(56, 189, 248, 0.25), inset 0 0 36px rgba(56, 189, 248, 0.06);
}
.rocket-skin.climbing .gauge-mult { color: var(--blue, #38bdf8); animation: climbPulse 0.9s ease-in-out infinite; }
.rocket-skin.settling .gauge { border-color: var(--gold); box-shadow: 0 0 22px var(--gold-glow); }
.rocket-skin.settling .gauge-mult { color: var(--gold); }
.rocket-skin.won .gauge {
  border-color: var(--green, #22c55e);
  box-shadow: 0 0 30px rgba(34, 197, 94, 0.4), inset 0 0 40px rgba(34, 197, 94, 0.08);
}
.rocket-skin.won .gauge-mult { color: var(--green, #22c55e); }
.rocket-skin.lost .gauge { border-color: var(--red); box-shadow: 0 0 24px rgba(239, 68, 68, 0.3); }
.rocket-skin.lost .gauge-mult { color: var(--red); animation: crashShake 0.4s ease; }

@keyframes climbPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
@keyframes crashShake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-8px) rotate(-2deg); }
  40% { transform: translateX(8px) rotate(2deg); }
  60% { transform: translateX(-5px); }
  80% { transform: translateX(5px); }
}

.rocket-controls {
  width: 100%;
  display: flex;
  justify-content: center;
}
.rocket-btn {
  width: 100%;
  max-width: 340px;
  border-radius: 12px;
  padding: 14px 24px;
  font-size: 1rem;
  font-weight: 800;
  letter-spacing: 2.5px;
  font-family: inherit;
  cursor: not-allowed;
  transition: all 0.2s;
  background: var(--bg-elevated);
  border: 2px solid var(--border-light);
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.rocket-btn.launch:enabled {
  border-color: var(--gold); color: var(--gold); cursor: pointer;
  background: rgba(247, 201, 72, 0.06); box-shadow: 0 0 16px var(--gold-glow);
}
.rocket-btn.launch:enabled:hover {
  background: linear-gradient(135deg, var(--gold) 0%, var(--gold-dim, #d4a91a) 100%);
  color: var(--bg, #08080d);
  box-shadow: 0 4px 24px var(--gold-glow);
  transform: translateY(-1px);
}
.rocket-btn.cashout.armed {
  cursor: pointer; border-color: var(--green, #22c55e); color: var(--green, #22c55e);
  background: rgba(34, 197, 94, 0.08); box-shadow: 0 0 18px rgba(34, 197, 94, 0.3);
  animation: cashoutPulse 1s ease-in-out infinite;
}
.rocket-btn.cashout.armed:hover { background: var(--green, #22c55e); color: var(--bg, #08080d); }
@keyframes cashoutPulse {
  0%, 100% { box-shadow: 0 0 18px rgba(34, 197, 94, 0.3); }
  50%      { box-shadow: 0 0 28px rgba(34, 197, 94, 0.55); }
}
.rocket-cashout-sats { font-size: 0.68rem; font-weight: 700; letter-spacing: 1px; opacity: 0.85; }
.rocket-settling { color: var(--gold); font-weight: 700; letter-spacing: 2px; font-size: 0.78rem; }
.rocket-hint {
  font-size: 0.62rem; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted);
}
</style>
