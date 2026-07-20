/**
 * Rocket-game math — maps a target multiplier M onto the existing trustless
 * variable-odds engine and back.
 *
 * A rocket bet "the multiplier reaches M×" is the same trustless primitive the
 * coin/slot/dice skins use: a provably-fair roll in [0, n) and a win when it
 * lands in a contiguous band. Picking the TOP 1/M of the range gives
 * P(win) = 1/M and a payout of ~M× (shaved by the house edge) — i.e. the
 * classic crash distribution P(crash ≥ M) = 1/M. ("Crash point" stays as the
 * math term: it's the standard name for that distribution, and the rocket
 * does crash on a loss.)
 *
 * The SERVER remains the source of truth — it enforces the range on-chain via
 * the same `(oddsN, oddsTarget, oddsLo)` we submit. The house-stake math is
 * single-sourced in the `arkade-coinflip` lib (`stake-math.ts`); the local
 * `rocketHouseStake` wraps that shared `computeHouseStake` so the client's
 * cap/preview can't drift from what the server charges.
 */

import { computeHouseStake } from 'arkade-coinflip/dist/stake-math'

/**
 * Range resolution. Higher = finer multiplier granularity. v0.3 escrow
 * encodes the digit as a single-byte arkade-script CScriptNum read by
 * `OP_1 OP_LEFT OP_BIN2NUM`, so the digit must fit in [0, 128) — bytes with
 * the high bit set decode as negative CScriptNums. The lib caps `n ≤ 128`
 * (`packages/lib/src/arkade-win.ts`).
 *
 * We pick `n = 100` — the largest base-10 value ≤ 128. It divides every
 * integer ladder stop (2, 5, 10, 20, 50, 100) cleanly so `P(win) = 1/M` is
 * exact at the high multipliers; the fractional stops drift by < 0.7%
 * absolute (`floor(100/1.2)=83 → P=0.83 vs. 0.833`; `floor(100/1.5)=66 →
 * P=0.66 vs. 0.667`). The displayed multiplier matches what the player
 * picks — only the true win probability is rounded to two decimal places.
 *
 * Was `300` in v0.2.x: the secret-length encoding had no high-bit problem,
 * so n could be picked as the LCM of ladder denominators to make every
 * P(win) exact. 100 is the v3-compatible analogue — preserves the full
 * v0.2.x rocket ladder (1.2× through 100×) under the v3 cap.
 */
export const ROCKET_ODDS_N = 100

export interface RocketOdds {
  oddsN: number
  oddsTarget: number
  oddsLo: number
}

/**
 * Map a target multiplier M (> 1) to the variable-odds range expressing
 * "the crash point is ≥ M". The winning band is the top 1/M of [0, n):
 *   win = floor(n / M), lo = n − win, target = n   →   P(win) = win/n ≤ 1/M.
 *
 * floor (not round) is load-bearing: it makes the on-chain win condition
 * (roll ≥ lo) EXACTLY equivalent to the revealed-crash-point condition
 * (C ≥ M), since both reduce to the integer inequality n − roll ≤ floor(n/M).
 * round would over-count the band by one whenever n/M rounds up, so the chain
 * would settle a win that rollToCrashPoint reports as C < M — a UI/chain
 * disagreement on the boundary roll. floor costs at most ~1/n of win
 * probability and keeps the two views in lockstep.
 */
export function rocketToOdds(multiplier: number, n: number = ROCKET_ODDS_N): RocketOdds {
  const m = Math.max(1.01, multiplier)
  // Winning band size; clamp to [1, n-1] so lo stays in [1, n-1] and the range
  // is non-empty and non-certain (the server requires 0 ≤ lo < target ≤ n).
  const win = Math.min(n - 1, Math.max(1, Math.floor(n / m)))
  return { oddsN: n, oddsTarget: n, oddsLo: n - win }
}

/**
 * Provably-fair crash point from the revealed roll in [0, n):
 *   C = n / (n − roll)  →  C ∈ [1, ∞), with P(C ≥ M) = 1/M.
 * The player wins iff C ≥ their locked multiplier, which is exactly the
 * on-chain condition (roll ∈ [lo, n) where lo = n − floor(n/M)).
 */
export function rollToCrashPoint(roll: number, n: number = ROCKET_ODDS_N): number {
  const denom = Math.max(1, n - roll)
  return n / denom
}

/**
 * Exact house stake for a "reach M" bet — delegates to the shared
 * computeHouseStake(bet, n, target, lo, edge) for the same range, so the
 * client's cap/preview never disagrees with what the server will charge.
 */
export function rocketHouseStake(bet: number, odds: RocketOdds, edgeBps: number): number {
  const win = odds.oddsTarget - odds.oddsLo
  if (win <= 0) return 0
  return computeHouseStake(bet, odds.oddsN, odds.oddsTarget, odds.oddsLo, edgeBps)
}

/**
 * Player-facing payout multiplier after the house edge: payout/bet =
 * (bet + houseStake)/bet. Used for the cash-out label and winnings preview.
 */
export function effectivePayoutMultiplier(bet: number, multiplier: number, edgeBps: number): number {
  if (bet <= 0) return multiplier
  return (bet + rocketHouseStake(bet, rocketToOdds(multiplier), edgeBps)) / bet
}

/**
 * Auto-cashout targets offered by the slider. Clamped at runtime to the
 * affordable window — a low M makes the house stake sub-dust, a high M pushes
 * it past the bankroll — exactly like the odds-slider ladder in PlayView.
 */
export const ROCKET_LADDER: number[] = [1.2, 1.5, 2, 3, 5, 10, 20, 50, 100]
