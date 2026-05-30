/**
 * Skin registry. Add a new skin here to expose it in the selector.
 *
 * Each skin presents the same coinflip game with different visuals — coin,
 * slot, dice. Every bet is a variable-odds range enforced on-chain; a skin just
 * scales its visual with the bet (more coins / reels / dice) and the slider in
 * PlayView walks the skin's `oddsLadder` (strictly decreasing win rate).
 */

import type { SkinMeta, OddsBet } from './types'
import CoinSkin from './CoinSkin.vue'
import SlotSkin from './SlotSkin.vue'
import DiceSkin from './DiceSkin.vue'
import RocketSkin from './RocketSkin.vue'
import { ROCKET_ODDS_N, ROCKET_LADDER } from '@/rocket'

/** Slot: a fixed 3-reel machine of SLOT_BASE ranked symbols (index 0 lowest). */
export const SLOT_BASE = 5
export const SLOT_REELS = 3

const intLog = (n: number, base: number) => Math.round(Math.log(n) / Math.log(base))
const winRate = (b: OddsBet) => (b.target - b.lo) / b.n
/** Default slider step: the bet whose win rate is closest to an even 50%. */
const nearHalf = (ladder: OddsBet[]): number => {
  let best = 0, bestD = Infinity
  ladder.forEach((b, i) => { const d = Math.abs(winRate(b) - 0.5); if (d < bestD) { bestD = d; best = i } })
  return best
}

// Coin: a parlay — k coins, win iff ALL land heads (roll 0). n = 2^k → win
// 1/2^k. Binary, so the odds are coarse by nature (½, ¼, ⅛…); for fine-grained
// odds use the threshold skins (Slot / Dice).
function coinLadder(): OddsBet[] {
  return Array.from({ length: 6 }, (_, i) => ({ n: 2 ** (i + 1), lo: 0, target: 1 }))
}

// Slot: 3 reels of SLOT_BASE ranked symbols read as one base-SLOT_BASE number;
// win iff roll ≥ lo — your reels "beat the target" left-to-right. A fine
// threshold sweep from ~85% (easiest) down to ~1/n, so the odds are granular and
// it's always a real 3-reel machine.
function slotLadder(): OddsBet[] {
  const n = SLOT_BASE ** SLOT_REELS // 125
  const out: OddsBet[] = []
  for (let lo = Math.round(0.15 * n); lo <= n - 1; lo++) out.push({ n, lo, target: n })
  return out
}

// Dice: a single readable polyhedral die — "roll N+". A d20 gives 5% steps
// across 95%→5%; for longer odds a d100 (dice-box renders it as a readable
// tens+ones percentile pair) extends to 1% steps. One die shows one number, so
// there's no place-value ambiguity (the flaw of a base-N number on scattered
// physics dice). n = the die's side count; roll ∈ [0, n); win iff roll ≥ lo.
function diceLadder(): OddsBet[] {
  const out: OddsBet[] = []
  for (let lo = 1; lo <= 19; lo++) out.push({ n: 20, lo, target: 20 })    // d20: 95% → 5%
  for (let lo = 96; lo <= 99; lo++) out.push({ n: 100, lo, target: 100 }) // d100: 4% → 1%
  return out
}

// Rocket: each ladder step is a target multiplier M; the on-chain bet is the
// variable-odds range [n − floor(n/M), n) so the player wins iff the roll
// lands in the top 1/M of [0, n). Slider sets the AUTO-CASHOUT target; the
// rocket skin owns its own LAUNCH/CASH OUT gesture (ownsPlayGesture: true).
function rocketLadder(): OddsBet[] {
  return ROCKET_LADDER.map((m) => {
    const win = Math.min(ROCKET_ODDS_N - 1, Math.max(1, Math.floor(ROCKET_ODDS_N / m)))
    return { n: ROCKET_ODDS_N, lo: ROCKET_ODDS_N - win, target: ROCKET_ODDS_N }
  })
}

const coinBets = coinLadder()
const slotBets = slotLadder()
const diceBets = diceLadder()
const rocketBets = rocketLadder()

export const SKINS: SkinMeta[] = [
  {
    id: 'coin', name: 'Coin', icon: '₿', component: CoinSkin,
    oddsLadder: coinBets, defaultStep: 0, // 1 coin = 50%
    stepLabel: (b) => { const k = intLog(b.n, 2); return `${k} COIN${k > 1 ? 'S' : ''}` },
  },
  {
    id: 'slot', name: 'Slot', icon: '♦', component: SlotSkin,
    oddsLadder: slotBets, defaultStep: nearHalf(slotBets),
    stepLabel: () => 'BEAT THE REELS',
  },
  {
    id: 'dice', name: 'Dice', icon: '⚅', component: DiceSkin,
    oddsLadder: diceBets, defaultStep: nearHalf(diceBets),
    stepLabel: (b) => `ROLL ${b.lo + 1}+`,
  },
  {
    id: 'rocket', name: 'Rocket', icon: '🚀', component: RocketSkin,
    oddsLadder: rocketBets, defaultStep: 0,
    stepLabel: (b) => {
      const m = b.n / (b.target - b.lo)
      return `AUTO ${Number.isInteger(m) ? m : m.toFixed(1)}×`
    },
    ownsPlayGesture: true,
  },
]

const STORAGE_KEY = 'coinflip.selected_skin'

export function getSavedSkinId(): string {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved && SKINS.some((s) => s.id === saved)) return saved
  return SKINS[0].id
}

export function saveSkinId(id: string): void {
  localStorage.setItem(STORAGE_KEY, id)
}

export function findSkin(id: string): SkinMeta {
  return SKINS.find((s) => s.id === id) ?? SKINS[0]
}

export type { SkinState, SkinMeta, SkinProps, OddsBet } from './types'
