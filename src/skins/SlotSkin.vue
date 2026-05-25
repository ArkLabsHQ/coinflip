<template>
  <div class="slot-machine">
    <div class="slot-frame">
      <div class="reel" v-for="(reel, i) in reels" :key="i" :class="{ spinning: reel.spinning }">
        <div class="reel-strip" :style="reel.spinning ? '' : `transform: translateY(-${reel.targetIndex * 64}px)`">
          <div class="reel-cell" v-for="(sym, j) in reel.symbols" :key="j">{{ sym }}</div>
        </div>
      </div>
    </div>
    <div class="slot-base">
      <span class="payline">&laquo; {{ paylineLabel }} &raquo;</span>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, type PropType } from 'vue'
import type { SkinState } from './types'

// Slot symbols, ordered common → rare. The win/loss outcome is server-driven;
// the reels just reflect it (3-of-3 jackpot for a win, a non-matching row for a
// loss). The jackpot SYMBOL is chosen by the payout multiple — bigger bets land
// rarer symbols — so the reels visibly reflect which bet is in play. ₿ is the
// grand jackpot (6×+).
const SYMBOLS = ['♦', '◆', '⚡', '★', '₿']

interface Reel {
  symbols: string[]
  targetIndex: number
  spinning: boolean
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function buildReelStrip(target: string, stripLen = 12): { symbols: string[]; targetIndex: number } {
  // Build a strip of stripLen symbols with the target placed roughly in
  // the middle so the "snap to target" animation feels natural.
  const symbols: string[] = []
  for (let i = 0; i < stripLen; i++) {
    symbols.push(SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)])
  }
  const targetIndex = Math.floor(stripLen / 2)
  symbols[targetIndex] = target
  return { symbols, targetIndex }
}

/** The jackpot symbol for a bet: rarer the bigger the payout multiple, so the
 *  winning row reflects which bet was placed. */
function jackpotSymbol(odds: SkinState['odds']): string {
  const mult = odds ? odds.n / (odds.target - odds.lo) : 2
  const idx = Math.min(SYMBOLS.length - 1, Math.max(0, Math.round(mult) - 2))
  return SYMBOLS[idx]
}

/** A losing row: 3 distinct symbols, so it's never a (3-of-3) jackpot. */
function lossSymbols(): string[] {
  return shuffle(SYMBOLS).slice(0, 3)
}

export default defineComponent({
  name: 'SlotSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
  },
  setup(props) {
    const reels = ref<Reel[]>([
      { symbols: shuffle(SYMBOLS).slice(0, 3), targetIndex: 0, spinning: false },
      { symbols: shuffle(SYMBOLS).slice(0, 3), targetIndex: 0, spinning: false },
      { symbols: shuffle(SYMBOLS).slice(0, 3), targetIndex: 0, spinning: false },
    ])

    const phase = computed(() => props.state.phase)

    // Payline reflects the bet's payout multiple (e.g. "MATCH 3 — 6× JACKPOT").
    const paylineLabel = computed(() => {
      const o = props.state.odds
      if (!o) return 'MATCH 3 PAYS'
      const m = o.n / (o.target - o.lo)
      return `MATCH 3 — ${Number.isInteger(m) ? m : m.toFixed(1)}× JACKPOT`
    })

    watch(phase, (newPhase, oldPhase) => {
      if (newPhase === 'flipping') {
        // Start all three reels spinning
        reels.value = reels.value.map(() => ({
          symbols: shuffle(SYMBOLS.concat(SYMBOLS).concat(SYMBOLS)),
          targetIndex: 0,
          spinning: true,
        }))
      } else if (newPhase === 'resolved' && oldPhase === 'flipping' && props.state.outcome) {
        // Snap reels to their target symbols, staggered 250ms each. A win lands
        // all three on the jackpot symbol; a loss lands a non-matching row.
        const jackpot = jackpotSymbol(props.state.odds)
        const targets = props.state.outcome.won ? [jackpot, jackpot, jackpot] : lossSymbols()
        targets.forEach((sym, i) => {
          setTimeout(() => {
            const strip = buildReelStrip(sym)
            reels.value[i] = { ...strip, spinning: false }
          }, i * 250)
        })
      } else if (newPhase === 'idle') {
        reels.value.forEach((r) => { r.spinning = false })
      }
    })

    return { reels, paylineLabel }
  },
})
</script>

<style scoped>
.slot-machine {
  width: 280px;
  height: 172px;
  margin: 8px auto;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.slot-frame {
  display: flex;
  gap: 8px;
  padding: 14px;
  background: linear-gradient(180deg, #1a1413 0%, #0d0a09 100%);
  border: 3px solid var(--gold);
  border-radius: 16px;
  box-shadow:
    inset 0 2px 8px rgba(0,0,0,0.6),
    0 0 30px var(--gold-glow);
  flex: 1;
}
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
.reel.spinning .reel-strip {
  animation: reelSpin 0.18s linear infinite;
  transition: none;
}
.reel-cell {
  height: 64px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2.6rem;
  font-weight: 800;
  color: var(--gold);
  background: radial-gradient(circle at 50% 50%, #1a1413 0%, #000 100%);
  text-shadow: 0 0 8px var(--gold-glow);
}
.slot-base {
  margin-top: 6px;
  font-size: 0.62rem;
  letter-spacing: 2px;
  color: var(--text-muted);
}
.payline {
  font-weight: 700;
}

@keyframes reelSpin {
  from { transform: translateY(0); }
  to { transform: translateY(-128px); }
}

@media (max-width: 640px) {
  .slot-machine { width: 240px; height: 150px; }
  .reel { width: 54px; height: 82px; }
  .reel-cell { height: 54px; font-size: 2.2rem; }
}
</style>
