<template>
  <div class="qr-wrapper" :style="{ width: size + 'px', height: size + 'px' }" @click="$emit('copy')" :title="title">
    <svg v-if="dataUrl" :viewBox="`0 0 ${cellCount} ${cellCount}`" :width="size" :height="size" xmlns="http://www.w3.org/2000/svg" class="qr-svg" preserveAspectRatio="xMidYMid meet">
      <rect width="100%" height="100%" fill="#ffffff" />
      <path :d="pathD" fill="#000000" />
    </svg>
    <div v-else class="qr-placeholder">…</div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, watch } from 'vue'
import QRCode from 'qrcode'

/**
 * A minimal QR renderer used by the wallet receive panel.
 *
 * We render to an SVG path via `qrcode`'s internal `create()` matrix —
 * smaller and crisper than the default raster output, and trivially
 * style-able. The QR is click-to-copy via the parent (`@copy` event).
 *
 * Margin is fixed at 1 module so the QR can sit tight inside its frame
 * without needing per-call tuning.
 */
export default defineComponent({
  name: 'QrCode',
  props: {
    value: { type: String, required: true },
    size: { type: Number, default: 256 },
    title: { type: String, default: 'Tap to copy' },
  },
  emits: ['copy'],
  setup(props) {
    const dataUrl = ref('')
    const pathD = ref('')
    const cellCount = ref(33) // Version-4 default; recomputed per render.

    async function rerender() {
      if (!props.value) {
        dataUrl.value = ''
        pathD.value = ''
        return
      }
      try {
        // `create` returns the raw bit matrix — much smaller than letting
        // qrcode rasterise to PNG. We then build an SVG path: one `M ... h1`
        // per black module.
        const qr = QRCode.create(props.value, { errorCorrectionLevel: 'M' })
        const modules = qr.modules
        cellCount.value = modules.size + 2 // include 1-module margin per side
        const path: string[] = []
        for (let y = 0; y < modules.size; y++) {
          for (let x = 0; x < modules.size; x++) {
            // `modules.get(x, y)` returns 1 for dark, 0 for light. The d.ts
            // exposes `data` directly — index is `y * size + x`.
            if (modules.data[y * modules.size + x]) {
              path.push(`M${x + 1},${y + 1}h1v1h-1z`)
            }
          }
        }
        pathD.value = path.join('')
        dataUrl.value = 'svg'
      } catch (e) {
        console.warn('[QrCode] render failed:', e instanceof Error ? e.message : e)
        dataUrl.value = ''
      }
    }

    watch(() => props.value, rerender, { immediate: true })

    return { dataUrl, pathD, cellCount }
  },
})
</script>

<style scoped>
.qr-wrapper {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: #fff;
  border-radius: 14px;
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.qr-wrapper:hover { box-shadow: 0 0 0 2px var(--gold-glow, rgba(247, 201, 72, 0.4)); }
.qr-wrapper:active { transform: scale(0.985); }
.qr-svg { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
.qr-placeholder {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  color: #94a3b8; font-size: 1rem;
}
</style>
