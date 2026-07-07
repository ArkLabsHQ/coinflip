/**
 * House stake economics for variable-odds games. Relocated verbatim from the
 * (removed) v2/v3 `trustless-game.ts` so the v4 server keeps a stable import.
 */

/**
 * The house stake for a variable-odds game: the amount the house escrows so
 * that, minus the configured edge, the payout matches the odds. `win = target
 * - lo` is the size of the player's winning range; `edgeBps` is the house edge
 * in basis points. Verified against odds-math.unit.test.ts.
 */
export function computeHouseStake(
  playerStake: number,
  n: number,
  target: number,
  lo: number,
  edgeBps: number,
): number {
  const win = target - lo // size of the player's winning range [lo, target)
  return Math.floor((playerStake * (n - win) * (10000 - edgeBps)) / (win * 10000))
}
