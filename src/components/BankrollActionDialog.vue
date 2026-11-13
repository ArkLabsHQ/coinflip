<template>
  <dialog ref="dialog" class="bankroll-dialog" aria-labelledby="bankroll-dialog-title" @cancel.prevent="$emit('close')" @click="backdrop">
    <div class="dialog-content">
      <header>
        <h2 id="bankroll-dialog-title">{{ title }}</h2>
        <button class="dialog-close" aria-label="Close preview" @click="$emit('close')">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </header>
      <slot />
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      <footer>
        <button class="btn-outline" @click="$emit('close')">{{ confirmLabel ? 'Cancel' : 'Close preview' }}</button>
        <button v-if="confirmLabel" class="btn-gold" :disabled="disabled" @click="$emit('confirm')">{{ confirmLabel }}</button>
      </footer>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ title: string; confirmLabel?: string; disabled?: boolean; error?: string }>()
const emit = defineEmits<{ (event: 'close'): void; (event: 'confirm'): void }>()
const dialog = ref<HTMLDialogElement>()
let previousFocus: HTMLElement | null = null
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
})
onBeforeUnmount(() => {
  dialog.value?.close()
  previousFocus?.focus()
})
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value) emit('close')
}
</script>

<style scoped>
.bankroll-dialog { width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); margin: auto; padding: 0; border: 1px solid var(--border-light); border-radius: 16px; background: var(--bg-elevated); color: var(--text); box-shadow: 0 20px 64px rgba(0,0,0,.48); }
.bankroll-dialog::backdrop { background: rgba(0,0,0,.72); }
.dialog-content { padding: 26px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
h2 { font-size: 1.25rem; letter-spacing: -.02em; }
.dialog-close { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--border-light); border-radius: 50%; background: transparent; color: var(--text-dim); cursor: pointer; flex-shrink: 0; }
svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; }
footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
.dialog-error { color: var(--red); margin-top: 18px; font-size: .85rem; }
button:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }
button:active:enabled { transform: scale(.97); }
@media(max-width:450px) {
  .dialog-content { padding: 22px; }
  footer { display: grid; grid-template-columns: 1fr; }
  footer button { min-height: 44px; }
}
</style>
