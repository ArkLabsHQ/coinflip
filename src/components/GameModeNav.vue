<template>
  <nav class="game-mode-nav" aria-label="Game modes">
    <RouterLink to="/" exact-active-class="active" aria-current-value="page">Play</RouterLink>
    <RouterLink to="/bankroll" exact-active-class="active" aria-current-value="page">Bankroll</RouterLink>
  </nav>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<style scoped>
.game-mode-nav {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--border-light);
  border-radius: 999px;
  background: var(--bg-elevated);
}
a {
  display: flex;
  align-items: center;
  min-height: 30px;
  padding: 4px 13px;
  border-radius: 999px;
  color: var(--text-dim);
  font-size: .78rem;
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
}
a:hover, a:focus-visible { color: var(--gold); }
a:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
a.active { background: rgba(247, 201, 72, .14); color: var(--gold); }
</style>
