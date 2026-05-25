<template>
  <div class="dice3d-wrapper">
    <!-- The target to reach (read left-to-right); you win if your roll is ≥ it. -->
    <div class="dice-target">
      <span class="t-label">BEAT</span>
      <span class="t-face" v-for="(f, i) in targetFaces" :key="i">{{ f }}</span>
    </div>

    <!-- 3D physics dice (dice-box-threejs) land on the server-determined roll. -->
    <div class="dice-stage" :class="tint">
      <div :id="canvasId" class="dice-canvas" />
      <div v-if="!ready" class="dice-loading">loading dice…</div>
    </div>

    <div class="dice-rule" :class="tint">{{ ruleLabel }}</div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, onMounted, onBeforeUnmount, type PropType } from 'vue'
import type { SkinState } from './types'

/** The `count` base-6 dice faces (1-6) of `value`, most-significant die first. */
function facesOf(value: number, count: number): number[] {
  return Array.from({ length: count }, (_, j) => (Math.floor(value / 6 ** (count - 1 - j)) % 6) + 1)
}

let uid = 0

export default defineComponent({
  name: 'DiceSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
  },
  setup(props) {
    const canvasId = `dice-canvas-${++uid}`
    const diceCount = computed(() => {
      const o = props.state.odds
      return o ? Math.max(1, Math.round(Math.log(o.n) / Math.log(6))) : 2
    })
    const threshold = computed(() => props.state.odds?.lo ?? 0)
    const targetFaces = computed(() => facesOf(threshold.value, diceCount.value))
    const tint = ref<'' | 'win' | 'loss'>('')
    const ready = ref(false)

    // The DiceBox is a WebGL/physics instance; lazy-loaded so three.js stays out
    // of the main bundle (only the Dice skin pulls it in).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let box: any = null
    let disposed = false

    // Force the 3D dice onto specific faces (the @ notation makes the physics
    // land there → provably fair). dice-box only runs its render loop while dice
    // are in motion, so this is also what puts anything on the (otherwise black)
    // canvas in the first place.
    function showDice(faces: number[]) {
      try {
        box?.clearDice?.()
        box?.roll(`${faces.length}d6@${faces.join(',')}`)
      } catch (e) {
        console.warn('[dice] roll failed:', e)
      }
    }

    onMounted(async () => {
      try {
        const DiceBox = (await import('@3d-dice/dice-box-threejs')).default
        if (disposed) return
        box = new DiceBox(`#${canvasId}`, {
          assetPath: '/dice-assets/',
          theme_colorset: 'white',
          theme_surface: 'green-felt',
          theme_material: 'plastic', // 'glass' needs an envmap.jpg we don't ship → renders dark
          gravity_multiplier: 400,
          light_intensity: 0.9,
          baseScale: 90,
          sounds: false,
        })
        if (typeof box.initialize === 'function') await box.initialize()
        if (disposed) return
        ready.value = true
        // Populate the felt at rest with the target dice (otherwise the canvas
        // stays black until the first roll). A short delay lets assets finish.
        if (props.state.phase !== 'resolved') {
          setTimeout(() => { if (!disposed) showDice(targetFaces.value) }, 400)
        }
      } catch (e) {
        console.warn('[dice] dice-box init failed:', e)
      }
    })

    onBeforeUnmount(() => {
      disposed = true
      try { box?.clearDice?.() } catch { /* ignore */ }
      box = null
    })

    // On resolve, re-roll the 3D dice onto the server's actual roll. The dice
    // stay on the felt afterwards (no clear on idle), so the stage is never blank.
    watch(() => props.state.phase, (phase, old) => {
      if (phase === 'resolved' && old === 'flipping' && props.state.outcome) {
        const roll = props.state.outcome.roll ?? threshold.value
        tint.value = props.state.outcome.won ? 'win' : 'loss'
        showDice(facesOf(roll, diceCount.value))
      } else if (phase === 'flipping') {
        tint.value = ''
      }
    })

    const ruleLabel = computed(() => {
      if (props.state.phase === 'resolved' && props.state.outcome) {
        return props.state.outcome.won ? 'YOU BEAT THE TARGET' : 'FELL SHORT'
      }
      if (props.state.phase === 'flipping') return 'ROLLING…'
      return 'ROLL ≥ TARGET TO WIN'
    })

    return { canvasId, targetFaces, tint, ready, ruleLabel }
  },
})
</script>

<style scoped>
.dice3d-wrapper {
  width: 100%;
  margin: 8px auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.dice-target {
  display: flex;
  align-items: center;
  gap: 8px;
}
.t-label {
  font-size: 0.6rem;
  letter-spacing: 2px;
  font-weight: 800;
  color: var(--text-muted);
}
.t-face {
  min-width: 26px;
  height: 26px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: #f0f0f3;
  color: #111;
  font-weight: 800;
  font-size: 0.95rem;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
}

.dice-stage {
  position: relative;
  width: 100%;
  max-width: 340px;
  height: 240px;
  border-radius: 16px;
  overflow: hidden;
  background: radial-gradient(circle at 50% 40%, rgba(255, 255, 255, 0.04) 0%, transparent 70%);
  border: 2px solid transparent;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}
.dice-stage.win {
  border-color: rgba(34, 197, 94, 0.6);
  box-shadow: 0 0 26px rgba(34, 197, 94, 0.35);
}
.dice-stage.loss {
  border-color: rgba(239, 68, 68, 0.5);
  box-shadow: 0 0 22px rgba(239, 68, 68, 0.28);
}
.dice-canvas {
  width: 100%;
  height: 100%;
}
.dice-canvas :deep(canvas) {
  width: 100% !important;
  height: 100% !important;
  display: block;
}
.dice-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  letter-spacing: 2px;
  color: var(--text-muted);
}

.dice-rule {
  font-size: 0.72rem;
  letter-spacing: 2px;
  font-weight: 800;
  color: var(--text-muted);
  font-family: ui-monospace, monospace;
}
.dice-rule.win { color: var(--green, #22c55e); }
.dice-rule.loss { color: var(--red); }
</style>
