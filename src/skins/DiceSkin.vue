<template>
  <div class="dice-wrapper">
    <div class="dice" :style="{ transform: diceTransform, transition: diceTransition }">
      <div class="dice-face face-1" :class="faceTint(1)"><span class="pip" /></div>
      <div class="dice-face face-2" :class="faceTint(2)"><span class="pip" /><span class="pip" /></div>
      <div class="dice-face face-3" :class="faceTint(3)"><span class="pip" /><span class="pip" /><span class="pip" /></div>
      <div class="dice-face face-4" :class="faceTint(4)"><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /></div>
      <div class="dice-face face-5" :class="faceTint(5)"><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /></div>
      <div class="dice-face face-6" :class="faceTint(6)"><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /></div>
    </div>
    <div class="dice-rule">ROLL 4+ TO WIN</div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, onUnmounted, type PropType } from 'vue'
import type { SkinState } from './types'

// Steep look-down view so the TOP face dominates — you read a die from the
// top, like one resting on a table. Front + one side stay visible for depth.
const VIEW = 'translateZ(-60px) rotateX(-38deg) rotateY(-26deg)'

// Rotation that brings each face onto the visual TOP of the cube. In CSS the
// +Y axis points DOWN the screen, so the screen-top is the -Y direction:
// these rotations send each face's outward normal to -Y. Face layout:
// 1 front (+Z), 2 right (+X), 3 left (-X), 4 bottom (-Y → already top),
// 5 top-in-model (+Y), 6 back (-Z).
const FACE_TO_TOP: Record<number, string> = {
  1: 'rotateX(90deg)',
  2: 'rotateZ(-90deg)',
  3: 'rotateZ(90deg)',
  4: '',
  5: 'rotateX(180deg)',
  6: 'rotateX(-90deg)',
}

export default defineComponent({
  name: 'DiceSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
  },
  setup(props) {
    // Spin accumulators (only used while tumbling). The resting orientation is
    // driven by FACE_TO_TOP once settled.
    const rotX = ref(0)
    const rotY = ref(0)
    const settled = ref(true)
    const landedFace = ref(4) // idle rests showing face-4 on top (-Y)
    const diceTransition = ref('transform 0.85s cubic-bezier(0.18, 1.2, 0.35, 1)')

    // While tumbling: VIEW + accumulating spin. Once settled: VIEW + the
    // result face rotated onto the top. The view tilt is the constant prefix
    // so the camera angle never changes.
    const diceTransform = computed(() => {
      if (settled.value) return `${VIEW} ${FACE_TO_TOP[landedFace.value]}`.trim()
      return `${VIEW} rotateX(${rotX.value}deg) rotateY(${rotY.value}deg)`
    })

    // Tint only the landed (top) face — green on win, red on loss.
    function faceTint(n: number): string {
      if (props.state.phase === 'resolved' && props.state.outcome && landedFace.value === n) {
        return props.state.outcome.won ? 'face-win' : 'face-loss'
      }
      return ''
    }

    // Continuous tumble driven by rAF so the cube keeps spinning for the
    // entire time the bet is resolving — it never stops early and "waits".
    let rafId = 0
    function spinLoop() {
      rotX.value += 7
      rotY.value += 11
      rafId = requestAnimationFrame(spinLoop)
    }
    function stopSpin() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
    }

    watch(() => props.state.phase, (phase, old) => {
      if (phase === 'flipping') {
        // Spin freely with no CSS transition — rAF sets each frame directly.
        settled.value = false
        diceTransition.value = 'none'
        stopSpin()
        spinLoop()
      } else if (phase === 'resolved' && old === 'flipping' && props.state.outcome) {
        stopSpin()
        landedFace.value = props.state.outcome.won
          ? 4 + Math.floor(Math.random() * 3) // 4,5,6 → win
          : 1 + Math.floor(Math.random() * 3) // 1,2,3 → loss
        // Settle from the current spin onto the result face (on top).
        diceTransition.value = 'transform 0.9s cubic-bezier(0.18, 1.25, 0.35, 1)'
        settled.value = true
      } else {
        // idle / error
        stopSpin()
        settled.value = true
      }
    })

    onUnmounted(stopSpin)

    return { diceTransform, diceTransition, faceTint }
  },
})
</script>

<style scoped>
.dice-wrapper {
  width: 172px;
  height: 230px;
  margin: 8px auto;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* Cube sits in the upper area; the rule label sits below it in normal flow
     so the two never overlap. */
  justify-content: flex-start;
  padding-top: 24px;
  gap: 28px;
  /* Stronger perspective = more pronounced cube depth. */
  perspective: 520px;
  perspective-origin: center center;
}
.dice {
  width: 120px;
  height: 120px;
  position: relative;
  transform-style: preserve-3d;
  will-change: transform;
  /* NOTE: never put `filter`, `opacity`, `clip`, or `overflow` here — any of
     them creates a flattening context that collapses preserve-3d, turning
     the cube into a single flat face. The drop shadow lives on faces instead. */
}

.dice-face {
  position: absolute;
  width: 120px;
  height: 120px;
  background: linear-gradient(145deg, #ffffff 0%, #f0f0f3 55%, #d8d8de 100%);
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  box-shadow: inset 0 -3px 6px rgba(0, 0, 0, 0.15), inset 0 3px 6px rgba(255, 255, 255, 0.5);
  display: grid;
  padding: 18px;
  gap: 4px;
  transition: background 0.3s ease, border-color 0.3s ease;
}
/* Result tint — makes win/loss obvious at a glance. */
.dice-face.face-win {
  background: linear-gradient(145deg, #d1fae5 0%, #6ee7b7 55%, #34d399 100%);
  border-color: rgba(5, 150, 105, 0.6);
}
.dice-face.face-loss {
  background: linear-gradient(145deg, #fee2e2 0%, #fca5a5 55%, #f87171 100%);
  border-color: rgba(220, 38, 38, 0.6);
}
.face-1 { transform: translateZ(60px); grid-template: 1fr / 1fr; place-items: center; }
.face-2 { transform: rotateY(90deg) translateZ(60px); grid-template: 1fr 1fr / 1fr 1fr; }
.face-2 .pip:nth-child(1) { grid-area: 1 / 1; }
.face-2 .pip:nth-child(2) { grid-area: 2 / 2; }
.face-3 { transform: rotateY(-90deg) translateZ(60px); grid-template: 1fr 1fr 1fr / 1fr 1fr 1fr; }
.face-3 .pip:nth-child(1) { grid-area: 1 / 1; }
.face-3 .pip:nth-child(2) { grid-area: 2 / 2; }
.face-3 .pip:nth-child(3) { grid-area: 3 / 3; }
.face-4 { transform: rotateX(90deg) translateZ(60px); grid-template: 1fr 1fr / 1fr 1fr; }
.face-5 { transform: rotateX(-90deg) translateZ(60px); grid-template: 1fr 1fr 1fr / 1fr 1fr 1fr; }
.face-5 .pip:nth-child(1) { grid-area: 1 / 1; }
.face-5 .pip:nth-child(2) { grid-area: 1 / 3; }
.face-5 .pip:nth-child(3) { grid-area: 2 / 2; }
.face-5 .pip:nth-child(4) { grid-area: 3 / 1; }
.face-5 .pip:nth-child(5) { grid-area: 3 / 3; }
.face-6 { transform: rotateY(180deg) translateZ(60px); grid-template: 1fr 1fr 1fr / 1fr 1fr; }

.pip {
  width: 20px;
  height: 20px;
  background: radial-gradient(circle at 35% 30%, #444 0%, #111 60%, #000 100%);
  border-radius: 50%;
  box-shadow: inset 0 2px 3px rgba(0, 0, 0, 0.6), 0 1px 1px rgba(255, 255, 255, 0.4);
  align-self: center;
  justify-self: center;
}

.dice-rule {
  font-size: 0.62rem;
  letter-spacing: 2px;
  color: var(--text-muted);
  font-weight: 700;
}

@media (max-width: 640px) {
  .dice-wrapper { width: 150px; height: 180px; }
  .dice { width: 100px; height: 100px; }
  .dice-face { width: 100px; height: 100px; padding: 14px; }
  .face-1 { transform: translateZ(50px); }
  .face-2 { transform: rotateY(90deg) translateZ(50px); }
  .face-3 { transform: rotateY(-90deg) translateZ(50px); }
  .face-4 { transform: rotateX(90deg) translateZ(50px); }
  .face-5 { transform: rotateX(-90deg) translateZ(50px); }
  .face-6 { transform: rotateY(180deg) translateZ(50px); }
  .pip { width: 14px; height: 14px; }
}
</style>
