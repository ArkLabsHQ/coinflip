<template>
  <div class="rocket-skin" :class="gaugeClass">
    <div class="gauge">
      <!-- The flight. Altitude is log(multiplier) so 1×–100× is legible in one
           view; the dashed line is the multiplier the player locked. During the
           reveal the rocket climbs to the multiplier the chain actually rolled,
           so a bust below the line is visibly a bust below the line. -->
      <svg v-if="showFlight" class="flight" viewBox="0 0 100 60" preserveAspectRatio="none">
        <path v-if="flightPath" class="flight-trail" :d="flightPath" />
        <!-- Drawn AFTER the trail: this is the player's line and it must stay
             readable where the rocket crosses it, not get painted over. -->
        <line class="flight-lock" x1="6" :y1="lockedY" x2="94" :y2="lockedY" />
        <circle v-if="!busted" class="flight-head" :cx="headX" :cy="headY" r="1.6" />
        <circle v-if="busted" class="flight-boom" :cx="headX" :cy="headY" r="2.2" />
      </svg>
      <div class="gauge-mult mono">{{ gaugeText }}</div>
      <div class="gauge-sub">{{ gaugeSub }}</div>
      <!-- Chosen cash-out alongside the outcome — visible from the moment the
           bet is committed (no mid-game cash-out) through the revealed result. -->
      <div v-if="showReadout" class="gauge-readout">
        <span class="ro-chosen mono">YOU {{ lockedMult.toFixed(2) }}×</span>
        <span class="ro-arrow">→</span>
        <span class="ro-result mono" :class="resultClass">{{ resultText }}</span>
      </div>
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
        :class="{ armed: canLockIn }"
        :disabled="!canLockIn"
        @click="onLockIn"
      >
        LOCK IN @ {{ displayMult.toFixed(2) }}×
        <span v-if="cashoutSats !== null" class="rocket-cashout-sats mono">
          {{ cashoutSats.toLocaleString() }} sats
        </span>
      </button>

      <div v-else-if="state.phase === 'settling' || state.phase === 'flipping'" class="rocket-settling">
        <span class="settling-label">LOCKED IN @ {{ lockedMult.toFixed(2) }}×</span>
        <span class="settling-dots"><i></i><i></i><i></i></span>
      </div>
    </div>

    <!-- The cost of nerve, made visible: holding for a bigger multiplier drains
         the win chance. That trade IS this beat — without it on screen the climb
         reads as a countdown with no stakes. -->
    <div v-if="state.phase === 'climbing'" class="rocket-hint">
      <span v-if="!canLockIn">arming at {{ minMult.toFixed(2) }}×…</span>
      <template v-else>
        <span class="hint-odds" :class="{ thin: liveWinPct < 20 }">{{ liveWinPct.toFixed(0) }}% to land</span>
        <span class="hint-sep">·</span>
        <span>auto-locks at {{ targetMult.toFixed(2) }}×</span>
      </template>
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
    const canLockIn = computed(() => props.state.phase === 'climbing' && displayMult.value >= minMult.value)
    /** Win chance at the multiplier currently on the dial — drains as you hold. */
    const liveWinPct = computed(() => (liveWin.value / ROCKET_ODDS_N) * 100)
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

    function onLockIn() {
      if (!canLockIn.value) return
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
    onUnmounted(() => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (flightRaf !== null) cancelAnimationFrame(flightRaf)
    })

    // The multiplier the rocket actually reached, derived from the revealed
    // roll. roll = lo is exactly the player's locked multiplier (the boundary):
    // roll > lo → reached higher (win), roll < lo → crashed early (loss). So
    // this single value is the "target"/outcome the chosen cash-out is measured
    // against — shown alongside the player's pick so the result is legible.
    const crashMult = computed<number | null>(() => {
      const roll = props.state.outcome?.roll
      if (roll == null) return null
      return ROCKET_ODDS_N / Math.max(1, ROCKET_ODDS_N - roll)
    })
    // ── The flight ────────────────────────────────────────────────────
    // The roll is committed on-chain and revealed only at settlement, so the
    // client cannot know the bust point while the player is choosing. The
    // flight is therefore a REPLAY of a settled outcome — the same thing the
    // dice and roulette skins do — but it is the real one: the rocket climbs to
    // the multiplier the chain actually rolled and dies there.
    const flightMult = ref(1)
    const busted = ref(false)
    const flightPts = ref<Array<[number, number]>>([])
    let flightRaf: number | null = null

    /** Top of the altitude axis — always leaves headroom above both lines. */
    const scaleTop = computed(() =>
      Math.max(2, (crashMult.value ?? lockedMult.value) * 1.25, lockedMult.value * 1.25),
    )
    // The plot is inset inside the card's 20px border radius. Drawing to the
    // raw viewBox edges puts the launch point (x≈0, altitude(1)≈bottom) right
    // in the clipped corner, so the trail visibly starts outside the box.
    const PAD_X = 9
    const Y_BOTTOM = 50
    const Y_TOP = 9

    /** Altitude is logarithmic so 1× and 100× are legible on one axis. */
    function altitude(m: number): number {
      const t = Math.log(Math.max(1, m)) / Math.log(scaleTop.value)
      return Y_BOTTOM - Math.min(1, t) * (Y_BOTTOM - Y_TOP)
    }
    /** Horizontal position for flight progress p∈[0,1], inset from both edges. */
    function abscissa(p: number): number {
      return PAD_X + p * (100 - 2 * PAD_X)
    }
    const lockedY = computed(() => altitude(lockedMult.value))
    const headX = computed(() => (flightPts.value.length ? flightPts.value[flightPts.value.length - 1][0] : 0))
    const headY = computed(() => (flightPts.value.length ? flightPts.value[flightPts.value.length - 1][1] : altitude(1)))
    const flightPath = computed(() =>
      flightPts.value.length < 2 ? '' : 'M' + flightPts.value.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L'),
    )
    const showFlight = computed(() =>
      props.state.phase === 'resolved' && crashMult.value != null && flightPts.value.length > 0,
    )
    /**
     * True while the rocket is still climbing toward its (already-settled) bust
     * point. Everything that reveals the outcome — the number, the verdict
     * readout, the win/lose colouring — is suppressed until this goes false.
     * Printing the result at the START of the flight makes the animation a
     * replay of an answer you have already read, which is worse than no
     * animation at all.
     */
    const flying = computed(() => showFlight.value && !busted.value)

    function runFlight(bust: number) {
      if (flightRaf !== null) cancelAnimationFrame(flightRaf)
      flightPts.value = []
      busted.value = false
      flightMult.value = 1
      // Duration tracks the outcome, so rounds stop feeling identical: a 1.08×
      // bust is over in ~0.4s (brutal), a 12× climb takes ~4s (agonising).
      const duration = Math.min(4000, 350 + Math.log(Math.max(1.01, bust)) * 1100)
      const t0 = performance.now()
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / duration)
        // Ease-in hard: the rocket hugs the floor, then rips. On a log altitude
        // axis a gentle ease still draws a near-straight diagonal — which reads
        // as a progress bar, not a launch. 2.6 gives it a real hockey stick.
        const eased = Math.pow(p, 2.2)
        flightMult.value = Math.pow(bust, eased)
        flightPts.value.push([abscissa(p), altitude(flightMult.value)])
        if (p < 1) { flightRaf = requestAnimationFrame(step); return }
        flightRaf = null
        busted.value = true
      }
      flightRaf = requestAnimationFrame(step)
    }

    // Fly as soon as the chain reveals where it actually busted; clear the old
    // trail the moment a new round starts (LAUNCH AGAIN goes straight to
    // `climbing`, never back through `idle`, so both have to reset it).
    watch(() => [props.state.phase, crashMult.value] as const, ([phase, bust]) => {
      if (phase === 'resolved' && typeof bust === 'number') { runFlight(bust); return }
      if (phase === 'idle' || phase === 'climbing') {
        if (flightRaf !== null) { cancelAnimationFrame(flightRaf); flightRaf = null }
        flightPts.value = []
        busted.value = false
        flightMult.value = 1
      }
    })

    // Readout (chosen vs. outcome) shows from cash-out through the result —
    // you can't cash out once it's committed, so keep both numbers on screen.
    const showReadout = computed(() =>
      props.state.phase === 'settling' || props.state.phase === 'flipping' ||
      (props.state.phase === 'resolved' && !flying.value),
    )
    const resultText = computed(() => {
      if (props.state.phase === 'settling' || props.state.phase === 'flipping') return 'resolving…'
      if (props.state.phase === 'resolved') {
        if (crashMult.value != null) {
          return `${props.state.outcome?.won ? 'reached' : 'crashed'} ${crashMult.value.toFixed(2)}×`
        }
        return props.state.outcome?.won ? 'won' : 'lost'
      }
      return ''
    })
    const resultClass = computed(() => {
      if (props.state.phase === 'resolved') return props.state.outcome?.won ? 'won' : 'lost'
      return 'pending'
    })

    // ── Gauge presentation ────────────────────────────────────────────
    const gaugeClass = computed(() => {
      if (props.state.phase === 'climbing') return 'climbing'
      if (props.state.phase === 'settling' || props.state.phase === 'flipping') return 'settling'
      // Stay neutral while the rocket is still in the air. This one class drives
      // the card border, the number colour AND the trail stroke, so returning
      // won/lost here paints the answer on screen before the flight lands.
      if (props.state.phase === 'resolved') {
        if (flying.value) return 'climbing'
        return props.state.outcome?.won ? 'won' : 'lost'
      }
      return 'idle'
    })
    const gaugeText = computed(() => {
      if (props.state.phase === 'climbing') return `${displayMult.value.toFixed(2)}×`
      if (props.state.phase === 'settling' || props.state.phase === 'flipping') return `${lockedMult.value.toFixed(2)}×`
      // Mid-flight: the live altitude, ticking up. The player watches this climb
      // toward their line without knowing where it stops.
      if (flying.value) return `${flightMult.value.toFixed(2)}×`
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
      if (flying.value) return 'IN FLIGHT…'
      if (props.state.phase === 'resolved') return props.state.outcome?.won ? 'cashed out' : 'crashed'
      return 'launch when ready'
    })

    return {
      gaugeClass, gaugeText, gaugeSub,
      displayMult, lockedMult, minMult, targetMult, cashoutSats,
      showReadout, resultText, resultClass,
      canLaunch, canLockIn, liveWinPct,
      onLaunch, onLockIn,
      showFlight, flightPath, lockedY, headX, headY, busted,
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
/* The flight sits behind the readout so the number stays the focal point and
   the trajectory reads as context, not decoration competing with it. */
.flight {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
/* NB: `vector-effect: non-scaling-stroke` makes stroke-width SCREEN pixels, not
   viewBox units — sub-pixel values render invisible. These are px. */
.flight-lock {
  stroke: var(--gold, #ffd700);
  stroke-width: 2.5;
  stroke-dasharray: 6 4;
  opacity: 1;
  vector-effect: non-scaling-stroke;
  filter: drop-shadow(0 0 3px rgba(0, 0, 0, 0.9));
}
.flight-trail {
  fill: none;
  stroke: var(--blue, #38bdf8);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
  opacity: 1;
  filter: drop-shadow(0 0 4px currentColor);
}
.rocket-skin.lost .flight-trail { stroke: var(--red, #ff4444); }
.rocket-skin.won .flight-trail { stroke: var(--green, #00ff88); }
.flight-head {
  fill: #fff;
  filter: drop-shadow(0 0 3px var(--blue, #38bdf8));
}
.flight-boom {
  fill: var(--red, #ff4444);
  animation: boom 0.45s ease-out forwards;
}
.rocket-skin.won .flight-boom { fill: var(--green, #00ff88); }
@keyframes boom {
  0%   { r: 1.6; opacity: 1; }
  60%  { r: 5;   opacity: 0.55; }
  100% { r: 7;   opacity: 0; }
}

/* The readout sits over the trajectory, so it needs its own ground to stand on
   or the two just interfere with each other. */
.gauge-mult, .gauge-sub, .gauge-readout {
  position: relative;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.95), 0 0 4px rgba(0, 0, 0, 0.9);
}

.gauge {
  position: relative;
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
.rocket-skin.settling .gauge { border-color: var(--gold); animation: settleBreath 1.2s ease-in-out infinite; }
.rocket-skin.settling .gauge-mult { color: var(--gold); animation: climbPulse 0.9s ease-in-out infinite; }
@keyframes settleBreath {
  0%, 100% { box-shadow: 0 0 18px var(--gold-glow); }
  50%      { box-shadow: 0 0 36px rgba(247, 201, 72, 0.5), inset 0 0 32px rgba(247, 201, 72, 0.08); }
}
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

/* Chosen-vs-outcome readout under the gauge multiplier. */
.gauge-readout {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  margin-top: 6px; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.5px;
}
.ro-chosen { color: var(--text-muted); }
.ro-arrow { color: var(--text-dim, #6b6b80); }
.ro-result.pending { color: var(--gold); }
.ro-result.won { color: var(--green, #22c55e); }
.ro-result.lost { color: var(--red); }

/* Animated "resolving" state — keeps the panel alive while the server settles
   so the game never freezes between cash-out and result. */
.rocket-settling {
  color: var(--gold); font-weight: 700; letter-spacing: 2px; font-size: 0.78rem;
  display: flex; align-items: center; justify-content: center; gap: 10px;
}
.settling-dots { display: inline-flex; gap: 5px; }
.settling-dots i {
  width: 6px; height: 6px; border-radius: 50%; background: var(--gold);
  display: inline-block; animation: settleDot 1s ease-in-out infinite;
}
.settling-dots i:nth-child(2) { animation-delay: 0.16s; }
.settling-dots i:nth-child(3) { animation-delay: 0.32s; }
@keyframes settleDot {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50%      { opacity: 1; transform: translateY(-4px); }
}
.rocket-hint {
  font-size: 0.62rem; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted);
}
/* Win chance drains as the player holds — it turns red once the bet is a
   longshot, so the cost of nerve is felt, not just read. */
.hint-odds { color: var(--green, #00ff88); font-weight: 600; }
.hint-odds.thin { color: var(--red, #ff4444); }
.hint-sep { opacity: 0.4; margin: 0 5px; }
</style>
