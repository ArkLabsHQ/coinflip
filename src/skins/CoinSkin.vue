<template>
  <div class="coin-wrapper" :class="`coins-${coins.length}`">
    <div class="coin-unit" v-for="(c, i) in coins" :key="i">
      <div class="coin" :class="c" :style="{ animationDelay: `${i * 0.08}s` }">
        <div class="coin-face coin-heads">
          <span class="coin-symbol">&#x20BF;</span>
        </div>
        <div class="coin-face coin-tails">
          <span class="coin-symbol tails-symbol">&#x20BF;</span>
        </div>
      </div>
      <div class="coin-shadow" :class="c"></div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, type PropType } from 'vue'
import type { SkinState } from './types'

export default defineComponent({
  name: 'CoinSkin',
  props: {
    state: { type: Object as PropType<SkinState>, required: true },
  },
  setup(props) {
    // n = 2^k renders as k coins. Every rung uses the same k now — what varies
    // is how wide the winning band is — so the count no longer encodes the odds.
    const coinCount = computed(() => {
      const o = props.state.odds
      return o ? Math.max(1, Math.round(Math.log2(o.n))) : 1
    })

    // Per-coin face. While flipping, all spin. On resolve the classic 50/50
    // shows the called side; a multi-coin bet shows the roll's bits.
    //
    // HEADS IS BIT 1, deliberately: the roll is read as a binary number and the
    // winning band is the TOP of the range, so more heads = a bigger number =
    // closer to winning, and an all-heads row is a win at every rung. Under the
    // old mapping (heads = bit 0) the win was roll 0 — all heads — which only
    // worked because the band was always exactly one outcome wide.
    const coins = computed<string[]>(() => {
      const count = coinCount.value
      if (props.state.phase === 'flipping') return Array(count).fill('flipping')
      if (props.state.phase === 'resolved' && props.state.outcome) {
        if (!props.state.odds) return [props.state.outcome.side]
        const roll = props.state.outcome.roll ?? 0
        return Array.from({ length: count }, (_, i) => ((roll >> i) & 1) ? 'heads' : 'tails')
      }
      return Array(count).fill('idle')
    })

    return { coins }
  },
})
</script>

<style scoped>
.coin-wrapper {
  width: 100%;
  min-height: 190px;
  margin: 8px auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 18px;
}
.coin-unit {
  position: relative;
  perspective: 900px;
}
/* Coin sizing by how many are in play — one big coin, or a tighter row that
   wraps for the higher counts. */
.coins-1 .coin-unit { width: 172px; height: 172px; }
.coins-2 .coin-unit { width: 120px; height: 120px; }
.coins-3 .coin-unit { width: 96px; height: 96px; }
.coins-4 .coin-unit { width: 84px; height: 84px; }
.coins-5 .coin-unit,
.coins-6 .coin-unit { width: 76px; height: 76px; }
/* Seven is the shared-ladder count (2^7 = 128 outcomes, fine enough for a 1%
   rung), so it is the common case rather than an edge one. */
.coins-7 .coin-unit { width: 64px; height: 64px; }
/* Seven in a row wraps 6+1, which reads as a mistake. Cap the row so it breaks
   evenly into 4+3 instead. */
.coins-7 { max-width: 300px; }

.coin {
  width: 100%;
  height: 100%;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.6s cubic-bezier(0.35, 0, 0.25, 1);
}
.coin.idle { animation: coinFloat 4s ease-in-out infinite; }
.coin.flipping { animation: coinSpin 0.35s linear infinite; }
.coin.heads { transform: rotateY(0deg); }
.coin.tails { transform: rotateY(180deg); }

.coin-face {
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  backface-visibility: hidden;
  border: 3px solid rgba(255, 215, 0, 0.5);
}
.coin-heads {
  background: radial-gradient(circle at 35% 35%, #ffe066 0%, #f7c948 30%, #d4a530 70%, #b8860b 100%);
  box-shadow: inset 0 2px 6px rgba(255, 255, 255, 0.35), inset 0 -4px 10px rgba(0, 0, 0, 0.25), 0 0 40px rgba(247, 201, 72, 0.25);
}
.coin-tails {
  background: radial-gradient(circle at 65% 65%, #e0b840 0%, #c99a2e 30%, #a07820 70%, #8b6914 100%);
  transform: rotateY(180deg);
  box-shadow: inset 0 2px 6px rgba(255, 255, 255, 0.25), inset 0 -4px 10px rgba(0, 0, 0, 0.3), 0 0 40px rgba(247, 201, 72, 0.2);
}
.coin-symbol {
  font-weight: 800;
  color: rgba(26, 18, 0, 0.8);
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.3);
  line-height: 1;
}
.coins-1 .coin-symbol { font-size: 4rem; }
.coins-2 .coin-symbol { font-size: 2.8rem; }
.coins-3 .coin-symbol { font-size: 2.2rem; }
.coins-4 .coin-symbol { font-size: 1.9rem; }
.coins-5 .coin-symbol,
.coins-6 .coin-symbol { font-size: 1.7rem; }
.tails-symbol { opacity: 0.7; }
.coin-shadow {
  position: absolute;
  bottom: -18px;
  left: 50%;
  transform: translateX(-50%);
  width: 70%;
  height: 12px;
  background: radial-gradient(ellipse, rgba(0,0,0,0.35) 0%, transparent 70%);
  border-radius: 50%;
  transition: all 0.3s ease;
}
.coin-shadow.idle { animation: shadowFloat 4s ease-in-out infinite; }
.coin-shadow.flipping { width: 50%; opacity: 0.5; }

@keyframes coinFloat {
  0%, 100% { transform: translateY(0) rotateY(0); }
  50% { transform: translateY(-14px) rotateY(12deg); }
}
@keyframes coinSpin {
  0% { transform: rotateY(0deg); }
  100% { transform: rotateY(360deg); }
}
@keyframes shadowFloat {
  0%, 100% { width: 70%; opacity: 1; }
  50% { width: 52%; opacity: 0.6; }
}
@media (max-width: 640px) {
  .coins-1 .coin-unit { width: 140px; height: 140px; }
  .coins-2 .coin-unit { width: 104px; height: 104px; }
  .coins-3 .coin-unit { width: 84px; height: 84px; }
  .coins-4 .coin-unit { width: 70px; height: 70px; }
  .coins-5 .coin-unit,
  .coins-6 .coin-unit { width: 60px; height: 60px; }
  .coins-1 .coin-symbol { font-size: 3.2rem; }
  .coins-3 .coin-symbol { font-size: 1.85rem; }
  .coins-4 .coin-symbol { font-size: 1.55rem; }
  .coins-5 .coin-symbol,
  .coins-6 .coin-symbol { font-size: 1.35rem; }
  .coin-wrapper { gap: 14px; min-height: 160px; }
}
</style>
