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
 * Client-only by convention: the standalone client build doesn't import the
 * `arkade-coinflip` lib, so (like PlayView's `houseStakeOf`) it re-derives the
 * money math here. The SERVER remains the source of truth — it enforces the
 * range on-chain via the same `(oddsN, oddsTarget, oddsLo)` we submit, and
 * `rocketHouseStake` mirrors its `computeHouseStake` exactly to avoid drift.
 */

/**
 * Range resolution. Higher = finer multiplier granularity. The roll digit is
 * encoded as the secret's BYTE LENGTH (`randomBytes(16 + digit)`, base =
 * VARIABLE_ODDS_BASE_LEN), so a digit up to n−1 needs a `16 + n − 1`-byte
 * secret. Bitcoin's script push limit is 520 bytes, so the lib's
 * CoinflipEscrowScript hard-rejects `16 + n − 1 > 520`, i.e. n > 505. We use
 * 300: comfortably under that ceiling (max secret 315B) and divisible by every
 * ROCKET_LADDER multiplier, so P(win) = 1/M is exact at each ladder stop.
 * Crash points therefore top out at n/(n−(n−1)) = 300×.
 */
export const ROCKET_ODDS_N = 300

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
 * Exact house stake for a "reach M" bet — mirrors the server's
 * computeHouseStake(bet, n, target, lo, edge) for the same range, so the
 * client's cap/preview never disagrees with what the server will charge.
 */
export function rocketHouseStake(bet: number, odds: RocketOdds, edgeBps: number): number {
  const win = odds.oddsTarget - odds.oddsLo
  if (win <= 0) return 0
  return Math.floor((bet * (odds.oddsN - win) * (10000 - edgeBps)) / (win * 10000))
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
