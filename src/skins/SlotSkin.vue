<template>
  <div class="slot-machine">
    <!-- The target hand you must out-rank (read left-to-right). -->
    <div class="slot-target">
      <span class="t-label">BEAT</span>
      <span class="t-card" v-for="(s, i) in targetSymbols" :key="i" :class="{ red: isRed(s) }">
        <b>{{ s }}</b>{{ SUIT[s] }}
      </span>
    </div>

    <div class="slot-frame" :class="tint">
      <div class="reel" v-for="(reel, i) in reels" :key="i" :class="{ spinning: reel.spinning }">
        <div class="reel-strip" :style="reel.spinning ? '' : `transform: translateY(-${reel.targetIndex * 64}px)`">
          <div class="reel-cell" v-for="(sym, j) in reel.symbols" :key="j">
            <div class="card" :class="{ red: isRed(sym), ace: sym === TOP }">
              <span class="corner tl"><b>{{ sym }}</b><i>{{ SUIT[sym] }}</i></span>
              <span class="pip">{{ SUIT[sym] }}</span>
              <span class="corner br"><b>{{ sym }}</b><i>{{ SUIT[sym] }}</i></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="slot-base" :class="tint">{{ ruleLabel }}</div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, type PropType } from 'vue'
import type { SkinState } from './types'

// Card ranks, low → high (10 < J < Q < K < A) — a familiar, self-evident order,
// so "beat the target" needs no legend. Your reels beat the target when they
// out-rank it reading left-to-right. Length MUST equal SLOT_BASE in index.ts
// (SLOT_BASE = SYMBOLS.length, SLOT_REELS reels → n = SLOT_BASE^SLOT_REELS).
const SYMBOLS = ['10', 'J', 'Q', 'K', 'A']
const SLOT_BASE = SYMBOLS.length
const SLOT_REELS = 3
const TOP = SYMBOLS[SYMBOLS.length - 1] // 'A' — the top rank

// A suit per rank so each reel reads as a real card face (suit is decorative —
// only the rank decides the beat-the-target order).
const SUIT: Record<string, string> = { '10': '♣', J: '♦', Q: '♥', K: '♠', A: '♠' }
const isRed = (rank: string): boolean => SUIT[rank] === '♥' || SUIT[rank] === '♦'

interface Reel { symbols: string[]; targetIndex: number; spinning: boolean }

/** The `count` base-SLOT_BASE symbols of `value`, most-significant reel first. */
function symbolsOf(value: number, count: number): string[] {
  return Array.from({ length: count }, (_, j) => SYMBOLS[Math.floor(value / SLOT_BASE ** (count - 1 - j)) % SLOT_BASE])
}

function spunStrip(): { symbols: string[]; targetIndex: number } {
  return { symbols: Array.from({ length: 12 }, () => SYMBOLS[Math.floor(Math.random() * SLOT_BASE)]), targetIndex: 0 }
}
function stripEndingOn(sym: string, stripLen = 12): { symbols: string[]; targetIndex: number } {
  const symbols = Array.from({ length: stripLen }, () => SYMBOLS[Math.floor(Math.random() * SLOT_BASE)])
  const targetIndex = Math.floor(stripLen / 2)
  symbols[targetIndex] = sym
  return { symbols, targetIndex }
}

export default defineComponent({
  name: 'SlotSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
  },
  setup(props) {
    const threshold = computed(() => props.state.odds?.lo ?? 0)
    const targetSymbols = computed(() => symbolsOf(threshold.value, SLOT_REELS))
    const tint = ref<'' | 'win' | 'loss'>('')

    const makeIdle = (): Reel[] => symbolsOf(threshold.value, SLOT_REELS).map((s) => ({ ...stripEndingOn(s), spinning: false }))
    const reels = ref<Reel[]>(makeIdle())

    watch(threshold, () => { if (props.state.phase !== 'flipping') { reels.value = makeIdle(); tint.value = '' } })

    watch(() => props.state.phase, (newPhase, oldPhase) => {
      if (newPhase === 'flipping') {
        tint.value = ''
        reels.value = Array.from({ length: SLOT_REELS }, () => ({ ...spunStrip(), spinning: true }))
      } else if (newPhase === 'resolved' && oldPhase === 'flipping' && props.state.outcome) {
        // Reels land on the rolled symbols (your hand); win iff they out-rank
        // the target, which the server has already decided.
        const roll = props.state.outcome.roll ?? threshold.value
        const symbols = symbolsOf(roll, SLOT_REELS)
        tint.value = props.state.outcome.won ? 'win' : 'loss'
        symbols.forEach((sym, i) => {
          setTimeout(() => { reels.value[i] = { ...stripEndingOn(sym), spinning: false } }, i * 240)
        })
      } else if (newPhase === 'idle') {
        reels.value = makeIdle()
        tint.value = ''
      }
    })

    const ruleLabel = computed(() => {
      if (props.state.phase === 'resolved' && props.state.outcome) {
        return props.state.outcome.won ? '« YOU OUT-RANKED IT »' : '« OUT-RANKED »'
      }
      return '« BEAT THE TARGET · A HIGH »'
    })

    return { reels, targetSymbols, ruleLabel, tint, TOP, SUIT, isRed }
  },
})
</script>

<style scoped>
.slot-machine {
  width: 100%;
  min-height: 200px;
  margin: 8px auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.slot-target {
  display: flex;
  align-items: center;
  gap: 10px;
  opacity: 0.7;
}
.t-label { font-size: 0.6rem; letter-spacing: 2px; font-weight: 800; color: var(--text-muted); }
.t-card {
  display: inline-flex;
  align-items: baseline;
  gap: 1px;
  min-width: 30px;
  padding: 3px 5px;
  border-radius: 5px;
  background: linear-gradient(160deg, #ffffff 0%, #f0f0ea 100%);
  color: #1a1a1a;
  font-weight: 800;
  font-size: 0.82rem;
  line-height: 1;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
.t-card.red { color: #c8102e; }

.slot-frame {
  display: flex;
  gap: 8px;
  padding: 14px;
  background: linear-gradient(180deg, #1a1413 0%, #0d0a09 100%);
  border: 3px solid var(--gold);
  border-radius: 16px;
  box-shadow: inset 0 2px 8px rgba(0,0,0,0.6), 0 0 30px var(--gold-glow);
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}
.slot-frame.win { border-color: var(--green, #22c55e); box-shadow: inset 0 2px 8px rgba(0,0,0,0.6), 0 0 32px rgba(34, 197, 94, 0.5); }
.slot-frame.loss { border-color: var(--red); }
.reel {
  width: 64px;
  height: 96px;
  background: #000;
  border: 1.5px solid rgba(255, 215, 0, 0.3);
  border-radius: 8px;
  overflow: hidden;
  position: relative;
}
.reel-strip {
  display: flex;
  flex-direction: column;
  transition: transform 0.55s cubic-bezier(0.25, 1.0, 0.4, 1);
}
.reel.spinning .reel-strip { animation: reelSpin 0.18s linear infinite; transition: none; }
.reel-cell {
  height: 64px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  background: radial-gradient(circle at 50% 50%, #1a1413 0%, #000 100%);
}
/* Each cell is a playing-card face — rank + suit corners, big centre pip. */
.card {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 6px;
  background: linear-gradient(160deg, #ffffff 0%, #ecece4 100%);
  color: #1a1a1a;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.5);
}
.card.red { color: #c8102e; }
.card.ace { box-shadow: inset 0 0 0 1.5px var(--gold), 0 0 10px var(--gold-glow); }
.corner {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 0.85;
  font-weight: 800;
}
.corner b { font-size: 0.72rem; }
.corner i { font-style: normal; font-size: 0.62rem; }
.corner.tl { top: 3px; left: 4px; }
.corner.br { bottom: 3px; right: 4px; transform: rotate(180deg); }
.pip {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.7rem;
}
.slot-base {
  font-size: 0.6rem;
  letter-spacing: 1.5px;
  font-weight: 700;
  color: var(--text-muted);
}
.slot-base.win { color: var(--green, #22c55e); }
.slot-base.loss { color: var(--red); }

@keyframes reelSpin {
  from { transform: translateY(0); }
  to { transform: translateY(-128px); }
}

@media (max-width: 640px) {
  .reel { width: 54px; height: 82px; }
  .reel-cell { height: 54px; }
  .pip { font-size: 1.4rem; }
}
</style>
