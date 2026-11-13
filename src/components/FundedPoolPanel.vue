<template>
  <section class="funded-pool" aria-labelledby="funded-pool-title">
    <header class="pool-header">
      <div><h2 id="funded-pool-title">{{ state.name || 'Community bankroll' }}</h2><p>Back the house, share its results, or play against this pool.</p></div>
      <span class="pool-network">{{ state.network || (state.status === 'unconfigured' ? 'Pool awaiting setup' : 'Connect your wallet') }}</span>
    </header>

    <div v-if="!initialized" class="pool-message">
      <h3>Your wallet holds your pool shares.</h3><p>Create or restore a wallet to contribute, redeem, or place a bet. Practice is available without one.</p>
      <RouterLink :to="setupRoute" class="btn-gold">Set up wallet</RouterLink>
    </div>
    <div v-else-if="state.status === 'disconnected'" class="pool-message">
      <h3>Connect to your selected network.</h3><p>Pool balances and actions appear after your wallet has synchronized.</p>
      <button class="btn-outline" @click="$emit('open-wallet')">Open wallet</button>
    </div>
    <div v-else-if="state.status === 'loading' && !state.verified" class="pool-message" role="status"><span class="spinner"/><h3>Verifying the pool and your shares…</h3><p>Checking the contract, bootstrap, and current state before showing amounts.</p></div>
    <div v-else-if="!state.verified && !state.pending" class="pool-message" :role="state.error ? 'alert' : 'status'">
      <h3>{{ state.status === 'unconfigured' ? 'The operator has not opened this pool yet.' : 'The pool is temporarily unavailable.' }}</h3>
      <p>{{ state.error || 'An operator must seed the community bankroll before members can join.' }}</p><button class="btn-outline" :disabled="busy" @click="refresh">Check again</button>
    </div>

    <template v-if="initialized && (state.verified || state.pending)">
      <p v-if="state.fairnessTrust === 'operator'" class="fairness-notice">Game fairness depends on the casino operator. An operator cooperating with a bettor can force losses onto pool members. The contract enforces payouts and shares; it does not prevent that collusion.</p>
      <div v-if="state.pending" class="pending-operation" role="status" aria-live="polite">
        <span class="spinner"/><div><strong>{{ pendingTitle }}</strong><p>{{ state.pending.error || 'Keep this operation here while its exact transaction is reconciled. Its inputs stay reserved.' }}</p><code v-if="state.pending.arkTxid">{{ shortId(state.pending.arkTxid) }}</code></div>
        <button class="btn-outline" :disabled="busy" @click="refresh">Check status</button>
      </div>
      <div v-if="state.recovery" class="recovery-message" role="alert"><strong>This operation needs recovery.</strong><p>{{ state.recovery.reason }}</p><button class="btn-outline" :disabled="busy" @click="recover">Resume recovery</button></div>
      <div v-if="state.capabilities.rescue" class="recovery-message" role="status"><strong>The pool is due for renewal.</strong><p>Its batch is close to expiry and new operations are paused. Any member can renew it unchanged: the pool balance and every member's shares stay exactly as they are. Normally the casino does this; use it if the casino is offline.</p><button class="btn-outline" :disabled="busy" @click="rescue">Renew pool now</button></div>
      <p v-if="state.error && state.verified && !state.pending && !state.capabilities.rescue" class="error-message" role="alert">{{ state.error }} <button @click="refresh">Retry</button></p>

      <div class="pool-columns">
        <section class="pool-position" aria-labelledby="pool-position-title">
          <div class="position-heading"><h3 id="pool-position-title">Your position</h3><span>{{ phaseLabel }}</span></div>
          <p class="position-amount">{{ format(state.estimatedClaimSats) }} <small>sats equity</small></p>
          <div class="position-ownership"><span>Your ownership</span><strong>{{ ownership }}</strong></div>
          <div class="ownership-track" aria-hidden="true"><span :style="{ width: ownership === '—' ? '0%' : ownership }"/></div>
          <dl class="pool-details">
            <div><dt>Pool equity</dt><dd>{{ format(state.navSats) }} sats</dd></div>
            <div><dt>Your shares</dt><dd>{{ format(state.memberShares) }} units</dd></div>
            <div><dt>Available to redeem</dt><dd>{{ format(state.availableShares) }} units</dd></div>
            <div><dt>Operator performance fee</dt><dd>{{ bps(state.operatorFeeBps) }}</dd></div>
            <div><dt>Minimum expected house margin</dt><dd>{{ bps(state.minHouseEdgeBps) }} before costs</dd></div>
            <div><dt>Losses to recover first</dt><dd>{{ format(state.carriedLossSats) }} sats</dd></div>
            <div><dt>Accrued operator fees</dt><dd>{{ format(state.accruedFeesSats) }} sats</dd></div>
          </dl>
          <p class="position-note">Your shares participate in gains and losses. Pool equity excludes player stakes, accrued operator fees, and the operator’s output reserve.</p>
          <p v-if="state.verifiedAt" class="verified-at">Verified {{ date(state.verifiedAt) }} <button :disabled="busy" @click="refresh">Refresh</button></p>
        </section>

        <section class="pool-membership" aria-label="Manage pool membership">
          <div class="action-tabs" role="group" aria-label="Membership action"><button :aria-pressed="action === 'subscribe'" @click="action = 'subscribe'; error = ''">Contribute</button><button :aria-pressed="action === 'redeem'" @click="action = 'redeem'; error = ''">Redeem</button></div>
          <form v-if="action === 'subscribe'" @submit.prevent="prepareMembership">
            <label for="funded-contribution">Contribution in sats</label><input id="funded-contribution" v-model="contribution" inputmode="numeric" autocomplete="off" maxlength="24" :disabled="busy"/>
            <p class="input-note">Receive shares at the verified pool price. Contributions are capital, rather than operator revenue.</p>
            <button class="btn-gold" :disabled="busy || !state.capabilities.subscribe">{{ busy ? 'Preparing…' : 'Preview contribution' }}</button>
          </form>
          <form v-else @submit.prevent="prepareMembership">
            <label for="funded-redemption">{{ redeemPercent }}% of available shares</label><input id="funded-redemption" v-model.number="redeemPercent" type="range" min="1" max="100" step="1" :disabled="busy || !state.capabilities.redeem"/>
            <dl class="membership-preview"><div><dt>Shares to redeem</dt><dd>{{ format(redeemShares.toString()) }} units</dd></div><div><dt>Estimated return</dt><dd>{{ redemptionEstimate }} sats</dd></div></dl>
            <button class="btn-gold" :disabled="busy || !state.capabilities.redeem || redeemShares === 0n">{{ busy ? 'Preparing…' : 'Preview redemption' }}</button>
          </form>
          <p v-if="state.phase && state.phase !== 'idle'" class="input-note">Contributions and redemptions resume after the current game settles.</p>
          <p v-if="error" class="error-message" role="alert">{{ error }}</p>
          <p class="membership-risk">Returns vary with game results and costs. You can lose the sats you contribute.</p>
        </section>
      </div>

      <section class="pool-game" aria-labelledby="pool-game-title">
        <div><h3 id="pool-game-title">Play against the community pool</h3><p>A real wager settled by the pool contract. Members share the house’s result.</p></div>
        <form @submit.prevent="prepareGame">
          <label for="pool-bet">Your stake in sats<input id="pool-bet" v-model="betAmount" inputmode="numeric" autocomplete="off" maxlength="24" :disabled="busy"/></label>
          <div class="coin-choice" role="group" aria-label="Choose a side"><button type="button" :aria-pressed="choice === 0" @click="choice = 0">Heads</button><button type="button" :aria-pressed="choice === 1" @click="choice = 1">Tails</button></div>
          <button class="btn-gold" :disabled="busy || !state.capabilities.bet">Preview 50% wager</button>
        </form>
        <p class="input-note">The preview shows your exact stake and winning payout before signing. The contract caps the pool’s liability at {{ bps(state.maxStakeBps) }} of its equity per game.</p>
        <p v-if="gameError" class="error-message" role="alert">{{ gameError }}</p>
      </section>

      <section class="funded-activity" aria-labelledby="funded-activity-title">
        <div class="activity-heading"><h3 id="funded-activity-title">Your pool activity</h3><span>Verified transactions</span></div>
        <p v-if="!state.receipts.length" class="input-note">Contributions, redemptions and game results appear here after verification.</p>
        <button v-for="receipt in state.receipts" :key="receipt.operationId" class="receipt-row" @click="selectedReceipt = receipt"><span><strong>{{ receiptTitle(receipt) }}</strong><small>{{ date(receipt.verifiedAt) }}</small></span><span class="receipt-value">{{ receiptAmount(receipt) }}<small>{{ shortId(receipt.arkTxid) }}</small></span><span aria-hidden="true">›</span></button>
      </section>
    </template>

    <section v-if="initialized && state.verified" class="wallet-renewal" aria-labelledby="pool-renewal-title">
      <div><h3 id="pool-renewal-title">Wallet coin renewal</h3><p>{{ renewalState.error || (renewalState.status === 'renewing' ? 'Your selected coins are joining a new batch. Keep this operation open while it confirms.' : 'Renew older wallet coins and share outputs before using them in a pool operation.') }}</p><code v-if="renewalState.intentId">{{ shortId(renewalState.intentId) }}</code></div>
      <button v-if="renewalState.status === 'recovery'" class="btn-outline" :disabled="busy" @click="recover">Resume wallet renewal</button>
      <button v-else class="btn-outline" :disabled="busy || renewalBusy || !!state.pending" @click="prepareRenewal">{{ renewalState.status === 'preparing' ? 'Preparing renewal…' : renewalState.status === 'renewing' ? 'Renewing…' : 'Review wallet renewal' }}</button>
      <p v-if="renewalError" class="error-message" role="alert">{{ renewalError }}</p>
    </section>

    <p class="pool-service-note">Pool actions require the Arkade operator and emulator. A pool nearing expiry must be renewed before shares can be redeemed; the casino normally does this, and any member can do it while the casino is offline. Pool shares currently have no independent Bitcoin withdrawal path.</p>

    <BankrollActionDialog v-if="renewalQuote" title="Review wallet coin renewal" confirm-label="Sign wallet renewal" :disabled="busy || renewalBusy || renewalQuote.expiresAt <= now" :error="renewalError" @close="closeRenewal" @confirm="confirmRenewal">
      <p class="quote-intro">Renew these {{ renewalQuote.inputs.length }} wallet outputs in an Arkade batch. Their assets return to your wallet. This does not add capital to the pool.</p>
      <dl class="quote-details"><div><dt>Network</dt><dd>{{ renewalQuote.network }}</dd></div><div><dt>Selected Bitcoin</dt><dd>{{ format(renewalQuote.inputTotalSats) }} sats</dd></div><div><dt>Maximum batch fee</dt><dd>{{ format(renewalQuote.estimatedFeeSats) }} sats</dd></div><div><dt>Minimum returned Bitcoin</dt><dd>{{ format(renewalQuote.estimatedOutputSats) }} sats</dd></div><div><dt>Preview expires</dt><dd>{{ date(renewalQuote.expiresAt) }}</dd></div></dl>
      <ul class="renewal-inputs"><li v-for="input in renewalQuote.inputs" :key="`${input.outpoint.txid}:${input.outpoint.vout}`"><code>{{ shortId(input.outpoint.txid) }}:{{ input.outpoint.vout }}</code><span>{{ format(input.valueSats) }} sats</span><small v-for="asset in input.assets" :key="asset.assetId">{{ format(asset.amount) }} units · {{ shortId(asset.assetId) }}</small></li></ul>
      <p class="input-note">Your renewal cannot charge more than the reviewed fee. Changes requiring a higher fee need a new preview.</p>
    </BankrollActionDialog>

    <BankrollActionDialog v-if="quote" :title="quoteTitle" :confirm-label="quote.kind === 'openGame' ? 'Sign and place wager' : quote.kind === 'subscribe' ? 'Sign contribution' : 'Sign redemption'" :disabled="quoteStale || busy || (quote.kind === 'subscribe' && state.fairnessTrust === 'operator' && !trustAcknowledged)" :error="confirmationError" @close="closeQuote" @confirm="confirmQuote">
      <p class="quote-intro">{{ quote.kind === 'openGame' ? 'This uses wallet sats for a real wager.' : 'This moves real wallet sats or pool shares.' }} Review the exact amounts before signing.</p>
      <p v-if="(quote.transactionCount || 1) > 1" class="quote-intro">This action uses {{ quote.transactionCount }} transactions to prepare your input, update the pool, and return spendable Bitcoin change when needed. Confirmed steps stay completed if a later step needs recovery.</p>
      <dl class="quote-details">
        <div v-if="quote.kind === 'openGame'"><dt>Your side</dt><dd>{{ quote.oddsLo === 0 ? 'Heads' : 'Tails' }}</dd></div>
        <template v-if="quote.kind === 'subscribe'"><div><dt>Contribution</dt><dd>{{ format(quote.amountSats) }} sats</dd></div><div><dt>Shares received</dt><dd>{{ format(quote.mintedShares) }} units</dd></div><div><dt>Minimum shares</dt><dd>{{ format(quote.minShares) }} units</dd></div><div><dt>Your ownership after</dt><dd>{{ decimalBps(quote.ownershipBps) }}</dd></div></template>
        <template v-else-if="quote.kind === 'redeem'"><div><dt>Shares redeemed</dt><dd>{{ format(quote.burnShares) }} units</dd></div><div><dt>Return</dt><dd>{{ format(quote.payoutSats) }} sats</dd></div><div><dt>Minimum return</dt><dd>{{ format(quote.minSats) }} sats</dd></div></template>
        <template v-else><div><dt>Your stake</dt><dd>{{ format(quote.playerStakeSats) }} sats</dd></div><div><dt>Pool stake</dt><dd>{{ format(quote.houseStakeSats) }} sats</dd></div><div><dt>Winning payout, including stake</dt><dd>{{ format(quote.expectedPayoutSats) }} sats</dd></div><div><dt>Win probability</dt><dd>50%</dd></div></template>
        <div><dt>Transaction fees</dt><dd>{{ format(quote.feeSats) }} sats</dd></div><div><dt>Quote expires</dt><dd>{{ date(quote.expiresAt) }}</dd></div>
        <div v-if="quote.cashReleasedSats && BigInt(quote.cashReleasedSats) > 0n"><dt>Spendable wallet change</dt><dd>{{ format(quote.cashReleasedSats) }} sats</dd></div>
      </dl>
      <label v-if="quote.kind === 'subscribe' && state.fairnessTrust === 'operator'" class="trust-acknowledgment"><input v-model="trustAcknowledged" type="checkbox"/>I understand that pool capital is at risk and game fairness depends on the operator, including the risk of collusion with bettors.</label>
      <p v-if="quoteStale" class="error-message">This quote expired or the pool changed. Close it and request a fresh preview.</p>
    </BankrollActionDialog>
    <BankrollActionDialog v-if="selectedReceipt" :title="receiptTitle(selectedReceipt)" @close="selectedReceipt = null">
      <dl class="quote-details"><div><dt>Transaction</dt><dd class="full-txid">{{ selectedReceipt.arkTxid }}</dd></div><div v-if="selectedReceipt.kind === 'subscribe'"><dt>Contribution / shares</dt><dd>{{ format(selectedReceipt.depositedSats) }} sats / {{ format(selectedReceipt.mintedShares) }} units</dd></div><div v-else-if="selectedReceipt.kind === 'redeem'"><dt>Returned / burned shares</dt><dd>{{ format(selectedReceipt.payoutSats) }} sats / {{ format(selectedReceipt.burnedShares) }} units</dd></div><template v-else><div><dt>Player stake</dt><dd>{{ format(selectedReceipt.playerStakeSats) }} sats</dd></div><div><dt>Player payout</dt><dd>{{ format(selectedReceipt.payoutSats) }} sats</dd></div><div><dt>Outcome</dt><dd>{{ selectedReceipt.outcome || 'Pending settlement' }}</dd></div></template></dl>
    </BankrollActionDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useStore } from 'vuex'
import BankrollActionDialog from '@/components/BankrollActionDialog.vue'
import { useFundedPool } from '@/composables/useFundedPool'
import type { FundedPoolInputRenewalQuote, FundedPoolQuote, FundedPoolReceipt } from '@/services/fundedPoolTypes'

defineEmits<{ (event: 'open-wallet'): void }>()
const store = useStore()
const pool = useFundedPool()
const { state, renewalState } = pool
const initialized = computed(() => !!store.state.wallet?.isInitialized)
const setupRoute = { path: '/setup', query: { returnTo: '/bankroll', poolView: 'pool' } }
const action = ref<'subscribe' | 'redeem'>('subscribe')
const contribution = ref('25000')
const redeemPercent = ref(100)
const betAmount = ref('1000')
const choice = ref(0)
const busy = ref(false)
const error = ref('')
const gameError = ref('')
const confirmationError = ref('')
const quote = ref<FundedPoolQuote | null>(null)
const renewalQuote = ref<FundedPoolInputRenewalQuote | null>(null)
const renewalError = ref('')
const renewalBusy = computed(() => renewalState.value.status === 'preparing' || renewalState.value.status === 'renewing')
const trustAcknowledged = ref(false)
watch(quote, () => { trustAcknowledged.value = false })
const selectedReceipt = ref<FundedPoolReceipt | null>(null)
const now = ref(Date.now())
const clock = setInterval(() => { now.value = Date.now() }, 1000)
onBeforeUnmount(() => clearInterval(clock))
watch(() => JSON.stringify([state.value.descriptor?.controlAssetId, state.value.descriptor?.operatorUrl, state.value.network, store.state.wallet?.publicKey]), () => { quote.value = null; renewalQuote.value = null; selectedReceipt.value = null })
const quoteTitle = computed(() => quote.value?.kind === 'openGame' ? 'Review pool wager' : quote.value?.kind === 'subscribe' ? 'Review contribution' : 'Review redemption')
const quoteStale = computed(() => !quote.value || renewalBusy.value || !state.value.verified || quote.value.expiresAt <= now.value || quote.value.head.txid !== state.value.head?.txid || quote.value.head.vout !== state.value.head?.vout)
const ownership = computed(() => {
  if (state.value.memberShares === null || state.value.supply === null || BigInt(state.value.supply) <= 0n) return '—'
  return decimalBps((BigInt(state.value.memberShares) * 10_000n / BigInt(state.value.supply)).toString())
})
const redeemShares = computed(() => BigInt(state.value.availableShares || '0') * BigInt(Math.max(1, Math.min(100, Math.trunc(redeemPercent.value) || 1))) / 100n)
const redemptionEstimate = computed(() => state.value.navSats !== null && state.value.supply !== null && BigInt(state.value.supply) > 0n ? format((redeemShares.value * BigInt(state.value.navSats) / BigInt(state.value.supply)).toString()) : '—')
const phaseLabel = computed(() => state.value.phase === null ? 'Verifying state' : state.value.phase === 'idle' ? 'Between games' : state.value.phase === 'contest' ? 'Waiting for settlement' : 'Game in progress')
const pendingTitle = computed(() => {
  const stage = state.value.pending?.stage
  return stage === 'authorizing' ? 'Authorizing your reviewed operation…' : stage === 'staging' ? 'Preparing your pool input…' : stage === 'refunding' ? 'Returning your staged funds…' : stage === 'revealing' ? 'Revealing your committed result…' : stage === 'settling' ? 'Settling the game…' : stage === 'signing' ? 'Signing your operation…' : stage === 'confirming' ? 'Verifying the transaction…' : stage === 'recovery' ? 'Recovery in progress' : 'Reconciling your operation…'
})
function format(value: string | null): string { return value === null ? '—' : BigInt(value).toLocaleString() }
function decimalBps(value: string): string { const n = BigInt(value); return `${n / 100n}.${String(n % 100n).padStart(2, '0')}%` }
function bps(value: number | null): string { return value === null ? '—' : decimalBps(String(value)) }
function date(value: number): string { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value) }
function shortId(value: string): string { return `${value.slice(0, 8)}…${value.slice(-8)}` }
function message(value: unknown): string { return value instanceof Error ? value.message : 'The operation could not be completed. Check its status before retrying.' }
function amount(value: string): bigint { const raw = value.trim(); const normalized = raw.replaceAll(',', ''); if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw) || normalized.length > 20 || BigInt(normalized) <= 0n) throw new Error('Enter a positive whole number of sats.'); return BigInt(normalized) }
function closeQuote() { if (!busy.value) { quote.value = null; confirmationError.value = '' } }
function closeRenewal() { if (!busy.value) { renewalQuote.value = null; renewalError.value = '' } }
async function prepareRenewal() {
  if (busy.value || renewalBusy.value || renewalState.value.status === 'recovery' || state.value.pending) return
  busy.value = true; quote.value = null; renewalError.value = ''
  try { renewalQuote.value = await pool.prepareRenewInputs() }
  catch (failure) { renewalError.value = message(failure) } finally { busy.value = false }
}
async function confirmRenewal() {
  if (!renewalQuote.value || busy.value || renewalBusy.value || renewalQuote.value.expiresAt <= Date.now()) return
  busy.value = true; renewalError.value = ''
  try { await pool.confirmRenewInputs(renewalQuote.value); renewalQuote.value = null }
  catch (failure) { renewalError.value = message(failure) } finally { busy.value = false }
}
async function refresh() { if (busy.value) return; busy.value = true; try { await pool.refresh() } catch (failure) { error.value = message(failure) } finally { busy.value = false } }
async function recover() { if (busy.value) return; busy.value = true; error.value = ''; try { await pool.recover() } catch (failure) { error.value = message(failure) } finally { busy.value = false } }
async function rescue() { if (busy.value) return; busy.value = true; error.value = ''; try { await pool.rescue() } catch (failure) { error.value = message(failure) } finally { busy.value = false } }
async function prepareMembership() {
  if (busy.value || renewalBusy.value) return
  renewalQuote.value = null
  busy.value = true; error.value = ''; confirmationError.value = ''
  try { quote.value = action.value === 'subscribe' ? await pool.prepareSubscribe(amount(contribution.value)) : await pool.prepareRedeem(redeemShares.value) }
  catch (failure) { error.value = message(failure) } finally { busy.value = false }
}
async function prepareGame() {
  if (busy.value || renewalBusy.value) return
  renewalQuote.value = null
  busy.value = true; gameError.value = ''; confirmationError.value = ''
  try { quote.value = await pool.prepareBet({ playerStakeSats: amount(betAmount.value), oddsN: 100, oddsLo: choice.value === 0 ? 0 : 50, oddsTarget: choice.value === 0 ? 50 : 100 }) }
  catch (failure) { gameError.value = message(failure) } finally { busy.value = false }
}
async function confirmQuote() {
  if (!quote.value || quoteStale.value || busy.value || (quote.value.kind === 'subscribe' && state.value.fairnessTrust === 'operator' && !trustAcknowledged.value)) return
  const accepted = quote.value
  busy.value = true; confirmationError.value = ''
  try { await pool.confirm(accepted); quote.value = null }
  catch (failure) { confirmationError.value = message(failure) } finally { busy.value = false }
}
function receiptTitle(receipt: FundedPoolReceipt): string { return receipt.kind === 'subscribe' ? 'Contribution confirmed' : receipt.kind === 'redeem' ? 'Shares redeemed' : receipt.outcome === 'player' ? 'You won against the pool' : receipt.outcome === 'house' ? 'The pool won the game' : receipt.outcome === 'refund' ? 'Game refunded' : 'Game funded' }
function receiptAmount(receipt: FundedPoolReceipt): string { return `${format(receipt.kind === 'subscribe' ? receipt.depositedSats : receipt.kind === 'redeem' ? receipt.payoutSats : receipt.memberDeltaSats)} sats` }
</script>

<style scoped>
.wallet-renewal { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-top: 30px; padding-top: 24px; border-top: 1px solid var(--border-light); }
.wallet-renewal > div { flex: 1 1 260px; }
.wallet-renewal h3 { font-size: .86rem; }
.wallet-renewal p { font-size: .74rem; line-height: 1.65; color: var(--text-dim); margin-top: 7px; }
.wallet-renewal code { display: block; margin-top: 6px; font-size: .7rem; }
.renewal-inputs { list-style: none; padding: 0; margin: 18px 0; }
.renewal-inputs li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; padding: 11px 0; border-bottom: 1px solid var(--border-light); font-size: .72rem; }
.renewal-inputs small { grid-column: 1 / -1; overflow-wrap: anywhere; color: var(--text-dim); }
.funded-pool { padding-top: 28px; }
.pool-header,.position-heading,.activity-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 20px; }
h2 { font-size: 1.2rem; letter-spacing: -.025em; } h3 { font-size: 1rem; letter-spacing: -.015em; }
.pool-header p,.pool-game>div p { color: var(--text-dim); font-size: .8rem; line-height: 1.65; margin-top: 8px; }
.pool-network,.position-heading>span,.activity-heading>span { color: var(--text-dim); font-size: .7rem; }
.pool-message { padding: 38px 26px; margin: 28px 0; border: 1px solid var(--border-light); border-radius: 14px; background: var(--bg-card); }
.pool-message p { max-width: 560px; color: var(--text-dim); font-size: .85rem; line-height: 1.7; margin: 12px 0 24px; }
.pool-message .btn-gold { display: inline-flex; text-decoration: none; }
.pool-columns { display: grid; grid-template-columns: minmax(0,1.2fr) minmax(0,1fr); gap: 24px; margin-top: 28px; }
.pool-position,.pool-membership { padding: 28px; border-radius: 14px; background: var(--bg-card); border: 1px solid var(--border-light); }
.pool-membership { background: var(--bg-elevated); }
.position-amount { font-family: var(--font-mono); font-size: 2.2rem; margin: 28px 0; font-variant-numeric: tabular-nums; }
.position-amount small { font-family: var(--font-sans); color: var(--text-dim); font-size: .75rem; }
.position-ownership { display: flex; justify-content: space-between; font-size: .75rem; }.position-ownership strong { color: var(--gold); font-family: var(--font-mono); }
.ownership-track { height: 6px; background: var(--border-light); border-radius: 5px; margin: 13px 0 25px; overflow: hidden; }.ownership-track>span { display: block; height: 100%; background: var(--gold); }
.pool-details>div,.membership-preview>div,.quote-details>div { display: flex; justify-content: space-between; align-items: baseline; gap: 18px; padding: 10px 0; }
dt { font-size: .72rem; color: var(--text-dim); } dd { font-family: var(--font-mono); font-size: .75rem; text-align: right; overflow-wrap: anywhere; margin: 0; }
.position-note,.verified-at,.input-note,.membership-risk,.pool-service-note { color: var(--text-dim); font-size: .72rem; line-height: 1.7; }
.position-note { margin-top: 20px; }.verified-at { margin-top: 14px; }.verified-at button,.error-message>button { background: none; border: 0; color: inherit; text-decoration: underline; margin-left: 8px; cursor: pointer; }
.action-tabs,.coin-choice { display: flex; gap: 6px; }.action-tabs { margin-bottom: 26px; border-bottom: 1px solid var(--border-light); }
.action-tabs button,.coin-choice button { flex: 1; color: var(--text-dim); background: transparent; border: 0; padding: 12px 8px; font-size: .78rem; cursor: pointer; }.action-tabs button[aria-pressed=true] { color: var(--gold); border-bottom: 2px solid var(--gold); }
label { display: block; color: var(--text); font-size: .78rem; }
input:not([type=range]) { display: block; min-width: 0; width: 100%; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 8px; color: var(--text); padding: 13px; font-family: var(--font-mono); margin: 12px 0; }
input[type=range] { width: 100%; accent-color: var(--gold); margin: 22px 0; }
.pool-membership form>.btn-gold { margin-top: 23px; width: 100%; min-height: 44px; }.membership-risk { border-top: 1px solid var(--border-light); margin-top: 24px; padding-top: 20px; }
.input-note { margin-top: 12px; }.membership-preview { margin-bottom: 18px; }.error-message { color: var(--red); line-height: 1.65; font-size: .8rem; margin-top: 16px; }
.pool-game { padding: 26px 0; border-block: 1px solid var(--border-light); margin-top: 30px; }.pool-game form { display: flex; align-items: center; gap: 18px; margin-top: 23px; }.pool-game label { flex: 1; }.pool-game .coin-choice { flex: 1; padding-top: 12px; }.coin-choice button { border: 1px solid var(--border-light); border-radius: 8px; min-height: 44px; }.coin-choice button[aria-pressed=true] { border-color: var(--gold); color: var(--gold); }.pool-game .btn-gold { min-height: 44px; margin-top: 12px; }
.pending-operation,.recovery-message { background: var(--bg-elevated); padding: 20px; border: 1px solid var(--border-light); border-radius: 12px; margin-top: 24px; }.pending-operation { display: flex; align-items: center; gap: 16px; }.pending-operation>div { flex: 1; }.pending-operation strong,.recovery-message strong { font-size: .85rem; }.pending-operation p,.recovery-message p { color: var(--text-dim); font-size: .75rem; line-height: 1.7; margin: 8px 0; }.pending-operation code { font-size: .7rem; color: var(--text-dim); }
.funded-activity { margin-top: 30px; }.activity-heading { margin-bottom: 16px; }.receipt-row { width: 100%; display: flex; align-items: center; gap: 16px; padding: 17px 0; border: 0; border-bottom: 1px solid var(--border-light); text-align: left; background: transparent; color: var(--text); cursor: pointer; }.receipt-row>span:first-child { flex: 1; }.receipt-row strong { display: block; font-size: .8rem; font-weight: 500; }.receipt-row small { display: block; font-size: .65rem; color: var(--text-dim); margin-top: 7px; }.receipt-value { font-family: var(--font-mono); font-size: .8rem; text-align: right; }
.pool-service-note { margin-top: 26px; }.quote-intro { font-size: .8rem; color: var(--text-dim); line-height: 1.7; margin-bottom: 20px; }.quote-details>div { border-bottom: 1px solid var(--border-light); padding: 14px 0; }.quote-details dd { max-width: 62%; }.full-txid { font-size: .66rem; }
.fairness-notice { color: var(--text-dim); border-left: 2px solid var(--gold); font-size: .75rem; line-height: 1.7; padding-left: 15px; margin-top: 24px; }.trust-acknowledgment { display: flex; align-items: start; gap: 10px; font-size: .75rem; line-height: 1.7; margin-top: 20px; }.trust-acknowledgment input[type=checkbox] { flex-shrink: 0; width: 17px; margin: 4px 0; accent-color: var(--gold); }
button:focus-visible,input:focus-visible,a:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }button:active:enabled { transform: scale(.98); }button:disabled { opacity: .45; cursor: not-allowed; }
@media(max-width:750px) { .pool-columns { grid-template-columns: 1fr; gap: 18px; }.pool-position,.pool-membership { padding: 23px; }.pool-game form { flex-wrap: wrap; gap: 12px; }.pool-game label { flex-basis: 100%; }.pool-game .coin-choice { padding: 0; }.pool-game .btn-gold { margin-top: 0; }.pending-operation { flex-wrap: wrap; }.pending-operation>div { min-width: 200px; }.pending-operation>button { width: 100%; }.pool-header { align-items: start; }.pool-network { text-align: right; } }
@media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation: none !important; transition: none !important; }button:active:enabled { transform: none; } }
</style>
