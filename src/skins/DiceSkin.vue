<template>
  <div class="dice3d-wrapper">
    <!-- A single polyhedral die (d20, or a d100 percentile pair for long odds)
         physics-lands on the server's roll. One die = one number, so it reads
         unambiguously (no place value). -->
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

let uid = 0

export default defineComponent({
  name: 'DiceSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
  },
  setup(props) {
    const canvasId = `dice-canvas-${++uid}`
    // The bet's `n` IS the die's side count (20 → d20, 100 → d100). The roll is
    // a single value in [0, n); win iff roll ≥ lo, i.e. "roll (lo+1)+".
    const sides = computed(() => props.state.odds?.n ?? 20)
    const dieType = computed(() => `d${sides.value}`)
    const targetValue = computed(() => (props.state.odds?.lo ?? 0) + 1)
    const tint = ref<'' | 'win' | 'loss'>('')
    const ready = ref(false)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let box: any = null
    let disposed = false

    // Force the die onto `value` (1..sides) via the @ notation (provably fair).
    // Also the only thing that draws to the canvas — dice-box renders solely
    // while dice are in motion.
    function showDie(value: number) {
      try {
        box?.clearDice?.()
        box?.roll(`1${dieType.value}@${value}`)
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
          baseScale: 100,
          sounds: false,
        })
        if (typeof box.initialize === 'function') await box.initialize()
        if (disposed) return
        ready.value = true
        // Populate the felt at rest (otherwise the canvas stays black until the
        // first roll). Show the target value as a reference.
        if (props.state.phase !== 'resolved') {
          setTimeout(() => { if (!disposed) showDie(targetValue.value) }, 400)
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

    // Re-roll the resting die when the DIE TYPE changes (e.g. d20 → d100 as the
    // slider crosses into long odds). Threshold-only changes just update the
    // text, so dragging the slider doesn't re-tumble every step.
    watch(sides, () => {
      if (props.state.phase !== 'flipping' && ready.value) { tint.value = ''; showDie(targetValue.value) }
    })

    // On resolve, roll the die onto the server's actual value (roll + 1).
    watch(() => props.state.phase, (phase, old) => {
      if (phase === 'resolved' && old === 'flipping' && props.state.outcome) {
        const roll = props.state.outcome.roll ?? 0
        tint.value = props.state.outcome.won ? 'win' : 'loss'
        showDie(roll + 1)
      } else if (phase === 'flipping') {
        tint.value = ''
      }
    })

    const ruleLabel = computed(() => {
      const o = props.state.outcome
      if (props.state.phase === 'resolved' && o && o.roll != null) {
        return `${o.won ? 'WIN' : 'LOSE'} — rolled ${o.roll + 1}, needed ${targetValue.value}+`
      }
      return `ROLL ${targetValue.value}+ TO WIN`
    })

    return { canvasId, tint, ready, ruleLabel }
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
  letter-spacing: 1.5px;
  font-weight: 800;
  color: var(--text-muted);
  font-family: ui-monospace, monospace;
}
.dice-rule.win { color: var(--green, #22c55e); }
.dice-rule.loss { color: var(--red); }
</style>
