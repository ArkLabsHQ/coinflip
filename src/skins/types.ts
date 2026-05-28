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
   * The active bet — never null now (every bet is a variable-odds range). Set
   * from the moment a flip starts (not just on resolve) so a skin can frame the
   * target up front (the dice count, the number of coins/reels, etc.).
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
   * The skin's bet ladder — the ordered set of slider positions, with strictly
   * decreasing win rate. Each step is a variable-odds range; the skin scales its
   * visual with the bet (more coins / reels / dice). The slider indexes into it.
   */
  oddsLadder: OddsBet[]
  /** Initial slider index when the skin is selected. */
  defaultStep: number
  /** Themed label for a ladder step ("3 COINS", "LINE UP 2 ₿", "ROLL 4+"). */
  stepLabel: (bet: OddsBet, index: number) => string
}

/** Props all skin components must accept. */
export interface SkinProps {
  state: SkinState
}
