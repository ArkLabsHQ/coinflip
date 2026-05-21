<template>
  <div class="dice-wrapper">
    <div class="dice" :class="diceClass" :data-face="face">
      <div class="dice-face face-1"><span class="pip" /></div>
      <div class="dice-face face-2"><span class="pip" /><span class="pip" /></div>
      <div class="dice-face face-3"><span class="pip" /><span class="pip" /><span class="pip" /></div>
      <div class="dice-face face-4"><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /></div>
      <div class="dice-face face-5"><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /></div>
      <div class="dice-face face-6"><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /><span class="pip" /></div>
    </div>
    <div class="dice-rule">ROLL 4+ TO WIN</div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, type PropType } from 'vue'
import type { SkinState } from './types'

export default defineComponent({
  name: 'DiceSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
  },
  setup(props) {
    const face = ref<number>(1)

    const diceClass = computed(() => {
      if (props.state.phase === 'flipping') return 'rolling'
      if (props.state.phase === 'resolved') return 'settled'
      return 'idle'
    })

    watch(() => props.state.phase, (newPhase, oldPhase) => {
      if (newPhase === 'resolved' && oldPhase === 'flipping' && props.state.outcome) {
        // Win = 4, 5, or 6. Loss = 1, 2, or 3. Pick a random face within the
        // band so the result feels real.
        face.value = props.state.outcome.won
          ? 4 + Math.floor(Math.random() * 3)
          : 1 + Math.floor(Math.random() * 3)
      }
    })

    return { face, diceClass }
  },
})
</script>

<style scoped>
.dice-wrapper {
  width: 172px;
  height: 200px;
  margin: 8px auto;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  perspective: 800px;
  perspective-origin: center center;
}
.dice {
  width: 120px;
  height: 120px;
  position: relative;
  transform-style: preserve-3d;
  transform: rotateX(15deg) rotateY(15deg);
  transition: transform 0.6s cubic-bezier(0.25, 1.0, 0.4, 1);
  filter: drop-shadow(0 8px 20px rgba(0, 0, 0, 0.5));
}
.dice.idle {
  animation: diceFloat 4s ease-in-out infinite;
}
.dice.rolling {
  animation: diceRoll 0.4s linear infinite;
}
.dice.settled[data-face="1"] { transform: rotateX(0deg) rotateY(0deg); }
.dice.settled[data-face="2"] { transform: rotateX(0deg) rotateY(-90deg); }
.dice.settled[data-face="3"] { transform: rotateX(0deg) rotateY(90deg); }
.dice.settled[data-face="4"] { transform: rotateX(-90deg) rotateY(0deg); }
.dice.settled[data-face="5"] { transform: rotateX(90deg) rotateY(0deg); }
.dice.settled[data-face="6"] { transform: rotateX(0deg) rotateY(180deg); }

.dice-face {
  position: absolute;
  width: 120px;
  height: 120px;
  background: linear-gradient(135deg, #fef3c7 0%, #f4d27a 100%);
  border-radius: 16px;
  box-shadow: inset 0 -3px 6px rgba(0, 0, 0, 0.15), inset 0 3px 6px rgba(255, 255, 255, 0.5);
  display: grid;
  padding: 18px;
  gap: 4px;
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
  width: 18px;
  height: 18px;
  background: #1a0f00;
  border-radius: 50%;
  box-shadow: inset 0 2px 3px rgba(0, 0, 0, 0.5);
  align-self: center;
  justify-self: center;
}

.dice-rule {
  margin-top: 16px;
  font-size: 0.62rem;
  letter-spacing: 2px;
  color: var(--text-muted);
  font-weight: 700;
}

@keyframes diceFloat {
  0%, 100% { transform: translateY(0) rotateX(15deg) rotateY(15deg); }
  50% { transform: translateY(-10px) rotateX(20deg) rotateY(25deg); }
}
@keyframes diceRoll {
  0% { transform: rotateX(0) rotateY(0); }
  25% { transform: rotateX(90deg) rotateY(180deg); }
  50% { transform: rotateX(180deg) rotateY(90deg); }
  75% { transform: rotateX(270deg) rotateY(270deg); }
  100% { transform: rotateX(360deg) rotateY(360deg); }
}

@media (max-width: 640px) {
  .dice-wrapper { width: 150px; height: 150px; }
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
