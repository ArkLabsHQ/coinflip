/**
 * The denomination planner — pure, so every give-up path is a table test.
 *
 * These exist because the OLD sizing rule (`floor(freeTotal/pieceSize) - 1`)
 * had two silent no-op cases that only showed up in production as a fragment
 * button that "ran" and did nothing: a bankroll under 2x pieceSize, and a pool
 * already at the ceiling. Both now return a REASON, and both are pinned here.
 */
export {}

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  planSplit, defaultLadder, parseLadder, bucketOf, summarise,
} = require('arkade-coinflip-server/dist/vtxo-denominations.js')

const DUST = 330
const LADDER = defaultLadder(50_000) // 5,000:60 / 25,000:30 / 100,000:10

const plan = (existing: number[], over: Record<string, unknown> = {}) =>
  planSplit({
    existing, ladder: LADDER, maxCount: 64, maxOutputsPerTx: 16,
    spendable: existing.reduce((s, v) => s + v, 0), dust: DUST, ...over,
  })

describe('defaultLadder', () => {
  it('derives from the largest bet tier, small-heavy', () => {
    expect(defaultLadder(50_000)).toEqual([
      { size: 5_000, weightPct: 60 },
      { size: 25_000, weightPct: 30 },
      { size: 100_000, weightPct: 10 },
    ])
  })

  it('tracks a changed tier config instead of drifting from it', () => {
    expect(defaultLadder(10_000).map((d: any) => d.size)).toEqual([1_000, 5_000, 20_000])
  })

  it('stays strictly ascending and positive even for a tiny max tier', () => {
    for (const t of [1, 2, 5, 10, 330]) {
      const sizes = defaultLadder(t).map((d: any) => d.size)
      expect(sizes.every((s: number) => s > 0)).toBe(true)
      expect([...sizes].sort((a: number, b: number) => a - b)).toEqual(sizes)
    }
  })
})

describe('parseLadder', () => {
  it('parses size:weight pairs and sorts ascending', () => {
    expect(parseLadder('100000:10,5000:60,25000:30')).toEqual([
      { size: 5_000, weightPct: 60 },
      { size: 25_000, weightPct: 30 },
      { size: 100_000, weightPct: 10 },
    ])
  })

  it('returns null for unset/empty so the caller uses the derived default', () => {
    expect(parseLadder(undefined)).toBeNull()
    expect(parseLadder('')).toBeNull()
    expect(parseLadder('   ')).toBeNull()
  })

  // A typo in a deploy env must not silently reshape the bankroll.
  it.each([
    ['missing weight', '5000'],
    ['non-numeric size', 'abc:60'],
    ['non-numeric weight', '5000:xyz'],
    ['zero size', '0:60'],
    ['negative weight', '5000:-1'],
    ['one bad pair among good ones', '5000:60,bad,25000:30'],
  ])('rejects %s rather than guessing', (_label, spec) => {
    expect(parseLadder(spec)).toBeNull()
  })
})

describe('bucketOf', () => {
  it('counts a coin toward the largest rung it fully covers', () => {
    expect(bucketOf(4_999, LADDER)).toBe(-1)   // below every rung
    expect(bucketOf(5_000, LADDER)).toBe(0)
    expect(bucketOf(24_999, LADDER)).toBe(0)
    expect(bucketOf(25_000, LADDER)).toBe(1)
    expect(bucketOf(100_000, LADDER)).toBe(2)
    expect(bucketOf(9_999_999, LADDER)).toBe(2)
  })
})

describe('planSplit — the cases the old rule silently no-opped on', () => {
  // The headline bug: at pieceSize 50,000 a house under 100,000 free could
  // never split, with no log and no reason in the HTTP response.
  it('a bankroll the old rule could not split at all now mints small pieces', () => {
    const r = plan([80_000])
    expect(r.outputs.length).toBeGreaterThan(0)
    expect(r.outputs).toContain(5_000)
    expect(r.reason).toMatch(/minting/)
  })

  it('names the ceiling instead of returning a bare 0', () => {
    const r = plan(Array.from({ length: 64 }, () => 5_000))
    expect(r.outputs).toEqual([])
    expect(r.reason).toBe('pool at ceiling — 64/64 free pieces')
  })

  it('names an empty bankroll', () => {
    const r = plan([])
    expect(r.outputs).toEqual([])
    expect(r.reason).toMatch(/nothing free to split/)
  })

  // A nearly-empty house is NOT a healthy pool. Saying "already matches the
  // ladder" here would read as fine to an operator who actually needs to fund.
  it('distinguishes a too-small bankroll from a satisfied ladder', () => {
    const r = plan([1_000])
    expect(r.outputs).toEqual([])
    expect(r.reason).toMatch(/too small for the smallest denomination/)
    expect(r.reason).toContain('1000')  // what it has
    expect(r.reason).toContain('5000')  // the cheapest rung
    expect(r.reason).not.toMatch(/matches the ladder/)
  })

  /**
   * The invariant that matters for a ROUTINE splitter: it has to reach a
   * fixed point. If planning never returns an empty plan the tick would
   * re-split the same bankroll forever, burning a tx fee each time — the
   * failure mode of "routinely split" done wrong. Simulate the real loop
   * (plan, spend the largest coins, mint outputs + change) and require it to
   * settle rather than asserting a hand-computed shape.
   */
  it('converges to a fixed point instead of churning fees forever', () => {
    let existing = [1_150_000]
    let iterations = 0
    let last: any
    while (iterations < 200) {
      const spendable = existing.reduce((s, v) => s + v, 0)
      last = planSplit({
        existing, ladder: LADDER, maxCount: 64, maxOutputsPerTx: 16, spendable, dust: DUST,
      })
      if (last.outputs.length === 0) break
      iterations++
      // Apply: spend the largest coins that cover the plan, mint outputs + change.
      const need = last.outputs.reduce((s: number, v: number) => s + v, 0) + DUST
      const desc = [...existing].sort((a, b) => b - a)
      const spent: number[] = []
      let got = 0
      while (got < need && desc.length > 0) { const c = desc.shift() as number; spent.push(c); got += c }
      const change = got - last.outputs.reduce((s: number, v: number) => s + v, 0)
      existing = [...desc, ...last.outputs, ...(change > DUST ? [change] : [])]
    }
    expect(iterations).toBeLessThan(200)          // it terminated
    expect(last.outputs).toEqual([])              // on a deliberate no-op
    // And it stopped for a real reason, not because it ran out of money.
    expect(last.reason).toMatch(/matches the ladder|at ceiling/)
    // The bankroll is genuinely fragmented now, not still one lump.
    expect(existing.length).toBeGreaterThan(10)
  })
})

describe('planSplit — caps and budgets', () => {
  it('never exceeds maxOutputsPerTx (the tx-weight limit)', () => {
    const r = plan([5_000_000], { maxOutputsPerTx: 16 })
    expect(r.outputs.length).toBeLessThanOrEqual(16)
    expect(r.outputs.length).toBe(16)
  })

  it('never pushes the pool past maxCount', () => {
    const existing = Array.from({ length: 60 }, () => 5_000) // 300,000
    const r = planSplit({
      existing, ladder: LADDER, maxCount: 64, maxOutputsPerTx: 16,
      spendable: 300_000, dust: DUST,
    })
    expect(r.outputs.length).toBeLessThanOrEqual(4) // 64 - 60
  })

  it('leaves dust-safe change — never plans more than the inputs cover', () => {
    const r = plan([10_500])
    const spent = r.outputs.reduce((s: number, v: number) => s + v, 0)
    expect(spent).toBeLessThanOrEqual(10_500 - DUST)
  })

  it('fills small rungs first, so a scarce output budget buys usable pieces', () => {
    // The single 1.15M coin ALREADY buckets as the large rung (want 1, have 1),
    // so there is no large deficit — the budget correctly goes to the rungs
    // that are actually short, smallest first.
    const r = plan([1_150_000], { maxOutputsPerTx: 3 })
    expect(r.outputs).toEqual([5_000, 25_000, 5_000])
    expect(r.outputs[0]).toBe(5_000)
  })

  it('round-robins so one expensive rung cannot starve the others', () => {
    // Budget fits many small but only one large; the large must not consume
    // the whole output allowance before the small rung is served.
    const r = plan([1_150_000], { maxOutputsPerTx: 8 })
    expect(r.outputs.filter((v: number) => v === 5_000).length).toBeGreaterThan(1)
  })

  it('reports an empty ladder rather than dividing by nothing', () => {
    const r = planSplit({
      existing: [100_000], ladder: [], maxCount: 64, maxOutputsPerTx: 16,
      spendable: 100_000, dust: DUST,
    })
    expect(r.outputs).toEqual([])
    expect(r.reason).toBe('no denominations configured')
  })

  it('every returned plan is affordable and positive', () => {
    for (const bankroll of [5_331, 10_000, 80_000, 500_000, 1_150_000, 9_000_000]) {
      const r = plan([bankroll])
      const spent = r.outputs.reduce((s: number, v: number) => s + v, 0)
      expect(spent).toBeLessThanOrEqual(bankroll - DUST)
      expect(r.outputs.every((v: number) => v > 0)).toBe(true)
      expect(r.reason).toBeTruthy()
    }
  })
})

describe('summarise', () => {
  it('compacts a plan for the log line', () => {
    expect(summarise([5_000, 5_000, 25_000, 5_000])).toBe('3x5000 1x25000')
    expect(summarise([])).toBe('')
  })
})
