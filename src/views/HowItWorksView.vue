<template>
  <main class="how page">
    <div class="hiw-wrap">
      <div class="how-navigation"><router-link to="/" class="back-link">&laquo; Back to play</router-link><GameModeNav /></div>
      <header>
        <p class="eyebrow">THE JOINT POT</p>
        <h1>Two secrets. One outcome.</h1>
        <p class="lede">You and the house commit before either secret is revealed. A compiled Arkade Script contract checks the result and where the pot goes.</p>
      </header>

      <section class="casino-card flow" aria-label="Game flow">
        <div v-for="(step, index) in steps" :key="step.title" class="flow-step">
          <span class="step-number">{{ index + 1 }}</span>
          <h2>{{ step.title }}</h2>
          <p>{{ step.body }}</p>
        </div>
      </section>

      <section class="casino-card outcomes">
        <h2>What if the game stalls?</h2>
        <div class="scenario-tabs" role="tablist" aria-label="Game outcome">
          <button v-for="item in scenarios" :id="'tab-' + item.id" :key="item.id" type="button" role="tab"
            :aria-selected="scenario === item.id" aria-controls="scenario-panel"
            :class="{ active: scenario === item.id }" @click="scenario = item.id">{{ item.label }}</button>
        </div>
        <div id="scenario-panel" role="tabpanel" :aria-labelledby="'tab-' + selected.id" class="scenario-panel">
          <span class="eyebrow">{{ selected.destination }}</span>
          <h3>{{ selected.title }}</h3>
          <p>{{ selected.body }}</p>
          <p class="detail">{{ selected.detail }}</p>
        </div>
      </section>

      <div class="explanation-grid">
        <section class="casino-card">
          <h2>Check the result yourself</h2>
          <p>Each secret contains a random digit and at least 16 bytes of random salt. The commitment is SHA256 of that digit followed by its salt.</p>
          <p>The result is <code>(house digit + your digit) mod n</code>. Your chosen winning band is <code>[lo, target)</code>. The game details show both commitments, the reveals, the band and the payout.</p>
          <p>Odds and the house edge determine the house stake before you approve funding. The complete pot goes to the winner.</p>
        </section>
        <section class="casino-card">
          <h2>Know what you rely on</h2>
          <p>The Arkade Service cosigns collaborative transactions. The emulator checks the contract's spending rules. They are separate roles from the game house.</p>
          <p>Offchain recovery needs those services. Onchain recovery starts by unrolling the virtual output and waiting for its exit delay; some leaves also need the emulator or both players.</p>
          <p>Keep your wallet backup and local recovery data. Losing a reveal secret changes which recovery paths you can use. The wallet shows the action available for each stalled game.</p>
        </section>
      </div>

      <section class="pool-note">
        <h2>A separate community bankroll</h2>
        <p>In Bankroll, you can contribute Bitcoin to the community pool and receive shares in your wallet. Those shares represent your portion of the pool's equity. A contribution buys ownership; it does not place a wager.</p>
        <div class="explanation-grid">
          <div><h3>When the pool wins</h3><p>A losing bettor's stake increases pool equity. The operator earns its configured performance fee only on profit above carried losses. The remaining gain increases the value of members' shares.</p></div>
          <div><h3>When the pool loses</h3><p>A winning bettor receives the committed payout. Pool equity and share value fall. Later wins must recover the pool's carried losses before another performance fee accrues.</p></div>
        </div>
        <p><strong>Your share of the result:</strong> with 20% ownership, a 1,000-sat pool gain after fees increases your estimated equity by 200 sats. A 1,000-sat pool loss reduces it by 200 sats. Rounding and transaction costs can change the amount you redeem.</p>
        <p>You redeem shares for their current portion of pool equity between games. The preview shows the shares burned, minimum return, fees and transaction count before you sign. Your estimated pool equity stays separate from spendable wallet Bitcoin.</p>
        <p>Only wagers placed against the community pool affect its results. Normal Play uses separate house funds. Betting against a pool you also own gives you both the bettor's result and your portion of the pool's opposite result.</p>
        <p>Pool capital is at risk. The current game trusts the casino operator not to collude with bettors; commit–reveal does not prevent that collusion. New contributions and games stay closed until the operator explicitly selects that policy. Redemptions require an idle pool with enough remaining lifetime, the Arkade operator and the emulator. Shareholders currently have no independent Bitcoin withdrawal path.</p>
        <div class="pool-links"><router-link to="/bankroll">Open the community pool &rarr;</router-link><router-link :to="{ path: '/bankroll', query: { view: 'practice' } }">Try with practice sats &rarr;</router-link></div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import GameModeNav from '@/components/GameModeNav.vue'

const steps = [
  { title: 'Commit', body: 'Both sides pin a secret hash, the odds, stakes and payout destinations.' },
  { title: 'Fund together', body: 'Both sides sign one transaction that combines their stakes into a joint pot.' },
  { title: 'Reveal and settle', body: 'The contract verifies the reveals, calculates the winner and pays the agreed destination.' },
]
const scenarios = [
  { id: 'settle', label: 'Normal game', destination: 'THE WINNER', title: 'The winner receives the pot.', body: 'Both revealed secrets must match their commitments. The contract checks the winning band and pins the payout.', detail: 'A signature cannot redirect the payout to another address.' },
  { id: 'unfunded', label: 'Funding stops', destination: 'YOUR WALLET', title: 'An unfunded offer can expire.', body: 'Before a cofund transaction is submitted, no pot exists and the house can release the reserved coins.', detail: 'Once funding is submitted, the game stays in recovery until the transaction is reconciled; a timeout alone cannot discard it.' },
  { id: 'refund', label: 'No reveal', destination: 'EACH ORIGINAL FUNDER', title: 'The deadline opens a split refund.', body: 'If the pot remains unrevealed, the refund path returns each party’s committed stake to its fixed destination after the deadline.', detail: 'The player can reveal into the contest before that refund wins the race. The ledger follows the transaction that actually spends the pot.' },
  { id: 'contest', label: 'House stalls', destination: 'THE CONTEST CONTRACT', title: 'Publish your reveal to advance the game.', body: 'Your reveal moves the pot into a contest contract. The house can still settle to the actual winner; after the contest deadline, the player can take the pot.', detail: 'Recovery must preserve the funded contract parameters and reveal secret. Onchain exit is a separate process with its own delay and signing requirements.' },
]
const scenario = ref('settle')
const selected = computed(() => scenarios.find(item => item.id === scenario.value) ?? scenarios[0])
</script>

<style scoped lang="scss">
.hiw-wrap { max-width: 960px; margin: 0 auto; padding: 28px 20px 64px; }
.how-navigation { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 32px; }
.back-link { display: inline-block; color: var(--text-dim, #b5b0a1); }
header { max-width: 760px; margin-bottom: 32px; }
h1 { font-size: clamp(2rem, 5vw, 3.5rem); line-height: 1.08; margin: 10px 0 20px; }
h2 { font-size: 1.2rem; margin: 0 0 14px; }
h3 { font-size: 1.5rem; margin: 12px 0; }
p { line-height: 1.65; color: var(--text-dim, #b5b0a1); }
.lede { font-size: 1.15rem; }
.eyebrow { font-size: .72rem; letter-spacing: .16em; color: var(--gold, #d6b76d); }
.casino-card { padding: 28px; margin-bottom: 20px; }
.flow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; }
.step-number { display: block; font-size: 2rem; color: var(--gold, #d6b76d); margin-bottom: 18px; }
.flow-step p { margin-bottom: 0; }
.scenario-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0; }
.scenario-tabs button { font: inherit; padding: 10px 14px; border: 1px solid #ffffff26; background: transparent; border-radius: 6px; color: inherit; cursor: pointer; }
.scenario-tabs button.active { background: #d6b76d1a; border-color: var(--gold, #d6b76d); }
.scenario-tabs button:focus-visible { outline: 2px solid var(--gold, #d6b76d); outline-offset: 3px; }
.scenario-panel { min-height: 180px; padding-top: 12px; }
.detail { font-size: .9rem; }
.explanation-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
code { color: var(--gold, #d6b76d); font-size: .9em; }
.pool-note { border-top: 1px solid #ffffff26; margin-top: 24px; padding-top: 30px; }
.pool-note h3 { font-size: 1rem; }
.pool-note p { margin-bottom: 18px; }
.pool-links { display: flex; flex-wrap: wrap; gap: 16px 28px; }
.pool-note a { color: var(--gold, #d6b76d); }
@media (max-width: 650px) { .flow, .explanation-grid { grid-template-columns: 1fr; } .casino-card { padding: 22px; } .scenario-panel { min-height: 0; } }
</style>
