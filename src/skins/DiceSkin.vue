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
import { defineComponent, computed, ref, watch, type PropType } from 'vue'
import type { SkinState } from './types'

// Resting rotation that brings each face toward the viewer (+Z). Derived
// from the face layout below: face-1 front, 2 right, 3 left, 4 top, 5
// bottom, 6 back.
const FACE_ROTATION: Record<number, { x: number; y: number }> = {
  1: { x: 0, y: 0 },
  2: { x: 0, y: -90 },
  3: { x: 0, y: 90 },
  4: { x: -90, y: 0 },
  5: { x: 90, y: 0 },
  6: { x: 0, y: 180 },
}

const roundUpToTurn = (deg: number) => Math.ceil(deg / 360) * 360

export default defineComponent({
  name: 'DiceSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
  },
  setup(props) {
    // Absolute, ever-increasing rotation. We only ever add turns so the cube
    // always spins forward — never snaps backward to land on a face.
    const rotX = ref(0)
    const rotY = ref(0)
    const diceTransition = ref('transform 0.7s cubic-bezier(0.18, 1.15, 0.4, 1)')

    // A constant isometric viewing tilt is applied AFTER the face rotation so
    // the cube always reads as 3D (you see two side faces) and never lands
    // perfectly edge-on to the camera (which would render as a zero-height
    // sliver). rotX/rotY select which face points "forward"; the tilt then
    // angles the whole cube toward the viewer.
    const diceTransform = computed(
      () => `translateZ(-60px) rotateX(-24deg) rotateY(24deg) rotateX(${rotX.value}deg) rotateY(${rotY.value}deg)`,
    )

    // Which face value the cube landed on (1-6). Only this face gets tinted.
    const landedFace = ref(1)

    // Tint only the landed (front) face — green on win, red on loss.
    function faceTint(n: number): string {
      if (props.state.phase === 'resolved' && props.state.outcome && landedFace.value === n) {
        return props.state.outcome.won ? 'face-win' : 'face-loss'
      }
      return ''
    }

    watch(() => props.state.phase, (phase, old) => {
      if (phase === 'flipping') {
        // Long, near-linear spin. If the result arrives before this finishes,
        // the 'resolved' branch just retargets the transition mid-flight.
        diceTransition.value = 'transform 2.6s cubic-bezier(0.25, 0.6, 0.4, 1)'
        rotX.value += 1080 + 90 * Math.floor(Math.random() * 4)
        rotY.value += 1440 + 90 * Math.floor(Math.random() * 4)
      } else if (phase === 'resolved' && old === 'flipping' && props.state.outcome) {
        const face = props.state.outcome.won
          ? 4 + Math.floor(Math.random() * 3) // 4,5,6 → win
          : 1 + Math.floor(Math.random() * 3) // 1,2,3 → loss
        landedFace.value = face
        const fr = FACE_ROTATION[face]
        // Round each axis up to a whole turn, add one more turn for momentum,
        // then the face's resting offset → always lands flat, facing forward.
        diceTransition.value = 'transform 0.85s cubic-bezier(0.18, 1.2, 0.35, 1)'
        rotX.value = roundUpToTurn(rotX.value) + 360 + fr.x
        rotY.value = roundUpToTurn(rotY.value) + 360 + fr.y
      }
    })

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
