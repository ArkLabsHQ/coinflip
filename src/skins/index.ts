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
  { id: 'coin', name: 'Coin', icon: '₿', component: CoinSkin },
  { id: 'slot', name: 'Slot', icon: '♦', component: SlotSkin },
  { id: 'dice', name: 'Dice', icon: '⚅', component: DiceSkin },
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

export type { SkinState, SkinMeta, SkinProps } from './types'
