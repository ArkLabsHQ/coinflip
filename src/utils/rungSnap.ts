/**
 * Pure ladder math for the odds control.
 *
 * A skin's bet ladder is an ordered list of rungs whose win chance STRICTLY
 * DECREASES as the index rises (verified across all five real ladders: coin 6
 * rungs 50%→1.56%, slot 106 rungs 84.8%→0.8%, dice 23 rungs 95%→1%, roulette
 * 10 rungs 89.19%→2.7%, rocket 9 rungs 83%→1%). That ordering is what makes
 * "nearest by win chance" unambiguous and lets the tie-break below be stated as
 * "prefer the lower index".
 *
 * Deliberately free of imports so it can be used from the Vue-less store tree
 * and from tests — `vitest.config.ts` registers no Vue plugin, so anything that
 * transitively imports a `.vue` file is untestable here.
 */

/** One rung of a skin's bet ladder. Structurally `OddsBet` / `GameOdds`. */
export interface Rung {
  n: number
  lo: number
  target: number
}

/** Exact win chance as a percentage, e.g. 32.432432432432435. */
export function winPctOf(bet: Rung): number {
  return ((bet.target - bet.lo) / bet.n) * 100
}

/**
 * Display rounding for a win chance: whole numbers at 10% and above, one
 * decimal below, so long-odds rungs stay distinguishable (2.7% vs 5.4%) without
 * littering the common range with decimals.
 */
export function roundWinPct(pct: number): number {
  return pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10
}

/** Win chance formatted for display, e.g. "32%" / "4.5%". */
export function formatWinPct(bet: Rung): string {
  return roundWinPct(winPctOf(bet)) + '%'
}

/**
 * Index of the rung in [loIndex, hiIndex] whose win chance is closest to `pct`.
 *
 * The window is the FEASIBLE band (what the house can cover at the current
 * stake), so a percentage outside it clamps to the window's end — never to a
 * ladder rung the server would reject. Ties keep the earlier index, which on a
 * decreasing ladder is the safer bet: if the player is exactly between two
 * rungs, give them the better win chance.
 */
export function nearestRungByWinPct(
  ladder: Rung[], loIndex: number, hiIndex: number, pct: number,
): number {
  if (ladder.length === 0) return 0
  const lo = Math.max(0, loIndex)
  const hi = Math.min(ladder.length - 1, hiIndex)
  if (hi < lo) return lo

  let best = lo
  let bestDistance = Infinity
  for (let i = lo; i <= hi; i++) {
    // Strict `<` is what makes a tie keep the earlier (safer) rung.
    const distance = Math.abs(winPctOf(ladder[i]) - pct)
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}
