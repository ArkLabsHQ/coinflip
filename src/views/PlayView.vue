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
      </div>
    </div>

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

    <!-- Centerpiece skin -->
    <div class="skin-area" :class="{ playing: isFlipping }">
      <component :is="currentSkin.component" :state="skinState" />
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
          :max-available="maxAvailable"
          :player-balance="playerBalance"
          @select="selectedTier = $event"
        />
      </div>

      <!-- Side selection only for skins where it's meaningful (coin). Default
           is RANDOM so getting started is one click. Auto mode always
           randomises, so the selector hides during auto. -->
      <div v-if="currentSkin.supportsSide && !isAutoMode" class="side-selector">
        <button
          class="side-btn random"
          :class="{ selected: selectedSide === 'random' }"
          @click="selectedSide = 'random'"
        >
          <span class="side-icon">&#9858;</span>
          RANDOM
        </button>
        <button
          class="side-btn"
          :class="{ selected: selectedSide === 'heads' }"
          @click="selectedSide = 'heads'"
        >
          <span class="side-icon">&#x20BF;</span>
          HEADS
        </button>
        <button
          class="side-btn"
          :class="{ selected: selectedSide === 'tails' }"
          @click="selectedSide = 'tails'"
        >
          <span class="side-icon flipped">&#x20BF;</span>
          TAILS
        </button>
      </div>

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
import { getTiers } from '@/services/api'
import { SKINS, getSavedSkinId, saveSkinId, findSkin, type SkinState } from '@/skins'

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
  components: { TierSelector, GameHistoryList },
  emits: ['open-wallet'],
  setup(_props, { emit }) {
    const store = useStore()

    // ── Game config ───────────────────────────────────────────────────
    const tiers = ref<number[]>([1000, 5000, 10000, 50000])
    const maxAvailable = ref(50000)
    const houseReady = ref(false)
    const selectedTier = ref<number | null>(null)
    // 'random' (default) flips a random side each play — getting started is
    // one click. 'heads'/'tails' are explicit player calls (coin skin only).
    const selectedSide = ref<'heads' | 'tails' | 'random'>('random')

    // ── Flip lifecycle state ──────────────────────────────────────────
    const phase = ref<'idle' | 'flipping' | 'resolved'>('idle')
    const outcome = ref<{ won: boolean; side: 'heads' | 'tails' } | null>(null)
    const isFlipping = ref(false)
    const error = ref<string | null>(null)

    const skinState = computed<SkinState>(() => ({
      phase: phase.value,
      outcome: outcome.value,
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
    const currentSkinId = ref(getSavedSkinId())
    const currentSkin = computed(() => findSkin(currentSkinId.value))
    function selectSkin(id: string) {
      currentSkinId.value = id
      saveSkinId(id)
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
    const playerBalance = computed(() => store.state.walletBalance || Infinity)
    // Only a tier is required now — the side defaults to 'random', so a fresh
    // player can flip immediately after load.
    const canFlip = computed(() => !isFlipping.value && selectedTier.value !== null)

    // ── Data load ─────────────────────────────────────────────────────
    async function loadTiers() {
      try {
        const data = await getTiers()
        tiers.value = data.tiers
        maxAvailable.value = data.maxAvailable
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

    /** Resolve the side to actually play: explicit pick, or a coin toss. */
    function resolveSide(): 'heads' | 'tails' {
      if (selectedSide.value === 'random') return Math.random() < 0.5 ? 'heads' : 'tails'
      return selectedSide.value
    }

    // ── Stats recording ───────────────────────────────────────────────
    let sparkKey = 0
    function recordResult(side: 'heads' | 'tails', won: boolean, payout: number) {
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

      // Outcome for the skin
      outcome.value = { won, side }
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
    async function flipOnce(side: 'heads' | 'tails'): Promise<boolean> {
      if (!selectedTier.value) return false

      // Mark busy but DON'T animate yet — we only spin once the bet is
      // actually placed on the server, so a rejected bet (insufficient
      // balance, house busy, validation) never shows a phantom flip.
      isFlipping.value = true
      phase.value = 'idle'
      outcome.value = null
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
        const [result] = await Promise.all([
          store.dispatch('ark/playTrustlessGame', { tier: selectedTier.value, side }),
          new Promise((r) => setTimeout(r, MIN_FLIP_MS)),
        ])

        recordResult(side, result.winner === 'player', result.payout)

        const historyEntry = {
          id: `${Date.now()}`,
          tier: selectedTier.value,
          playerChoice: side,
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

        setTimeout(() => {
          store.dispatch('ark/refreshBalance').catch(() => { /* deferred for indexer lag */ })
        }, 2000)

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
        const side: 'heads' | 'tails' = Math.random() < 0.5 ? 'heads' : 'tails'
        const ok = await flipOnce(side)
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
      await flipOnce(resolveSide())
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

    // Reset streak silently to 0 when starting a fresh session via PnL reload —
    // not strictly necessary, just guards against runaway counters.
    watch(currentSkinId, () => {
      // Cosmetic: skin change doesn't reset stats. Future: per-skin stats.
    })

    return {
      // Game config
      tiers, maxAvailable, houseReady, selectedTier, selectedSide,
      // Lifecycle
      isFlipping, error, skinState, phase,
      // Auto
      autoOptions: AUTO_OPTIONS, autoCount, autoRemaining, isAutoRunning, isAutoMode,
      autoCountLabel, autoRemainingLabel,
      // Skin
      skins: SKINS, currentSkinId, currentSkin, selectSkin,
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

/* Side selector */
.side-selector {
  display: flex;
  gap: 10px;
  justify-content: center;
  width: 100%;
  max-width: 340px;
}
.side-btn {
  flex: 1;
  background: var(--bg-elevated);
  border: 1.5px solid var(--border-light);
  color: var(--text-dim);
  border-radius: 12px;
  padding: 14px 12px;
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: 1.5px;
  cursor: pointer;
  transition: all 0.18s;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-family: inherit;
}
.side-icon { font-size: 1.4rem; color: var(--gold); opacity: 0.5; transition: opacity 0.18s; }
.side-icon.flipped { transform: scaleX(-1); filter: brightness(0.8); }
.side-btn:hover { border-color: var(--blue); color: var(--text); }
.side-btn:hover .side-icon { opacity: 0.8; }
.side-btn.selected {
  border-color: var(--blue);
  background: rgba(56, 189, 248, 0.08);
  color: var(--blue);
  box-shadow: 0 0 16px var(--blue-glow);
}
.side-btn.selected .side-icon { opacity: 1; color: var(--blue); }
.side-btn.random.selected {
  border-color: var(--gold);
  background: rgba(247, 201, 72, 0.08);
  color: var(--gold);
  box-shadow: 0 0 16px var(--gold-glow);
}
.side-btn.random.selected .side-icon { opacity: 1; color: var(--gold); }

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
}
</style>
