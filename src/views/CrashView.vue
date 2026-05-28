<template>
  <div class="page crash-page">
    <!-- Win flash — same Stake/Roobet trick PlayView uses. -->
    <div v-if="winFlash" class="win-flash" />

    <!-- Top HUD: mode is set by the nav in App.vue; here we mirror PlayView's
         right-side P&L pill + history button so both games share the HUD. -->
    <div class="top-hud">
      <div class="mode-tag">🚀 CRASH</div>
      <div class="hud-right">
        <div class="pnl-pill" :class="pnlClass" @click="togglePnlScope" :title="`Click to switch — currently ${pnlScope}`">
          <span class="pnl-scope">{{ pnlScope }}</span>
          <span class="pnl-amount mono">{{ formattedPnl }}</span>
        </div>
        <button class="history-btn" title="Game history" @click="openHistory">&#9827;</button>
      </div>
    </div>

    <!-- Trustless safety net: a crash bet escrows the player's stake just like a
         flip, so a stalled game is reclaimable here without trusting the server. -->
    <StalledBets />

    <!-- The rocket gauge: one big multiplier that climbs while holding, freezes
         on cash-out, then either confirms the cash-out (win) or shows the real
         crash point C revealed by the on-chain roll (loss). -->
    <div class="gauge" :class="gaugeClass">
      <div class="gauge-mult mono">{{ gaugeText }}</div>
      <div class="gauge-sub">{{ gaugeSub }}</div>
    </div>

    <div class="controls" :class="{ inert: phase === 'settling' }">
      <!-- IDLE: pick stake + auto-cashout target, then launch. -->
      <template v-if="phase === 'idle' || phase === 'revealed'">
        <TierSelector
          :tiers="tiers"
          :selected-tier="selectedTier"
          :affordable-tiers="affordableTiers"
          :player-balance="playerBalance"
          @select="selectedTier = $event"
        />

        <div class="target-slider" v-if="selectedTier">
          <div class="target-readout">
            <span class="target-label">AUTO CASH OUT</span>
            <span class="target-stats">
              <span class="win-pct">{{ winPctLabel }} chance</span>
              <span class="target-mult mono">{{ targetMult.toFixed(2) }}×</span>
            </span>
          </div>
          <input
            class="target-range"
            type="range"
            :min="floorIdx"
            :max="ceilIdx"
            step="1"
            v-model.number="targetIndex"
            aria-label="Auto cash-out multiplier"
          />
          <div class="target-hint">
            <span>hold for more · cash out anytime ≥ {{ minMult.toFixed(2) }}×</span>
            <span class="payout-preview mono">→ {{ potentialPayout.toLocaleString() }} sats</span>
          </div>
        </div>

        <button class="launch-btn" :class="{ active: canLaunch }" :disabled="!canLaunch" @click="launch">
          {{ phase === 'revealed' ? 'LAUNCH AGAIN' : 'LAUNCH 🚀' }}
        </button>
      </template>

      <!-- CLIMBING: the only control is CASH OUT (armed once past the dust floor). -->
      <template v-else-if="phase === 'climbing'">
        <button class="cashout-btn" :class="{ armed: canCashOut }" :disabled="!canCashOut" @click="() => cashOut(false)">
          CASH OUT @ {{ displayMult.toFixed(2) }}×
          <span class="cashout-sats mono">{{ liveCashoutSats.toLocaleString() }} sats</span>
        </button>
        <div class="climb-hint" v-if="!canCashOut">arming at {{ minMult.toFixed(2) }}×…</div>
        <div class="climb-hint" v-else>auto cash-out at {{ targetMult.toFixed(2) }}×</div>
      </template>

      <!-- SETTLING: bet is locked on-chain; waiting for the reveal. -->
      <template v-else-if="phase === 'settling'">
        <div class="settling-note">LOCKING IN @ {{ lockedMult.toFixed(2) }}× …</div>
      </template>
    </div>

    <div v-if="error" class="error-toast">{{ error }}</div>

    <!-- Result slab — reused from PlayView's vocabulary. -->
    <transition name="slab">
      <div v-if="slab" class="result-slab" :class="slab.won ? 'win' : 'loss'">
        <div class="slab-label">{{ slab.won ? `CASHED OUT @ ${lockedMult.toFixed(2)}×` : `CRASHED @ ${crashLabel}` }}</div>
        <div class="slab-amount mono">
          {{ slab.won ? '+' : '−' }}{{ Math.abs(slab.amount).toLocaleString() }}
          <span class="slab-unit">sats</span>
        </div>
      </div>
    </transition>

    <!-- Shared game-history modal. -->
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
import {
  CRASH_ODDS_N, CRASH_LADDER, rollToCrashPoint, crashHouseStake,
} from '@/crash'

// Exponential climb: multiplier = e^(rate·seconds). 0.18 reaches ~2× in 3.9s,
// ~5× in 8.9s, ~10× in 12.8s — fast enough to stay tense, slow enough to read.
const CLIMB_RATE = 0.18
const SLAB_MS = 2200
const WIN_FLASH_MS = 120
const PNL_KEY = 'coinflip.pnl_alltime'

type Phase = 'idle' | 'climbing' | 'settling' | 'revealed'
interface SlabResult { won: boolean; amount: number }

export default defineComponent({
  name: 'CrashView',
  components: { TierSelector, GameHistoryList, StalledBets },
  emits: ['open-wallet'],
  setup(_props, { emit }) {
    const store = useStore()

    // ── Config (from /api/tiers, same source PlayView uses) ───────────
    const tiers = ref<number[]>([1000, 5000, 10000, 50000])
    const houseBankroll = ref(0)
    const dust = ref(546)
    const oddsEdgeBps = ref(300)
    const selectedTier = ref<number | null>(null)

    // ── Money math (mirrors the server's computeHouseStake via crash.ts) ──
    // House escrow for "reach M" at this stake. Rises with M (bigger payout),
    // so the playable multiplier window is a band: the dust FLOOR (a low M's
    // stake must clear dust) up to the bankroll CEILING (a high M's stake must
    // fit what the house can pay). Identical shape to PlayView's odds slider.
    // Integer win-count is the single source of truth for a crash bet: a band
    // of `win` winning rolls out of n, threshold n/win, win chance win/n.
    // Building odds straight from `win` (never round-tripping a multiplier back
    // through floor(n/M)) keeps the committed band byte-identical to what the
    // player sees — a win→n/win→floor round-trip drifts by ±1 for ~6% of bands.
    function oddsForWin(win: number) {
      return { oddsN: CRASH_ODDS_N, oddsTarget: CRASH_ODDS_N, oddsLo: CRASH_ODDS_N - win }
    }
    function winForMult(m: number): number {
      return Math.min(CRASH_ODDS_N - 1, Math.max(1, Math.round(CRASH_ODDS_N / m)))
    }
    function houseStakeForWin(bet: number, win: number): number {
      return crashHouseStake(bet, oddsForWin(win), oddsEdgeBps.value)
    }
    function houseStakeFor(bet: number, m: number): number {
      return houseStakeForWin(bet, winForMult(m))
    }
    // A tier is offerable iff SOME ladder multiplier yields a stake within
    // [dust, bankroll] — capping on the house STAKE, not the player's tier
    // (a high-chance/low-M bet's stake is far below the tier).
    const affordableTiers = computed<number[]>(() =>
      tiers.value.filter((t) =>
        CRASH_LADDER.some((m) => {
          const s = houseStakeFor(t, m)
          return s >= dust.value && s <= houseBankroll.value
        }),
      ),
    )
    // Ladder indices playable at the current stake (clamped slider bounds).
    const floorIdx = computed(() => {
      const bet = selectedTier.value
      if (!bet) return 0
      for (let i = 0; i < CRASH_LADDER.length; i++) if (houseStakeFor(bet, CRASH_LADDER[i]) >= dust.value) return i
      return CRASH_LADDER.length - 1
    })
    const ceilIdx = computed(() => {
      const bet = selectedTier.value
      if (!bet) return CRASH_LADDER.length - 1
      let hi = floorIdx.value
      for (let i = floorIdx.value; i < CRASH_LADDER.length; i++) {
        if (houseStakeFor(bet, CRASH_LADDER[i]) <= houseBankroll.value) hi = i
        else break
      }
      return Math.max(hi, floorIdx.value)
    })

    const targetIndex = ref(0)
    const safeTargetIdx = computed(() => Math.min(Math.max(targetIndex.value, floorIdx.value), ceilIdx.value))
    // Auto-cashout ceiling (the most you'll ride to) and dust floor (the least
    // you can cash out at). Both are exact achievable thresholds (n=300 is
    // divisible by every ladder M, so 1/M is exact at each stop).
    const targetMult = computed(() => CRASH_LADDER[safeTargetIdx.value])
    const minMult = computed(() => CRASH_LADDER[floorIdx.value])
    const winPctLabel = computed(() => {
      const p = (1 / targetMult.value) * 100
      return (p >= 10 ? Math.round(p) : Math.round(p * 10) / 10) + '%'
    })
    // Gross sats the player sweeps if the rocket reaches the auto target =
    // stake + house stake (payout = bet · effective multiple, edge baked in).
    const potentialPayout = computed(() =>
      selectedTier.value ? selectedTier.value + houseStakeFor(selectedTier.value, targetMult.value) : 0,
    )

    // ── Live climb ────────────────────────────────────────────────────
    const phase = ref<Phase>('idle')
    const rawMult = ref(1)        // continuous e^(rate·t)
    const lockedWin = ref(1)      // integer winning-roll count locked at cash-out
    const lockedMult = ref(1)     // its threshold n/win, for display
    const crashPoint = ref<number | null>(null)
    const won = ref(false)
    const error = ref<string | null>(null)
    let rafId: number | null = null
    let climbStart = 0

    // Snap the continuous climb to an achievable crash threshold by tracking the
    // integer winning-roll count: as rawMult rises, fewer rolls win (win falls),
    // so the threshold n/win rises in exact steps. `liveWin` is the band we
    // actually commit on cash-out and the display is derived FROM it, so what the
    // player sees IS what settles on-chain (reveal "C ≥ n/win" agrees byte-for-
    // byte with the chain's "roll ≥ n−win").
    const liveWin = computed(() =>
      Math.min(CRASH_ODDS_N - 1, Math.max(1, Math.floor(CRASH_ODDS_N / Math.min(rawMult.value, CRASH_ODDS_N)))),
    )
    const displayMult = computed(() => CRASH_ODDS_N / liveWin.value)
    const canCashOut = computed(() => phase.value === 'climbing' && displayMult.value >= minMult.value)
    // What the player would sweep if they cashed out right now.
    const liveCashoutSats = computed(() =>
      selectedTier.value ? selectedTier.value + houseStakeForWin(selectedTier.value, liveWin.value) : 0,
    )

    function tick(now: number) {
      rawMult.value = Math.exp(CLIMB_RATE * ((now - climbStart) / 1000))
      // Auto cash-out the moment the snapped display reaches the chosen ceiling.
      if (displayMult.value >= targetMult.value) {
        void cashOut(true)
        return
      }
      rafId = requestAnimationFrame(tick)
    }

    const playerBalance = computed(() => store.state.walletBalance || Infinity)
    const canLaunch = computed(() =>
      (phase.value === 'idle' || phase.value === 'revealed') &&
      selectedTier.value !== null &&
      ceilIdx.value >= floorIdx.value,
    )

    function launch() {
      if (!canLaunch.value) return
      error.value = null
      crashPoint.value = null
      won.value = false
      slab.value = null
      rawMult.value = 1
      phase.value = 'climbing'
      climbStart = performance.now()
      rafId = requestAnimationFrame(tick)
    }

    // Lock the multiplier (manual click = current display, auto = the ceiling)
    // and settle the bet on-chain. The climb is a variance picker: the roll is
    // only committed HERE, so holding longer just chooses a higher M / lower
    // win chance — no information leaks from the climb (it's a timer, not the
    // crash itself), which keeps the commit-reveal fair.
    async function cashOut(isAuto: boolean) {
      if (phase.value !== 'climbing') return
      if (!isAuto && !canCashOut.value) return
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
      lockedWin.value = isAuto ? winForMult(targetMult.value) : liveWin.value
      lockedMult.value = CRASH_ODDS_N / lockedWin.value
      phase.value = 'settling'
      await settle()
    }

    async function settle() {
      const bet = selectedTier.value
      if (!bet) { phase.value = 'idle'; return }
      try {
        if (store.state.ark.status !== 'connected') {
          throw new Error('Wallet not connected — open the wallet drawer to reconnect.')
        }
        const odds = oddsForWin(lockedWin.value)
        const result = await store.dispatch('ark/playTrustlessGame', {
          tier: bet,
          oddsN: odds.oddsN, oddsTarget: odds.oddsTarget, oddsLo: odds.oddsLo,
        })
        // result.winner is the on-chain truth; C is the revealed crash point.
        // They agree by construction (win ⟺ roll ≥ lo ⟺ C ≥ lockedMult).
        won.value = result.winner === 'player'
        crashPoint.value = result.roll != null ? rollToCrashPoint(result.roll, odds.oddsN) : null
        recordResult(won.value, result.payout, result.rake)
        phase.value = 'revealed'
        setTimeout(() => {
          store.dispatch('ark/refreshBalance').catch(() => { /* indexer lag */ })
        }, 2000)
      } catch (e: unknown) {
        error.value = e instanceof Error ? e.message : 'Something went wrong'
        phase.value = 'idle'
        setTimeout(() => { error.value = null }, 5000)
      }
    }

    // ── Gauge presentation ────────────────────────────────────────────
    const crashLabel = computed(() => crashPoint.value != null ? `${crashPoint.value.toFixed(2)}×` : '—')
    const gaugeClass = computed(() => {
      if (phase.value === 'climbing') return 'climbing'
      if (phase.value === 'settling') return 'settling'
      if (phase.value === 'revealed') return won.value ? 'won' : 'lost'
      return 'idle'
    })
    const gaugeText = computed(() => {
      if (phase.value === 'climbing') return `${displayMult.value.toFixed(2)}×`
      if (phase.value === 'settling') return `${lockedMult.value.toFixed(2)}×`
      if (phase.value === 'revealed') return won.value ? `${lockedMult.value.toFixed(2)}×` : crashLabel.value
      return '1.00×'
    })
    const gaugeSub = computed(() => {
      if (phase.value === 'climbing') return 'HOLDING…'
      if (phase.value === 'settling') return 'locking in'
      if (phase.value === 'revealed') return won.value ? 'cashed out' : 'crashed'
      return 'set your target & launch'
    })

    // ── P&L / history / slab (shared keys with PlayView) ──────────────
    const sessionPnl = ref(0)
    const allTimePnl = ref<number>((() => {
      try { return JSON.parse(localStorage.getItem(PNL_KEY) || '0') } catch { return 0 }
    })())
    const pnlScope = ref<'session' | 'alltime'>('session')
    function togglePnlScope() { pnlScope.value = pnlScope.value === 'session' ? 'alltime' : 'session' }
    const displayedPnl = computed(() => pnlScope.value === 'session' ? sessionPnl.value : allTimePnl.value)
    const formattedPnl = computed(() => {
      const n = displayedPnl.value
      const sign = n > 0 ? '+' : n < 0 ? '−' : ''
      return `${sign}${Math.abs(n).toLocaleString()}`
    })
    const pnlClass = computed(() => displayedPnl.value > 0 ? 'up' : displayedPnl.value < 0 ? 'down' : 'neutral')

    const slab = ref<SlabResult | null>(null)
    let slabTimer: ReturnType<typeof setTimeout> | null = null
    const winFlash = ref(false)

    function recordResult(isWin: boolean, payout: number, rake: number) {
      const bet = selectedTier.value ?? 0
      const net = isWin ? payout - bet : -bet
      sessionPnl.value += net
      allTimePnl.value += net
      try { localStorage.setItem(PNL_KEY, JSON.stringify(allTimePnl.value)) } catch { /* quota */ }

      const entry: GameHistoryItem = {
        id: `${Date.now()}`,
        tier: bet,
        playerChoice: `CRASH ${lockedMult.value.toFixed(2)}×`,
        winner: isWin ? 'player' : 'house',
        rakeAmount: rake,
        payoutAmount: payout,
        status: 'resolved',
        createdAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
      }
      try {
        const history = JSON.parse(localStorage.getItem('gameHistory') || '[]')
        history.unshift(entry)
        localStorage.setItem('gameHistory', JSON.stringify(history.slice(0, 100)))
      } catch { /* quota */ }

      if (slabTimer) clearTimeout(slabTimer)
      slab.value = { won: isWin, amount: net }
      slabTimer = setTimeout(() => { slab.value = null }, SLAB_MS)
      if (isWin) {
        winFlash.value = true
        setTimeout(() => { winFlash.value = false }, WIN_FLASH_MS)
      }
    }

    const historyOpen = ref(false)
    const historyGames = ref<GameHistoryItem[]>([])
    function openHistory() {
      try { historyGames.value = JSON.parse(localStorage.getItem('gameHistory') || '[]') } catch { historyGames.value = [] }
      historyOpen.value = true
    }

    // ── Data load + wallet bootstrap (mirrors PlayView) ───────────────
    async function loadTiers() {
      try {
        const data = await getTiers()
        tiers.value = data.tiers
        houseBankroll.value = data.houseBankroll ?? data.maxAvailable
        if (data.dust) dust.value = data.dust
        if (data.oddsEdgeBps !== undefined) oddsEdgeBps.value = data.oddsEdgeBps
        if (selectedTier.value === null && tiers.value.length > 0) {
          selectedTier.value = Math.min(...tiers.value)
        }
      } catch (e) {
        console.warn('Failed to load tiers:', e)
      }
    }

    onMounted(async () => {
      await loadTiers()
      // Default the slider to the safest playable target for the chosen stake.
      targetIndex.value = floorIdx.value
      if (store.state.ark.status !== 'connected' && store.state.ark.status !== 'connecting') {
        store.dispatch('ark/syncNetworkFromServer').catch(() => { /* surfaced in drawer */ })
      }
      setTimeout(() => {
        const settled = Number(store.getters['ark/balance'] || 0)
        const boarding = Number(store.getters['ark/boardingBalance'] || 0)
        if (settled === 0 && boarding === 0) emit('open-wallet')
      }, 1500)
    })

    onUnmounted(() => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (slabTimer) clearTimeout(slabTimer)
    })

    // Keep the slider inside the playable window as stake/bankroll shift.
    watch([floorIdx, ceilIdx], ([lo, hi]) => {
      targetIndex.value = Math.min(Math.max(targetIndex.value, lo), hi)
    })

    return {
      tiers, selectedTier, affordableTiers, playerBalance,
      floorIdx, ceilIdx, targetIndex, targetMult, minMult, winPctLabel, potentialPayout,
      phase, displayMult, lockedMult, crashLabel, canCashOut, canLaunch, liveCashoutSats,
      gaugeClass, gaugeText, gaugeSub, error,
      launch, cashOut,
      pnlScope, togglePnlScope, formattedPnl, pnlClass,
      slab, winFlash, historyOpen, historyGames, openHistory,
    }
  },
})
</script>

<style scoped>
.crash-page {
  max-width: 520px;
  margin: 0 auto;
  padding: 60px 16px 80px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  position: relative;
}

/* ── Top HUD (mirrors PlayView) ───────────────────────────────────── */
.top-hud {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.mode-tag {
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 2px;
  color: var(--gold);
  background: rgba(247, 201, 72, 0.1);
  border: 1px solid var(--gold);
  border-radius: 999px;
  padding: 6px 14px;
  box-shadow: 0 0 10px var(--gold-glow);
}
.hud-right { display: flex; align-items: center; gap: 8px; }
.history-btn {
  display: flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: 999px;
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  color: var(--text-muted); font-size: 1.05rem; line-height: 1; cursor: pointer;
  transition: all 0.18s;
}
.history-btn:hover { color: var(--gold); border-color: var(--gold); box-shadow: 0 0 10px var(--gold-glow); }
.pnl-pill {
  display: flex; align-items: center; gap: 8px;
  background: var(--bg-elevated); border: 1px solid var(--border-light);
  border-radius: 999px; padding: 6px 14px; cursor: pointer; user-select: none;
  font-size: 0.85rem; font-weight: 600; transition: all 0.18s;
}
.pnl-pill:hover { border-color: var(--text-muted); }
.pnl-scope { text-transform: uppercase; font-size: 0.62rem; letter-spacing: 1.5px; color: var(--text-muted); font-weight: 700; }
.pnl-amount { font-family: ui-monospace, monospace; }
.pnl-pill.up .pnl-amount { color: var(--green, #22c55e); }
.pnl-pill.down .pnl-amount { color: var(--red); }
.pnl-pill.neutral .pnl-amount { color: var(--text-muted); }
.pnl-pill.up { border-color: rgba(34, 197, 94, 0.3); }
.pnl-pill.down { border-color: rgba(239, 68, 68, 0.3); }

/* ── Rocket gauge ─────────────────────────────────────────────────── */
.gauge {
  width: 100%;
  min-height: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 20px;
  border: 1.5px solid var(--border-light);
  background: radial-gradient(circle at 50% 120%, rgba(56, 189, 248, 0.08) 0%, transparent 65%), var(--bg-elevated);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.gauge-mult {
  font-size: 4rem;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 1px;
  font-family: ui-monospace, monospace;
  color: var(--text);
}
.gauge-sub {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--text-muted);
}
.gauge.idle { opacity: 0.85; }
.gauge.climbing {
  border-color: var(--blue);
  box-shadow: 0 0 28px rgba(56, 189, 248, 0.25), inset 0 0 40px rgba(56, 189, 248, 0.06);
}
.gauge.climbing .gauge-mult { color: var(--blue); animation: climbPulse 0.9s ease-in-out infinite; }
.gauge.settling { border-color: var(--gold); box-shadow: 0 0 24px var(--gold-glow); }
.gauge.settling .gauge-mult { color: var(--gold); }
.gauge.won {
  border-color: var(--green, #22c55e);
  box-shadow: 0 0 36px rgba(34, 197, 94, 0.4), inset 0 0 50px rgba(34, 197, 94, 0.08);
}
.gauge.won .gauge-mult { color: var(--green, #22c55e); }
.gauge.lost { border-color: var(--red); box-shadow: 0 0 28px rgba(239, 68, 68, 0.3); }
.gauge.lost .gauge-mult { color: var(--red); animation: crashShake 0.4s ease; }
@keyframes climbPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
@keyframes crashShake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-8px) rotate(-2deg); }
  40% { transform: translateX(8px) rotate(2deg); }
  60% { transform: translateX(-5px); }
  80% { transform: translateX(5px); }
}

/* ── Controls ─────────────────────────────────────────────────────── */
.controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  width: 100%;
  transition: opacity 0.18s ease;
}
.controls.inert { opacity: 0.5; pointer-events: none; }

.target-slider { display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 340px; }
.target-readout { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.target-label { font-size: 0.78rem; font-weight: 800; letter-spacing: 1.5px; color: var(--gold); }
.target-stats { display: flex; align-items: baseline; gap: 8px; }
.win-pct { font-size: 0.75rem; font-weight: 700; color: var(--text); }
.target-mult { font-size: 1.05rem; font-weight: 800; color: var(--green, #22c55e); }
.target-range {
  -webkit-appearance: none; appearance: none; width: 100%; height: 6px; border-radius: 999px;
  background: linear-gradient(90deg, var(--green, #22c55e) 0%, var(--gold) 55%, var(--red) 100%);
  outline: none; cursor: pointer;
}
.target-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 20px; height: 20px; border-radius: 50%;
  background: var(--gold); border: 2px solid var(--bg); box-shadow: 0 0 10px var(--gold-glow); cursor: pointer;
}
.target-range::-moz-range-thumb {
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--gold); border: 2px solid var(--bg); box-shadow: 0 0 10px var(--gold-glow); cursor: pointer;
}
.target-hint {
  display: flex; justify-content: space-between; gap: 10px;
  font-size: 0.62rem; letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-muted);
}
.payout-preview { color: var(--green, #22c55e); font-weight: 700; }

.launch-btn, .cashout-btn {
  width: 100%; max-width: 340px;
  border-radius: 12px; padding: 16px 36px;
  font-size: 1.05rem; font-weight: 800; letter-spacing: 3px;
  font-family: inherit; cursor: not-allowed; transition: all 0.2s;
  background: var(--bg-elevated); border: 2px solid var(--border-light); color: var(--text-muted);
}
.launch-btn.active {
  border-color: var(--gold); color: var(--gold); cursor: pointer;
  background: rgba(247, 201, 72, 0.06); box-shadow: 0 0 16px var(--gold-glow);
}
.launch-btn.active:hover {
  background: linear-gradient(135deg, var(--gold) 0%, var(--gold-dim) 100%); color: var(--bg);
  box-shadow: 0 4px 28px var(--gold-glow), 0 0 50px var(--gold-glow); transform: translateY(-1px);
}
.launch-btn:disabled { opacity: 0.4; }

.cashout-btn {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  border-color: var(--border); color: var(--text-muted); letter-spacing: 2px;
}
.cashout-btn.armed {
  cursor: pointer; border-color: var(--green, #22c55e); color: var(--green, #22c55e);
  background: rgba(34, 197, 94, 0.08); box-shadow: 0 0 18px rgba(34, 197, 94, 0.3);
  animation: cashoutPulse 1s ease-in-out infinite;
}
.cashout-btn.armed:hover { background: var(--green, #22c55e); color: var(--bg); }
.cashout-sats { font-size: 0.68rem; font-weight: 700; letter-spacing: 1px; opacity: 0.85; }
@keyframes cashoutPulse {
  0%, 100% { box-shadow: 0 0 18px rgba(34, 197, 94, 0.3); }
  50% { box-shadow: 0 0 28px rgba(34, 197, 94, 0.55); }
}
.climb-hint, .settling-note {
  font-size: 0.66rem; letter-spacing: 2px; text-transform: uppercase; color: var(--text-muted);
}
.settling-note { color: var(--gold); font-weight: 700; }

/* ── Error toast / win flash / result slab / history (from PlayView) ── */
.error-toast {
  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
  background: var(--red); color: #fff; padding: 10px 24px; border-radius: 10px;
  font-size: 0.85rem; font-weight: 600; z-index: 999;
  box-shadow: 0 4px 20px rgba(239, 68, 68, 0.4);
}
.win-flash {
  position: fixed; inset: 0; pointer-events: none; z-index: 100;
  background: radial-gradient(circle at 50% 40%, rgba(34, 197, 94, 0.18) 0%, transparent 70%);
  animation: winFlashAnim 120ms ease-out;
}
@keyframes winFlashAnim { 0% { opacity: 0; } 20% { opacity: 1; } 100% { opacity: 0; } }

.result-slab {
  position: fixed; bottom: 0; left: 0; right: 0; padding: 22px 24px 30px;
  text-align: center; z-index: 200; backdrop-filter: blur(8px);
}
.result-slab.win { background: linear-gradient(180deg, rgba(34, 197, 94, 0.18) 0%, rgba(20, 83, 45, 0.6) 100%); border-top: 1px solid rgba(34, 197, 94, 0.5); }
.result-slab.loss { background: linear-gradient(180deg, rgba(239, 68, 68, 0.12) 0%, rgba(127, 29, 29, 0.4) 100%); border-top: 1px solid rgba(239, 68, 68, 0.4); }
.slab-label { font-size: 0.8rem; font-weight: 800; letter-spacing: 3px; text-transform: uppercase; }
.result-slab.win .slab-label { color: var(--green, #22c55e); }
.result-slab.loss .slab-label { color: var(--red); }
.slab-amount { margin-top: 6px; font-weight: 800; letter-spacing: 1px; }
.result-slab.win .slab-amount { font-size: 2.2rem; color: var(--green, #22c55e); }
.result-slab.loss .slab-amount { font-size: 1.4rem; color: var(--red); }
.slab-unit { font-size: 0.65rem; color: var(--text-muted); margin-left: 4px; letter-spacing: 2px; }
.slab-enter-active, .slab-leave-active { transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s; }
.slab-enter-from, .slab-leave-to { transform: translateY(100%); opacity: 0; }

.hist-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(4px);
  z-index: 300; display: flex; align-items: center; justify-content: center; padding: 24px;
}
.hist-modal {
  width: min(520px, 100%); max-height: 80vh; display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--border); border-radius: 16px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5); overflow: hidden;
}
.hist-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.hist-title { margin: 0; font-size: 0.95rem; font-weight: 700; letter-spacing: 1px; color: var(--text); }
.hist-close { background: none; border: none; color: var(--text-muted); font-size: 1.6rem; line-height: 1; cursor: pointer; padding: 0 4px; transition: color 0.15s; }
.hist-close:hover { color: var(--text); }
.hist-body { overflow-y: auto; flex: 1; -webkit-overflow-scrolling: touch; }
.hist-fade-enter-active, .hist-fade-leave-active { transition: opacity 0.2s; }
.hist-fade-enter-from, .hist-fade-leave-to { opacity: 0; }

@media (max-width: 640px) {
  .gauge-mult { font-size: 3rem; }
  .launch-btn, .cashout-btn { padding: 14px 28px; font-size: 0.95rem; }
}
</style>
