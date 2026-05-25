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

// Dice: D dice read as one base-6 number; win iff roll ≥ lo ("beat the target
// dice"). Two dice give a fine ~85%→2.8% sweep; a third die extends the rare
// tail.
function diceLadder(): OddsBet[] {
  const out: OddsBet[] = []
  const n2 = 36
  for (let lo = Math.round(0.15 * n2); lo <= n2 - 1; lo++) out.push({ n: n2, lo, target: n2 })
  const n3 = 216
  for (let lo = n3 - 5; lo <= n3 - 1; lo++) out.push({ n: n3, lo, target: n3 })
  return out
}

const coinBets = coinLadder()
const slotBets = slotLadder()
const diceBets = diceLadder()

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
    stepLabel: () => 'BEAT THE DICE',
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
