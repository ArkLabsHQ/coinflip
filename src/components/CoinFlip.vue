<template>
  <div class="coin-wrapper">
    <div class="coin" :class="state">
      <div class="coin-face coin-heads">H</div>
      <div class="coin-face coin-tails">T</div>
    </div>
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
  perspective: 800px;
  width: 180px;
  height: 180px;
  margin: 0 auto;
}

.coin {
  width: 100%;
  height: 100%;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.6s ease;
}

.coin.idle {
  animation: coinFloat 3s ease-in-out infinite;
}

.coin.flipping {
  animation: coinSpin 0.4s linear infinite;
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
  font-size: 3.5rem;
  font-weight: 800;
  backface-visibility: hidden;
  border: 4px solid rgba(255, 215, 0, 0.6);
}

.coin-heads {
  background: linear-gradient(145deg, #ffd700, #c4a000, #ffd700);
  color: #1a1200;
  box-shadow: 0 0 30px rgba(255, 215, 0, 0.3), inset 0 -4px 8px rgba(0, 0, 0, 0.2);
}

.coin-tails {
  background: linear-gradient(145deg, #e0c200, #9a7d00, #e0c200);
  color: #1a1200;
  transform: rotateY(180deg);
  box-shadow: 0 0 30px rgba(255, 215, 0, 0.3), inset 0 -4px 8px rgba(0, 0, 0, 0.2);
}

@keyframes coinFloat {
  0%, 100% { transform: translateY(0) rotateY(0); }
  50% { transform: translateY(-12px) rotateY(15deg); }
}

@keyframes coinSpin {
  0% { transform: rotateY(0deg); }
  100% { transform: rotateY(360deg); }
}

@media (max-width: 640px) {
  .coin-wrapper {
    width: 140px;
    height: 140px;
  }
  .coin-face {
    font-size: 2.8rem;
  }
}
</style>
