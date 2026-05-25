/**
 * Skin registry. Add a new skin here to expose it in the selector.
 *
 * Each skin presents the same coinflip game with different visuals —
 * coin, slot machine, dice, etc. The underlying server-driven outcome
 * is shared; skins only differ in animation and "win" semantics
 * (e.g., 2-of-3 matching reels, dice > 3, etc.).
 */

import type { SkinMeta } from './types'
import CoinSkin from './CoinSkin.vue'
import SlotSkin from './SlotSkin.vue'
import DiceSkin from './DiceSkin.vue'

export const SKINS: SkinMeta[] = [
  {
    id: 'coin', name: 'Coin', icon: '₿', component: CoinSkin, supportsSide: true,
    // CLASSIC is the 50/50 parity coin (pick a side). The multi-coin bets are
    // variable-odds n=2^k where the player wins only if EVERY coin lands heads
    // (roll 0); the skin renders the roll's bits across k coins.
    oddsPresets: [
      { id: 'coin', label: 'CLASSIC', bet: null },
      { id: 'coin-2', label: '2 COINS', bet: { n: 4, lo: 0, target: 1 } },
      { id: 'coin-3', label: '3 COINS', bet: { n: 8, lo: 0, target: 1 } },
    ],
  },
  {
    id: 'slot', name: 'Slot', icon: '♦', component: SlotSkin, supportsSide: false,
    // Slot payouts are abstract jackpots — the reels reflect win/loss, the
    // multiple sets the rarity. A single roll < target over n.
    oddsPresets: [
      { id: 'slot-2', label: '2×', bet: { n: 2, lo: 0, target: 1 } },
      { id: 'slot-3', label: '3×', bet: { n: 3, lo: 0, target: 1 } },
      { id: 'slot-6', label: '6×', bet: { n: 6, lo: 0, target: 1 } },
    ],
  },
  {
    id: 'dice', name: 'Dice', icon: '⚅', component: DiceSkin, supportsSide: false,
    // n=6, roll 0..5 shown as face 1..6. Ranges are phrased in dice language;
    // the die lands on the actual rolled face and the winning faces glow.
    oddsPresets: [
      { id: 'dice-4plus', label: 'ROLL 4+', bet: { n: 6, lo: 3, target: 6 } },
      { id: 'dice-5plus', label: 'ROLL 5+', bet: { n: 6, lo: 4, target: 6 } },
      { id: 'dice-6', label: 'EXACTLY 6', bet: { n: 6, lo: 5, target: 6 } },
      { id: 'dice-1', label: 'ROLL A 1', bet: { n: 6, lo: 0, target: 1 } },
    ],
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

export type { SkinState, SkinMeta, SkinProps, OddsBet, OddsPreset } from './types'
