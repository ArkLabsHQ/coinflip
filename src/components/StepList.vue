<template>
  <div class="steps">
    <div v-for="(s, i) in steps" :key="i" class="step">
      <div class="step-n mono">{{ i + 1 }}</div>
      <div class="step-main">
        <div class="ops">
          <span v-for="(t, j) in s.ops" :key="j" class="tok" :class="tokClass(t)">{{ t }}</span>
        </div>
        <div class="step-explain">{{ s.explain }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// A numbered list of script steps: each step is an opcode row (framed) plus a
// plain-language explanation. Rendered from a template (not a render function)
// so the SFC's scoped styles actually apply to these elements.
interface Step { ops: string[]; explain: string }
defineProps<{ steps: Step[] }>()

function tokClass(t: string): string {
  if (t.startsWith('<') || t.startsWith('‹')) return 'tok-var'
  if (t.startsWith('OP_INSPECT') || t === 'OP_PUSHCURRENTINPUTINDEX') return 'tok-arkade'
  return 'tok-op'
}
</script>

<style scoped lang="scss">
.steps { display: flex; flex-direction: column; gap: 8px; }
.step {
  display: flex; gap: 11px; align-items: flex-start;
  background: var(--bg-subtle); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 11px 12px;
}
.step-n {
  flex-shrink: 0; width: 22px; height: 22px; margin-top: 1px;
  display: flex; align-items: center; justify-content: center; border-radius: 50%;
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  font-size: 0.72rem; font-weight: 700; color: var(--text-muted);
}
.step-main { flex: 1; min-width: 0; }
.ops {
  display: flex; flex-wrap: wrap; gap: 5px;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-xs);
  padding: 8px 9px;
}
.step-explain { font-size: 0.82rem; color: var(--text-dim); line-height: 1.55; margin-top: 8px; }
.tok {
  font-family: var(--font-mono); font-size: 0.72rem; padding: 3px 6px; border-radius: 4px; line-height: 1.5;
}
.tok-op { color: var(--text-dim); background: var(--bg-elevated); }
.tok-var { color: var(--blue); background: rgba(56, 189, 248, 0.1); }
.tok-arkade { color: var(--gold); background: var(--gold-glow); font-weight: 600; }
.mono { font-family: var(--font-mono); }
</style>
