<template>
  <div class="dice-wrapper">
    <!-- The target to reach: you win if your roll is ≥ this, read left-to-right. -->
    <div class="dice-target">
      <span class="t-label">BEAT</span>
      <div class="die small" v-for="(f, i) in targetFaces" :key="'t' + i">
        <span class="pip" v-for="cell in 9" :key="cell" :class="{ on: PIPS[f].includes(cell) }" />
      </div>
    </div>

    <!-- Your roll. -->
    <div class="dice-roll" :class="`n${rollFaces.length}`">
      <div class="die" v-for="(f, i) in rollFaces" :key="i" :class="[tint, { rolling }]">
        <span class="pip" v-for="cell in 9" :key="cell" :class="{ on: PIPS[f].includes(cell) }" />
      </div>
    </div>

    <div class="dice-rule" :class="tint">{{ ruleLabel }}</div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, onUnmounted, type PropType } from 'vue'
import type { SkinState } from './types'

// Which of the 9 (3×3) cells carry a pip, per face. Face 0 = blank ("not rolled").
const PIPS: Record<number, number[]> = {
  0: [],
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
}

/** The `count` base-6 faces (1-6) of `value`, most-significant die first, so the
 *  dice read left-to-right as one number. */
function facesOf(value: number, count: number): number[] {
  return Array.from({ length: count }, (_, j) => (Math.floor(value / 6 ** (count - 1 - j)) % 6) + 1)
}

export default defineComponent({
  name: 'DiceSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
  },
  setup(props) {
    const diceCount = computed(() => {
      const o = props.state.odds
      return o ? Math.max(1, Math.round(Math.log(o.n) / Math.log(6))) : 2
    })
    const threshold = computed(() => props.state.odds?.lo ?? 0)
    // The minimum winning roll, shown as the target dice to beat (or tie).
    const targetFaces = computed(() => facesOf(threshold.value, diceCount.value))

    const rollFaces = ref<number[]>(Array(diceCount.value).fill(0)) // 0 = blank (unrolled)
    const tint = ref<'' | 'win' | 'loss'>('')
    const rolling = ref(false)

    let tumble = 0
    function startTumble() {
      stopTumble()
      rolling.value = true
      tumble = window.setInterval(() => {
        rollFaces.value = Array.from({ length: diceCount.value }, () => 1 + Math.floor(Math.random() * 6))
      }, 80)
    }
    function stopTumble() {
      if (tumble) { clearInterval(tumble); tumble = 0 }
      rolling.value = false
    }

    // Reset to the blank/ready state when the bet changes while idle.
    watch([threshold, diceCount], () => {
      if (props.state.phase !== 'flipping') {
        rollFaces.value = Array(diceCount.value).fill(0)
        tint.value = ''
      }
    })

    watch(() => props.state.phase, (phase, old) => {
      if (phase === 'flipping') {
        tint.value = ''
        startTumble()
      } else if (phase === 'resolved' && old === 'flipping' && props.state.outcome) {
        stopTumble()
        const roll = props.state.outcome.roll ?? threshold.value
        rollFaces.value = facesOf(roll, diceCount.value)
        tint.value = props.state.outcome.won ? 'win' : 'loss'
      } else {
        stopTumble()
        rollFaces.value = Array(diceCount.value).fill(0)
        tint.value = ''
      }
    })

    onUnmounted(stopTumble)

    const ruleLabel = computed(() => {
      if (props.state.phase === 'resolved' && props.state.outcome) {
        return props.state.outcome.won ? 'YOU BEAT THE TARGET' : 'FELL SHORT'
      }
      if (props.state.phase === 'flipping') return 'ROLLING…'
      return 'ROLL ≥ TARGET TO WIN'
    })

    return { targetFaces, rollFaces, tint, rolling, ruleLabel, PIPS }
  },
})
</script>

<style scoped>
.dice-wrapper {
  width: 100%;
  min-height: 210px;
  margin: 8px auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

/* Target row — the dice you must beat (dimmed reference). */
.dice-target {
  display: flex;
  align-items: center;
  gap: 8px;
  opacity: 0.65;
}
.t-label {
  font-size: 0.6rem;
  letter-spacing: 2px;
  font-weight: 800;
  color: var(--text-muted);
}

.dice-roll {
  display: flex;
  gap: 14px;
  align-items: center;
  justify-content: center;
}

.die {
  display: grid;
  grid-template: repeat(3, 1fr) / repeat(3, 1fr);
  width: 84px;
  height: 84px;
  padding: 10px;
  gap: 2px;
  border-radius: 14px;
  background: linear-gradient(145deg, #ffffff 0%, #f0f0f3 55%, #d8d8de 100%);
  border: 1px solid rgba(0, 0, 0, 0.12);
  box-shadow: inset 0 -3px 6px rgba(0, 0, 0, 0.15), inset 0 3px 6px rgba(255, 255, 255, 0.5), 0 6px 14px rgba(0, 0, 0, 0.35);
  transition: background 0.3s ease, border-color 0.3s ease;
}
.die.small {
  width: 34px;
  height: 34px;
  padding: 4px;
  border-radius: 7px;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
}
.die.rolling { animation: diceShake 0.22s ease-in-out infinite; }
.die.win {
  background: linear-gradient(145deg, #d1fae5 0%, #6ee7b7 55%, #34d399 100%);
  border-color: rgba(5, 150, 105, 0.6);
}
.die.loss {
  background: linear-gradient(145deg, #fee2e2 0%, #fca5a5 55%, #f87171 100%);
  border-color: rgba(220, 38, 38, 0.6);
}
.n3 .die { width: 70px; height: 70px; padding: 8px; }

.pip {
  width: 72%;
  height: 72%;
  border-radius: 50%;
  place-self: center;
}
.pip.on {
  background: radial-gradient(circle at 35% 30%, #444 0%, #111 60%, #000 100%);
  box-shadow: inset 0 2px 3px rgba(0, 0, 0, 0.6), 0 1px 1px rgba(255, 255, 255, 0.4);
}
.pip:nth-child(1) { grid-area: 1 / 1; }
.pip:nth-child(2) { grid-area: 1 / 2; }
.pip:nth-child(3) { grid-area: 1 / 3; }
.pip:nth-child(4) { grid-area: 2 / 1; }
.pip:nth-child(5) { grid-area: 2 / 2; }
.pip:nth-child(6) { grid-area: 2 / 3; }
.pip:nth-child(7) { grid-area: 3 / 1; }
.pip:nth-child(8) { grid-area: 3 / 2; }
.pip:nth-child(9) { grid-area: 3 / 3; }

.dice-rule {
  font-size: 0.7rem;
  letter-spacing: 2px;
  font-weight: 800;
  color: var(--text-muted);
  font-family: ui-monospace, monospace;
}
.dice-rule.win { color: var(--green, #22c55e); }
.dice-rule.loss { color: var(--red); }

@keyframes diceShake {
  0%, 100% { transform: translateY(0) rotate(-4deg); }
  50% { transform: translateY(-6px) rotate(4deg); }
}

@media (max-width: 640px) {
  .die { width: 70px; height: 70px; }
  .n3 .die { width: 58px; height: 58px; padding: 6px; }
}
</style>
