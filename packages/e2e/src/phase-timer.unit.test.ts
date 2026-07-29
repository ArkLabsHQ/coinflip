/**
 * The phase timer sits on the money path (/play, /cofund, /reveal), so its
 * first duty is to be invisible: same return values, same errors, same order.
 * Its second is to actually attribute time, since the whole point is that the
 * dominant leg stops being something inferred by reading the handler.
 */
export {}

/* eslint-disable @typescript-eslint/no-require-imports */
const { startPhaseTimer, PHASE_LOG_THRESHOLD_MS } =
  require('arkade-coinflip-server/dist/phase-timer.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('phase timer', () => {
  let logged: string[]
  let origLog: typeof console.log

  beforeEach(() => {
    logged = []
    origLog = console.log
    console.log = (...a: unknown[]) => { logged.push(a.join(' ')) }
  })
  afterEach(() => { console.log = origLog })

  it('returns the step value untouched', async () => {
    const t = startPhaseTimer('test')
    const v = await t.step('a', async () => ({ ok: 1 }))
    expect(v).toEqual({ ok: 1 })
  })

  it('propagates the original error, not a wrapped one', async () => {
    const t = startPhaseTimer('test')
    const boom = new Error('VTXO_ALREADY_SPENT (6): deadbeef:0 already spent')
    let caught: unknown
    try {
      await t.step('a', async () => { throw boom })
    } catch (e) { caught = e }
    // Callers match on this message (the co-fund deny-list does), so identity
    // matters, not just shape.
    expect(caught).toBe(boom)
  })

  it('still closes a phase that threw, so later phases are not inflated by it', async () => {
    const t = startPhaseTimer('test')
    try { await t.step('doomed', async () => { await sleep(30); throw new Error('x') }) } catch { /* expected */ }
    await t.step('after', async () => sleep(5))
    const s = t.summary()
    expect(s).toContain('doomed=')
    expect(s).toContain('after=')
  })

  it('attributes time to the slow phase and lists it first', async () => {
    const t = startPhaseTimer('test')
    await t.step('fast', async () => sleep(2))
    await t.step('slow', async () => sleep(60))
    const s = t.summary()
    // Slowest first is the whole ergonomic point — the dominant leg is the
    // first thing on the line.
    expect(s.indexOf('slow=')).toBeLessThan(s.indexOf('fast='))
    const slowMs = Number(/slow=(\d+)/.exec(s)![1])
    expect(slowMs).toBeGreaterThanOrEqual(40)
  })

  it('stays quiet for a fast request and speaks for a slow one', async () => {
    const quiet = startPhaseTimer('test')
    await quiet.step('a', async () => sleep(1))
    quiet.done()
    expect(logged).toHaveLength(0)

    const loud = startPhaseTimer('test')
    loud.done(true) // force, so the test does not have to actually be slow
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('[timing] test')
    expect(logged[0]).toContain('total=')
  })

  it('has a threshold that is set and sane', () => {
    // Logging every request would bury the slow ones it exists to surface.
    expect(PHASE_LOG_THRESHOLD_MS).toBeGreaterThan(0)
    expect(PHASE_LOG_THRESHOLD_MS).toBeLessThanOrEqual(5000)
  })

  it('reports a total even with no phases marked', () => {
    const t = startPhaseTimer('test')
    expect(t.summary()).toContain('total=')
    expect(t.elapsed()).toBeGreaterThanOrEqual(0)
  })
})
