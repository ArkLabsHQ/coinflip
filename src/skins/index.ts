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
import RouletteSkin from './RouletteSkin.vue'
import { ROCKET_ODDS_N } from '@/rocket'
import {
  SHARED_WIN_PCTS, COIN_COUNT, ROULETTE_N, SLOT_BASE, SLOT_REELS, DICE_N, sharedLadder,
} from './ladder'

// Re-exported so consumers keep importing skin constants from '@/skins'.
export { SHARED_WIN_PCTS, COIN_COUNT, ROULETTE_N, SLOT_BASE, SLOT_REELS, DICE_N, sharedLadder }



const winRate = (b: OddsBet) => (b.target - b.lo) / b.n


/** Default slider step: the bet whose win rate is closest to an even 50%. */
const nearHalf = (ladder: OddsBet[]): number => {
  let best = 0, bestD = Infinity
  ladder.forEach((b, i) => { const d = Math.abs(winRate(b) - 0.5); if (d < bestD) { bestD = d; best = i } })
  return best
}

/**
 * Coin: COIN_COUNT coins read as one binary number, heads = 1. More heads is a
 * bigger number, and you win when it lands in the top band — so an all-heads row
 * is always a win, and the narrowest band (win = 1) is exactly the old
 * "every coin must be heads" parlay.
 *
 * That generalisation is what lets a binary skin sit on the shared ladder at
 * all: the old design won only on roll 0, fixing its odds to 1/2^k, so it could
 * offer nothing between 50% and 25%. Seven coins give 1/128 granularity, enough
 * to hit every rung within 0.34pp.
 */
function coinLadder(): OddsBet[] {
  return sharedLadder(2 ** COIN_COUNT)
}

// Slot: 3 reels of SLOT_BASE ranked symbols read as one base-SLOT_BASE number;
// win iff the reels beat the threshold left-to-right.
function slotLadder(): OddsBet[] {
  return sharedLadder(SLOT_BASE ** SLOT_REELS) // 125
}

// Dice: a single readable percentile die — "roll N+". One die shows one number,
// so there's no place-value ambiguity (the flaw of a base-N number spread over
// scattered physics dice). roll ∈ [0, n); win iff roll ≥ lo.
function diceLadder(): OddsBet[] {
  // A d100 throughout: it hits every shared rung exactly, and mixing a d20 in
  // for the easy end would make the same win chance a different die per rung.
  return sharedLadder(DICE_N)
}

// Roulette: walk the player through "bet any 18", "bet any 12", "bet any 6",
// "bet any 4", "bet any 3", "bet any 2", "bet any 1" — covering the natural
// ladder of real-roulette bet types (Even, Dozen, Line, Corner, Street, Split,
// Straight) without dressing up the on-chain math. Each step is the contiguous
// band [lo, target) = [n - winSize, n), so the highest indices always win for
// any band size — gives the wheel a single "winning arc" the player can see.
function rouletteLadder(): OddsBet[] {
  // The named real-roulette groups (Dozen, Line, Corner, Street, Split,
  // Straight-Up) were what fixed this to 37 pockets, and 37 cannot express the
  // long-odds end of the shared ladder — see ROULETTE_N.
  return sharedLadder(ROULETTE_N)
}

// Rocket: each ladder step is a target multiplier M; the on-chain bet is the
// variable-odds range [n − floor(n/M), n) so the player wins iff the roll
// lands in the top 1/M of [0, n). Slider sets the AUTO-CASHOUT target; the
// rocket skin owns its own LAUNCH/CASH OUT gesture (ownsPlayGesture: true).
function rocketLadder(): OddsBet[] {
  // The auto-cashout multiplier is now DERIVED from the shared rung (n / win)
  // rather than the rung being derived from a hand-written multiplier list, so
  // the rocket offers exactly the win chances every other skin does.
  return sharedLadder(ROCKET_ODDS_N)
}

const coinBets = coinLadder()
const slotBets = slotLadder()
const diceBets = diceLadder()
const rouletteBets = rouletteLadder()
const rocketBets = rocketLadder()

export const SKINS: SkinMeta[] = [
  {
    id: 'coin', name: 'Coin', icon: '₿', component: CoinSkin,
    oddsLadder: coinBets, defaultStep: nearHalf(coinBets),
    // Every rung is the same COIN_COUNT coins now — what changes is how many of
    // the 2^k orderings win — so the count alone no longer describes the bet.
    // Just the visual, not the band: "TOP 115 OF 128" was the longest label of
    // any skin and wrapped the odds row onto two lines, while restating what
    // the adjacent "90% win" already says. Every rung shows COIN_COUNT coins,
    // so this is honest and constant by design.
    stepLabel: () => `${COIN_COUNT} COINS`,
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
    id: 'roulette', name: 'Roulette', icon: '🎡', component: RouletteSkin,
    oddsLadder: rouletteBets, defaultStep: nearHalf(rouletteBets),
    stepLabel: (b) => {
      const win = b.target - b.lo
      // Compact form: "ANY 60 OF 100" overran the readout and ellipsised to
      // "ANY 60 OF 1…", which is worse than terse.
      return `ANY ${win}/${b.n}`
    },
  },
  {
    id: 'rocket', name: 'Rocket', icon: '🚀', component: RocketSkin,
    oddsLadder: rocketBets, defaultStep: nearHalf(rocketBets),
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
