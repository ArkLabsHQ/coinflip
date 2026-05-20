<template>
  <div class="coin-wrapper">
    <div class="coin" :class="state">
      <div class="coin-face coin-heads">
        <span class="coin-symbol">&#x20BF;</span>
      </div>
      <div class="coin-face coin-tails">
        <span class="coin-symbol tails-symbol">&#x20BF;</span>
      </div>
    </div>
    <div class="coin-shadow" :class="state"></div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'CoinFlip',
  props: {
    state: {
      type: String as () => 'idle' | 'flipping' | 'heads' | 'tails',
      default: 'idle',
    },
  },
})
</script>

<style scoped>
.coin-wrapper {
  perspective: 900px;
  width: 172px;
  height: 172px;
  margin: 8px auto;
  position: relative;
}

.coin {
  width: 100%;
  height: 100%;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.6s cubic-bezier(0.35, 0, 0.25, 1);
}

.coin.idle {
  animation: coinFloat 4s ease-in-out infinite;
}

.coin.flipping {
  animation: coinSpin 0.35s linear infinite;
}

.coin.heads {
  transform: rotateY(0deg);
}

.coin.tails {
  transform: rotateY(180deg);
}

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
  background:
    radial-gradient(circle at 35% 35%, #ffe066 0%, #f7c948 30%, #d4a530 70%, #b8860b 100%);
  box-shadow:
    inset 0 2px 6px rgba(255, 255, 255, 0.35),
    inset 0 -4px 10px rgba(0, 0, 0, 0.25),
    0 0 40px rgba(247, 201, 72, 0.25);
}

.coin-tails {
  background:
    radial-gradient(circle at 65% 65%, #e0b840 0%, #c99a2e 30%, #a07820 70%, #8b6914 100%);
  transform: rotateY(180deg);
  box-shadow:
    inset 0 2px 6px rgba(255, 255, 255, 0.25),
    inset 0 -4px 10px rgba(0, 0, 0, 0.3),
    0 0 40px rgba(247, 201, 72, 0.2);
}

.coin-symbol {
  font-size: 4rem;
  font-weight: 800;
  color: rgba(26, 18, 0, 0.8);
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.3);
  line-height: 1;
}

.tails-symbol {
  opacity: 0.7;
}

/* Ground shadow */
.coin-shadow {
  position: absolute;
  bottom: -18px;
  left: 50%;
  transform: translateX(-50%);
  width: 120px;
  height: 12px;
  background: radial-gradient(ellipse, rgba(0,0,0,0.35) 0%, transparent 70%);
  border-radius: 50%;
  transition: all 0.3s ease;
}

.coin-shadow.idle {
  animation: shadowFloat 4s ease-in-out infinite;
}

.coin-shadow.flipping {
  width: 80px;
  opacity: 0.5;
}

@keyframes coinFloat {
  0%, 100% { transform: translateY(0) rotateY(0); }
  50% { transform: translateY(-14px) rotateY(12deg); }
}

@keyframes coinSpin {
  0% { transform: rotateY(0deg); }
  100% { transform: rotateY(360deg); }
}

@keyframes shadowFloat {
  0%, 100% { width: 120px; opacity: 1; }
  50% { width: 90px; opacity: 0.6; }
}

@media (max-width: 640px) {
  .coin-wrapper {
    width: 140px;
    height: 140px;
  }
  .coin-symbol { font-size: 3.2rem; }
}
</style>
