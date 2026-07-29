/**
 * The shared odds ladder — the pure half of the skin registry.
 *
 * Split out of `index.ts` purely so it can be unit-tested: `index.ts` imports
 * the skin `.vue` components, and `vitest.config.ts` registers no Vue plugin, so
 * anything reachable from there is untestable. The monotonicity invariant these
 * ladders must satisfy is load-bearing (the odds slider and
 * `nearestRungByWinPct` both assume it), so it needs a real test rather than a
 * comment.
 */

import type { OddsBet } from './types'

/**
 * The ONE win-chance ladder every skin offers, highest chance first.
 *
 * Skins used to carry their own ladders of wildly different shape — 6 rungs on
 * the coin (powers of two) against 106 on the slot — so switching game changed
 * not just the odds but which odds could even be expressed, and the slider
 * jumped somewhere unrelated. Every skin now walks these same 17 rungs, so
 * switching keeps the player where they were and only the theatre changes.
 */
export const SHARED_WIN_PCTS = [95, 90, 80, 70, 60, 50, 40, 32, 25, 20, 15, 10, 7, 5, 3, 2, 1] as const

/** Coins per bet. 2^7 = 128 outcomes — fine enough to hit every rung to 0.34pp. */
export const COIN_COUNT = 7

/**
 * Pockets on the wheel. 100, not the real-roulette 37: a 37-pocket wheel cannot
 * resolve below 1/37 = 2.70%, which collapsed the 3% / 2% / 1% rungs into one
 * and would have capped EVERY skin sharing the ladder at ~32x. The cost is that
 * the wheel no longer mirrors a real single-zero layout (no Dozen / Split /
 * Straight-Up correspondence); the gain is the full ladder and the 100x bet.
 */
export const ROULETTE_N = 100

/** Slot: a fixed 3-reel machine of SLOT_BASE ranked symbols (index 0 lowest). */
export const SLOT_BASE = 5
export const SLOT_REELS = 3
/** Percentile die — hits every shared rung exactly. */
export const DICE_N = 100

/**
 * Realise the shared ladder over a range of `n` outcomes as TOP bands: the
 * winning outcomes are the highest `win` of `n`, so "further right = fewer
 * winning outcomes" reads identically in every skin.
 *
 * `n` must be fine enough to keep the rungs distinct — 2% and 1% collapse below
 * n=100, which is what moved the roulette wheel off 37 pockets. `ladderIsSane`
 * is the guard, asserted per skin in the unit test.
 */
export function sharedLadder(n: number): OddsBet[] {
  return SHARED_WIN_PCTS.map((pct) => {
    const win = Math.max(1, Math.min(n - 1, Math.round((n * pct) / 100)))
    return { n, lo: n - win, target: n }
  })
}

/** Win chance of a rung, as a percentage. */
export const winPctOfRung = (b: OddsBet): number => ((b.target - b.lo) / b.n) * 100

/**
 * True when a ladder is strictly decreasing in win chance — the invariant the
 * odds slider and `nearestRungByWinPct`'s tie-break both rely on. A too-coarse
 * `n` merges adjacent rungs and breaks it silently, which is why this is a test
 * and not a comment.
 */
export function ladderIsSane(ladder: OddsBet[]): boolean {
  return ladder.length === SHARED_WIN_PCTS.length
    && ladder.every((b, i) => i === 0 || winPctOfRung(b) < winPctOfRung(ladder[i - 1]))
}
