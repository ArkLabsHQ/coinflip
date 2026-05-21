/**
 * Skin contract.
 *
 * Skins are visual presentations of the same underlying coinflip game —
 * like iGaming slot themes sharing the same RNG. The server's outcome
 * (winner/loser) is final; skins just animate it differently.
 *
 * Every skin receives the same `state` prop and renders its own
 * animation based on phase + outcome. Skins do NOT trigger flips —
 * the parent PlayView owns the FLIP button and game state.
 */

import type { Component } from 'vue'

export interface SkinState {
  /** Lifecycle phase of the current flip. */
  phase: 'idle' | 'flipping' | 'resolved'
  /** Final outcome — populated when phase === 'resolved'. */
  outcome: { won: boolean; side: 'heads' | 'tails' } | null
}

export interface SkinMeta {
  id: string
  name: string
  /** Unicode glyph or short label for the selector chip. */
  icon: string
  component: Component
}

/** Props all skin components must accept. */
export interface SkinProps {
  state: SkinState
}
