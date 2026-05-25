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

/**
 * A variable-odds bet: `n` equally-likely outcomes, player wins iff the rolled
 * value lands in `[lo, target)`. Win probability is `(target - lo) / n`; the
 * fair payout multiple is its inverse. Enforced on-chain — see the lib's
 * `buildVariableOddsConditionScript`.
 */
export interface OddsBet {
  n: number
  lo: number
  target: number
}

/** A thematic bet option a skin offers (chip in the odds selector). */
export interface OddsPreset {
  /** Stable id, used for selection and as the render :key. */
  id: string
  /** Chip label in the skin's own language ("ROLL 4+", "EXACTLY 6", "3×"). */
  label: string
  /** The bet, or null for the classic 50/50 coin (heads/tails, coin path). */
  bet: OddsBet | null
}

export interface SkinState {
  /** Lifecycle phase of the current flip. */
  phase: 'idle' | 'flipping' | 'resolved'
  /** Final outcome — populated when phase === 'resolved'. */
  outcome: {
    won: boolean
    side: 'heads' | 'tails'
    /**
     * Variable-odds: the value the player actually rolled, in `[0, n)`, for the
     * skin to show (the dice face = roll + 1, etc.). null for the 50/50 coin or
     * a cheat-penalty result (no fair roll).
     */
    roll: number | null
  } | null
  /**
   * The active bet — null for the classic 50/50 coin. Set from the moment a flip
   * starts (not just on resolve) so a skin can frame the target up front, e.g.
   * highlight the winning dice faces while the cube tumbles.
   */
  odds: OddsBet | null
}

export interface SkinMeta {
  id: string
  name: string
  /** Unicode glyph or short label for the selector chip. */
  icon: string
  component: Component
  /**
   * Whether picking heads/tails is meaningful for this skin. Coin → yes;
   * slot/dice → no (the visual has no "side", so the outcome is always
   * randomised). When false, the side selector is hidden.
   */
  supportsSide: boolean
  /**
   * The bet menu shown when this skin is active, phrased in the skin's own
   * theme. The first entry is the skin's default. A preset with `bet: null` is
   * the classic 50/50 coin (side-pickable); any other is a variable-odds bet.
   */
  oddsPresets: OddsPreset[]
}

/** Props all skin components must accept. */
export interface SkinProps {
  state: SkinState
}
