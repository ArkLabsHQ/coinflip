/**
 * Variable-odds house-stake math — the single source of truth for the house
 * escrow / odds formula, shared by the server and the browser client so a
 * drifted client copy can never show wrong odds or get a bet rejected by the
 * server (the v0.7.2 sub-dust incident class).
 *
 * Crypto-free by design: the browser client imports this via the
 * `arkade-coinflip/dist/stake-math` subpath (like `joint-pot-tx` / `arkade-win`),
 * so it must not pull Node `crypto`. Pure integer arithmetic, no imports.
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
