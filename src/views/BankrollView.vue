<template>
  <main class="bankroll-page">
    <header class="bankroll-header">
      <div class="header-left"><RouterLink class="brand" to="/" aria-label="CoinFlip home"><svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="11"/><path d="M12 7v14m4-14v14M10 9h6a3 3 0 0 1 0 6h-6m2 0h5a2 2 0 0 1 0 4h-7"/></svg><span>CoinFlip</span></RouterLink><GameModeNav /></div>
      <button v-if="initialized" class="bankroll-wallet" @click="$emit('open-wallet')" :title="walletTitle"><span class="wallet-dot" :class="arkStatus"/><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h13v11H3zM3 5V3h11v2m-2 5h5v4h-5z"/></svg><span>{{ walletLabel }}</span><small v-if="balanceKnown">sats</small></button>
      <RouterLink v-else :to="setupRoute" class="connect-wallet">Set up wallet</RouterLink>
    </header>

    <div class="bankroll-heading"><div><h1>Bankroll</h1><p>Own a share of the table. Share its wins and its losses.</p></div><span class="availability-label"><span/>{{ view === 'practice' ? 'Practice sats' : view === 'watch' ? 'Read-only vault inspection' : 'Community house' }}</span></div>
    <div class="surface-tabs" role="tablist" aria-label="Bankroll view">
      <button id="pool-tab" role="tab" :aria-selected="view === 'pool'" aria-controls="pool-panel" :tabindex="view === 'pool' ? 0 : -1" @keydown="switchTab" @click="view = 'pool'">Community pool</button>
      <button id="practice-tab" role="tab" :aria-selected="view === 'practice'" aria-controls="practice-panel" :tabindex="view === 'practice' ? 0 : -1" @keydown="switchTab" @click="view = 'practice'">Practice pool<span>Simulated</span></button>
      <button id="watch-tab" role="tab" :aria-selected="view === 'watch'" aria-controls="watch-panel" :tabindex="view === 'watch' ? 0 : -1" @keydown="switchTab" @click="view = 'watch'">Watch a vault<span v-if="watched.descriptor">1 saved</span></button>
    </div>

    <section v-if="view === 'pool'" id="pool-panel" role="tabpanel" aria-labelledby="pool-tab"><FundedPoolPanel @open-wallet="$emit('open-wallet')" /></section>
    <section v-else-if="view === 'practice'" id="practice-panel" role="tabpanel" aria-labelledby="practice-tab">
      <div class="practice-note"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 9v5m0-8v1"/></svg><p>Practice sats only. Your wallet balance and Bitcoin stay untouched.</p><button @click="dialog = { kind: 'reset' }">Start over</button></div>
      <p v-if="storageWarning" class="storage-note" role="status">{{ storageWarning }}</p>
      <div class="pool-layout">
        <section class="pool-table" aria-labelledby="pool-equity-title">
          <div class="table-heading"><h2 id="pool-equity-title">Community practice pool</h2><span class="phase-pill">Between rounds</span></div>
          <div class="equity-line"><div><span class="field-label">Pool equity</span><p class="pool-amount">{{ sats(session.pool.navSats) }} <small>sats</small></p></div><span class="pool-change" :class="tone(poolNet)" aria-label="Pool result after fees">{{ signed(poolNet) }}<small>from rounds, after fees</small></span></div>
          <div class="equity-chart" role="img" :aria-label="`Pool equity over ${session.history.length} recorded updates, now ${sats(session.pool.navSats)} practice sats`">
            <div class="chart-values"><span>{{ sats(chart.max) }}</span><span>{{ sats(chart.min) }}</span></div>
            <svg viewBox="0 0 640 160" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="pool-equity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f7c948" stop-opacity=".13"/><stop offset="100%" stop-color="#f7c948" stop-opacity="0"/></linearGradient></defs><path d="M0 145H640M0 80H640M0 15H640" class="chart-grid"/><path :d="chart.area" fill="url(#pool-equity-fill)"/><polyline :points="chart.points" class="chart-line"/></svg>
            <div class="chart-caption"><span>{{ session.history.length >= 60 ? 'Recent updates' : 'Session start' }}</span><span>Latest update</span></div>
          </div>
          <div class="ownership-block"><div class="ownership-label"><strong>Your ownership</strong><span>{{ percent(ownershipBps) }}</span></div><div class="ownership-track" aria-hidden="true"><span :style="{ width: `${Number(ownershipBps) / 100}%` }"/></div><div class="ownership-key"><span><i/>You</span><span><i/>Founder and other members</span></div></div>
          <dl class="pool-terms"><div><dt>Operator performance fee</dt><dd>20% of new net profit</dd></div><div><dt>Losses to recover first</dt><dd>{{ sats(session.pool.carriedLossSats) }} sats</dd></div><div><dt>Fees paid this session</dt><dd>{{ sats(session.operatorFeesSats) }} sats</dd></div></dl>
        </section>

        <aside class="membership-ticket" aria-labelledby="membership-title">
          <div class="ticket-heading"><h2 id="membership-title">Your position</h2><svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="11"/><circle cx="14" cy="14" r="7"/><path d="M14 3v4m11 7h-4m-7 11v-4M3 14h4"/></svg></div>
          <p class="member-equity">{{ sats(memberValue) }} <small>practice sats</small></p>
          <p v-if="session.memberShares > 0n || session.contributedSats > 0n" class="member-result" :class="tone(memberPnl)">{{ signed(memberPnl) }} sats <span>your total result</span></p>
          <p v-else class="member-empty">Take a practice seat to see how pool ownership works.</p>
          <div class="ticket-tabs" role="group" aria-label="Position action"><button :class="{ selected: action === 'join' }" :aria-pressed="action === 'join'" @click="action = 'join'; formError = ''">Contribute</button><button :class="{ selected: action === 'redeem' }" :aria-pressed="action === 'redeem'" @click="action = 'redeem'; formError = ''">Redeem</button></div>
          <form v-if="action === 'join'" @submit.prevent="previewPractice">
            <label for="practice-contribution">Contribution <span>{{ sats(session.cashSats) }} practice sats available</span></label>
            <div class="amount-input"><input id="practice-contribution" v-model="contribution" inputmode="numeric" autocomplete="off" maxlength="24" :aria-invalid="!!(formError || joinIssue)" :aria-describedby="formError || joinIssue ? 'practice-amount-feedback' : undefined" @input="formError = ''"/><span>sats</span></div>
            <div class="quick-amounts"><button v-for="fraction in [25, 50, 100]" :key="fraction" type="button" @click="contribution = String(session.cashSats * BigInt(fraction) / 100n); formError = ''">{{ fraction === 100 ? 'Max' : `${fraction}%` }}</button></div>
            <div class="quote-line"><span>Ownership after contribution</span><strong>{{ practiceJoinQuote ? percent(practiceJoinQuote.ownershipBps) : '—' }}</strong></div>
            <button class="btn-gold ticket-primary" :disabled="!practiceJoinQuote">Preview contribution</button>
          </form>
          <form v-else @submit.prevent="previewPractice">
            <label for="practice-redemption">Shares to redeem <span>{{ percent(ownershipBps) }} of the pool owned</span></label>
            <div class="redemption-value"><strong>{{ redemptionPercent }}%</strong><span>of your shares</span></div>
            <input id="practice-redemption" v-model.number="redemptionPercent" type="range" min="1" max="100" step="1" :disabled="session.memberShares === 0n" @input="formError = ''"/>
            <div class="quote-line"><span>Estimated return</span><strong>{{ practiceRedeemQuote ? `${sats(practiceRedeemQuote.payoutSats)} sats` : '—' }}</strong></div>
            <p v-if="session.memberShares === 0n" class="small-note">Contribute practice sats first to receive shares.</p>
            <button class="btn-gold ticket-primary" :disabled="!practiceRedeemQuote">Preview redemption</button>
          </form>
          <p v-if="formError" id="practice-amount-feedback" class="form-error" role="alert">{{ formError }}</p>
          <p v-else-if="action === 'join' && joinIssue" id="practice-amount-feedback" class="form-hint">{{ joinIssue }}</p>
          <dl class="member-basis"><div><dt>Contributed</dt><dd>{{ sats(session.contributedSats) }} sats</dd></div><div><dt>Redeemed</dt><dd>{{ sats(session.redeemedSats) }} sats</dd></div></dl>
        </aside>
      </div>

      <section class="round-lab" aria-labelledby="round-title"><div><h2 id="round-title">See a round from the house side</h2><p>Choose a practice outcome. Profits pay the operator only after previous losses are recovered.</p></div><div class="round-controls"><label for="round-stake">Stake per side<div class="round-amount"><input id="round-stake" v-model="roundStake" inputmode="numeric" maxlength="24"/><span>sats</span></div></label><div class="round-buttons"><button @click="playRound('house')"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 13 4-4 3 3 5-7m-5 0h5v5"/></svg>House wins</button><button @click="playRound('player')"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 7 4 4 3-3 5 7m-5 0h5v-5"/></svg>Player wins</button><button @click="playRound('refund')">Refund</button></div></div><p v-if="roundError" class="form-error" role="alert">{{ roundError }}</p><p class="round-limit">At most {{ sats(session.pool.navSats * session.pool.maxStakeBps / 10_000n) }} practice sats per side at the current pool size.</p></section>

      <section class="pool-activity" aria-labelledby="activity-title"><div class="section-heading"><h2 id="activity-title">Pool activity</h2><span>Practice session</span></div><div v-if="!session.activity.length" class="activity-empty"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 5h16v22H8zM12 11h8m-8 5h8m-8 5h5"/></svg><h3>Your seat is waiting.</h3><p>Preview a contribution or explore a round. Every change will appear here.</p></div><button v-for="entry in session.activity" :key="entry.id" class="activity-row" @click="dialog = { kind: 'receipt', entry }"><span class="activity-symbol" :class="entry.kind === 'round' ? tone(entry.pnlSats) : ''"><svg viewBox="0 0 20 20" aria-hidden="true"><path v-if="entry.kind === 'join'" d="M10 3v14M3 10h14"/><path v-else-if="entry.kind === 'redeem'" d="M4 10h12m-5-5 5 5-5 5"/><circle v-else cx="10" cy="10" r="6"/></svg></span><span class="activity-description"><strong>{{ activityTitle(entry) }}</strong><small>{{ time(entry.at) }}<template v-if="entry.operatorFeeSats > 0n"> · {{ sats(entry.operatorFeeSats) }} sats operator fee</template></small></span><span class="activity-number" :class="entry.kind === 'round' ? tone(entry.pnlSats) : ''">{{ entry.kind === 'round' ? signed(entry.pnlSats) : sats(entry.amountSats) }}<small>sats{{ entry.kind === 'round' ? ' before fee' : '' }}</small></span><svg class="row-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 5 5-5 5"/></svg></button></section>
    </section>

    <section v-else id="watch-panel" role="tabpanel" aria-labelledby="watch-tab" class="watch-panel">
      <div class="watch-intro"><div><h2>{{ watched.descriptor?.name || 'Watch an existing vault' }}</h2><p>Verify a pool and see the shares held by your connected wallet. This view cannot sign or send transactions.</p></div><span class="watch-badge">Read only</span></div>
      <div v-if="!initialized" class="watch-empty"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 10h22v17H5zM5 10V6h18v4m-5 7h11v6H18z"/></svg><h3>Your wallet identifies your shares.</h3><p>Create or restore your wallet to check an existing vault. You can use the practice pool without one.</p><RouterLink :to="setupRoute" class="btn-gold">Set up wallet</RouterLink></div>
      <template v-else>
        <div v-if="arkStatus !== 'connected'" class="watch-message"><strong>Connect your wallet</strong><p>Open the wallet to connect to your selected network before importing a pool.</p><button class="btn-outline" @click="$emit('open-wallet')">Open wallet</button></div>
        <div v-if="watched.status === 'loading' || watched.status === 'validating'" class="watch-message" role="status" aria-live="polite"><span class="spinner"/><strong>{{ watched.status === 'validating' ? 'Verifying pool history and ownership…' : 'Refreshing the vault and your shares…' }}</strong><p>Amounts stay hidden until verification finishes.</p></div>
        <div v-else-if="watched.status === 'ready'" class="verified-pool"><div class="verified-heading"><span><span class="verified-dot"/>Verified on {{ watched.descriptor?.network }}</span><button @click="refreshPool">Refresh</button></div><dl class="watch-balances"><div><dt>Pool equity</dt><dd>{{ nullableSats(watched.navSats) }} <small>sats</small></dd></div><div><dt>Your estimated equity</dt><dd>{{ nullableSats(watched.estimatedClaimSats) }} <small>sats</small></dd></div><div><dt>Your available shares</dt><dd>{{ nullableSats(watched.availableShares) }} <small>units</small></dd></div></dl><p class="watch-freshness">Last verified {{ watched.verifiedAt ? time(watched.verifiedAt) : '—' }}. Shared pool equity is separate from your wallet balance.</p><div class="watch-quote"><div class="ticket-tabs" role="group" aria-label="Vault preview"><button :class="{ selected: watchAction === 'join' }" @click="watchAction = 'join'">Contribution estimate</button><button :class="{ selected: watchAction === 'redeem' }" @click="watchAction = 'redeem'">Redemption estimate</button></div><label v-if="watchAction === 'join'" for="vault-contribution">Contribution in sats<input id="vault-contribution" v-model="watchContribution" inputmode="numeric" maxlength="24"/></label><label v-else for="vault-redemption">{{ watchRedemptionPercent }}% of your available shares<input id="vault-redemption" v-model.number="watchRedemptionPercent" type="range" min="1" max="100"/></label><p v-if="watchQuote.error" class="form-hint">{{ watchQuote.error }}</p><button class="btn-outline" :disabled="!!watchQuote.error" @click="previewWatched">Preview estimate</button></div></div>
        <div v-else-if="watched.status === 'absent'" class="watch-message" role="status"><strong>No current vault coin is indexed</strong><p>The indexer may still be updating. This does not prove the pool has retired or that funds are gone.</p><button class="btn-outline" @click="refreshPool">Check again</button></div>
        <div v-else-if="watched.status === 'error' || watched.status === 'unavailable'" class="watch-message error-state" role="alert"><strong>{{ watched.status === 'unavailable' ? 'This vault needs recovery' : 'Pool verification failed' }}</strong><p>{{ watched.error }}</p><button class="btn-outline" @click="refreshPool">Try again</button></div>
        <details class="pool-import" :open="!watched.descriptor"><summary>{{ watched.descriptor ? 'Pool connection details' : 'Import a pool connection' }}</summary><p>Use the public connection details supplied by the pool operator. They contain its network and bootstrap proof, never a wallet key.</p><label for="pool-descriptor">Pool connection JSON</label><textarea id="pool-descriptor" v-model="descriptorText" rows="7" spellcheck="false" autocomplete="off" placeholder="Paste the pool's public connection details"/><p v-if="importError" class="form-error" role="alert">{{ importError }}</p><div class="import-actions"><button class="btn-outline" :disabled="arkStatus !== 'connected' || !descriptorText.trim() || poolBusy" @click="importPool">{{ poolBusy ? 'Verifying…' : 'Verify and watch pool' }}</button><button v-if="watched.descriptor" class="text-button" @click="pool.forget(); importError = ''">Forget pool</button></div></details>
      </template>
      <div class="live-boundary"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="8" width="12" height="9" rx="2"/><path d="M7 8V5a3 3 0 0 1 6 0v3"/></svg><div><strong>Live contributions and redemptions are unavailable.</strong><p>Pool transactions are still in development. You can inspect verified equity and estimate shares here; adding or withdrawing Bitcoin will come later.</p></div></div>
    </section>

    <footer class="bankroll-footer"><RouterLink to="/how-it-works">How CoinFlip works</RouterLink><span>Normal games use their own house bankroll.</span></footer>
    <p v-if="notice" class="bankroll-notice" role="status" aria-live="polite">{{ notice }}</p>

    <BankrollActionDialog v-if="dialog" :title="dialogTitle" :confirm-label="dialog.kind === 'practice' ? `Confirm practice ${dialog.action === 'join' ? 'contribution' : 'redemption'}` : dialog.kind === 'reset' ? 'Reset practice session' : undefined" :disabled="stalePreview" :error="dialogError" @close="closeDialog" @confirm="confirmAction">
      <template v-if="dialog.kind === 'practice'"><p class="preview-description">Practice only. No Bitcoin will be signed, sent or deposited.</p><dl class="preview-details"><div><dt>{{ dialog.action === 'join' ? 'Contribution' : 'You receive' }}</dt><dd>{{ sats(dialog.sats) }} sats</dd></div><div><dt>{{ dialog.action === 'join' ? 'Shares received' : 'Shares redeemed' }}</dt><dd>{{ sats(dialog.shares) }} units</dd></div><div><dt>Your ownership after</dt><dd>{{ percent(dialog.ownershipBps) }}</dd></div><div><dt>Pool equity after</dt><dd>{{ sats(dialog.nextPoolNavSats) }} sats</dd></div></dl><p v-if="stalePreview" class="form-error">The practice pool changed. Close this preview and request a new quote.</p></template>
      <template v-else-if="dialog.kind === 'watch'"><p class="preview-description">Read-only estimate. No transaction is prepared, signed or broadcast.</p><dl class="preview-details"><div><dt>{{ dialog.action === 'join' ? 'Contribution' : 'Estimated return' }}</dt><dd>{{ sats(dialog.sats) }} sats</dd></div><div><dt>{{ dialog.action === 'join' ? 'Estimated shares' : 'Shares to redeem' }}</dt><dd>{{ sats(dialog.shares) }} units</dd></div><div><dt>Based on verified data</dt><dd>{{ dialog.verifiedAt ? time(dialog.verifiedAt) : '—' }}</dd></div></dl><p class="preview-description">Actual spending requires a fresh quote and suitable share coins. Public pool transactions remain disabled.</p></template>
      <template v-else-if="dialog.kind === 'receipt'"><p class="preview-description">Simulated activity · {{ time(dialog.entry.at) }}</p><dl class="preview-details"><div><dt>{{ dialog.entry.kind === 'round' ? 'Stake per side' : 'Amount' }}</dt><dd>{{ sats(dialog.entry.amountSats) }} sats</dd></div><div v-if="dialog.entry.shareUnits !== undefined"><dt>{{ dialog.entry.kind === 'join' ? 'Shares received' : 'Shares redeemed' }}</dt><dd>{{ sats(dialog.entry.shareUnits) }} units</dd></div><div v-if="dialog.entry.kind === 'round'"><dt>Pool result before fee</dt><dd>{{ signed(dialog.entry.pnlSats) }} sats</dd></div><div><dt>Operator fee</dt><dd>{{ sats(dialog.entry.operatorFeeSats) }} sats</dd></div><div><dt>Your equity afterward</dt><dd>{{ sats(dialog.entry.memberValueSats) }} sats</dd></div></dl></template>
      <p v-else class="preview-description">Reset this device's practice cash, membership and activity. Your wallet, watched vault and Bitcoin will stay unchanged.</p>
    </BankrollActionDialog>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useStore } from 'vuex'
import type { BankrollOutcome } from 'arkade-coinflip/dist/bankroll.js'
import GameModeNav from '@/components/GameModeNav.vue'
import BankrollActionDialog from '@/components/BankrollActionDialog.vue'
import FundedPoolPanel from '@/components/FundedPoolPanel.vue'
import { PRACTICE_INITIAL_CAPITAL_SATS, useBankrollPractice, type PracticeActivity } from '@/services/bankrollPractice'
import { useBankrollPool } from '@/composables/useBankrollPool'

defineEmits<{ (event: 'open-wallet'): void }>()
const store = useStore()
const route = useRoute()
const router = useRouter()
const practice = useBankrollPractice()
const pool = useBankrollPool()
const { state: session, memberValue, ownershipBps, memberPnl, storageWarning } = practice
const { state: watched, descriptorText } = pool
const setupRoute = computed(() => ({ path: '/setup', query: { returnTo: '/bankroll', poolView: view.value === 'watch' ? 'watch' : 'pool' } }))
const initialized = computed(() => !!store.state.wallet?.isInitialized)
const arkStatus = computed(() => store.state.ark?.status || 'disconnected')
const balanceKnown = computed(() => arkStatus.value === 'connected' && store.state.ark?.balanceSynced === true)
const walletLabel = computed(() => balanceKnown.value ? Number(store.getters['ark/balance'] || 0).toLocaleString() : 'Wallet')
const walletTitle = computed(() => `Wallet · ${arkStatus.value}`)
const view = computed<'pool' | 'practice' | 'watch'>({
  get: () => route.query.view === 'watch' ? 'watch' : route.query.view === 'practice' ? 'practice' : 'pool',
  set: value => {
    const query = { ...route.query }
    if (value !== 'pool') query.view = value
    else delete query.view
    void router.replace({ path: route.path, query })
  },
})
const action = ref<'join' | 'redeem'>('join')
const contribution = ref('25000')
const redemptionPercent = ref(100)
const roundStake = ref('10000')
const formError = ref('')
const roundError = ref('')
const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(notice, value => {
  clearTimeout(noticeTimer)
  if (value) noticeTimer = setTimeout(() => { notice.value = '' }, 5000)
})
onBeforeUnmount(() => clearTimeout(noticeTimer))
const importError = ref('')
const watchAction = ref<'join' | 'redeem'>('join')
const watchContribution = ref('25000')
const watchRedemptionPercent = ref(100)
const dialogError = ref('')
type Dialog = { kind: 'practice'; action: 'join' | 'redeem'; version: number; sats: bigint; shares: bigint; ownershipBps: bigint; nextPoolNavSats: bigint }
  | { kind: 'watch'; action: 'join' | 'redeem'; sats: bigint; shares: bigint; verifiedAt: number | null }
  | { kind: 'receipt'; entry: PracticeActivity } | { kind: 'reset' }
const dialog = ref<Dialog | null>(null)
const stalePreview = computed(() => dialog.value?.kind === 'practice' && dialog.value.version !== session.value.version)
const poolBusy = computed(() => ['validating', 'loading'].includes(watched.value.status))
watch(watched, () => { if (dialog.value?.kind === 'watch') closeDialog() }, { flush: 'sync' })
const poolNet = computed(() => session.value.pool.navSats - PRACTICE_INITIAL_CAPITAL_SATS - session.value.contributedSats + session.value.redeemedSats)
const redeemUnits = computed(() => session.value.memberShares * percentageUnits(redemptionPercent.value) / 100n)
const practiceJoinQuote = computed(() => { try { return practice.quoteJoin(whole(contribution.value)) } catch { return null } })
const practiceRedeemQuote = computed(() => { try { return practice.quoteRedeem(redeemUnits.value) } catch { return null } })
const joinIssue = computed(() => { try { practice.quoteJoin(whole(contribution.value)); return '' } catch (error) { return errorText(error) } })
const dialogTitle = computed(() => {
  const value = dialog.value
  if (value?.kind === 'receipt') return activityTitle(value.entry)
  if (value?.kind === 'reset') return 'Start a fresh practice session?'
  if (value?.kind === 'watch') return 'Vault estimate'
  return value?.action === 'redeem' ? 'Review practice redemption' : 'Review practice contribution'
})
const chart = computed(() => {
  const history = session.value.history
  const values = history.map(point => point.navSats)
  const min = values.reduce((result, value) => value < result ? value : result, values[0])
  const max = values.reduce((result, value) => value > result ? value : result, values[0])
  const points = values.length === 1 ? [{ x: 0, y: 80 }, { x: 640, y: 80 }] : values.map((value, index) => ({
    x: index * 640 / (values.length - 1), y: max === min ? 80 : 145 - Number((value - min) * 13000n / (max - min)) / 100,
  }))
  return { min, max, points: points.map(point => `${point.x},${point.y}`).join(' '), area: `M${points[0].x},160 L${points.map(point => `${point.x},${point.y}`).join(' L')} L640,160 Z` }
})
const watchQuote = computed(() => {
  try {
    if (watched.value.status !== 'ready' || !watched.value.navSats || !watched.value.supply) throw new Error('Refresh the pool to request an estimate.')
    const nav = BigInt(watched.value.navSats), supply = BigInt(watched.value.supply)
    if (watchAction.value === 'join') {
      const sats = whole(watchContribution.value), shares = sats * supply / nav
      if (nav + sats > 1_000_000n || supply + shares > 1_000_000_000_000n || shares <= 0n) throw new Error('This contribution exceeds the experimental vault limits.')
      return { sats, shares, error: '' }
    }
    if (watched.value.availableShares === null) throw new Error('Your available shares have not been verified.')
    const shares = BigInt(watched.value.availableShares) * percentageUnits(watchRedemptionPercent.value) / 100n
    const sats = shares * nav / supply
    if (shares <= 0n || sats <= 0n) throw new Error('No redeemable shares at this amount.')
    if (shares < supply && nav - sats < 330n) throw new Error('This redemption would leave the vault below its minimum carrier.')
    return { sats, shares, error: '' }
  } catch (error) { return { sats: 0n, shares: 0n, error: errorText(error) } }
})
function sats(value: bigint): string { return value.toLocaleString() }
function nullableSats(value: string | null): string { return value === null ? '—' : BigInt(value).toLocaleString() }
function signed(value: bigint): string { return `${value > 0n ? '+' : value < 0n ? '−' : ''}${sats(value < 0n ? -value : value)}` }
function tone(value: bigint): string { return value > 0n ? 'positive' : value < 0n ? 'negative' : '' }
function percent(value: bigint): string { return `${value / 100n}.${String(value % 100n).padStart(2, '0')}%` }
function time(value: number): string { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value) }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'Please check the amount and try again.' }
function percentageUnits(value: number): bigint { return BigInt(Number.isFinite(value) ? Math.max(1, Math.min(100, Math.trunc(value))) : 1) }
function whole(text: string): bigint {
  const value = text.trim()
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value) || value.length > 24 || BigInt(value.replaceAll(',', '')) <= 0n) throw new Error('Enter a positive whole number of sats.')
  return BigInt(value.replaceAll(',', ''))
}
function activityTitle(entry: PracticeActivity): string {
  if (entry.kind === 'join') return 'Contribution confirmed'
  if (entry.kind === 'redeem') return 'Shares redeemed'
  return entry.outcome === 'house' ? 'House won the round' : entry.outcome === 'player' ? 'Player won the round' : 'Round refunded'
}
function closeDialog() { dialog.value = null; dialogError.value = '' }
function previewPractice() {
  formError.value = ''; dialogError.value = ''
  try {
    if (action.value === 'join') {
      const amount = whole(contribution.value), quote = practice.quoteJoin(amount)
      dialog.value = { kind: 'practice', action: 'join', version: session.value.version, sats: amount, shares: quote.mintedShares, ownershipBps: quote.ownershipBps, nextPoolNavSats: quote.nextPoolNavSats }
    } else {
      const quote = practice.quoteRedeem(redeemUnits.value)
      dialog.value = { kind: 'practice', action: 'redeem', version: session.value.version, sats: quote.payoutSats, shares: redeemUnits.value, ownershipBps: quote.ownershipBps, nextPoolNavSats: quote.nextPoolNavSats }
    }
  } catch (error) { formError.value = errorText(error) }
}
function confirmAction() {
  const value = dialog.value
  try {
    if (value?.kind === 'reset') { practice.reset(); notice.value = 'Practice session reset.' }
    if (value?.kind === 'practice') {
      if (value.action === 'join') practice.join(value.sats, value.version)
      else practice.redeemShares(value.shares, value.version)
      notice.value = value.action === 'join' ? `${sats(value.sats)} practice sats contributed.` : `${sats(value.sats)} practice sats returned to your cash.`
    }
    closeDialog()
  } catch (error) { dialogError.value = errorText(error) }
}
function playRound(outcome: BankrollOutcome) {
  roundError.value = ''
  try { practice.playRound(outcome, whole(roundStake.value)); notice.value = outcome === 'refund' ? 'Practice round refunded.' : 'Practice round settled. Pool equity and fees updated.' }
  catch (error) { roundError.value = errorText(error) }
}
function switchTab(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const tabs = ['pool', 'practice', 'watch'] as const
  const index = tabs.indexOf(view.value)
  view.value = event.key === 'Home' ? 'pool' : event.key === 'End' ? 'watch' : tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % tabs.length]
  requestAnimationFrame(() => document.getElementById(`${view.value}-tab`)?.focus())
}
async function importPool() { importError.value = ''; try { await pool.importDescriptor(descriptorText.value) } catch (error) { importError.value = errorText(error) } }
async function refreshPool() { importError.value = ''; try { await pool.refresh() } catch (error) { importError.value = errorText(error) } }
function previewWatched() {
  if (watchQuote.value.error) return
  dialog.value = { kind: 'watch', action: watchAction.value, sats: watchQuote.value.sats, shares: watchQuote.value.shares, verifiedAt: watched.value.verifiedAt }
}
</script>

<style scoped>
.bankroll-page { max-width: 1160px; width: 100%; margin: 0 auto; padding: 26px 30px 42px; }
.bankroll-header, .header-left, .bankroll-wallet, .brand { display: flex; align-items: center; }
.bankroll-header { justify-content: space-between; gap: 18px; margin-bottom: 50px; }
.header-left { gap: 32px; }.brand { gap: 9px; color: var(--text); text-decoration: none; font-weight: 750; letter-spacing: -.025em; font-size: 1.15rem; }
svg { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.brand svg { width: 28px; height: 28px; color: var(--gold); }
.bankroll-wallet { gap: 8px; padding: 8px 12px; border: 1px solid var(--border-light); border-radius: 999px; background: var(--bg-elevated); color: var(--text); font-family: var(--font-mono); font-size: .82rem; cursor: pointer; white-space: nowrap; }
.bankroll-wallet svg { width: 18px; height: 18px; color: var(--text-dim); }.bankroll-wallet small { color: var(--text-dim); font-family: var(--font-sans); font-size: .7rem; }
.wallet-dot, .availability-label>span, .verified-dot { width: 6px; height: 6px; display: inline-block; border-radius: 50%; background: var(--text-dim); }.wallet-dot.connected, .verified-dot { background: var(--green); }.wallet-dot.connecting { background: var(--gold); }.wallet-dot.error { background: var(--red); }
.connect-wallet { color: var(--gold); text-decoration: none; font-size: .8rem; font-weight: 650; }
.bankroll-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 30px; }h1 { font-size: clamp(2rem,4.3vw,2.8rem); letter-spacing: -.035em; line-height: 1.1; margin-bottom: 10px; }.bankroll-heading p { color: var(--text-dim); font-size: .95rem; }
.availability-label { display: flex; align-items: center; gap: 7px; color: var(--text-dim); font-size: .72rem; white-space: nowrap; margin-bottom: 3px; }
.surface-tabs { display: flex; gap: 28px; border-bottom: 1px solid var(--border-light); margin-bottom: 22px; }.surface-tabs button { background: none; border: 0; color: var(--text-dim); padding: 0 0 14px; font-size: .86rem; cursor: pointer; position: relative; }.surface-tabs button[aria-selected=true] { color: var(--text); }.surface-tabs button[aria-selected=true]::after { content: ''; position: absolute; height: 2px; background: var(--gold); bottom: -1px; left: 0; right: 0; }.surface-tabs button>span { display: inline-block; font-size: .62rem; color: var(--gold); background: rgba(247,201,72,.09); border-radius: 4px; padding: 2px 5px; margin-left: 8px; }
.practice-note { display: flex; align-items: center; gap: 8px; color: var(--text-dim); margin-bottom: 22px; font-size: .75rem; }.practice-note svg { width: 16px; height: 16px; flex-shrink: 0; }.practice-note button { margin-left: auto; padding: 4px 0 4px 10px; color: var(--text-dim); background: none; border: 0; text-decoration: underline; text-underline-offset: 3px; font-size: .72rem; white-space: nowrap; cursor: pointer; }.storage-note { color: var(--gold); margin: -8px 0 20px; font-size: .8rem; }
.pool-layout { display: grid; grid-template-columns: minmax(0,1.7fr) minmax(290px,1fr); gap: 24px; align-items: start; }.pool-table { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 16px; padding: 26px 28px; min-width: 0; }
.table-heading, .ticket-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; }h2 { font-size: 1rem; font-weight: 650; letter-spacing: -.015em; }.phase-pill { font-size: .64rem; color: var(--text-dim); padding: 4px 8px; border: 1px solid var(--border-light); border-radius: 999px; white-space: nowrap; }
.equity-line { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-top: 30px; }.field-label { color: var(--text-dim); font-size: .72rem; }.pool-amount { font-family: var(--font-mono); font-size: clamp(1.7rem,3.3vw,2.35rem); letter-spacing: -.025em; font-variant-numeric: tabular-nums; margin-top: 6px; }.pool-amount small { font-size: .72rem; color: var(--text-dim); font-family: var(--font-sans); letter-spacing: 0; }.pool-change { font-family: var(--font-mono); font-size: .9rem; text-align: right; }.pool-change small { display: block; font-family: var(--font-sans); color: var(--text-dim); font-size: .65rem; margin-top: 4px; }
.equity-chart { position: relative; margin: 28px 0; padding-left: 51px; }.equity-chart>svg { width: 100%; height: 145px; display: block; overflow: visible; }.chart-grid { stroke: var(--border-light); stroke-width: .5; stroke-dasharray: 3 5; }.chart-line { stroke: var(--gold); stroke-width: 2; vector-effect: non-scaling-stroke; fill: none; }.chart-values { position: absolute; left: 0; top: 12px; bottom: 30px; display: flex; flex-direction: column; justify-content: space-between; gap: 10px; color: var(--text-dim); font-size: .59rem; font-family: var(--font-mono); }.chart-caption { display: flex; justify-content: space-between; color: var(--text-dim); font-size: .62rem; margin-top: 8px; }
.ownership-block { margin-top: 24px; }.ownership-label, .ownership-key { display: flex; justify-content: space-between; align-items: center; }.ownership-label { font-size: .76rem; }.ownership-label strong { font-weight: 500; }.ownership-label>span { font-family: var(--font-mono); color: var(--gold); }.ownership-track { height: 8px; border-radius: 3px; background: #30303e; margin: 12px 0 10px; overflow: hidden; }.ownership-track>span { height: 100%; display: block; background: var(--gold); }.ownership-key { font-size: .65rem; color: var(--text-dim); gap: 14px; }.ownership-key span { display: inline-flex; align-items: center; gap: 6px; }.ownership-key i { width: 6px; height: 6px; background: var(--gold); border-radius: 1px; }.ownership-key span+span i { background: #6b6b80; }
.pool-terms, .member-basis { margin-top: 27px; font-size: .74rem; }.pool-terms>div, .member-basis>div { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; padding-top: 11px; }.pool-terms { border-top: 1px solid var(--border-light); padding-top: 9px; }dt { color: var(--text-dim); }dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.membership-ticket { padding: 25px; border-radius: 16px; background: var(--bg-elevated); min-width: 0; }.ticket-heading svg { height: 28px; width: 28px; color: var(--gold); }.member-equity { font-family: var(--font-mono); font-size: 1.9rem; font-variant-numeric: tabular-nums; margin-top: 23px; letter-spacing: -.02em; }.member-equity small { display: block; color: var(--text-dim); font-family: var(--font-sans); font-size: .7rem; margin-top: 2px; letter-spacing: 0; }.member-result, .member-empty { font-size: .75rem; min-height: 36px; margin-top: 12px; color: var(--text-dim); }.member-result span { color: var(--text-dim); margin-left: 4px; }.ticket-tabs { display: flex; gap: 3px; border-bottom: 1px solid var(--border-light); margin: 14px 0 22px; }.ticket-tabs button { flex: 1; border: 0; background: none; color: var(--text-dim); padding: 11px 2px; cursor: pointer; font-size: .76rem; }.ticket-tabs .selected { color: var(--gold); box-shadow: inset 0 -2px var(--gold); }
label { display: block; font-size: .77rem; color: var(--text); }label>span { display: block; color: var(--text-dim); font-size: .66rem; margin-top: 4px; }.amount-input { display: flex; align-items: center; gap: 10px; margin-top: 11px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 8px; padding: 12px; }.amount-input:focus-within { border-color: var(--gold); }.amount-input input { border: 0; background: none; width: 100%; min-width: 0; font-family: var(--font-mono); font-size: 1.15rem; color: var(--text); outline: 0; }.amount-input>span { color: var(--text-dim); font-size: .7rem; }.quick-amounts { display: flex; gap: 7px; margin-top: 10px; }.quick-amounts button { flex: 1; padding: 6px; background: transparent; border: 1px solid var(--border-light); border-radius: 5px; color: var(--text-dim); font-size: .66rem; cursor: pointer; }.quote-line { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin: 20px 0; font-size: .69rem; color: var(--text-dim); }.quote-line strong { color: var(--text); font-family: var(--font-mono); font-weight: 500; text-align: right; }.ticket-primary { width: 100%; font-size: .79rem; padding: 12px 8px; }
.member-basis { border-top: 1px solid var(--border-light); padding-top: 9px; margin-top: 22px; font-size: .67rem; }.form-error { color: var(--red); font-size: .77rem; margin-top: 12px; }.form-hint, .small-note { color: var(--text-dim); font-size: .72rem; line-height: 1.65; margin-top: 12px; }.redemption-value { display: flex; align-items: baseline; gap: 8px; margin: 16px 0; }.redemption-value strong { font-family: var(--font-mono); font-size: 1.3rem; }.redemption-value span { color: var(--text-dim); font-size: .7rem; }input[type=range] { width: 100%; accent-color: var(--gold); min-height: 28px; }
.round-lab { margin-top: 30px; padding: 25px 0; border-top: 1px solid var(--border-light); border-bottom: 1px solid var(--border-light); }.round-lab>div:first-child p { max-width: 65ch; font-size: .78rem; line-height: 1.65; color: var(--text-dim); margin-top: 7px; }.round-controls { display: flex; align-items: end; gap: 18px; margin-top: 19px; }.round-controls label { min-width: 145px; font-size: .68rem; }.round-amount { margin-top: 6px; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border-light); border-radius: 7px; }.round-amount input { background: none; border: 0; color: var(--text); font-family: var(--font-mono); width: 105px; min-width: 0; outline: 0; }.round-amount:focus-within { border-color: var(--gold); }.round-amount span { color: var(--text-dim); font-size: .65rem; }.round-buttons { display: flex; flex-wrap: wrap; gap: 8px; }.round-buttons button { display: flex; gap: 7px; align-items: center; padding: 10px 13px; background: var(--bg-elevated); border: 1px solid var(--border-light); border-radius: 7px; color: var(--text); font-size: .73rem; cursor: pointer; }.round-buttons svg { width: 16px; height: 16px; }.round-limit { font-size: .65rem; color: var(--text-dim); margin-top: 12px; }
.pool-activity { margin-top: 28px; }.section-heading>span { font-size: .7rem; color: var(--text-dim); }.activity-empty { text-align: center; padding: 37px 20px 30px; }.activity-empty>svg { width: 30px; height: 30px; color: var(--text-dim); margin-bottom: 13px; }.activity-empty h3 { font-size: .9rem; font-weight: 550; }.activity-empty p { color: var(--text-dim); font-size: .76rem; margin-top: 7px; }.activity-row { width: 100%; display: flex; align-items: center; gap: 13px; padding: 18px 2px; border: 0; border-bottom: 1px solid var(--border-light); color: var(--text); text-align: left; background: none; cursor: pointer; }.activity-symbol { width: 32px; height: 32px; display: grid; place-items: center; background: var(--bg-elevated); border-radius: 50%; color: var(--gold); flex-shrink: 0; }.activity-symbol svg { width: 17px; height: 17px; }.activity-description { display: flex; flex-direction: column; min-width: 0; gap: 4px; }.activity-description strong { font-size: .78rem; font-weight: 550; }.activity-description small { font-size: .64rem; color: var(--text-dim); }.activity-number { display: flex; flex-direction: column; gap: 3px; text-align: right; margin-left: auto; font-family: var(--font-mono); font-size: .86rem; white-space: nowrap; }.activity-number small { color: var(--text-dim); font-family: var(--font-sans); font-size: .61rem; }.row-chevron { width: 16px; height: 16px; flex-shrink: 0; color: var(--text-dim); }
.positive { color: var(--green); }.negative { color: var(--red); }.bankroll-footer { display: flex; justify-content: space-between; gap: 20px; font-size: .7rem; color: var(--text-dim); margin-top: 35px; }.bankroll-footer a { color: var(--text-dim); text-underline-offset: 4px; }.bankroll-notice { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px); background: var(--bg-elevated); border: 1px solid var(--border-light); padding: 11px 17px; border-radius: 9px; font-size: .76rem; box-shadow: 0 7px 25px rgba(0,0,0,.3); z-index: 60; pointer-events: none; }
.preview-description { color: var(--text-dim); font-size: .85rem; line-height: 1.65; margin-bottom: 18px; }.preview-details>div { display: flex; align-items: baseline; justify-content: space-between; gap: 25px; padding: 13px 0; border-bottom: 1px solid var(--border-light); font-size: .8rem; }.preview-details dd { font-family: var(--font-mono); font-size: .78rem; overflow-wrap: anywhere; }.preview-details+.preview-description { margin-top: 20px; }
.watch-panel { padding-bottom: 10px; }.watch-intro { display: flex; justify-content: space-between; align-items: start; gap: 24px; padding: 16px 0 28px; }.watch-intro h2 { font-size: 1.3rem; }.watch-intro p { color: var(--text-dim); max-width: 65ch; font-size: .85rem; margin-top: 10px; line-height: 1.7; }.watch-badge { font-size: .7rem; color: var(--blue); white-space: nowrap; border: 1px solid var(--border-light); border-radius: 5px; padding: 5px 8px; }.watch-empty { padding: 35px 20px 45px; text-align: center; background: var(--bg-card); border-radius: 14px; }.watch-empty>svg { width: 32px; height: 32px; color: var(--gold); margin-bottom: 18px; }.watch-empty h3 { font-size: 1.1rem; }.watch-empty p { color: var(--text-dim); max-width: 50ch; margin: 12px auto 23px; line-height: 1.7; font-size: .85rem; }.watch-message { padding: 23px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; margin-bottom: 20px; }.watch-message strong { font-size: .95rem; }.watch-message p { color: var(--text-dim); font-size: .82rem; line-height: 1.7; margin: 9px 0 18px; }.watch-message .spinner { display: inline-block; margin-right: 10px; vertical-align: middle; }.error-state strong { color: var(--red); }
.verified-pool { padding: 24px; border: 1px solid var(--border-light); border-radius: 14px; }.verified-heading { display: flex; justify-content: space-between; gap: 20px; font-size: .75rem; }.verified-heading>span { color: var(--green); display: inline-flex; gap: 7px; align-items: center; }.verified-heading>button { background: transparent; border: 0; color: var(--text-dim); cursor: pointer; text-decoration: underline; text-underline-offset: 4px; }.watch-balances { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 25px; margin-top: 28px; }.watch-balances dt { font-size: .74rem; }.watch-balances dd { text-align: left; font-family: var(--font-mono); font-size: 1.6rem; margin-top: 8px; overflow-wrap: anywhere; }.watch-balances small { font-family: var(--font-sans); color: var(--text-dim); font-size: .7rem; }.watch-freshness { color: var(--text-dim); font-size: .69rem; margin-top: 24px; }.watch-quote { max-width: 440px; margin-top: 26px; border-top: 1px solid var(--border-light); }.watch-quote input:not([type=range]) { display: block; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border-light); padding: 12px; border-radius: 7px; font-family: var(--font-mono); margin: 10px 0 18px; }.watch-quote>button { margin-top: 18px; }
.pool-import { margin-top: 24px; padding: 20px 0; border-top: 1px solid var(--border-light); }.pool-import summary { font-size: .86rem; cursor: pointer; }.pool-import p { color: var(--text-dim); font-size: .8rem; line-height: 1.7; max-width: 70ch; margin: 16px 0; }.pool-import label { color: var(--text-dim); font-size: .73rem; margin-bottom: 9px; }.pool-import textarea { width: 100%; resize: vertical; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 8px; color: var(--text); padding: 14px; font-family: var(--font-mono); font-size: .73rem; }.import-actions { display: flex; align-items: center; gap: 20px; margin-top: 14px; }.text-button { color: var(--text-dim); background: none; border: 0; cursor: pointer; font-size: .75rem; }.live-boundary { display: flex; gap: 14px; margin-top: 26px; padding-top: 22px; border-top: 1px solid var(--border-light); }.live-boundary>svg { width: 21px; height: 21px; flex-shrink: 0; color: var(--text-dim); }.live-boundary strong { font-size: .8rem; font-weight: 550; }.live-boundary p { color: var(--text-dim); max-width: 80ch; font-size: .76rem; line-height: 1.7; margin-top: 7px; }
.bankroll-page :is(button,a,input,textarea,summary):focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }.bankroll-page :is(input,textarea) { caret-color: var(--gold); }.bankroll-page ::selection { color: var(--bg); background: var(--gold); }.bankroll-page button { font-family: var(--font-sans); transition: background-color 160ms ease-out, border-color 160ms ease-out, transform 120ms ease-out; }.bankroll-page button:active:enabled { transform: scale(.97); }.bankroll-page button:disabled { cursor: not-allowed; }.bankroll-page input::placeholder, .bankroll-page textarea::placeholder { color: var(--text-dim); opacity: 1; }
@media(hover:hover) and (pointer:fine) { .activity-row:hover { background: var(--bg-card); }.quick-amounts button:hover,.round-buttons button:hover,.bankroll-wallet:hover { border-color: var(--gold); }.surface-tabs button:hover,.text-button:hover { color: var(--gold); } }
@media(max-width:850px) { .pool-layout { gap: 18px; grid-template-columns: minmax(0,1.4fr) minmax(275px,1fr); }.pool-table { padding: 23px 20px; }.membership-ticket { padding: 23px 20px; }.header-left { gap: 20px; }.pool-change small { max-width: 90px; }.pool-amount { font-size: 1.75rem; } }
@media(max-width:680px) { .bankroll-page { padding: 18px 18px 34px; }.bankroll-header { margin-bottom: 34px; }.brand span { display: none; }.header-left { gap: 12px; }.brand svg { width: 25px; height: 25px; }.bankroll-heading { display: block; margin-bottom: 25px; }.bankroll-heading p { font-size: .84rem; }.availability-label { margin-top: 16px; }.pool-layout { display: flex; flex-direction: column; }.pool-table,.membership-ticket { width: 100%; }.pool-table { padding: 23px; }.membership-ticket { padding: 25px; }.equity-chart { margin-top: 25px; }.member-empty,.member-result { min-height: 0; margin-bottom: 20px; }.round-controls { align-items: start; flex-direction: column; gap: 15px; }.round-controls label { width: 100%; }.round-amount input { width: 100%; }.round-buttons { width: 100%; }.round-buttons button { flex: 1; justify-content: center; font-size: .7rem; padding: 10px 7px; }.practice-note { align-items: start; font-size: .69rem; }.practice-note svg { margin-top: 2px; }.activity-row { gap: 10px; }.activity-description strong { font-size: .73rem; }.activity-description small { font-size: .58rem; }.activity-number { font-size: .77rem; }.row-chevron { display: none; }.bankroll-footer { flex-direction: column; gap: 9px; }.watch-balances { grid-template-columns: 1fr; gap: 22px; }.watch-balances dd { font-size: 1.5rem; }.watch-intro { gap: 16px; }.verified-pool { padding: 20px; }.bankroll-notice { bottom: 14px; font-size: .7rem; } }
@media(max-width:370px) { .bankroll-page { padding-left: 14px; padding-right: 14px; }.brand { display: none; }.bankroll-wallet { padding: 8px; font-size: .75rem; }.surface-tabs { gap: 20px; }.pool-table { padding: 20px; }.pool-amount { font-size: 1.6rem; }.table-heading h2 { font-size: .88rem; }.phase-pill { font-size: .59rem; }.ownership-key { font-size: .6rem; } }
@media(prefers-reduced-motion:reduce) { .bankroll-page *, .bankroll-page *::before, .bankroll-page *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
@media(max-width:680px) { .membership-ticket { order: -1; } }
</style>
