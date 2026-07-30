/**
 * House VTXO denomination planning — pure math, no wallet and no arkd.
 *
 * The pool used to be shaped by one number: `pieceSize`, defaulting to the
 * largest bet tier (50,000). That has two problems the ladder fixes.
 *
 * It asked the wrong question. `floor(freeTotal / pieceSize) - 1` is "how many
 * pieces can I afford?", so a house with less than 2x pieceSize free could
 * never split at all, and a house well above it kept minting 50,000 pieces it
 * already had plenty of. A ladder asks "what am I SHORT of, per size?" instead,
 * so each size converges on a target count and stops.
 *
 * And one size cannot serve the bet range. A 330-sat bet locked a whole 50,000
 * coin, while a 95%-win bet needs roughly 19x the player's stake in house money
 * and had to compose several. Multi-input funding already exists
 * (fundHouseEscrowOnce), so a pool weighted toward SMALL pieces serves both
 * ends: small bets lock little, big bets compose.
 *
 * Everything here is deliberately pure so the awkward cases — dust-sized
 * change, the POOL_MAX_COUNT ceiling, a rung the bankroll cannot afford — are
 * table tests rather than something only a live regtest can reach.
 */

/** One rung of the target pool shape. */
export interface Denomination {
  /** Piece size in sats. */
  size: number
  /** Share of the free bankroll to hold at this size, in percent. */
  weightPct: number
}

/**
 * Default ladder, DERIVED from the largest configured bet tier so it tracks
 * `tiers` instead of drifting from it: many small pieces, some medium, a few
 * large. maxTier 50,000 gives 5,000 / 25,000 / 100,000 at 60 / 30 / 10.
 *
 * Small-heavy on purpose — a small piece is usable by every bet, a large one
 * only by large bets, so the same bankroll supports more concurrent games when
 * it leans small. The large rung exists so a big house stake does not need a
 * dozen inputs (each input costs tx weight and a checkpoint).
 */
export function defaultLadder(maxTier: number): Denomination[] {
  return [
    { size: Math.max(1, Math.round(maxTier / 10)), weightPct: 60 },
    { size: Math.max(2, Math.round(maxTier / 2)), weightPct: 30 },
    { size: Math.max(3, maxTier * 2), weightPct: 10 },
  ]
}

/**
 * Parse `HOUSE_VTXO_DENOMINATIONS` — "5000:60,25000:30,100000:10" as
 * size:weightPct pairs. Returns null (caller falls back to the derived
 * default) when unset or malformed, so a typo in a deploy env cannot silently
 * reshape the bankroll into something unintended.
 */
export function parseLadder(spec: string | undefined): Denomination[] | null {
  if (!spec || !spec.trim()) return null
  const out: Denomination[] = []
  for (const part of spec.split(',')) {
    const [sizeStr, weightStr] = part.split(':')
    const size = Number(sizeStr)
    const weightPct = Number(weightStr)
    if (!Number.isFinite(size) || size <= 0) return null
    if (!Number.isFinite(weightPct) || weightPct <= 0) return null
    out.push({ size: Math.floor(size), weightPct })
  }
  if (out.length === 0) return null
  // Ascending, so planning always fills the most broadly usable size first.
  return out.sort((a, b) => a.size - b.size)
}

/** Which rung a coin counts toward: the largest rung it fully covers. */
export function bucketOf(value: number, ladder: Denomination[]): number {
  let idx = -1
  for (let i = 0; i < ladder.length; i++) {
    if (value >= ladder[i].size) idx = i
  }
  return idx
}

export interface SplitPlan {
  /** Output amounts to mint, in the order they should be added to the tx. */
  outputs: number[]
  /** Why the plan is empty — for the operator, never for control flow. */
  reason: string
}

/**
 * Decide what to mint.
 *
 * `bankroll` is the total free value; `existing` the free coin values. Returns
 * at most `maxOutputsPerTx` amounts, never more than `headroom` of them, and
 * never more than the inputs can pay for once `dust` change is allowed for.
 *
 * Smallest deficit rung first: small pieces are usable by every bet, so when
 * only a few outputs fit in one tx they are the ones worth minting. Successive
 * ticks walk up the ladder as the small rungs fill.
 */
export function planSplit(args: {
  existing: number[]
  ladder: Denomination[]
  maxCount: number
  maxOutputsPerTx: number
  /** Value of the coins actually being spent — the plan must fit inside this. */
  spendable: number
  dust: number
}): SplitPlan {
  const { existing, ladder, maxCount, maxOutputsPerTx, spendable, dust } = args

  if (ladder.length === 0) return { outputs: [], reason: 'no denominations configured' }

  const headroom = maxCount - existing.length
  if (headroom < 1) {
    return { outputs: [], reason: `pool at ceiling — ${existing.length}/${maxCount} free pieces` }
  }

  const bankroll = existing.reduce((s, v) => s + v, 0)
  if (bankroll <= dust) {
    return { outputs: [], reason: `nothing free to split — ${bankroll} sat` }
  }

  // Target count per rung, from that rung's share of the bankroll.
  const have = ladder.map(() => 0)
  for (const v of existing) {
    const b = bucketOf(v, ladder)
    if (b >= 0) have[b]++
  }
  const want = ladder.map((d) => Math.floor((bankroll * d.weightPct) / 100 / d.size))

  // A bankroll too small to want even one piece of the cheapest rung is NOT the
  // same state as a pool that already matches its ladder, and saying so is the
  // whole point of returning a reason — "matches the ladder" would read as
  // healthy to an operator whose house is simply nearly empty.
  if (want.every((w) => w === 0)) {
    const cheapest = ladder[0]
    const needed = Math.ceil((cheapest.size * 100) / cheapest.weightPct)
    return {
      outputs: [],
      reason: `bankroll ${bankroll} sat is too small for the smallest denomination — ${cheapest.size} sat at ${cheapest.weightPct}% weight wants a bankroll of ${needed} sat`,
    }
  }

  // Deficits, smallest size first.
  const deficits = ladder
    .map((d, i) => ({ size: d.size, short: want[i] - have[i] }))
    .filter((d) => d.short > 0)

  if (deficits.length === 0) {
    const shape = ladder.map((d, i) => `${have[i]}x${d.size}`).join(' ')
    return { outputs: [], reason: `pool already matches the ladder — ${shape}` }
  }

  // Fill round-robin from the smallest rung so one expensive rung cannot starve
  // the others out of a single tx's output budget.
  const outputs: number[] = []
  let budget = spendable - dust // leave change above dust
  let progress = true
  while (progress && outputs.length < Math.min(headroom, maxOutputsPerTx)) {
    progress = false
    for (const d of deficits) {
      if (d.short <= 0) continue
      if (outputs.length >= Math.min(headroom, maxOutputsPerTx)) break
      if (budget < d.size) continue
      outputs.push(d.size)
      budget -= d.size
      d.short--
      progress = true
    }
  }

  if (outputs.length === 0) {
    const cheapest = Math.min(...deficits.map((d) => d.size))
    return {
      outputs: [],
      reason: `not enough free value — ${spendable} sat spendable, smallest wanted piece is ${cheapest} sat plus ${dust} sat change`,
    }
  }

  const shape = summarise(outputs)
  return { outputs, reason: `minting ${outputs.length} piece(s) — ${shape}` }
}

/** "3x5000 1x25000" — compact shape for a log line. */
export function summarise(amounts: number[]): string {
  const counts = new Map<number, number>()
  for (const a of amounts) counts.set(a, (counts.get(a) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([size, n]) => `${n}x${size}`)
    .join(' ')
}
