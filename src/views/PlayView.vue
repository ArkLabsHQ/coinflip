<template>
  <div class="page play-page">
    <!-- Screen flash overlay — fires for ~80ms on wins. Roobet/Stake pattern:
         even peripheral vision picks it up. Skipped in auto mode to avoid
         epilepsy-grade strobing. -->
    <div v-if="winFlash" class="win-flash" />

    <!-- Top HUD: skin selector (left) + P&L pill (right). -->
    <div class="top-hud">
      <div class="skin-selector">
        <button
          v-for="skin in skins"
          :key="skin.id"
          class="skin-chip"
          :class="{ selected: currentSkinId === skin.id }"
          :title="skin.name"
          @click="selectSkin(skin.id)"
        >
          <span class="skin-icon">{{ skin.icon }}</span>
        </button>
      </div>
      <div class="hud-right">
        <div class="pnl-pill" :class="pnlClass" @click="togglePnlScope" :title="`Click to switch — currently ${pnlScope}`">
          <span class="pnl-scope">{{ pnlScope }}</span>
          <span class="pnl-amount mono">{{ formattedPnl }}</span>
        </div>
        <button class="history-btn" title="Game history" @click="openHistory">&#9827;</button>
        <router-link to="/how-it-works" class="history-btn help-btn" title="How it works">?</router-link>
      </div>
    </div>

    <!-- Trustless safety net: if a game ever fails to resolve, the player's
         escrowed stake is reclaimable here (no trust in the server). -->
    <StalledBets />

    <!-- Sparkline row: last-50 win/loss results. Rollbit pattern. -->
    <div class="sparkline" v-if="sparkline.length">
      <span
        v-for="(r, i) in sparkline"
        :key="r.key"
        class="spark-dot"
        :class="r.won ? 'win' : 'loss'"
        :style="{ animationDelay: `${(sparkline.length - 1 - i) * 12}ms` }"
      />
    </div>

    <!-- Centerpiece skin. For skins that own their play gesture (Rocket),
         pass the extra props the skin needs and bind its launch/cashout
         events; non-gesture skins ignore the unknown props. -->
    <div class="skin-area" :class="{ playing: isFlipping }">
      <component
        :is="currentSkin.component"
        :state="skinState"
        :tier="selectedTier"
        :odds-edge-bps="oddsEdgeBps"
        :dust="dust"
        @launch="onSkinLaunch"
        @cashout="onSkinCashout"
      />
    </div>

    <!-- Streak badge — appears at 3+ in a row. -->
    <transition name="streak-pop">
      <div v-if="streak.count >= 3" class="streak-badge" :class="streak.kind">
        <span class="streak-icon">{{ streak.kind === 'win' ? '🔥' : '❄' }}</span>
        STREAK ×{{ streak.count }}
      </div>
    </transition>

    <div class="controls" :class="{ inert: isFlipping && !isAutoRunning }">
      <div class="control-group">
        <TierSelector
          :tiers="tiers"
          :selected-tier="selectedTier"
          :affordable-tiers="affordableTiers"
          :player-balance="playerBalance"
          @select="selectedTier = $event"
        />
      </div>

      <!-- Odds slider: walks the active skin's bet ladder — slide right for
           more coins / reels / dice (lower win rate, bigger payout). The exact
           win chance + multiple update live; all enforced on-chain. The top end
           is clamped to what the house bankroll can cover for this stake. -->
      <!-- Visible in auto mode too — the player needs to see (and set) the odds
           and payout they're auto-betting at; the input only locks while a batch
           is actually running. -->
      <div class="odds-slider">
        <div class="odds-readout">
          <span class="odds-step-label">{{ stepLabel }}</span>
          <span class="odds-stats">
            <span class="win-pct">{{ winPctLabel }} win</span>
            <span class="payout-mult">{{ payoutMult(selectedBet) }}</span>
          </span>
        </div>
        <input
          class="odds-range"
          type="range"
          :min="minStep"
          :max="maxStep"
          step="1"
          v-model.number="sliderIndex"
          :disabled="isAutoRunning"
          aria-label="Odds"
        />
        <div class="odds-ends">
          <span>safer · bigger chance</span>
          <span>riskier · bigger payout</span>
        </div>
      </div>

      <!-- Auto-batch + FLIP button only when the skin doesn't own the
           play gesture. Rocket renders its own LAUNCH / CASH OUT inside
           the centerpiece. -->
      <template v-if="!skinOwnsGesture">
        <div class="auto-selector">
          <button
            v-for="opt in autoOptions"
            :key="opt.label"
            class="auto-chip"
            :class="{ selected: autoCount === opt.value }"
            :disabled="isAutoRunning"
            @click="selectAuto(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>

        <button
          class="flip-btn"
          :class="{ active: canFlip, stop: isAutoRunning }"
          :disabled="!canFlip && !isAutoRunning"
          @click="doFlip"
        >
          <template v-if="isAutoRunning">STOP ({{ autoRemainingLabel }} LEFT)</template>
          <template v-else-if="isAutoMode">{{ isFlipping ? 'FLIPPING...' : `AUTO ×${autoCountLabel}` }}</template>
          <template v-else>{{ isFlipping ? 'FLIPPING...' : 'FLIP IT' }}</template>
        </button>

        <div class="hotkey-hint" v-if="!isAutoMode && !isFlipping && canFlip">Press Enter to flip</div>
      </template>
    </div>

    <div v-if="error" class="error-toast">{{ error }}</div>

    <!-- Result slab — Stake pattern. Slides up from bottom, auto-dismisses. -->
    <transition name="slab">
      <div v-if="slab" class="result-slab" :class="slab.won ? 'win' : 'loss'">
        <div class="slab-label">{{ slab.won ? 'YOU WIN' : 'YOU LOSE' }}</div>
        <div class="slab-amount mono">
          {{ slab.won ? '+' : '−' }}{{ Math.abs(slab.amount).toLocaleString() }}
          <span class="slab-unit">sats</span>
        </div>
      </div>
    </transition>

    <!-- Game history modal — scrollable list within a fixed card, not the page. -->
    <transition name="hist-fade">
      <div v-if="historyOpen" class="hist-backdrop" @click.self="historyOpen = false">
        <div class="hist-modal" role="dialog" aria-label="Game history">
          <header class="hist-header">
            <h3 class="hist-title">Game History</h3>
            <button class="hist-close" @click="historyOpen = false" aria-label="Close">&times;</button>
          </header>
          <div class="hist-body">
            <GameHistoryList :games="historyGames" />
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useStore } from 'vuex'
import TierSelector from '@/components/TierSelector.vue'
import GameHistoryList, { type GameHistoryItem } from '@/components/GameHistoryList.vue'
import StalledBets from '@/components/StalledBets.vue'
import { getTiers } from '@/services/api'
import { SKINS, getSavedSkinId, saveSkinId, findSkin, type SkinState, type OddsBet } from '@/skins'

const AUTO_OPTIONS = [
  { label: 'OFF', value: null },
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: '∞', value: Infinity },
] as const

const AUTO_FLIP_PAUSE_MS = 900
const SLAB_MS_MANUAL = 1800
const SLAB_MS_AUTO = 700
// Minimum time the flip animation runs once the bet is placed, so a fast
// server resolution still reads as a real flip rather than an instant snap.
const MIN_FLIP_MS = 900
const WIN_FLASH_MS = 120
const SPARKLINE_MAX = 50
const PNL_KEY = 'coinflip.pnl_alltime'

interface SparkResult { won: boolean; key: number }
interface SlabResult { won: boolean; amount: number }

export default defineComponent({
  name: 'PlayView',
  components: { TierSelector, GameHistoryList, StalledBets },
  emits: ['open-wallet'],
  setup(_props, { emit }) {
    const store = useStore()

    // ── Game config ───────────────────────────────────────────────────
    const tiers = ref<number[]>([1000, 5000, 10000, 50000])
    const maxAvailable = ref(50000)
    // House spendable — the real ceiling on a payout (sizes the odds slider).
    const houseBankroll = ref(0)
    // arkd dust limit + variable-odds house edge — used to clamp the slider's
    // SAFE end (a high-win bet's house stake must clear dust, or the server
    // rejects it). Defaults mirror the server.
    const dust = ref(546)
    const oddsEdgeBps = ref(300)
    const rakeType = ref<'percentage' | 'flat'>('percentage')
    const rakeValue = ref(2)
    const houseReady = ref(false)
    const selectedTier = ref<number | null>(null)

    // ── Skin selection (early, so the odds slider can read the ladder) ──
    const currentSkinId = ref(getSavedSkinId())
    const currentSkin = computed(() => findSkin(currentSkinId.value))

    // ── Odds slider ───────────────────────────────────────────────────
    // The slider walks the active skin's bet ladder (strictly decreasing win
    // rate — more coins / reels / dice). `sliderIndex` is the position.
    const sliderIndex = ref(currentSkin.value.defaultStep)
    const currentSkinLadder = computed(() => currentSkin.value.oddsLadder)
    // The house escrow for a bet, mirroring the server's computeHouseStake
    // (house-edged): tier·(n−win)/win, trimmed by the edge. House stake RISES
    // with payout, so the ladder's playable window is a contiguous band:
    //   floor = first step whose stake clears dust (safe end, tiny stakes),
    //   ceiling = last step the bankroll can cover (risky end, big stakes).
    function houseStakeAt(tier: number, bet: OddsBet): number {
      const win = bet.target - bet.lo
      return Math.floor((tier * (bet.n - win) * (10000 - oddsEdgeBps.value)) / (win * 10000))
    }
    function houseStakeOf(bet: OddsBet): number {
      return houseStakeAt(selectedTier.value ?? 0, bet)
    }
    // A tier is offerable only if the CURRENT skin has at least one odds step
    // whose house stake both clears dust and fits the house bankroll. Capping on
    // the house STAKE (not the player's tier) matters for variable odds: a
    // high-win bet's house stake is far below the tier, so a tier-vs-bankroll
    // check would wrongly hide affordable bets. The slider then clamps the odds
    // range within the chosen tier; the server backstops over-cap bets.
    const affordableTiers = computed<number[]>(() =>
      tiers.value.filter((t) =>
        currentSkinLadder.value.some((b) => {
          const s = houseStakeAt(t, b)
          return s >= dust.value && s <= houseBankroll.value
        }),
      ),
    )
    const minStep = computed(() => {
      const ladder = currentSkinLadder.value
      if (!selectedTier.value) return 0
      for (let i = 0; i < ladder.length; i++) if (houseStakeOf(ladder[i]) >= dust.value) return i
      return ladder.length - 1 // nothing clears dust at this tier → pin to the riskiest
    })
    const maxStep = computed(() => {
      const ladder = currentSkinLadder.value
      if (!selectedTier.value) return ladder.length - 1
      let max = minStep.value
      for (let i = 0; i < ladder.length; i++) {
        if (houseStakeOf(ladder[i]) <= houseBankroll.value) max = i
        else break
      }
      return Math.max(max, minStep.value)
    })
    const safeStep = computed(() => Math.min(Math.max(sliderIndex.value, minStep.value), maxStep.value))
    const selectedBet = computed<OddsBet>(() => currentSkinLadder.value[safeStep.value])
    const stepLabel = computed(() => currentSkin.value.stepLabel(selectedBet.value, safeStep.value))
    const winPctLabel = computed(() => {
      const b = selectedBet.value
      const p = ((b.target - b.lo) / b.n) * 100
      return (p >= 10 ? Math.round(p) : Math.round(p * 10) / 10) + '%'
    })
    // ACTUAL payout multiple — what the player really receives, after the house
    // edge trims the house stake (computeHouseStake) AND the rake is taken off
    // the pot (calculateRake). The win% is exact (fees never touch probability);
    // this multiple is below the fair n/win because of the fees. Mirrors the
    // server economics so the slider shows the honest payout — e.g. a 50% coin
    // at 300 bps edge + 2% rake pays ~1.93×, not a fair 2×.
    function payoutMult(bet: OddsBet): string {
      const tier = selectedTier.value ?? 0
      if (!tier) return '—'
      const pot = tier + houseStakeAt(tier, bet)
      let rake = rakeType.value === 'percentage' ? Math.floor((pot * rakeValue.value) / 100) : rakeValue.value
      if (pot - rake < dust.value) rake = 0 // server waives a rake that would dust the payout
      const m = (pot - rake) / tier
      return m.toFixed(2).replace(/\.?0+$/, '') + '×'
    }

    // ── Flip lifecycle state ──────────────────────────────────────────
    // `climbing` and `settling` are for skins that own their play gesture
    // (Rocket): launch → climb → cashout → settle. Standard skins only
    // ever see idle / flipping / resolved.
    const phase = ref<'idle' | 'flipping' | 'resolved' | 'climbing' | 'settling'>('idle')
    const outcome = ref<{ won: boolean; side: 'heads' | 'tails'; roll: number | null } | null>(null)
    const isFlipping = ref(false)
    const error = ref<string | null>(null)

    const skinState = computed<SkinState>(() => ({
      phase: phase.value,
      outcome: outcome.value,
      odds: selectedBet.value,
    }))

    // ── Auto-flip state ───────────────────────────────────────────────
    const autoCount = ref<number | null>(null)
    const autoRemaining = ref(0)
    const isAutoRunning = ref(false)
    const stopRequested = ref(false)
    const isAutoMode = computed(() => autoCount.value !== null)
    const autoCountLabel = computed(() => autoCount.value === Infinity ? '∞' : String(autoCount.value ?? ''))
    const autoRemainingLabel = computed(() => isFinite(autoRemaining.value) ? String(autoRemaining.value) : '∞')

    // ── Skin selection ────────────────────────────────────────────────
    // (currentSkinId / currentSkin are declared above with the odds slider.)
    const skinOwnsGesture = computed(() => currentSkin.value.ownsPlayGesture === true)
    function selectSkin(id: string) {
      currentSkinId.value = id
      saveSkinId(id)
      // Reset to idle so a half-played gesture in the previous skin
      // doesn't bleed into the new one.
      phase.value = 'idle'
      outcome.value = null
    }

    /** Skin emitted `launch` — start the climb. (Only the Rocket skin does this today.) */
    function onSkinLaunch() {
      if (isFlipping.value) return
      phase.value = 'climbing'
      outcome.value = null
      error.value = null
    }

    /** Skin emitted `cashout` with the locked-in bet — commit it via flipOnce. */
    async function onSkinCashout(bet: OddsBet) {
      if (isFlipping.value) return
      phase.value = 'settling'
      await flipOnce(bet)
    }

    // ── History modal ─────────────────────────────────────────────────
    const historyOpen = ref(false)
    const historyGames = ref<GameHistoryItem[]>([])
    function openHistory() {
      try {
        historyGames.value = JSON.parse(localStorage.getItem('gameHistory') || '[]')
      } catch {
        historyGames.value = []
      }
      historyOpen.value = true
    }

    // ── P&L (session + all-time) ──────────────────────────────────────
    const sessionPnl = ref(0)
    const allTimePnl = ref<number>((() => {
      try { return JSON.parse(localStorage.getItem(PNL_KEY) || '0') } catch { return 0 }
    })())
    const pnlScope = ref<'session' | 'alltime'>('session')
    function togglePnlScope() {
      pnlScope.value = pnlScope.value === 'session' ? 'alltime' : 'session'
    }
    const displayedPnl = computed(() => pnlScope.value === 'session' ? sessionPnl.value : allTimePnl.value)
    const formattedPnl = computed(() => {
      const n = displayedPnl.value
      const sign = n > 0 ? '+' : n < 0 ? '−' : ''
      return `${sign}${Math.abs(n).toLocaleString()}`
    })
    const pnlClass = computed(() => {
      if (displayedPnl.value > 0) return 'up'
      if (displayedPnl.value < 0) return 'down'
      return 'neutral'
    })

    // ── Streak ────────────────────────────────────────────────────────
    const streak = ref<{ kind: 'win' | 'loss'; count: number }>({ kind: 'win', count: 0 })

    // ── Sparkline + slab + flash ──────────────────────────────────────
    const sparkline = ref<SparkResult[]>([])
    const slab = ref<SlabResult | null>(null)
    let slabTimer: ReturnType<typeof setTimeout> | null = null
    const winFlash = ref(false)

    // ── Other computed ────────────────────────────────────────────────
    // Spendable offchain balance (settled + preconfirmed). Was previously
    // returning the whole WalletBalance object (truthy), so `tier > balance`
    // was always false and tier options above the wallet balance were
    // staying enabled. Fall back to Infinity only when the wallet isn't
    // connected yet (state.walletBalance === null) so we don't gate the UI
    // on a stale-empty balance during boot.
    const playerBalance = computed(() => store.state.walletBalance?.available ?? Infinity)
    // Only a tier is required now — the side defaults to 'random', so a fresh
    // player can flip immediately after load.
    const canFlip = computed(() => !isFlipping.value && selectedTier.value !== null)

    // ── Data load ─────────────────────────────────────────────────────
    async function loadTiers() {
      try {
        const data = await getTiers()
        tiers.value = data.tiers
        maxAvailable.value = data.maxAvailable
        houseBankroll.value = data.houseBankroll ?? data.maxAvailable
        if (data.dust) dust.value = data.dust
        if (data.oddsEdgeBps !== undefined) oddsEdgeBps.value = data.oddsEdgeBps
        if (data.rakeType === 'percentage' || data.rakeType === 'flat') rakeType.value = data.rakeType
        if (data.rakeValue !== undefined) rakeValue.value = data.rakeValue
        houseReady.value = data.houseReady
        // Pre-select the cheapest affordable tier so getting started is one
        // click. Only set on first load (don't override a manual pick).
        if (selectedTier.value === null && tiers.value.length > 0) {
          selectedTier.value = Math.min(...tiers.value)
        }
      } catch (e) {
        console.warn('Failed to load tiers:', e)
      }
    }

    // ── Stats recording ───────────────────────────────────────────────
    let sparkKey = 0
    function recordResult(won: boolean, payout: number, roll: number | null) {
      const tier = selectedTier.value ?? 0
      const net = won ? payout - tier : -tier

      // P&L
      sessionPnl.value += net
      allTimePnl.value += net
      try { localStorage.setItem(PNL_KEY, JSON.stringify(allTimePnl.value)) } catch { /* quota */ }

      // Streak
      if (won) {
        streak.value = streak.value.kind === 'win'
          ? { kind: 'win', count: streak.value.count + 1 }
          : { kind: 'win', count: 1 }
      } else {
        streak.value = streak.value.kind === 'loss'
          ? { kind: 'loss', count: streak.value.count + 1 }
          : { kind: 'loss', count: 1 }
      }

      // Sparkline — newest pushed to the end (renders right-to-left).
      sparkline.value.push({ won, key: ++sparkKey })
      if (sparkline.value.length > SPARKLINE_MAX) sparkline.value.shift()

      // Outcome for the skin (roll = the variable-odds value; side is vestigial
      // now that every bet is variable-odds — kept for the SkinState shape).
      outcome.value = { won, side: 'heads', roll }
      phase.value = 'resolved'

      // Slab
      if (slabTimer) clearTimeout(slabTimer)
      slab.value = { won, amount: net }
      const slabMs = isAutoRunning.value ? SLAB_MS_AUTO : SLAB_MS_MANUAL
      slabTimer = setTimeout(() => { slab.value = null }, slabMs)

      // Win flash — only in manual mode to avoid strobing during auto.
      if (won && !isAutoRunning.value) {
        winFlash.value = true
        setTimeout(() => { winFlash.value = false }, WIN_FLASH_MS)
      }
    }

    // ── Single flip ───────────────────────────────────────────────────
    /**
     * Commit one game. `overrideBet` lets a skin that owns its play gesture
     * (Rocket) pass the bet it locked in at cashout — which may differ from
     * the parent slider's current step. When absent, falls back to
     * `selectedBet.value` (the slider's current position).
     */
    async function flipOnce(overrideBet?: OddsBet): Promise<boolean> {
      if (!selectedTier.value) return false

      // Mark busy but DON'T animate yet — we only spin once the bet is
      // actually placed on the server, so a rejected bet (insufficient
      // balance, house busy, validation) never shows a phantom flip.
      isFlipping.value = true
      // For gesture-owning skins, keep the 'settling' phase so the skin
      // doesn't flicker through 'idle' between cashout and flipping.
      if (!skinOwnsGesture.value) {
        phase.value = 'idle'
        outcome.value = null
      }
      error.value = null

      try {
        if (store.state.ark.status !== 'connected') {
          throw new Error('Wallet not connected — open the wallet drawer to reconnect.')
        }

        const playerChangeAddress = store.getters['ark/address']
        if (!playerChangeAddress) throw new Error('No Ark address available — wallet still connecting?')

        phase.value = 'flipping'

        // Trustless settlement: the store action escrows the player's stake,
        // reveals, and (on a win) sweeps the pot — all on-Ark. Keep animating
        // for at least MIN_FLIP_MS so a fast resolution still reads as a flip.
        const bet = overrideBet ?? selectedBet.value
        // Defense-in-depth dust guard. The odds slider already clamps coin /
        // roulette bets to a dust-safe house stake, and the Rocket skin gates its
        // cash-out the same way — but a gesture skin's overrideBet is the one path
        // that can hand us a sub-dust bet, which the server (and the on-chain
        // escrow) would reject. This is the universal choke point: never place a
        // bet whose house side falls below the dust floor.
        if (houseStakeOf(bet) < dust.value) {
          throw new Error(
            `That win chance is too high for this stake — the house side would fall below the ${dust.value}-sat minimum. Lower the win chance / multiplier or raise the stake.`,
          )
        }
        const [result] = await Promise.all([
          store.dispatch('ark/playTrustlessGame', {
            tier: selectedTier.value,
            oddsN: bet.n, oddsTarget: bet.target, oddsLo: bet.lo,
          }),
          new Promise((r) => setTimeout(r, MIN_FLIP_MS)),
        ])

        recordResult(result.winner === 'player', result.payout, result.roll ?? null)

        const historyEntry = {
          id: `${Date.now()}`,
          tier: selectedTier.value,
          playerChoice: stepLabel.value,
          winner: result.winner,
          rakeAmount: result.rake,
          payoutAmount: result.payout,
          status: 'resolved',
          createdAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
        }
        const history = JSON.parse(localStorage.getItem('gameHistory') || '[]')
        history.unshift(historyEntry)
        localStorage.setItem('gameHistory', JSON.stringify(history.slice(0, 100)))

        // No manual deferred refresh — the SDK contract watcher pushes the
        // post-flip balance the instant the sweep's vtxos move (ark.ts).

        return true
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Something went wrong'
        error.value = msg
        phase.value = 'idle'
        outcome.value = null
        setTimeout(() => { error.value = null }, 4000)
        return false
      } finally {
        isFlipping.value = false
      }
    }

    function selectAuto(value: number | null) {
      if (isAutoRunning.value) return
      autoCount.value = value
    }

    async function runAuto() {
      if (autoCount.value === null) return
      isAutoRunning.value = true
      stopRequested.value = false
      autoRemaining.value = autoCount.value === Infinity ? Infinity : autoCount.value

      while (autoRemaining.value > 0 && !stopRequested.value) {
        const ok = await flipOnce()
        if (!ok) break
        if (isFinite(autoRemaining.value)) autoRemaining.value -= 1
        if (autoRemaining.value > 0 && !stopRequested.value) {
          await new Promise((resolve) => setTimeout(resolve, AUTO_FLIP_PAUSE_MS))
        }
      }

      isAutoRunning.value = false
      stopRequested.value = false
      phase.value = 'idle'
    }

    async function doFlip() {
      if (isAutoRunning.value) {
        stopRequested.value = true
        return
      }
      if (isAutoMode.value) {
        await runAuto()
        return
      }
      await flipOnce()
    }

    // ── Keyboard hotkey: Enter to re-flip ─────────────────────────────
    function handleKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key !== 'Enter') return
      if (isFlipping.value || isAutoRunning.value) return
      if (!canFlip.value) return
      e.preventDefault()
      doFlip()
    }

    onMounted(async () => {
      window.addEventListener('keydown', handleKey)
      await loadTiers()

      if (store.state.ark.status !== 'connected' && store.state.ark.status !== 'connecting') {
        // Align to the server's network (env-driven) before connecting.
        store.dispatch('ark/syncNetworkFromServer').catch(() => { /* surfaced in drawer */ })
      }
      setTimeout(() => {
        const settled = Number(store.getters['ark/balance'] || 0)
        const boarding = Number(store.getters['ark/boardingBalance'] || 0)
        if (settled === 0 && boarding === 0) emit('open-wallet')
      }, 1500)
    })

    onUnmounted(() => {
      stopRequested.value = true
      window.removeEventListener('keydown', handleKey)
      if (slabTimer) clearTimeout(slabTimer)
    })

    // Switching skins swaps in that skin's own ladder — reset the slider to the
    // new skin's default step, clamped into the playable [dust, bankroll] window.
    watch(currentSkinId, () => {
      sliderIndex.value = Math.min(Math.max(currentSkin.value.defaultStep, minStep.value), maxStep.value)
    })
    // Keep the thumb inside the playable window when the stake changes — the
    // bankroll ceiling drops and the dust floor rises as the tier moves.
    watch([minStep, maxStep], ([lo, hi]) => {
      sliderIndex.value = Math.min(Math.max(sliderIndex.value, lo), hi)
    })

    return {
      // Game config
      tiers, maxAvailable, affordableTiers, houseReady, selectedTier,
      // Odds slider
      sliderIndex, minStep, maxStep, selectedBet, stepLabel, winPctLabel, payoutMult,
      // Lifecycle
      isFlipping, error, skinState, phase,
      // Auto
      autoOptions: AUTO_OPTIONS, autoCount, autoRemaining, isAutoRunning, isAutoMode,
      autoCountLabel, autoRemainingLabel,
      // Skin
      skins: SKINS, currentSkinId, currentSkin, selectSkin,
      skinOwnsGesture, onSkinLaunch, onSkinCashout,
      oddsEdgeBps,
      // History modal
      historyOpen, historyGames, openHistory,
      // Stats
      sessionPnl, allTimePnl, pnlScope, togglePnlScope, formattedPnl, pnlClass,
      streak, sparkline, slab, winFlash,
      // Other
      playerBalance, canFlip,
      // Actions
      selectAuto, doFlip,
    }
  },
})
</script>

<style scoped>
.play-page {
  max-width: 520px;
  margin: 0 auto;
  padding: 60px 16px 80px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  position: relative;
}

/* ── Top HUD ──────────────────────────────────────────────────────── */
.top-hud {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.skin-selector {
  display: flex;
  gap: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-light);
  border-radius: 999px;
  padding: 3px;
  /* Let the chips shrink when the HUD has to compete with the pill on
     narrow phones — otherwise the natural width pushes hud-right off-screen. */
  min-width: 0;
  flex-shrink: 1;
}
.skin-chip {
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 999px;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 1.05rem;
  line-height: 1;
  transition: all 0.15s;
}
.skin-chip:hover { color: var(--text); }
.skin-chip.selected {
  background: rgba(247, 201, 72, 0.14);
  color: var(--gold);
  box-shadow: 0 0 8px var(--gold-glow);
}
.skin-icon { display: inline-block; }

.hud-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.history-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-light);
  color: var(--text-muted);
  text-decoration: none;
  font-size: 1.05rem;
  line-height: 1;
  transition: all 0.18s;
}
.history-btn:hover {
  color: var(--gold);
  border-color: var(--gold);
  box-shadow: 0 0 10px var(--gold-glow);
}

.pnl-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-light);
  border-radius: 999px;
  padding: 6px 14px;
  cursor: pointer;
  user-select: none;
  font-size: 0.85rem;
  font-weight: 600;
  transition: all 0.18s;
}
.pnl-pill:hover { border-color: var(--text-muted); }
.pnl-scope {
  text-transform: uppercase;
  font-size: 0.62rem;
  letter-spacing: 1.5px;
  color: var(--text-muted);
  font-weight: 700;
}
.pnl-amount { font-family: ui-monospace, monospace; }
.pnl-pill.up .pnl-amount { color: var(--green, #22c55e); }
.pnl-pill.down .pnl-amount { color: var(--red); }
.pnl-pill.neutral .pnl-amount { color: var(--text-muted); }
.pnl-pill.up { border-color: rgba(34, 197, 94, 0.3); }
.pnl-pill.down { border-color: rgba(239, 68, 68, 0.3); }

/* ── Sparkline ──────────────────────────────────────────────────── */
.sparkline {
  width: 100%;
  display: flex;
  gap: 3px;
  justify-content: flex-end;
  flex-wrap: nowrap;
  overflow: hidden;
  min-height: 14px;
}
.spark-dot {
  width: 6px;
  height: 14px;
  border-radius: 2px;
  flex-shrink: 0;
  animation: sparkIn 0.3s ease both;
}
.spark-dot.win {
  background: linear-gradient(180deg, var(--green, #22c55e) 0%, #14532d 100%);
  box-shadow: 0 0 4px rgba(34, 197, 94, 0.5);
}
.spark-dot.loss {
  background: linear-gradient(180deg, #7f1d1d 0%, var(--red) 100%);
  box-shadow: 0 0 4px rgba(239, 68, 68, 0.4);
}
@keyframes sparkIn {
  from { opacity: 0; transform: translateX(8px); }
  to { opacity: 1; transform: translateX(0); }
}

/* ── Skin area ──────────────────────────────────────────────────── */
.skin-area {
  padding: 14px 0 16px;
  transition: filter 0.2s ease;
}
.skin-area.playing { filter: brightness(1.1); }

/* ── Streak badge ───────────────────────────────────────────────── */
.streak-badge {
  position: absolute;
  top: 120px;
  right: 18px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 1.5px;
  z-index: 10;
}
.streak-badge.win {
  background: rgba(247, 201, 72, 0.15);
  color: var(--gold);
  border: 1px solid var(--gold);
  box-shadow: 0 0 12px var(--gold-glow);
  animation: streakPulse 1.4s ease-in-out infinite;
}
.streak-badge.loss {
  background: rgba(56, 189, 248, 0.12);
  color: var(--blue);
  border: 1px solid var(--blue);
}
.streak-icon { font-size: 0.9rem; }
@keyframes streakPulse {
  0%, 100% { box-shadow: 0 0 12px var(--gold-glow); }
  50% { box-shadow: 0 0 20px var(--gold-glow), 0 0 30px rgba(247, 201, 72, 0.3); }
}
.streak-pop-enter-active, .streak-pop-leave-active { transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.streak-pop-enter-from { opacity: 0; transform: scale(0.6) translateY(-6px); }
.streak-pop-leave-to { opacity: 0; transform: scale(0.8); }

/* ── Controls ───────────────────────────────────────────────────── */
.controls {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 100%;
  align-items: center;
  transition: opacity 0.18s ease;
}
.controls.inert {
  opacity: 0.35;
  pointer-events: none;
}

.control-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.auto-call-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elevated);
  border: 1.5px dashed var(--gold);
  color: var(--gold);
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 1.5px;
}
.dice-icon { font-size: 1.1rem; }

/* Auto chips */
.auto-selector {
  display: flex;
  gap: 6px;
  justify-content: center;
  flex-wrap: wrap;
  width: 100%;
  max-width: 340px;
}
.auto-chip {
  flex: 1;
  min-width: 42px;
  background: var(--bg-elevated);
  border: 1.5px solid var(--border-light);
  color: var(--text-muted);
  border-radius: 8px;
  padding: 8px 4px;
  font-size: 0.78rem;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}
.auto-chip:hover:not(:disabled) { border-color: var(--blue); color: var(--text); }
.auto-chip.selected {
  border-color: var(--gold);
  background: rgba(247, 201, 72, 0.1);
  color: var(--gold);
}
.auto-chip:disabled { opacity: 0.4; cursor: not-allowed; }

/* Odds slider */
.odds-slider {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 340px;
}
.odds-readout {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.odds-step-label {
  font-size: 0.92rem;
  font-weight: 800;
  letter-spacing: 1px;
  color: var(--gold);
}
.odds-readout .odds-stats {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.win-pct {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--text);
}
.payout-mult {
  font-size: 0.95rem;
  font-weight: 800;
  font-family: ui-monospace, monospace;
  color: var(--green, #22c55e);
}
.odds-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--green, #22c55e) 0%, var(--gold) 55%, var(--red) 100%);
  outline: none;
  cursor: pointer;
}
.odds-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--gold);
  border: 2px solid var(--bg);
  box-shadow: 0 0 10px var(--gold-glow);
  cursor: pointer;
}
.odds-range::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--gold);
  border: 2px solid var(--bg);
  box-shadow: 0 0 10px var(--gold-glow);
  cursor: pointer;
}
.odds-ends {
  display: flex;
  justify-content: space-between;
  font-size: 0.58rem;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-muted);
}

/* Flip button */
.flip-btn {
  width: 100%;
  max-width: 340px;
  background: var(--bg-elevated);
  border: 2px solid var(--border-light);
  color: var(--text-muted);
  border-radius: 12px;
  padding: 16px 36px;
  font-size: 1.05rem;
  font-weight: 800;
  letter-spacing: 3px;
  cursor: not-allowed;
  transition: all 0.2s;
  font-family: inherit;
}
.flip-btn.active {
  border-color: var(--gold);
  color: var(--gold);
  cursor: pointer;
  background: rgba(247, 201, 72, 0.06);
  box-shadow: 0 0 16px var(--gold-glow);
}
.flip-btn.active:hover {
  background: linear-gradient(135deg, var(--gold) 0%, var(--gold-dim) 100%);
  color: var(--bg);
  box-shadow: 0 4px 28px var(--gold-glow), 0 0 50px var(--gold-glow);
  transform: translateY(-1px);
}
.flip-btn.active:active { transform: translateY(0) scale(0.99); }
.flip-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.flip-btn.stop {
  border-color: var(--red);
  color: var(--red);
  cursor: pointer;
  background: rgba(239, 68, 68, 0.08);
  opacity: 1;
}
.flip-btn.stop:hover { background: var(--red); color: #fff; }

.hotkey-hint {
  font-size: 0.62rem;
  color: var(--text-muted);
  letter-spacing: 2px;
  margin-top: -8px;
  opacity: 0.6;
}

/* ── Error toast ────────────────────────────────────────────────── */
.error-toast {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--red);
  color: #fff;
  padding: 10px 24px;
  border-radius: 10px;
  font-size: 0.85rem;
  font-weight: 600;
  z-index: 999;
  animation: slideUp 0.3s ease;
  box-shadow: 0 4px 20px rgba(239, 68, 68, 0.4);
}

/* ── Win flash ──────────────────────────────────────────────────── */
.win-flash {
  position: fixed;
  inset: 0;
  background: radial-gradient(circle at 50% 40%, rgba(34, 197, 94, 0.18) 0%, transparent 70%);
  pointer-events: none;
  z-index: 100;
  animation: winFlashAnim 120ms ease-out;
}
@keyframes winFlashAnim {
  0%   { opacity: 0; }
  20%  { opacity: 1; }
  100% { opacity: 0; }
}

/* ── Result slab ────────────────────────────────────────────────── */
.result-slab {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 22px 24px 30px;
  text-align: center;
  z-index: 200;
  backdrop-filter: blur(8px);
}
.result-slab.win {
  background: linear-gradient(180deg, rgba(34, 197, 94, 0.18) 0%, rgba(20, 83, 45, 0.6) 100%);
  border-top: 1px solid rgba(34, 197, 94, 0.5);
}
.result-slab.loss {
  background: linear-gradient(180deg, rgba(239, 68, 68, 0.12) 0%, rgba(127, 29, 29, 0.4) 100%);
  border-top: 1px solid rgba(239, 68, 68, 0.4);
}
.slab-label {
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 4px;
  text-transform: uppercase;
}
.result-slab.win .slab-label { color: var(--green, #22c55e); font-size: 0.85rem; letter-spacing: 6px; }
.result-slab.loss .slab-label { color: var(--red); }
.slab-amount {
  margin-top: 6px;
  font-weight: 800;
  letter-spacing: 1px;
}
.result-slab.win .slab-amount { font-size: 2.2rem; color: var(--green, #22c55e); }
.result-slab.loss .slab-amount { font-size: 1.4rem; color: var(--red); }
.slab-unit { font-size: 0.65rem; color: var(--text-muted); margin-left: 4px; letter-spacing: 2px; }

.slab-enter-active, .slab-leave-active { transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s; }
.slab-enter-from { transform: translateY(100%); opacity: 0; }
.slab-leave-to { transform: translateY(100%); opacity: 0; }

/* ── History modal ──────────────────────────────────────────────── */
.hist-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.hist-modal {
  width: min(520px, 100%);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.hist-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.hist-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 1px;
  color: var(--text);
}
.hist-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1.6rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  transition: color 0.15s;
}
.hist-close:hover { color: var(--text); }
/* Only the list scrolls — the header stays pinned. */
.hist-body {
  overflow-y: auto;
  flex: 1;
  -webkit-overflow-scrolling: touch;
}
.hist-fade-enter-active, .hist-fade-leave-active { transition: opacity 0.2s; }
.hist-fade-enter-from, .hist-fade-leave-to { opacity: 0; }

@media (max-width: 640px) {
  .side-btn { padding: 12px 10px; font-size: 0.8rem; }
  .flip-btn { padding: 14px 28px; font-size: 0.95rem; }
  .streak-badge { top: 100px; right: 10px; }
  .result-slab.win .slab-amount { font-size: 1.8rem; }

  /* Tight HUD: at <520px the skin chips + pnl pill + 2 round buttons
     together exceeded the viewport, pushing the right side off-screen.
     Shrink chip padding, drop the pnl 'SESSION' label, hide help button
     (still reachable via /how-it-works directly). */
  .play-page { padding: 48px 12px 80px; }
  .skin-chip { padding: 5px 8px; font-size: 1rem; }
  .pnl-pill { padding: 5px 10px; font-size: 0.8rem; gap: 6px; }
  .pnl-scope { display: none; }
  .history-btn { width: 30px; height: 30px; font-size: 0.95rem; }
}

@media (max-width: 380px) {
  /* Very narrow phones — even tighter. Cut chip padding further and drop the
     help button entirely. */
  .skin-chip { padding: 5px 6px; font-size: 0.95rem; }
  .help-btn { display: none; }
}

/* Auto-chip row should always fit and wrap if it can't. The base CSS already
   sets flex-wrap; this just lets each chip shrink past its 42px min-width on
   narrow viewports rather than overflowing the parent. */
@media (max-width: 520px) {
  .auto-chip { min-width: 0; padding: 8px 2px; font-size: 0.72rem; }
}

/* Slider end labels: 'RISKIER · BIGGER PAYOUT' is borderline at 380px. Allow
   the right end to wrap to two lines instead of clipping. */
@media (max-width: 420px) {
  .odds-ends { font-size: 0.54rem; }
  .odds-ends span:last-child { text-align: right; }
}
</style>
