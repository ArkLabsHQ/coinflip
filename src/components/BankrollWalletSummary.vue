<template>
  <section class="wallet-pools" aria-label="Bankroll membership">
    <header><h3>Your bankroll positions</h3><p>Pool shares stay separate from your spendable wallet balance.</p></header>
    <div v-if="funded.descriptor || funded.pending" class="funded-position">
      <div class="position-title"><strong>{{ funded.name || 'Community bankroll' }}</strong><span>Funded pool</span></div>
      <template v-if="funded.verified"><div class="position-value">{{ format(funded.estimatedClaimSats) }} <small>sats estimated equity</small></div><p>{{ format(funded.memberShares) }} share units held in this wallet.</p></template>
      <p v-else>{{ funded.error || 'Verifying the pool and your shares…' }}</p>
      <p v-if="funded.pending">Your {{ funded.pending.kind === 'openGame' ? 'game' : 'membership operation' }} is {{ funded.pending.stage }}.</p>
      <p v-if="funded.recovery">{{ funded.recovery.reason }}</p>
    </div>
    <div v-if="watched.descriptor" class="watched-position">
      <div class="position-title"><strong>{{ watched.descriptor.name }}</strong><span>Watched vault</span></div>
      <template v-if="watched.status === 'ready'">
        <div class="position-value">{{ format(watched.estimatedClaimSats) }} <small>sats estimated equity</small></div>
        <p>{{ format(watched.memberShares) }} share units held in this wallet.</p>
      </template>
      <p v-else-if="watched.status === 'loading' || watched.status === 'validating'">Checking the vault and your shares…</p>
      <p v-else-if="watched.status === 'absent'">No current vault coin is indexed. This does not prove the pool has retired.</p>
      <p v-else>{{ watched.error || 'Connect your wallet to refresh this position.' }}</p>
      <span class="read-only">Observation only · live deposits unavailable</span>
    </div>
    <div class="practice-position">
      <div class="position-title"><strong>Community practice pool</strong><span>Simulated</span></div>
      <template v-if="session.memberShares > 0n">
        <div class="position-value">{{ format(memberValue) }} <small>practice sats</small></div>
        <p>{{ percent(ownershipBps) }} ownership. No Bitcoin is held in this practice position.</p>
      </template>
      <p v-else>Try contributing, explore wins and losses, and redeem practice shares without moving Bitcoin.</p>
    </div>
    <button class="btn-gold" @click="$emit('open-bankroll')">Open bankroll</button>
  </section>
</template>

<script setup lang="ts">
import { useBankrollPractice } from '@/services/bankrollPractice'
import { useBankrollPool } from '@/composables/useBankrollPool'
import { useFundedPool } from '@/composables/useFundedPool'

defineEmits<{ (event: 'open-bankroll'): void }>()
const { state: session, memberValue, ownershipBps } = useBankrollPractice()
const { state: watched } = useBankrollPool()
const { state: funded } = useFundedPool()
function format(value: bigint | string | null): string { return value === null ? '—' : BigInt(value).toLocaleString() }
function percent(value: bigint): string { return `${value / 100n}.${String(value % 100n).padStart(2, '0')}%` }
</script>

<style scoped>
.wallet-pools { display: grid; gap: 22px; }
h3 { font-size: 1.05rem; margin-bottom: 8px; }
p { color: var(--text-dim); font-size: .85rem; line-height: 1.6; }
.position-title { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
.position-title strong { font-size: .9rem; }
.position-title span, .read-only { font-size: .72rem; color: var(--gold); }
.position-value { font-family: var(--font-mono); font-size: 1.5rem; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
.position-value small { font-family: var(--font-sans); font-size: .75rem; color: var(--text-dim); }
.funded-position, .watched-position, .practice-position { border-top: 1px solid var(--border-light); padding-top: 20px; }
.read-only { display: block; margin-top: 12px; }
</style>
