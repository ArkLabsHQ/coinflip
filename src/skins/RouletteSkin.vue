<template>
  <div class="roulette-skin">
    <!-- Wheel: 37 slots around the perimeter; the winning band is a single
         contiguous arc on the high side, the ball lands on the rolled slot.
         No fake red/black — slots inside the band are gold, outside are dim. -->
    <div class="wheel" :class="wheelClass">
      <div class="wheel-inner" :style="wheelStyle">
        <div
          v-for="i in n"
          :key="i - 1"
          class="slot"
          :class="{
            win: isInBand(i - 1),
            landed: phase === 'resolved' && roll === (i - 1),
            zero: i - 1 === 0,
          }"
          :style="slotStyle(i - 1)"
        >
          <span class="slot-num mono">{{ i - 1 }}</span>
        </div>
      </div>

      <!-- Pointer + centre live OUTSIDE wheel-inner so they don't rotate
           with the wheel. Pointer is fixed at 12 o'clock; centre stays
           upright so the rolled number is readable. -->
      <div class="pointer" />
      <div class="centre" :class="centreClass">
        <div class="centre-num mono">{{ centreText }}</div>
        <div class="centre-sub">{{ centreSub }}</div>
      </div>
    </div>

    <div class="band-readout">
      <span class="band-label">YOU WIN ON</span>
      <span class="band-range mono">{{ bandLabel }}</span>
      <span class="band-pct">{{ winPctLabel }}</span>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, type PropType } from 'vue'
import type { SkinState } from './types'

// One full revolution under the pointer takes WHEEL_SPIN_MS. We rotate by a
// fixed many-turn amount plus the angle to the landed slot, eased out, so the
// player sees a real-feeling spin even though the outcome is already decided
// on-chain. The reveal of `roll` triggers the watcher.
const WHEEL_SPIN_MS = 1800
const SPIN_TURNS = 4

export default defineComponent({
  name: 'RouletteSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
  },
  setup(props) {
    const n = computed(() => props.state.odds?.n ?? 37)
    const lo = computed(() => props.state.odds?.lo ?? 0)
    const target = computed(() => props.state.odds?.target ?? n.value)
    const winSize = computed(() => target.value - lo.value)
    const roll = computed(() => props.state.outcome?.roll ?? null)
    const phase = computed(() => props.state.phase)

    /** Angle (deg) for slot index k, measured from 12 o'clock clockwise. */
    function angleOf(k: number): number {
      return (k / n.value) * 360
    }

    /** Position the slot bubble on the wheel perimeter. */
    function slotStyle(k: number): Record<string, string> {
      const angle = angleOf(k)
      return {
        transform: `rotate(${angle}deg) translateY(-115px) rotate(${-angle}deg)`,
      }
    }

    const isInBand = (k: number): boolean => k >= lo.value && k < target.value

    // ── Wheel spin ────────────────────────────────────────────────────
    // The whole wheel rotates; the pointer is fixed at 12 o'clock. To land
    // slot k under the pointer we rotate to `-angleOf(k)`. We accumulate
    // rotations across games (always > previous angle) so consecutive spins
    // visibly turn forward.
    const rotation = ref(0)

    watch(() => phase.value, (p) => {
      if (p === 'flipping') {
        // Pre-roll spin: a few full turns; the final position is locked in
        // after the on-chain reveal hits the `resolved` watcher below.
        rotation.value = rotation.value + 360 * SPIN_TURNS
      }
    })

    watch(() => roll.value, (newRoll) => {
      if (newRoll === null || newRoll === undefined) return
      // Land on the rolled slot. Snap to the next full N turns past the
      // current rotation so the wheel only ever spins forward.
      const settle = 360 * SPIN_TURNS - angleOf(newRoll)
      const cur = rotation.value
      const turns = Math.ceil(cur / 360)
      rotation.value = turns * 360 + settle
    })

    // CSS transition is driven by inline-style transform on .wheel-inner.
    const wheelStyle = computed(() => ({
      transform: `rotate(${rotation.value}deg)`,
      transition: phase.value === 'idle'
        ? 'none'
        : `transform ${WHEEL_SPIN_MS}ms cubic-bezier(0.2, 0.7, 0.2, 1)`,
    }))

    const wheelClass = computed(() => {
      if (phase.value === 'flipping') return 'spinning'
      if (phase.value === 'resolved') return props.state.outcome?.won ? 'won' : 'lost'
      return 'idle'
    })

    const centreText = computed(() => {
      if (phase.value === 'resolved' && roll.value !== null) return String(roll.value)
      if (phase.value === 'flipping') return '…'
      return '?'
    })
    const centreSub = computed(() => {
      if (phase.value === 'resolved') return props.state.outcome?.won ? 'win' : 'no win'
      if (phase.value === 'flipping') return 'spinning'
      return 'place your bet'
    })
    const centreClass = computed(() => {
      if (phase.value === 'resolved') return props.state.outcome?.won ? 'win' : 'loss'
      return ''
    })

    const winPctLabel = computed(() => {
      const p = (winSize.value / n.value) * 100
      const r = p >= 10 ? Math.round(p) : Math.round(p * 10) / 10
      return `${r}%`
    })
    const bandLabel = computed(() => {
      if (winSize.value === 1) return `${lo.value}`
      return `${lo.value}–${target.value - 1}`
    })

    return {
      n, roll, phase, isInBand, slotStyle,
      wheelClass, centreText, centreSub, centreClass,
      winPctLabel, bandLabel,
      wheelStyle,
    }
  },
})
</script>

<style lang="scss" scoped>
.roulette-skin {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 100%;
}

.wheel {
  position: relative;
  width: 280px;
  height: 280px;
  border-radius: 50%;
  background: radial-gradient(circle, #1a1a24 0%, #08080d 80%);
  border: 2px solid var(--border-light, #2a2a38);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.25s, box-shadow 0.25s;
}
.wheel.spinning {
  border-color: var(--gold, #f7c948);
  box-shadow: 0 0 32px var(--gold-glow, rgba(247, 201, 72, 0.35));
}
.wheel.won {
  border-color: var(--green, #22c55e);
  box-shadow: 0 0 32px rgba(34, 197, 94, 0.5);
}
.wheel.lost {
  border-color: var(--red, #f87171);
  box-shadow: 0 0 28px rgba(239, 68, 68, 0.4);
}

.wheel-inner {
  position: relative;
  width: 100%;
  height: 100%;
  transform: rotate(0deg);
}

.slot {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 26px;
  height: 26px;
  margin: -13px 0 0 -13px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-muted, #5c5c78);
  font-size: 0.62rem;
  font-weight: 700;
  transition: background 0.2s, color 0.2s, transform 0.2s, box-shadow 0.2s;
}
.slot.win {
  background: rgba(247, 201, 72, 0.18);
  color: var(--gold, #f7c948);
}
.slot.zero {
  background: rgba(34, 197, 94, 0.15);
  color: var(--green, #22c55e);
}
.slot.zero.win {
  background: linear-gradient(135deg, rgba(247, 201, 72, 0.2), rgba(34, 197, 94, 0.2));
  color: var(--gold, #f7c948);
}
.slot.landed {
  background: var(--gold, #f7c948);
  color: #08080d;
  /* Keep the per-slot rotation transform from inline style; just add a
     bright background + glow + a ring to make the landed slot pop. */
  box-shadow: 0 0 16px var(--gold-glow, rgba(247, 201, 72, 0.7)),
              0 0 0 2px var(--gold, #f7c948);
  z-index: 4;
}

.slot-num { font-family: ui-monospace, monospace; line-height: 1; }

.pointer {
  position: absolute;
  top: -10px;
  left: 50%;
  width: 0;
  height: 0;
  margin-left: -8px;
  border-left: 8px solid transparent;
  border-right: 8px solid transparent;
  border-top: 14px solid var(--gold, #f7c948);
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.6));
  z-index: 5;
}

.centre {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 130px;
  height: 130px;
  border-radius: 50%;
  background: var(--bg-elevated, #14141c);
  border: 1.5px solid var(--border-light, #2a2a38);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  transition: border-color 0.25s, background 0.25s;
}
.centre.win {
  border-color: var(--green, #22c55e);
  background: radial-gradient(circle, rgba(34, 197, 94, 0.12), var(--bg-elevated, #14141c));
}
.centre.loss {
  border-color: var(--red, #f87171);
  background: radial-gradient(circle, rgba(239, 68, 68, 0.1), var(--bg-elevated, #14141c));
}
.centre-num {
  font-size: 2.6rem;
  font-weight: 800;
  line-height: 1;
  color: var(--text, #eeeef4);
  font-family: ui-monospace, monospace;
}
.centre.win .centre-num { color: var(--green, #22c55e); }
.centre.loss .centre-num { color: var(--red, #f87171); }
.centre-sub {
  margin-top: 4px;
  font-size: 0.62rem;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text-muted, #5c5c78);
}

.band-readout {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 0.72rem;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--text-muted, #5c5c78);
}
.band-label { font-weight: 700; }
.band-range { color: var(--gold, #f7c948); font-weight: 800; }
.band-pct { color: var(--text, #eeeef4); font-weight: 700; }
</style>
