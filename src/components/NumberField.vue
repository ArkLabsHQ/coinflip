<template>
  <input
    ref="el"
    v-model="draft"
    class="number-field"
    type="text"
    inputmode="decimal"
    autocomplete="off"
    :size="Math.max(3, draft.length)"
    :disabled="disabled"
    :aria-label="ariaLabel"
    @focus="onFocus"
    @blur="onBlur"
    @keydown.enter.prevent="commitAndBlur"
    @keydown.esc.prevent="cancelAndBlur"
  />
</template>

<script lang="ts">
import { defineComponent, ref, watch, type PropType } from 'vue'

/**
 * A number input that holds its own DRAFT text and never writes the value it
 * displays — it only emits `commit`, and the parent decides what the number
 * means.
 *
 * That indirection is the whole point. The play view clamps `betAmount` and
 * `sliderIndex` into the live bet envelope from watchers, so binding an input
 * straight to either ref would rewrite the box mid-keystroke: typing "1" on the
 * way to "10000" clamps to the minimum instantly and eats the rest.
 *
 * `type="text"` rather than `type="number"`, because a number input cannot show
 * a grouped value like "7,777" and adds spinners nobody wants here. `inputmode`
 * still gets the numeric keypad on mobile. `size` tracks the draft length so the
 * field is exactly as wide as its content, with no parent CSS needed.
 */
export default defineComponent({
  name: 'NumberField',
  props: {
    modelValue: { type: Number, required: true },
    disabled: { type: Boolean, default: false },
    ariaLabel: { type: String, default: '' },
    /** How the value reads when the field is NOT focused, e.g. "7,777". */
    format: {
      type: Function as PropType<(n: number) => string>,
      default: (n: number) => String(n),
    },
  },
  emits: ['commit'],
  setup(props, { emit }) {
    const el = ref<HTMLInputElement | null>(null)
    const focused = ref(false)
    const draft = ref(props.format(props.modelValue))
    // Set while Escape is unwinding, so the blur it triggers doesn't commit.
    let cancelling = false

    // Re-sync when the value moves underneath us — the envelope clamps it from
    // the parent's watchers and the field has to show the corrected number.
    // Never while focused: that is the mid-keystroke rewrite this component
    // exists to prevent.
    watch(
      () => [props.modelValue, props.format] as const,
      () => { if (!focused.value) draft.value = props.format(props.modelValue) },
    )

    function onFocus() {
      focused.value = true
      // Raw while editing: grouped digits are hostile to type into.
      draft.value = String(props.modelValue)
      el.value?.select()
    }

    function commit() {
      focused.value = false
      const parsed = Number(draft.value.replace(/[,\s]/g, ''))
      // An empty or unparseable entry reverts instead of erroring. The player
      // can just retype, and committing a NaN (or zeroing the stake) would be
      // strictly worse than doing nothing.
      if (draft.value.trim() !== '' && Number.isFinite(parsed)) emit('commit', parsed)
      // Show the value we actually hold. If the parent clamps to something
      // else, the watcher above corrects this on the next tick.
      draft.value = props.format(props.modelValue)
    }

    function onBlur() {
      if (cancelling) {
        cancelling = false
        focused.value = false
        return
      }
      commit()
    }

    function commitAndBlur() { el.value?.blur() }

    function cancelAndBlur() {
      cancelling = true
      draft.value = props.format(props.modelValue)
      el.value?.blur()
    }

    return { el, draft, onFocus, onBlur, commitAndBlur, cancelAndBlur }
  },
})
</script>

<style scoped>
.number-field {
  /* Inherit the readout's own type so the field reads as the value it replaced,
     not as a form control bolted into the middle of it. */
  font: inherit;
  color: inherit;
  background: transparent;
  border: none;
  /* The dashed rule is the entire affordance that this number is typeable. */
  border-bottom: 1px dashed var(--border-light);
  padding: 0 1px;
  text-align: right;
  transition: border-color 0.18s;
}
.number-field:hover:not(:disabled) { border-bottom-color: var(--gold); }
.number-field:focus {
  outline: none;
  border-bottom-color: var(--gold);
  border-bottom-style: solid;
}
.number-field:disabled {
  border-bottom-color: transparent;
  opacity: 0.6;
}
</style>
