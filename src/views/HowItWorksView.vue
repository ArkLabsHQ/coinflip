<template>
  <div class="how page">
    <div class="hiw-wrap">
      <router-link to="/" class="back-link">&laquo; back to play</router-link>

      <header class="hiw-header">
        <h1>How It Works</h1>
        <p class="lede">
          A <strong class="text-gold">trustless</strong> coinflip: the fairness and the payout are
          enforced by <strong>Bitcoin script</strong> and an <strong>Arkade&nbsp;Script</strong>
          covenant — not by trusting the operator. Everything below is taken directly from this
          repo's code; expand any spend path to see its exact opcodes, step by step.
        </p>
      </header>

      <!-- 30-second version + interactive per-party diagram, side by side -->
      <section class="overview-row">
        <div class="tldr casino-card">
          <h2 class="tldr-title">The 30-second version</h2>
          <ol class="tldr-steps">
            <li>Both sides <strong>commit</strong> to a hidden secret (only its hash is shared).</li>
            <li v-if="activeVersion === 'v4'">Both sides <strong>co-fund</strong> a single joint pot in one atomic transaction — neither stake moves unless both sign.</li>
            <li v-else>Each side <strong>escrows</strong> its own stake into its <strong>own</strong> per-party escrow — neither can touch the other's.</li>
            <li>You <strong>reveal</strong> your secret. The two secrets together decide the winner.</li>
            <li>An <strong>Arkade&nbsp;Script covenant</strong> pays the full pot to the winner — the
              winner never signs, and the loser has no spend path.</li>
            <li>If the operator goes silent, the contract still lets you <strong>reclaim or sweep</strong>
              on your own.</li>
          </ol>
        </div>

        <div class="diagram-card">
          <div class="diagram-version mono">showing <span :class="['evol-pill', `evol-${evolution}`]">{{ EVOLUTION_BY[evolution].version }}</span> model</div>
          <div class="scenario-tabs" role="tablist" aria-label="Scenario">
            <button v-for="s in scenarios" :key="s.id" type="button" role="tab"
                    :aria-selected="scenario === s.id"
                    :class="['scenario-tab', { active: scenario === s.id }]"
                    @click="scenario = s.id">{{ s.label }}</button>
          </div>

          <!-- v0.1 — SHARED escrow: both fund one bucket -->
          <div v-if="evolution === 'v1'" class="pp">
            <div class="pp-cols">
              <div class="pp-col">
                <div class="pp-box you"><span class="pp-name">YOU</span><span class="pp-meta">commit + stake</span></div>
              </div>
              <div class="pp-col">
                <div class="pp-box house" :class="{ ghost: scenario === 'nofund' }">
                  <span class="pp-name">HOUSE</span>
                  <span class="pp-meta">{{ scenario === 'nofund' ? 'no-show' : 'commit + stake' }}</span>
                </div>
              </div>
            </div>
            <span class="pp-merge">↓ setup tx ↓</span>
            <div class="pp-box escrow shared" :class="scenario === 'nofund' ? 'empty' : 'filled'">
              <span class="pp-name">shared escrow</span>
              <span class="pp-meta">{{ scenario === 'nofund' ? 'half-funded · stranded risk' : 'both stakes pooled' }}</span>
            </div>
            <div class="pp-trigger">{{ outcome.trigger }}</div>
            <span class="pp-merge">↓ final tx ↓</span>
            <div class="pp-outcome" :class="outcome.kind">
              <span class="pp-out-title">{{ outcome.title }}</span>
              <span class="pp-out-detail">{{ outcome.detail }}</span>
            </div>
          </div>

          <!-- v0.4 — JOINT pot: both co-fund one VTXO atomically -->
          <div v-else-if="evolution === 'v4'" class="pp">
            <div class="pp-cols">
              <div class="pp-col">
                <div class="pp-box you"><span class="pp-name">YOU</span><span class="pp-meta">digit + salt commit</span></div>
              </div>
              <div class="pp-col">
                <div class="pp-box house" :class="{ ghost: scenario === 'nofund' }">
                  <span class="pp-name">HOUSE</span>
                  <span class="pp-meta">{{ scenario === 'nofund' ? 'no-show' : 'digit + salt commit' }}</span>
                </div>
              </div>
            </div>
            <span class="pp-merge">↓ atomic co-fund · 1 tx ↓</span>
            <div class="pp-box escrow shared" :class="scenario === 'nofund' ? 'empty' : 'filled'">
              <span class="pp-name">joint pot</span>
              <span class="pp-meta">{{ scenario === 'nofund' ? 'co-fund never lands' : 'both stakes · one VTXO' }}</span>
            </div>
            <div class="pp-trigger">
              {{ scenario === 'nofund' ? 'co-fund aborts atomically' : outcome.trigger }}
              <span v-if="scenario === 'happy'" class="pp-trigger-sub mono">payTo(winner, pot) · 1 settle tx</span>
            </div>
            <span class="pp-merge">↓ settle · 1 tx ↓</span>
            <div class="pp-outcome" :class="scenario === 'nofund' ? 'refund' : outcome.kind">
              <span class="pp-out-title">{{ scenario === 'nofund' ? 'Nothing at risk' : outcome.title }}</span>
              <span class="pp-out-detail">{{ scenario === 'nofund' ? 'atomic co-fund — both sign or it never lands' : outcome.detail }}</span>
            </div>
          </div>

          <!-- v0.2 / v0.3 — PER-PARTY escrow -->
          <div v-else class="pp">
            <div class="pp-cols">
              <div class="pp-col">
                <div class="pp-box you"><span class="pp-name">YOU</span><span class="pp-meta">{{ evolution === 'v3' ? 'digit + salt commit' : 'commit + stake' }}</span></div>
                <span class="pp-arr">↓</span>
                <div class="pp-box escrow filled"><span class="pp-name">your escrow</span><span class="pp-meta">staked</span></div>
              </div>
              <div class="pp-col">
                <div class="pp-box house" :class="{ ghost: scenario === 'nofund' }">
                  <span class="pp-name">HOUSE</span>
                  <span class="pp-meta">{{ scenario === 'nofund' ? 'no-show' : (evolution === 'v3' ? 'digit + salt commit' : 'commit + stake') }}</span>
                </div>
                <span class="pp-arr" :class="{ ghost: scenario === 'nofund' }">↓</span>
                <div class="pp-box escrow" :class="scenario === 'nofund' ? 'empty' : 'filled'">
                  <span class="pp-name">house escrow</span>
                  <span class="pp-meta">{{ scenario === 'nofund' ? 'never funded' : 'staked' }}</span>
                </div>
              </div>
            </div>

            <div class="pp-trigger">
              {{ outcome.trigger }}
              <span v-if="evolution === 'v3' && scenario === 'happy'" class="pp-trigger-sub mono">via OP_INSPECTPACKET arkade-script</span>
            </div>
            <span class="pp-merge">↓</span>

            <div class="pp-outcome" :class="outcome.kind">
              <span class="pp-out-title">{{ outcome.title }}</span>
              <span class="pp-out-detail">{{ outcome.detail }}</span>
            </div>
          </div>

          <p v-if="!(evolution === 'v4' && scenario === 'nofund')" class="scenario-note">{{ outcome.note }}</p>
          <p v-if="evolution === 'v4' && scenario === 'nofund'" class="scenario-note">
            v0.4: the co-fund is a single atomic tx — if the house never signs, it simply never lands, so
            neither stake is ever committed. Nothing to refund, nothing to strand.
          </p>
          <p v-if="evolution === 'v1' && scenario === 'nofund'" class="scenario-warn">
            ⚠ v0.1 limitation: a no-show on the shared escrow could strand your stake until either side cooperated.
            Per-party escrows in v0.2/v0.3 fix this — each side reclaims its OWN stake unilaterally after the timeout.
          </p>
        </div>
      </section>

      <!-- Design evolution — three published variants of the contract -->
      <section class="hiw-section">
        <h2>Design evolution</h2>
        <p class="section-intro">
          The contract has gone through three shipped designs, plus a fourth (<strong>v0.4</strong>, the joint
          pot). This client is playing
          <strong>{{ activeVersion === 'v4' ? 'v0.4 (joint pot)' : 'v0.3 (per-party escrow)' }}</strong>
          right now — read from <span class="mono">/api/network</span> — and the tabs below open on it. The
          other variants are kept for reference; each one fixes a real flaw in the previous. The detailed
          spend-path and flow sections further down describe the <strong>v0.3</strong> per-party-escrow design,
          the shape v0.4 streamlines into a single co-funded pot.
        </p>
        <div class="variant-tabs evolution-tabs" role="tablist" aria-label="Design evolution">
          <button v-for="e in EVOLUTION" :key="e.id" type="button" role="tab"
                  :aria-selected="evolution === e.id"
                  :class="['variant-tab', { active: evolution === e.id }]"
                  @click="evolution = e.id">{{ e.tab }}</button>
        </div>
        <div class="evolution-card casino-card">
          <div class="evolution-headline">
            <span class="evolution-version mono">{{ EVOLUTION_BY[evolution].version }}</span>
            <span class="evolution-title">{{ EVOLUTION_BY[evolution].title }}</span>
            <span class="evolution-badge" :class="EVOLUTION_BY[evolution].badge.cls">
              {{ EVOLUTION_BY[evolution].badge.label }}
            </span>
          </div>
          <p class="evolution-summary">{{ EVOLUTION_BY[evolution].summary }}</p>
          <div class="evolution-grid">
            <div class="evolution-pane">
              <h4 class="evolution-h">How it worked</h4>
              <ul>
                <li v-for="(b, i) in EVOLUTION_BY[evolution].how" :key="`how-${i}`">{{ b }}</li>
              </ul>
            </div>
            <div class="evolution-pane">
              <h4 class="evolution-h">{{ EVOLUTION_BY[evolution].whyTitle || 'Why we moved on' }}</h4>
              <ul>
                <li v-for="(b, i) in EVOLUTION_BY[evolution].why" :key="`why-${i}`">{{ b }}</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <!-- The layers -->
      <section class="hiw-section">
        <h2>The building blocks</h2>
        <div class="layer-grid">
          <article class="layer-card">
            <div class="layer-badge arkade">ARKADE</div>
            <h3>Arkade — the execution layer</h3>
            <p>
              Arkade is a <strong>programmable Bitcoin execution layer</strong>. Coins are held as
              <strong>VTXOs</strong> (Virtual Transaction Outputs) — self-custodial, off-chain
              Bitcoin coins that move <strong>instantly at near-zero fees</strong>, with no changes
              to Bitcoin required. The coinflip stakes are VTXOs.
            </p>
            <p>
              Two of its properties make this game possible: a VTXO can be locked by <strong>any
              valid Tapscript</strong> (so the escrow's spend paths below are enforceable), and you
              keep <strong>unilateral exit</strong> — funds are always withdrawable on-chain without
              the operator's cooperation. More at
              <a href="https://docs.arkadeos.com" target="_blank" rel="noopener">docs.arkadeos.com</a>.
            </p>
          </article>

          <article class="layer-card">
            <div class="layer-badge script">ARKADE&nbsp;SCRIPT</div>
            <h3>Arkade Script — the covenant</h3>
            <p>
              Plain Bitcoin script can't say <em>"this may only be spent to address X for exactly
              amount Y."</em> That rule — a <strong>covenant</strong> — is what makes the trustless
              payout possible.
            </p>
            <p>
              In the code it works through an <strong>emulator</strong> co-signer. A covenant leaf is
              an ordinary multisig whose emulator pubkey is <em>tweaked</em> by
              <span class="mono">pubkey + tagged_hash("ArkScriptHash", arkadeScript)·G</span>. The
              emulator produces that tweaked signature <strong>only after running the arkade
              script</strong> — so a signature on the <span class="mono">&lt;emu✦&gt;</span> slot
              <em>is</em> the proof the covenant held. The script bytes travel at spend time in the
              <span class="mono">EmulatorPacket</span>.
            </p>
          </article>
        </div>
      </section>

      <!-- Commit / reveal -->
      <section class="hiw-section">
        <h2>The commit–reveal coin</h2>
        <p class="section-intro">
          The randomness comes from two secrets neither side can see in advance. The trick: the
          <strong>length</strong> of the secret encodes the choice.
        </p>
        <div class="cr-grid">
          <div class="cr-card">
            <div class="cr-step">1 · Commit</div>
            <p>Each side shares only the <strong>SHA-256 hash</strong> of a random secret — hiding both the bytes and the length, so neither can react to the other's choice.</p>
          </div>
          <div class="cr-card">
            <div class="cr-step">2 · Encode</div>
            <p>Coin: <span class="chip">15 bytes = Heads</span> <span class="chip">16 bytes = Tails</span>. Variable-odds: length is <span class="mono">16 + digit</span>, <span class="mono">digit ∈ [0, n)</span>.</p>
          </div>
          <div class="cr-card">
            <div class="cr-step">3 · Reveal</div>
            <p>Coin: you win when your secret's length <strong>matches</strong> the house's. Odds: <span class="mono">roll = (d_house + d_player) mod n</span>; you win when <span class="mono">lo ≤ roll &lt; target</span>.</p>
          </div>
        </div>
        <p class="note">
          <span class="note-tag">Fair RNG</span>
          The coin side and the odds digit are drawn from a <strong>CSPRNG</strong>; the committed
          hash binds each side to its choice <em>before</em> any reveal. The
          <span class="mono">‹win condition›</span> tapscript below verifies exactly this on-chain.
        </p>
      </section>

      <!-- The escrow contract -->
      <section class="hiw-section">
        <h2>The escrow contract — 8 spend paths</h2>
        <p class="section-intro">
          Stakes go into a Taproot contract (<span class="mono">CoinflipEscrowScript</span>). It's
          <strong>per-party</strong> — house funds the house escrow, you fund the player escrow — so
          neither side can abort and steal the other's stake. Each escrow has eight tapscript leaves:
          four <strong>collaborative</strong> covenant paths and four <strong>unilateral exit</strong>
          mirrors. Click <span class="mono">show script ▸</span> on any leaf for its opcodes,
          explained step by step.
        </p>

        <!-- Shared win condition (coin / variable-odds) -->
        <div class="subscript">
          <button class="sub-toggle" @click="toggle('cond')">
            <span class="caret" :class="{ open: open.cond }">▸</span>
            <span class="mono">‹win condition›</span>
            <span class="sub-hint">the on-chain script that decides the winner</span>
          </button>
          <div v-if="open.cond" class="sub-body">
            <div class="variant-tabs">
              <button :class="['variant-tab', { active: condVariant === 'coin' }]" @click="condVariant = 'coin'">Coin (50/50)</button>
              <button :class="['variant-tab', { active: condVariant === 'odds' }]" @click="condVariant = 'odds'">Variable odds</button>
            </div>
            <p class="variant-note" v-if="condVariant === 'odds'">
              Example shown: <span class="mono">n = 6, lo = 0, target = 3</span> — a "roll under 3 on a d6" bet (player wins ~50%). Other skins just change <span class="mono">n / lo / target</span>.
            </p>
            <StepList :steps="condVariant === 'coin' ? WIN_COIN : WIN_ODDS" />
            <p class="ops-note">Result: <span class="mono">1</span> → player wins, <span class="mono">0</span> → house wins. <span class="mono">creatorWin*</span> leaves wrap this in <span class="mono">OP_NOT</span>. An invalid secret length <em>loses</em> (it can't void the game).</p>
          </div>
        </div>

        <div class="leaf-cols">
          <div class="leaf-col">
            <div class="leaf-col-head collab">Collaborative (operator + emulator)</div>
            <div v-for="leaf in collabLeaves" :key="leaf.key" class="leaf">
              <div class="leaf-name" :class="leaf.cls">{{ leaf.name }}</div>
              <div class="leaf-kind mono">{{ leaf.kind }}</div>
              <p>{{ leaf.desc }}</p>
              <button class="show-script" @click="toggle(leaf.key)">
                <span class="caret" :class="{ open: open[leaf.key] }">▸</span> show script
              </button>
              <div v-if="open[leaf.key]" class="script-detail">
                <div class="script-label">Tapscript — spend path</div>
                <StepList :steps="leaf.steps" />
                <template v-if="leaf.payout">
                  <div class="script-label arkade-label">Arkade covenant — run by the emulator for <span class="mono">&lt;emu✦&gt;</span></div>
                  <StepList :steps="arkadeSteps(leaf.payout)" />
                </template>
              </div>
            </div>
          </div>

          <div class="leaf-col">
            <div class="leaf-col-head exit">Unilateral exit (no operator needed)</div>
            <div v-for="leaf in exitLeaves" :key="leaf.key" class="leaf">
              <div class="leaf-name" :class="leaf.cls">{{ leaf.name }}</div>
              <div class="leaf-kind mono">{{ leaf.kind }}</div>
              <p>{{ leaf.desc }}</p>
              <button class="show-script" @click="toggle(leaf.key)">
                <span class="caret" :class="{ open: open[leaf.key] }">▸</span> show script
              </button>
              <div v-if="open[leaf.key]" class="script-detail">
                <div class="script-label">Tapscript — spend path</div>
                <StepList :steps="leaf.steps" />
                <template v-if="leaf.payout">
                  <div class="script-label arkade-label">Arkade covenant — run by the emulator for <span class="mono">&lt;emu✦&gt;</span></div>
                  <StepList :steps="arkadeSteps(leaf.payout)" />
                </template>
              </div>
            </div>
          </div>
        </div>
        <p class="legend mono">
          <span class="tok tok-var">&lt;emu✦&gt;</span> emulator key tweaked by that leaf's arkade script ·
          <span class="tok tok-arkade">OP_INSPECT…</span> Arkade-extension opcodes (tx introspection) ·
          ‹win condition› expands above
        </p>
      </section>

      <!-- Flow -->
      <section class="hiw-section">
        <h2>A game, end to end <span class="flow-version mono"><span :class="['evol-pill', `evol-${evolution}`]">{{ EVOLUTION_BY[evolution].version }}</span></span></h2>
        <div class="flow">
          <div v-for="step in FLOW_STEPS[evolution]" :key="step.num" class="flow-step" :class="step.cls">
            <div class="flow-num">{{ step.num }}</div>
            <div class="flow-body">
              <h4>{{ step.title }}</h4>
              <p v-html="step.body"></p>
            </div>
          </div>
        </div>
      </section>

      <!-- Trust model -->
      <section class="hiw-section trust">
        <h2>What you have to trust</h2>
        <ul class="trust-list">
          <li><span class="tick">✓</span><span class="t"><strong>Not the outcome.</strong> It's fixed by the committed hashes before any reveal.</span></li>
          <li><span class="tick">✓</span><span class="t"><strong>Not the payout.</strong> The covenant only authorizes the full pot to the rightful winner's key; the loser has no spendable leaf.</span></li>
          <li><span class="tick">✓</span><span class="t"><strong>Not the operator's uptime.</strong> The forfeit, refund, and exit leaves recover your funds without it.</span></li>
          <li><span class="cross">·</span><span class="t"><strong>You do rely on</strong> the emulator running the published arkade script honestly for the <em>fast</em> path — and on Arkade itself (<a href="https://docs.arkadeos.com" target="_blank" rel="noopener">docs</a>). If the emulator misbehaves or vanishes, <span class="mono">refundExit</span> still returns your stake with no operator and no emulator.</span></li>
        </ul>
      </section>

      <footer class="hiw-footer">
        <router-link to="/" class="btn-gold">Start playing</router-link>
        <span class="footer-cite text-muted">Secret-length coin scheme inspired by <a href="https://arxiv.org/pdf/1612.05390v3" target="_blank" rel="noopener">arxiv.org/pdf/1612.05390v3</a></span>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import StepList from '@/components/StepList.vue'
import { getNetwork } from '@/services/api'

// Expand state, keyed by leaf name (+ 'cond' for the shared win-condition).
const open = ref<Record<string, boolean>>({})
const toggle = (k: string) => { open.value = { ...open.value, [k]: !open.value[k] } }
const condVariant = ref<'coin' | 'odds'>('coin')

// ── Design evolution tabs ─────────────────────────────────────────
//
// Each design is a real shipped variant of the coinflip contract. The
// tabs let a reader see WHY the protocol changed shape between versions
// — the failure modes that motivated v2, and the script-cleanups that
// motivated v3. v0.3 is the design every other section on this page
// describes in detail.
type Evolution = 'v1' | 'v2' | 'v3' | 'v4'
const EVOLUTION: { id: Evolution; tab: string }[] = [
  { id: 'v1', tab: 'v0.1 — setup/final (original)' },
  { id: 'v2', tab: 'v0.2 — per-party covenant' },
  { id: 'v3', tab: 'v0.3 — Arkade-Script + packets ★' },
  { id: 'v4', tab: 'v0.4 — joint pot (opt-in)' },
]
interface EvolutionCard {
  version: string
  title: string
  badge: { label: string; cls: string }
  summary: string
  how: string[]
  why: string[]
  /** Header for the right pane — defaults to "Why we moved on"; the newest
   *  variant overrides it (nothing's superseded it yet). */
  whyTitle?: string
}
const EVOLUTION_BY: Record<Evolution, EvolutionCard> = {
  v1: {
    version: 'v0.1',
    title: 'Setup + final, shared escrow',
    badge: { label: 'retired', cls: 'badge-old' },
    summary:
      "Two transactions per game (setup + final), with a single shared escrow funded by both sides. The earliest design — it shipped, but it had abort-theft windows that the per-party design closes.",
    how: [
      "A 'setup' tx put both stakes into one shared escrow address.",
      "A 'final' tx redistributed the pot on reveal — pay-out covenant referenced the committed hashes.",
      "Settlement and refund both touched the SHARED escrow; either side could grief the other on stall.",
    ],
    why: [
      "Abort theft: if one side never funded, the other side's funds could be stranded with no clean self-refund path.",
      "Multi-tx setup added latency and broke gracefully only on the happy path — recovery flows were complex.",
      "Single escrow meant a server stall could leave BOTH stakes in limbo; the reveal-then-stall window paid the staller.",
    ],
  },
  v2: {
    version: 'v0.2',
    title: 'Per-party escrow, length-encoded predicate',
    badge: { label: 'previous default', cls: 'badge-prev' },
    summary:
      "Each side funds its OWN escrow into a 4-leaf Taproot tree (covenant + forfeit + refund + exit), so a no-show can NEVER touch the other side's stake. Win condition lives in Bitcoin Script and hides the random digit in the secret's BYTE LENGTH.",
    how: [
      'Per-funder escrow: 4 collaborative leaves (`*winCovenant`, `playerForfeit`, `refund`) + 4 CSV-gated unilateral-exit mirrors.',
      'Win condition: `OP_SIZE` on each revealed secret → secret length encodes a digit; (digitC + digitP) mod n decides the winner.',
      'Atomic-sweep covenant pays the full pot on-chain — winner signs nothing, loser has no spend path.',
    ],
    why: [
      'The length-encoded digit is fragile to extend (every new odds variant adds opcodes) and burns extra bytes per secret.',
      "Secrets are arbitrary bytes — there's no canonical wire shape for higher-level tooling to share between server and client.",
      'The on-chain script is harder to audit than `OP_INSPECTPACKET`-based reveals where the emulator runs the decision in arkade-script.',
    ],
  },
  v3: {
    version: 'v0.3',
    title: 'Arkade-Script win condition + packet-borne reveals',
    badge: { label: 'shipping now', cls: 'badge-new' },
    summary:
      "Per-party escrow keeps its safety guarantees, but the win-condition predicate MOVES INTO arkade-script. Reveals are typed extension packets attached to the spending tx (`OP_INSPECTPACKET`) — not raw bytes whose length encodes meaning. Cleaner consensus check, simpler client, 10-leaf taptree.",
    how: [
      'Each side commits a `digit + salt` ; the on-chain `digitHash = SHA256([digit] ‖ salt)` is verified by the emulator at sweep time.',
      'Reveals ride two extension packets (0x10 = player, 0x11 = creator); the win-predicate reads them via `OP_INSPECTPACKET`, runs `(dC+dP) mod n` in arkade-script.',
      'The escrow taptree gains a cooperative `playerSpend` leaf and a CSV mirror — 10 leaves total. The taptree is assembled with btcd\'s algorithm so arkd and the SDK agree on the tap-key.',
    ],
    why: [
      'Why this is the keeper: emulator-evaluated predicate makes the win condition trivial to extend (new game shapes are arkade-script edits, no tapscript rework).',
      'Typed packets give the client a fixed-length wire shape and remove the secret-length-as-data trick.',
      'The btcd-compatible taptree fix has been upstreamed into the official @arkade-os/ts-sdk so every consumer of the SDK gets correct tap-keys for any leaf count.',
    ],
  },
  v4: {
    version: 'v0.4',
    title: 'Joint pot — atomic co-fund, 2 on-chain txs',
    badge: { label: 'opt-in · wired', cls: 'badge-prev' },
    summary:
      "Collapses the two per-party escrows into ONE joint-pot VTXO funded by a single atomic two-party co-fund, then settled by paying the whole pot to the winner — 2 on-chain txs (co-fund + settle) instead of v0.3's three, with the same commit–reveal fairness and emulator covenant. Library, house server, and web client are all wired and proven on regtest; v0.4 is opt-in (server PROTOCOL_VERSION=v4), v0.3 stays the default, and only the happy path is wired client-side so far.",
    how: [
      'One co-fund tx spends BOTH stake VTXOs (player + house) into a single joint pot — a 2-round signing handshake the API orchestrates, where each party signs only its OWN input + checkpoint (proven feasible on regtest; v0.3 deliberately avoided this).',
      'The pot is an 8-leaf taptree whose win leaves pay the WHOLE pot to the winner via `payTo(winner, pot)` on the one VTXO — vs v0.3\'s two-escrow `atomicSweep`. Same arkade-script win-predicate + `OP_INSPECTPACKET` reveals.',
      'Settle is one input → one output: the winner\'s win-covenant leaf + the emulator, off a single player reveal. The /api/v4 endpoints (play → cofund → cofund-finalize → reveal) drive the whole flow.',
    ],
    whyTitle: 'What it improves',
    why: [
      'Fewer on-chain txs (2 vs 3) and fewer round-trips → faster settlement and lower fees.',
      'One joint pot, not two escrows: the winner sweeps a single VTXO, and the API funnels every arkd submit — which sidesteps a checkpoint-signature race we found under concurrent load.',
      'A pre-signed cooperative refund plus CSV unilateral-exit mirrors keep it non-custodial; the house stays a counterparty (not a permissionless taker).',
    ],
  },
}
const evolution = ref<Evolution>('v3')

// Reflect the protocol version the server actually serves (from /api/network):
// open the page on that version and tailor the "what this client plays" copy.
// Falls back to v0.3 if the network can't be reached.
const activeVersion = ref<'v3' | 'v4'>('v3')
onMounted(async () => {
  try {
    const net = await getNetwork()
    activeVersion.value = net.protocolVersion === 'v4' ? 'v4' : 'v3'
    evolution.value = activeVersion.value
  } catch {
    /* keep the v0.3 default */
  }
})

// Per-version game flow. v0.1 (shared escrow) had setup + final txs; v0.2 and
// v0.3 share the per-party shape, but v0.3 specifically routes reveals through
// extension packets read on-chain via OP_INSPECTPACKET.
interface FlowStep { num: string; title: string; body: string; cls?: string }
const FLOW_STEPS: Record<Evolution, FlowStep[]> = {
  v1: [
    { num: '1', title: 'Play & commit', body: 'You commit your secret\'s hash; the house commits its own. The contract address is derived from both commitments.' },
    { num: '2', title: 'Setup tx', body: 'Both sides co-sign a <em>single</em> setup transaction that funds <strong>one shared escrow</strong> with the combined pot.' },
    { num: '3', title: 'Reveal', body: 'You send your secret to the server. Combined with the house secret, it decides the winner via the length-encoded coin scheme.' },
    { num: '4', title: 'Final tx', body: 'A pre-agreed final transaction redistributes the shared pot to the winner. Both sides must co-sign — anyone who stalls grids the funds.' },
    { num: '!', title: 'If the operator goes dark', body: 'The big v0.1 weakness: a no-show on the setup tx leaves your half-stake stranded, and a stall after the reveal needs both sides\' signatures on the final tx to recover.', cls: 'recovery' },
  ],
  v2: [
    { num: '1', title: 'Play & commit', body: 'You commit your secret\'s hash; the house commits its own. The server returns a <strong>per-party</strong> escrow address derived from both commitments.' },
    { num: '2', title: 'Escrow the stakes', body: 'You fund the <em>player escrow</em>, the house funds the <em>house escrow</em> — two single-party transactions into separate contracts that neither side can touch alone.' },
    { num: '3', title: 'Reveal', body: 'You send your secret bytes to the server. Combined with the house secret, the length-encoded mod-n rule deterministically decides the winner.' },
    { num: '4', title: 'Covenant settlement', body: 'The server builds one atomic sweep of <em>both</em> escrows to the winner\'s address. The emulator runs the arkade-script atomic-sweep covenant, confirms the payout matches, co-signs the <span class="mono">&lt;emu✦&gt;</span> slot, and forwards it on. <strong>The winner signs nothing.</strong>' },
    { num: '!', title: 'If the operator goes dark', body: 'Revealed but unpaid? Sweep the whole pot via <span class="mono">playerForfeit</span> after the deadline. Never revealed? <span class="mono">refund</span>. Operator censoring? Take a unilateral <span class="mono">*Exit</span> after the CSV delay.', cls: 'recovery' },
  ],
  v3: [
    { num: '1', title: 'Play & commit', body: 'You commit a <strong>digit + 16-byte salt</strong> (the digit picks your coin face for n=2; the salt blinds it). Only <span class="mono">SHA256(digit‖salt)</span> goes on-chain — your digit is hidden until reveal.' },
    { num: '2', title: 'Escrow the stakes', body: 'You fund the <em>player escrow</em>, the house funds the <em>house escrow</em> — two single-party transactions into the v3 10-leaf taptree. Neither side can touch the other\'s stake.' },
    { num: '3', title: 'Reveal (via extension packet)', body: 'You send <span class="mono">[digit] ‖ salt</span> to the server. The server attaches BOTH reveals as <strong>typed extension packets</strong> (0x10 player, 0x11 creator) to the sweep tx — the emulator reads them on-chain via <span class="mono">OP_INSPECTPACKET</span>.' },
    { num: '4', title: 'Arkade-script settlement', body: 'The emulator runs the <em>win predicate</em>: pulls both reveal packets, verifies their hashes, extracts the digits, and decides via <span class="mono">(dC + dP) mod n ∈ [lo, target)</span>. If the predicate passes, the atomic-sweep covenant pays the full pot to the winner. <strong>The winner signs nothing.</strong>' },
    { num: '!', title: 'If the operator goes dark', body: 'Same three recovery leaves as v0.2 — <span class="mono">playerForfeit</span> (post-reveal stall), <span class="mono">refund</span> (pre-reveal stall), and <span class="mono">*Exit</span> mirrors (operator censoring). v0.3 also adds a <span class="mono">cooperativeSpend</span> leaf so player + creator can settle without the emulator if it disappears.', cls: 'recovery' },
  ],
}

// ── At-a-glance scenario toggle ───────────────────────────────────
// The per-party escrow means each failure mode has a self-serve mitigation.
type Scenario = 'happy' | 'nofund' | 'noreveal'
const scenarios: { id: Scenario; label: string }[] = [
  { id: 'happy', label: 'Happy path' },
  { id: 'nofund', label: "House doesn't fund" },
  { id: 'noreveal', label: 'Secret not revealed' },
]
const scenario = ref<Scenario>('happy')
const OUTCOMES: Record<Scenario, { kind: string; trigger: string; title: string; detail: string; note: string }> = {
  happy: {
    kind: 'win', trigger: 'you reveal → covenant settles',
    title: 'Winner takes the pot', detail: 'covenant pays the full pot on-chain',
    note: 'Both stakes are escrowed and you reveal — the Arkade-Script covenant settles the whole pot to the rightful winner. The winner signs nothing; the loser has no spend path.',
  },
  nofund: {
    kind: 'refund', trigger: 'timeout passes',
    title: 'You refund your stake', detail: 'CLTV self-refund — nothing at risk',
    note: "Because escrows are per-party, the house never touched your stake. If it never funds its own, there's no game — after the timeout you reclaim your stake with just your key. A no-show can't cost you.",
  },
  noreveal: {
    kind: 'forfeit', trigger: 'you revealed → deadline passes',
    title: 'You take the whole pot', detail: 'forfeit path (CLTV) — the staller loses',
    note: "You revealed but the operator won't settle. After the deadline the forfeit leaf lets you sweep BOTH stakes to yourself — stalling costs the house everything.",
  },
}
const outcome = computed(() => OUTCOMES[scenario.value])

interface Step { ops: string[]; explain: string }

// ── Byte-accurate opcodes, disassembled from the real CoinflipEscrowScript
//    (packages/lib), grouped into steps with plain-language explanations. ──

// Coin win-determination condition (buildCoinflipConditionScript).
const WIN_COIN: Step[] = [
  { ops: ['OP_2DUP', 'OP_SHA256', '<playerHash>', 'OP_EQUALVERIFY', 'OP_SHA256', '<houseHash>', 'OP_EQUALVERIFY'],
    explain: 'Verify both reveals: SHA-256 each secret and require it to equal the hash committed at /play. A wrong secret fails here.' },
  { ops: ['OP_SIZE', 'OP_DUP', 'OP_16', 'OP_EQUAL', 'OP_SWAP', 'OP_15', 'OP_EQUAL', 'OP_BOOLOR', 'OP_NOTIF', 'OP_2DROP', 'OP_0', 'OP_ELSE'],
    explain: "Validate the player's secret length — it must be 15 (heads) or 16 (tails). If neither, push 0 → house wins (a bad length loses)." },
  { ops: ['OP_SWAP', 'OP_SIZE', 'OP_DUP', 'OP_16', 'OP_EQUAL', 'OP_SWAP', 'OP_15', 'OP_EQUAL', 'OP_BOOLOR', 'OP_NOTIF', 'OP_2DROP', 'OP_1', 'OP_ELSE'],
    explain: "Same length check on the house's secret. If the house's length is invalid, push 1 → player wins." },
  { ops: ['OP_SIZE', 'OP_SWAP', 'OP_DROP', 'OP_SWAP', 'OP_SIZE', 'OP_SWAP', 'OP_DROP', 'OP_EQUAL', 'OP_ENDIF', 'OP_ENDIF'],
    explain: 'Both lengths valid → compare them. Equal → 1 (player wins); different → 0 (house wins). That is the coin flip.' },
]

// Variable-odds condition (buildVariableOddsConditionScript), shown for n=6, lo=0, target=3.
const WIN_ODDS: Step[] = [
  { ops: ['OP_2DUP', 'OP_SHA256', '<playerHash>', 'OP_EQUALVERIFY', 'OP_SHA256', '<houseHash>', 'OP_EQUALVERIFY'],
    explain: 'Verify both reveals against their committed hashes — identical to the coin.' },
  { ops: ['OP_SIZE', 'OP_DUP', 'OP_16', 'OP_GREATERTHANOREQUAL', 'OP_SWAP', '22', 'OP_LESSTHAN', 'OP_BOOLAND', 'OP_NOTIF', 'OP_2DROP', 'OP_0', 'OP_ELSE'],
    explain: "Player's length must be in [16, 16+n) — here [16, 22). The length minus 16 is the player's digit in [0, n). Out of range → 0, house wins." },
  { ops: ['OP_SWAP', 'OP_SIZE', 'OP_DUP', 'OP_16', 'OP_GREATERTHANOREQUAL', 'OP_SWAP', '22', 'OP_LESSTHAN', 'OP_BOOLAND', 'OP_NOTIF', 'OP_2DROP', 'OP_1', 'OP_ELSE'],
    explain: "Same range check on the house's secret. House out of range → 1, player wins." },
  { ops: ['OP_SIZE', 'OP_NIP', 'OP_16', 'OP_SUB', 'OP_SWAP', 'OP_SIZE', 'OP_NIP', 'OP_16', 'OP_SUB', 'OP_ADD'],
    explain: 'Decode both digits (digit = length − 16) and add them: sum = digit_house + digit_player, which lands in [0, 2n−2].' },
  { ops: ['OP_DUP', 'OP_6', 'OP_GREATERTHANOREQUAL', 'OP_IF', 'OP_6', 'OP_SUB', 'OP_ENDIF'],
    explain: 'roll = sum mod n. OP_MOD is disabled in Script, but since sum < 2n one conditional subtract does it: if sum ≥ n (6), subtract n.' },
  { ops: ['OP_DUP', 'OP_0', 'OP_GREATERTHANOREQUAL', 'OP_SWAP', 'OP_3', 'OP_LESSTHAN', 'OP_BOOLAND', 'OP_ENDIF', 'OP_ENDIF'],
    explain: 'Player wins iff lo ≤ roll < target — here 0 ≤ roll < 3. Pushes 1 (player) or 0 (house). Win probability = (target − lo) / n.' },
]

// The arkade covenant (covenants.atomicSweep) the emulator runs before signing <emu✦>.
function arkadeSteps(payout: 'player' | 'house'): Step[] {
  const payKey = payout === 'player' ? '<playerPayoutKey>' : '<housePayoutKey>'
  return [
    { ops: ['OP_INSPECTINPUTVALUE', '<otherEscrowStake>', 'OP_EQUALVERIFY'],
      explain: 'Atomicity: the spending tx must also include the OTHER escrow as an input, its value pinned. Neither escrow can be swept on its own.' },
    { ops: ['OP_DUP', 'OP_INSPECTOUTPUTSCRIPTPUBKEY', 'OP_1', 'OP_EQUALVERIFY', payKey, 'OP_EQUALVERIFY'],
      explain: "Destination is forced: output #1's scriptPubKey must be exactly the winner's payout key (P2TR)." },
    { ops: ['OP_INSPECTOUTPUTVALUE', '<fullPot>', 'OP_EQUAL'],
      explain: 'Amount is forced: that output must carry the full pot. The emulator co-signs <emu✦> only if all three checks pass.' },
  ]
}

const COND: string[] = ['‹win condition›']
const VERIFY = 'OP_VERIFY'

// Reusable step fragments.
const winStep = (negate = false): Step => ({
  ops: negate ? [...COND, 'OP_NOT', VERIFY] : [...COND, VERIFY],
  explain: negate
    ? 'Evaluate the win condition and negate it — require the HOUSE won.'
    : 'Evaluate the win condition — require the PLAYER won (true).',
})
const cltvStep: Step = {
  ops: ['<finalExpiration>', 'OP_CHECKLOCKTIMEVERIFY', 'OP_DROP'],
  explain: 'Absolute timelock: this path is unspendable until finalExpiration.',
}
const csvStep: Step = {
  ops: ['<exitDelay>', 'OP_CHECKSEQUENCEVERIFY', 'OP_DROP'],
  explain: 'Relative timelock (CSV): spendable alone after exitDelay — survives an operator outage.',
}

interface Leaf {
  key: string; name: string; group: 'collab' | 'exit'; cls: string
  kind: string; desc: string; steps: Step[]; payout?: 'player' | 'house'
}

const LEAVES: Leaf[] = [
  {
    key: 'playerWinCovenant', name: 'playerWinCovenant', group: 'collab', cls: 'text-green',
    kind: 'ConditionMultisig[server, emu✦]',
    desc: 'Player won → the operator settles the full pot to the player. The player signs nothing.',
    payout: 'player',
    steps: [winStep(false),
      { ops: ['<serverKey>', 'OP_CHECKSIGVERIFY', '<emu✦>', 'OP_CHECKSIG'],
        explain: '2-of-2: the operator signs, and <emu✦> is the emulator key tweaked by this leaf’s arkade covenant — signed only after the covenant (below) passes. So the pot can only land where the covenant says.' }],
  },
  {
    key: 'creatorWinCovenant', name: 'creatorWinCovenant', group: 'collab', cls: 'text-green',
    kind: 'ConditionMultisig[server, emu✦]',
    desc: 'House won (win condition negated) → the pot settles to the house.',
    payout: 'house',
    steps: [winStep(true),
      { ops: ['<serverKey>', 'OP_CHECKSIGVERIFY', '<emu✦>', 'OP_CHECKSIG'],
        explain: '2-of-2 [operator, emu✦]: same covenant binding, paying the house key.' }],
  },
  {
    key: 'playerForfeit', name: 'playerForfeit', group: 'collab', cls: 'text-gold',
    kind: 'CLTVMultisig[player, server, emu✦]',
    desc: 'If the operator stalls after you revealed, you sweep the entire pot after the deadline.',
    payout: 'player',
    steps: [cltvStep,
      { ops: ['<playerKey>', 'OP_CHECKSIGVERIFY', '<serverKey>', 'OP_CHECKSIGVERIFY', '<emu✦>', 'OP_CHECKSIG'],
        explain: '3-of-3 [player, operator, emu✦]: after the deadline the player sweeps the full pot — the covenant forces the payout to the player. This is the penalty for a stalling house.' }],
  },
  {
    key: 'refund', name: 'refund', group: 'collab', cls: 'text-blue',
    kind: 'CLTVMultisig[funder, server]',
    desc: 'If the game never resolved, each funder reclaims their own stake after the deadline.',
    steps: [cltvStep,
      { ops: ['<funderKey>', 'OP_CHECKSIGVERIFY', '<serverKey>', 'OP_CHECKSIG'],
        explain: '2-of-2 [funder, operator]: the funder reclaims only their own stake — no covenant, no payout binding. No winner, no loss.' }],
  },
  {
    key: 'playerWinExit', name: 'playerWinExit', group: 'exit', cls: '',
    kind: 'ConditionCSVMultisig[player, emu✦]',
    desc: 'The player-win payout, spendable alone after a CSV delay — survives an operator outage.',
    payout: 'player',
    steps: [winStep(false), csvStep,
      { ops: ['<playerKey>', 'OP_CHECKSIGVERIFY', '<emu✦>', 'OP_CHECKSIG'],
        explain: '2-of-2 [player, emu✦]: no operator signature needed; the emulator still enforces the covenant payout.' }],
  },
  {
    key: 'creatorWinExit', name: 'creatorWinExit', group: 'exit', cls: '',
    kind: 'ConditionCSVMultisig[creator, emu✦]',
    desc: 'The house win path, as a self-spendable CSV mirror.',
    payout: 'house',
    steps: [winStep(true), csvStep,
      { ops: ['<houseKey>', 'OP_CHECKSIGVERIFY', '<emu✦>', 'OP_CHECKSIG'],
        explain: '2-of-2 [house, emu✦]: the house exits its win without the operator.' }],
  },
  {
    key: 'playerForfeitExit', name: 'playerForfeitExit', group: 'exit', cls: '',
    kind: 'ConditionCSVMultisig[player, emu✦]',
    desc: 'The forfeit sweep as a CSV mirror, gated by a hash-check on your revealed secret.',
    payout: 'player',
    steps: [
      { ops: ['OP_SHA256', '<playerHash>', 'OP_EQUAL', VERIFY],
        explain: 'Hash-lock: prove you know the secret behind your commitment (you revealed).' },
      csvStep,
      { ops: ['<playerKey>', 'OP_CHECKSIGVERIFY', '<emu✦>', 'OP_CHECKSIG'],
        explain: '2-of-2 [player, emu✦]: sweep the pot to the player without the operator.' }],
  },
  {
    key: 'refundExit', name: 'refundExit', group: 'exit', cls: 'text-blue',
    kind: 'CSVMultisig[funder]',
    desc: 'Last resort — no operator, no emulator. The funder reclaims their stake after the CSV delay.',
    steps: [csvStep,
      { ops: ['<funderKey>', 'OP_CHECKSIG'],
        explain: 'Just the funder’s signature — no operator, no emulator. The final fallback if everything else is down.' }],
  },
]

const collabLeaves = computed(() => LEAVES.filter((l) => l.group === 'collab'))
const exitLeaves = computed(() => LEAVES.filter((l) => l.group === 'exit'))
</script>

<style scoped lang="scss">
.how { align-items: stretch; }
.hiw-wrap { width: 100%; max-width: 880px; margin: 0 auto; }

.back-link {
  display: inline-block; color: var(--text-muted); text-decoration: none;
  font-size: 0.72rem; letter-spacing: 1.5px; text-transform: uppercase;
  margin-bottom: 18px; transition: color 0.18s;
  &:hover { color: var(--gold); }
}

.hiw-header {
  margin-bottom: 28px;
  h1 { font-size: 2.1rem; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 12px; }
  .lede { font-size: 1.05rem; color: var(--text-dim); line-height: 1.65; max-width: 66ch; }
}

h2 { font-size: 1.25rem; font-weight: 700; margin-bottom: 6px; }
.section-intro { color: var(--text-dim); line-height: 1.65; margin: 4px 0 18px; max-width: 72ch; }
.hiw-section { margin: 34px 0; }

/* TL;DR */
.tldr { border-color: var(--gold-dim); background: linear-gradient(180deg, rgba(247, 201, 72, 0.05), var(--bg-card)); }
.tldr-title { color: var(--gold); margin-bottom: 14px; }
.tldr-steps {
  list-style: none; counter-reset: tldr; display: flex; flex-direction: column; gap: 10px;
  li {
    counter-increment: tldr; position: relative; padding-left: 38px; color: var(--text-dim); line-height: 1.55;
    &::before {
      content: counter(tldr); position: absolute; left: 0; top: -1px;
      width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
      background: rgba(247, 201, 72, 0.12); color: var(--gold); border-radius: 50%;
      font-size: 0.8rem; font-weight: 700; font-family: var(--font-mono);
    }
    strong { color: var(--text); }
  }
}

/* Overview: 30-second version + interactive per-party diagram, side by side */
.overview-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 8px 0 34px; align-items: start;
}
.overview-row .tldr { margin: 0; }

.diagram-card {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 16px; box-shadow: var(--shadow-card); display: flex; flex-direction: column; gap: 12px;
}
.scenario-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.scenario-tab {
  flex: 1 1 auto; background: var(--bg-elevated); border: 1px solid var(--border-light);
  color: var(--text-muted); font-size: 0.7rem; font-weight: 600; padding: 6px 8px;
  border-radius: 999px; cursor: pointer; transition: all 0.16s; white-space: nowrap;
  &:hover { color: var(--text); }
  &.active { background: var(--gold-glow); border-color: var(--gold); color: var(--gold); }
}

.pp { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.pp-cols { display: flex; gap: 14px; width: 100%; }
.pp-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; }
.pp-box {
  width: 100%; text-align: center; border: 1.5px solid var(--border-light); border-radius: 10px;
  padding: 8px 6px; background: var(--bg-elevated); display: flex; flex-direction: column; gap: 1px;
  transition: opacity 0.16s, border-color 0.16s;
  .pp-name { font-weight: 700; font-size: 0.8rem; color: var(--text); }
  .pp-meta { font-size: 0.64rem; color: var(--text-dim); }
}
.pp-box.you { border-color: var(--blue); .pp-name { color: var(--blue); } }
.pp-box.house { border-color: var(--gold); .pp-name { color: var(--gold); } }
.pp-box.escrow .pp-name { color: var(--text); font-size: 0.74rem; }
.pp-box.escrow.filled { border-color: var(--green); background: var(--green-glow); }
.pp-box.escrow.empty { border-style: dashed; border-color: var(--text-muted); opacity: 0.55; }
.pp-box.ghost { opacity: 0.4; border-style: dashed; }
.pp-arr, .pp-merge { color: var(--text-muted); font-size: 0.95rem; line-height: 1; }
.pp-arr.ghost { opacity: 0.3; }
.pp-trigger { font-size: 0.66rem; color: var(--text-muted); font-style: italic; margin-top: 3px; }
.pp-outcome {
  width: 100%; text-align: center; border: 1.5px solid var(--border-light); border-radius: 10px;
  padding: 10px 8px; display: flex; flex-direction: column; gap: 2px;
  .pp-out-title { font-weight: 700; font-size: 0.85rem; }
  .pp-out-detail { font-size: 0.66rem; color: var(--text-dim); }
}
.pp-outcome.win { border-color: var(--green); background: var(--green-glow); .pp-out-title { color: var(--green); } }
.pp-outcome.refund { border-color: var(--blue); background: var(--blue-glow); .pp-out-title { color: var(--blue); } }
.pp-outcome.forfeit { border-color: var(--gold); background: var(--gold-glow); .pp-out-title { color: var(--gold); } }
.scenario-note { font-size: 0.74rem; line-height: 1.55; color: var(--text-dim); margin: 2px 0 0; }

@media (max-width: 720px) {
  .overview-row { grid-template-columns: 1fr; }
}

/* Layer cards */
.layer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 8px; }
.layer-card {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 22px; box-shadow: var(--shadow-card);
  h3 { font-size: 1.05rem; margin: 12px 0 8px; }
  p { color: var(--text-dim); line-height: 1.6; font-size: 0.92rem; margin-bottom: 10px; &:last-child { margin-bottom: 0; } }
  strong { color: var(--text); } a { color: var(--blue); }
}
.layer-badge {
  display: inline-block; font-size: 0.62rem; font-weight: 800; letter-spacing: 2px;
  padding: 4px 10px; border-radius: 999px; font-family: var(--font-mono);
  &.arkade { color: var(--blue); background: var(--blue-glow); }
  &.script { color: var(--gold); background: var(--gold-glow); }
}

/* Commit/reveal */
.cr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
.cr-card {
  background: var(--bg-elevated); border: 1px solid var(--border-light); border-radius: var(--radius-sm); padding: 18px;
  p { color: var(--text-dim); font-size: 0.9rem; line-height: 1.6; }
  strong { color: var(--text); }
}
.cr-step { font-size: 0.72rem; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: var(--blue); margin-bottom: 10px; }
.chip {
  display: inline-block; font-family: var(--font-mono); font-size: 0.78rem;
  background: rgba(56, 189, 248, 0.1); color: var(--blue); border: 1px solid var(--border-light);
  padding: 2px 8px; border-radius: 6px; margin: 2px 4px 2px 0;
}
.note {
  margin-top: 16px; background: var(--bg-subtle); border: 1px solid var(--border);
  border-left: 3px solid var(--green); border-radius: var(--radius-sm); padding: 14px 16px;
  color: var(--text-dim); font-size: 0.9rem; line-height: 1.6;
  strong { color: var(--text); }
}
.note-tag {
  display: inline-block; margin-right: 8px; font-size: 0.66rem; font-weight: 800; letter-spacing: 1px;
  text-transform: uppercase; color: var(--green); background: var(--green-glow); padding: 2px 8px; border-radius: 6px;
}

/* Shared sub-scripts */
.subscript { margin-bottom: 16px; }
.sub-toggle {
  display: flex; align-items: center; gap: 10px; width: 100%;
  background: var(--bg-elevated); border: 1px solid var(--border-light); border-radius: var(--radius-sm);
  padding: 10px 14px; cursor: pointer; color: var(--text); text-align: left;
  &:hover { border-color: var(--gold); }
}
.sub-hint { color: var(--text-muted); font-size: 0.78rem; }
.sub-body {
  margin-top: 10px; padding: 14px; background: var(--bg-subtle);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.variant-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.variant-tab {
  background: var(--bg-elevated); border: 1px solid var(--border-light); color: var(--text-muted);
  font-size: 0.78rem; font-weight: 600; padding: 6px 14px; border-radius: 999px; cursor: pointer;
  transition: all 0.18s;
  &:hover { color: var(--text); }
  &.active { background: rgba(56, 189, 248, 0.12); border-color: var(--blue); color: var(--blue); }
}
.variant-note { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 12px; }

/* Leaves */
.leaf-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.leaf-col { display: flex; flex-direction: column; gap: 10px; }
.leaf-col-head {
  font-size: 0.72rem; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
  padding: 8px 12px; border-radius: var(--radius-xs);
  &.collab { color: var(--green); background: var(--green-glow); }
  &.exit { color: var(--text-dim); background: var(--bg-elevated); }
}
.leaf {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px;
  .leaf-name { font-weight: 700; font-size: 0.92rem; }
  .leaf-kind { font-size: 0.7rem; color: var(--text-muted); margin: 3px 0 7px; }
  p { font-size: 0.84rem; color: var(--text-dim); line-height: 1.5; }
  strong { color: var(--text); }
}
.show-script {
  margin-top: 9px; background: none; border: none; color: var(--blue);
  font-size: 0.74rem; font-weight: 600; cursor: pointer; padding: 0; display: inline-flex; align-items: center; gap: 5px;
  &:hover { color: var(--gold); }
}
.caret { display: inline-block; transition: transform 0.18s; font-size: 0.7rem; &.open { transform: rotate(90deg); } }

.script-detail { margin-top: 10px; }
.script-label {
  font-size: 0.64rem; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
  color: var(--text-muted); margin: 12px 0 6px;
  &.arkade-label { color: var(--gold); .mono { color: var(--gold); } }
}

/* Step chips live in StepList.vue; these .tok rules are for the legend below. */
.ops-note { font-size: 0.78rem; color: var(--text-muted); margin-top: 10px; line-height: 1.5; }
.tok {
  font-family: var(--font-mono); font-size: 0.72rem; padding: 3px 6px; border-radius: 4px; line-height: 1.5;
  &.tok-op { color: var(--text-dim); background: var(--bg-elevated); }
  &.tok-var { color: var(--blue); background: rgba(56, 189, 248, 0.1); }
  &.tok-arkade { color: var(--gold); background: var(--gold-glow); font-weight: 600; }
}
.legend { font-size: 0.72rem; color: var(--text-muted); margin-top: 12px; line-height: 1.9; .tok { font-size: 0.66rem; } }

/* Flow */
.flow { display: flex; flex-direction: column; gap: 0; }
.flow-step {
  display: flex; gap: 16px; padding: 4px 0;
  &:not(:last-child) .flow-num::after {
    content: ''; position: absolute; top: 32px; left: 50%; transform: translateX(-50%);
    width: 2px; height: calc(100% - 20px); background: var(--border-light);
  }
}
.flow-num {
  position: relative; flex-shrink: 0; width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-elevated); border: 1px solid var(--border-light); border-radius: 50%;
  font-family: var(--font-mono); font-weight: 700; font-size: 0.85rem; color: var(--blue);
}
.flow-body {
  padding-bottom: 18px;
  h4 { font-size: 0.98rem; margin-bottom: 4px; }
  p { color: var(--text-dim); font-size: 0.9rem; line-height: 1.6; }
  strong { color: var(--text); }
}
.flow-step.recovery .flow-num { color: var(--gold); border-color: var(--gold-dim); background: var(--gold-glow); }

/* Trust */
.trust-list {
  list-style: none; display: flex; flex-direction: column; gap: 12px;
  li { display: flex; gap: 10px; color: var(--text-dim); line-height: 1.6; font-size: 0.95rem; }
  .t { flex: 1; min-width: 0; strong { color: var(--text); } a { color: var(--blue); } .mono { color: var(--text); } }
  .tick { color: var(--green); font-weight: 800; flex-shrink: 0; }
  .cross { color: var(--text-muted); font-weight: 800; flex-shrink: 0; }
}

/* Footer */
.hiw-footer { margin: 40px 0 8px; display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.footer-cite { font-size: 0.78rem; a { color: var(--blue); } }

/* Per-version pill shown in the diagram header + flow header */
.diagram-version, .flow-version {
  font-size: 0.72rem; font-weight: 600; color: var(--text-muted); margin-bottom: 10px;
  display: inline-flex; align-items: center; gap: 8px;
}
.flow-version { margin-left: 10px; }
.evol-pill {
  display: inline-block; font-weight: 800; letter-spacing: 0.5px;
  padding: 2px 8px; border-radius: 999px; font-size: 0.72rem;
  &.evol-v1 { background: rgba(148,163,184,0.15); color: var(--text-muted); border: 1px solid var(--border-light); }
  &.evol-v2 { background: rgba(56,189,248,0.12); color: var(--blue); border: 1px solid rgba(56,189,248,0.35); }
  &.evol-v3 { background: var(--green-glow); color: var(--green); border: 1px solid rgba(34,197,94,0.45); }
}
.pp-trigger-sub {
  display: block; margin-top: 4px; font-size: 0.7rem; color: var(--text-muted);
  letter-spacing: 0.3px;
}
.pp-box.escrow.shared {
  border-color: rgba(56,189,248,0.45); background: rgba(56,189,248,0.06);
}
.scenario-warn {
  margin-top: 10px; padding: 10px 12px; border-radius: var(--radius-sm);
  background: rgba(234,179,8,0.08); border: 1px solid rgba(234,179,8,0.35);
  color: var(--text-dim); font-size: 0.82rem; line-height: 1.5;
}

/* Design evolution */
.evolution-tabs { flex-wrap: wrap; margin-bottom: 16px; }
.evolution-card { padding: 18px 20px; }
.evolution-headline { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
.evolution-version { font-weight: 700; font-size: 0.86rem; color: var(--text-dim); }
.evolution-title { font-weight: 700; color: var(--text); font-size: 1.05rem; }
.evolution-badge {
  font-size: 0.66rem; font-weight: 800; letter-spacing: 1px; text-transform: uppercase;
  padding: 3px 9px; border-radius: 999px;
  &.badge-old { background: rgba(148,163,184,0.12); color: var(--text-muted); border: 1px solid var(--border-light); }
  &.badge-prev { background: rgba(56,189,248,0.12); color: var(--blue); border: 1px solid rgba(56,189,248,0.35); }
  &.badge-new { background: var(--green-glow); color: var(--green); border: 1px solid rgba(34,197,94,0.45); }
}
.evolution-summary { color: var(--text-dim); margin: 6px 0 14px; font-size: 0.9rem; line-height: 1.5; }
.evolution-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.evolution-pane { background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; }
.evolution-h { margin: 0 0 8px; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.5px; color: var(--text); text-transform: uppercase; }
.evolution-pane ul { margin: 0; padding-left: 18px; color: var(--text-dim); font-size: 0.85rem; line-height: 1.5; }
.evolution-pane li + li { margin-top: 6px; }
@media (max-width: 640px) {
  .leaf-cols { grid-template-columns: 1fr; }
  .hiw-header h1 { font-size: 1.7rem; }
  .evolution-grid { grid-template-columns: 1fr; }
}
</style>
