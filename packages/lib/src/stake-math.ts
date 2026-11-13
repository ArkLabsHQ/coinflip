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

export interface ExactRatio {
  numerator: string
  denominator: string
}

export interface CommittedGameTerms {
  playerStake: number
  houseStake: number
  oddsN: number
  oddsTarget: number
  oddsLo: number
  configuredHouseStakeDiscountBps?: number
}

export interface CommittedGameEconomics {
  playerStake: number
  houseStake: number
  pot: number
  rakeAmount: 0
  winProbability: ExactRatio
  expectedHouseProfitSats: ExactRatio
  effectiveHouseEdgeBps: ExactRatio
  configuredHouseStakeDiscountBps: number | null
  basis: 'committed-stakes-before-network-costs'
}

function exactRatio(numerator: bigint, denominator: bigint): ExactRatio {
  let a = numerator < 0n ? -numerator : numerator
  let b = denominator
  while (b !== 0n) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return { numerator: String(numerator / a), denominator: String(denominator / a) }
}

// Use actual committed stakes: denomination change folding can alter the effective edge.
export function quoteCommittedEconomics(terms: CommittedGameTerms): CommittedGameEconomics {
  const { playerStake, houseStake, oddsN, oddsTarget, oddsLo, configuredHouseStakeDiscountBps } = terms
  if (!Number.isSafeInteger(playerStake) || playerStake <= 0 ||
      !Number.isSafeInteger(houseStake) || houseStake < 0 || !Number.isSafeInteger(playerStake + houseStake)) {
    throw new Error('Committed stakes and their pot must be safe whole sats; player stake must be positive')
  }
  if (!Number.isSafeInteger(oddsN) || oddsN < 2 || oddsN > 128 ||
      !Number.isSafeInteger(oddsLo) || !Number.isSafeInteger(oddsTarget) ||
      oddsLo < 0 || oddsLo >= oddsTarget || oddsTarget > oddsN) {
    throw new Error('Committed odds must satisfy 2 <= n <= 128 and 0 <= lo < target <= n')
  }
  if (configuredHouseStakeDiscountBps !== undefined &&
      (!Number.isSafeInteger(configuredHouseStakeDiscountBps) || configuredHouseStakeDiscountBps < 0 || configuredHouseStakeDiscountBps > 10000)) {
    throw new Error('Configured house stake discount must be whole basis points in [0, 10000]')
  }
  const n = BigInt(oddsN), win = BigInt(oddsTarget - oddsLo)
  const player = BigInt(playerStake), house = BigInt(houseStake)
  const expectedProfit = (n - win) * player - win * house
  return {
    playerStake, houseStake, pot: playerStake + houseStake, rakeAmount: 0,
    winProbability: exactRatio(win, n),
    expectedHouseProfitSats: exactRatio(expectedProfit, n),
    effectiveHouseEdgeBps: exactRatio(expectedProfit * 10000n, n * player),
    configuredHouseStakeDiscountBps: configuredHouseStakeDiscountBps ?? null,
    basis: 'committed-stakes-before-network-costs',
  }
}

export function quotePoolEconomics(terms: CommittedGameTerms): CommittedGameEconomics {
  const quote = quoteCommittedEconomics(terms)
  if (BigInt(quote.expectedHouseProfitSats.numerator) < 0n) {
    throw new Error('Pool wager has negative expected house profit for its committed stakes')
  }
  return quote
}

/**
 * The static bet rails from the configured tiers. `tiers` is no longer a
 * whitelist — only its extremes matter, and the floor is pushed strictly above
 * dust so the smallest bet is never exactly the dust limit.
 *
 * The single definition of the rails: both /play (validation) and /api/tiers
 * (publication) call this, so they cannot drift apart.
 */
export function betRails(tiers: number[], dust: number): { railMin: number; railMax: number } {
  return {
    railMin: Math.max(Math.min(...tiers), dust + 1),
    railMax: Math.max(...tiers),
  }
}

/** A ladder step / odds range: the player wins on a roll in [lo, target) of n. */
export interface OddsRange {
  n: number
  target: number
  lo: number
}

/** Amount bounds for one odds range. `feasible` is false when min > max. */
export interface AmountBounds {
  min: number
  max: number
  feasible: boolean
}

/**
 * The bet amounts whose house stake lands inside [dust, capacity] for a fixed
 * odds range, clamped to the configured rails.
 *
 * houseStake(A) = floor(A * K / D) with K = (n - win)*(10000 - edgeBps) and
 * D = win*10000, so:
 *   floor(A*K/D) >= dust      <=>  A >= ceil(dust*D / K)
 *   floor(A*K/D) <= capacity  <=>  A*K <= (capacity+1)*D - 1
 * The max uses that exact form rather than floor(capacity*D/K), which can fall
 * a sat short of the true ceiling and hide the largest playable bet.
 *
 * `topUpHeadroom` reserves that many sats at the CAPACITY ceiling, for callers
 * whose displayed amount is not the amount the cap is finally applied to. The
 * player's wallet folds a sub-dust change (≤ dust) into its stake AFTER the bet
 * is chosen, and /play caps on `tier + stakeTopUp` — so a client bounding on the
 * bare amount offers a maximum the server intermittently rejects, and at long
 * odds the house-stake overshoot is ~K/D per top-up sat (≈96× on a 1%-win rung),
 * so the rejection is nowhere near marginal. A ≤ max ⟹ A + headroom ≤ trueMax,
 * so this is exact, not an estimate. Only the capacity term is reserved: the
 * rails are checked server-side against the bare amount, which never grows.
 */
export function amountBoundsForOdds(
  odds: OddsRange,
  opts: {
    edgeBps: number
    dust: number
    capacity: number
    railMin: number
    railMax: number
    topUpHeadroom?: number
  },
): AmountBounds {
  const { edgeBps, dust, capacity, railMin, railMax } = opts
  const topUpHeadroom = opts.topUpHeadroom ?? 0
  const win = odds.target - odds.lo
  const K = (odds.n - win) * (10000 - edgeBps)
  const D = win * 10000
  // win === n (or a zero edge divisor) means the house stakes nothing, so no
  // amount can ever produce a dust-clearing house stake.
  if (K <= 0 || D <= 0) return { min: railMin, max: railMax, feasible: false }
  const min = Math.max(railMin, Math.ceil((dust * D) / K))
  const max = Math.min(railMax, Math.floor(((capacity + 1) * D - 1) / K) - topUpHeadroom)
  // A headroom that eats the whole window makes this rung genuinely unplayable —
  // report it through `feasible` (the existing infeasible path) rather than
  // handing back an inverted min > max range for a caller to render.
  return { min, max, feasible: min <= max }
}

/**
 * The contiguous window of ladder steps playable at `amount`. The ladder is
 * ordered by strictly decreasing win rate, so the house stake increases along
 * it and the playable steps form one band:
 *   loIndex = first step whose stake clears dust,
 *   hiIndex = last step the capacity can cover.
 * Walks the real computeHouseStake rather than inverting the odds, so the
 * client can never offer a step the server would reject.
 */
export function feasibleOddsWindow(
  amount: number,
  ladder: OddsRange[],
  opts: { edgeBps: number; dust: number; capacity: number },
): { loIndex: number; hiIndex: number } | null {
  const { edgeBps, dust, capacity } = opts
  let loIndex = -1
  let hiIndex = -1
  for (let i = 0; i < ladder.length; i++) {
    const stake = computeHouseStake(amount, ladder[i].n, ladder[i].target, ladder[i].lo, edgeBps)
    if (loIndex === -1 && stake >= dust) loIndex = i
    if (stake <= capacity) hiIndex = i
  }
  if (loIndex === -1 || hiIndex === -1 || loIndex > hiIndex) return null
  return { loIndex, hiIndex }
}
