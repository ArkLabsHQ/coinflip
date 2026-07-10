/**
 * Version-neutral game math — CSPRNG uniform sampling and winner/roll
 * resolution. Relocated verbatim from the (removed) v0.2.x/v0.3 transaction
 * modules so the v4 server + tests keep a stable `arkade-coinflip` import.
 * (The `V3` suffixes are retained: v4 reuses the same variable-odds outcome
 * logic the v3 arkade-script predicate encodes.)
 */

import { randomBytes } from 'crypto'
import { type DigitCommit } from './arkade-win'

/**
 * Cryptographically-uniform integer in `[0, n)`. Uses `crypto.randomBytes`
 * (CSPRNG) with rejection sampling to avoid modulo bias.
 *
 * This matters for game-outcome selection: `Math.random()` is a non-crypto PRNG
 * whose internal state can be recovered from a sequence of observed outputs. The
 * house's chosen coin side / odds digit is revealed at settlement, so a stream of
 * `Math.random()`-derived choices would leak the PRNG state and let a player
 * predict (and match) the next house pick. A CSPRNG closes that channel.
 */
export function randomUniformInt(n: number): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`randomUniformInt: n must be a positive integer (got ${n})`)
  }
  if (n === 1) return 0
  const bytes = Math.ceil(Math.log2(n) / 8) || 1
  const max = 256 ** bytes
  const limit = max - (max % n) // largest multiple of n that fits in `bytes` bytes
  // Rejection-sample: discard draws in the non-uniform tail [limit, max).
  for (;;) {
    const buf = randomBytes(bytes)
    let x = 0
    for (const b of buf) x = x * 256 + b
    if (x < limit) return x % n
  }
}

/**
 * v4 winner determination — mirrors the on-chain arkade-script in
 * `buildVariableOddsWinPredicate`. Bad creator → player wins; bad player →
 * creator wins; else `(digitC + digitP) mod n` in `[lo, target)` → player wins.
 */
export function determineWinnerV3(
  creatorReveal: DigitCommit,
  playerReveal: DigitCommit,
  n: number,
  target: number,
  lo: number,
): 'creator' | 'player' {
  const dC = creatorReveal.digit
  const dP = playerReveal.digit
  if (dC < 0 || dC >= n) return 'player' // bad creator → player wins
  if (dP < 0 || dP >= n) return 'creator' // bad player → creator wins
  const roll = (dC + dP) % n
  return roll >= lo && roll < target ? 'player' : 'creator'
}

/**
 * Roll value `(digitC + digitP) mod n` for display, or null if either digit
 * is out of `[0, n)` (winner was decided by the cheat-penalty, not a fair roll).
 */
export function computeRollV3(
  creatorReveal: DigitCommit,
  playerReveal: DigitCommit,
  n: number,
): number | null {
  const dC = creatorReveal.digit,
    dP = playerReveal.digit
  if (dC < 0 || dC >= n || dP < 0 || dP >= n) return null
  return (dC + dP) % n
}
