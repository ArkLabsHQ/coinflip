/**
 * Regression unit tests for renewSettle (no regtest). Locks in two fixes from
 * the renewal-settle saga:
 *
 *   1. It must call the SDK's NO-ARG settle(). An earlier "fix" passed
 *      settle({ inputs, outputs: [] }) to exclude a phantom boarding input;
 *      empty outputs made arkd reject the intent proof ("proof does not
 *      contain outputs"), so renewal failed every tick and expiring house
 *      VTXOs were never re-minted — surfacing to players as "House has no free
 *      dust-safe VTXO". The no-arg path lets the SDK do the fee + self-output
 *      math it already knows how to do. (commit 60ca445)
 *
 *   2. "No inputs found" (the SDK's empty-eligible-set signal) is a graceful
 *      no-op → returns false, NOT a thrown failure.
 *
 *   3. The phantom-boarding failure (a cached boarding UTXO arkd can't resolve →
 *      TX_NOT_FOUND / "failed to (get|validate) boarding input") is also a
 *      graceful skip → returns false, with an actionable RESYNC_WALLET_ON_BOOT
 *      log, instead of a stack trace every tick. Any OTHER error still rethrows
 *      so the renewal worker logs a real problem.
 *
 * Imports the BUILT server (dist) directly, like the sibling unit tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const { renewSettle } = require('arkade-coinflip-server/dist/game-engine.js')

function depsWithSettle(settle: (...args: any[]) => Promise<any>) {
  return { wallet: { settle } } as any
}

describe('renewSettle (renewal settle path)', () => {
  it('calls settle() with undefined params (SDK default gathering, not explicit empty-outputs)', async () => {
    const calls: any[][] = []
    const deps = depsWithSettle(async (...args: any[]) => {
      calls.push(args)
      return 'txid-abc'
    })
    const ok = await renewSettle(deps)
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    // Load-bearing: the FIRST arg (settle params) must be undefined so the SDK
    // does its own input gathering + fee + self-output math. A regression to
    // settle({ inputs, outputs: [] }) would put an object here and arkd would
    // reject with "proof does not contain outputs". (The 2nd arg is the
    // batch-event handler — see below.)
    expect(calls[0][0]).toBeUndefined()
  })

  it('passes a batch/round event handler as the settle eventCallback', async () => {
    const calls: any[][] = []
    const deps = depsWithSettle(async (...args: any[]) => { calls.push(args); return 'txid' })
    await renewSettle(deps)
    // 2nd arg is the SettlementEvent handler (function) — the per-phase
    // observability layer wired in for every party's settle.
    expect(typeof calls[0][1]).toBe('function')
  })

  it('treats "No inputs found" as a graceful no-op (returns false, does not throw)', async () => {
    const deps = depsWithSettle(async () => { throw new Error('No inputs found') })
    await expect(renewSettle(deps)).resolves.toBe(false)
  })

  it('is case-insensitive on the no-inputs signal', async () => {
    const deps = depsWithSettle(async () => { throw new Error('settle aborted: NO INPUTS FOUND in wallet') })
    await expect(renewSettle(deps)).resolves.toBe(false)
  })

  it('rethrows any other settle failure so the worker logs a real problem', async () => {
    const deps = depsWithSettle(async () => {
      throw new Error('INVALID_INTENT_PROOF (23): proof does not contain outputs')
    })
    await expect(renewSettle(deps)).rejects.toThrow('proof does not contain outputs')
  })

  it('treats the phantom-boarding failure as a graceful skip (returns false, no rethrow)', async () => {
    // A boarding UTXO whose funding tx arkd can't resolve poisons every settle.
    // It looks confirmed locally so it can't be filtered; renewSettle skips the
    // tick (with an actionable RESYNC_WALLET_ON_BOOT log) instead of throwing a
    // stack trace each interval.
    const deps = depsWithSettle(async () => { throw new Error('TX_NOT_FOUND (19): failed to get boarding input tx') })
    await expect(renewSettle(deps)).resolves.toBe(false)
  })

  it('also skips the "failed to validate boarding input" variant', async () => {
    const deps = depsWithSettle(async () => { throw new Error('INVALID_PSBT_INPUT (5): failed to validate boarding input: failed to get tx abc') })
    await expect(renewSettle(deps)).resolves.toBe(false)
  })

  it('still rethrows a non-boarding TX_NOT_FOUND (the phantom-boarding match stays narrow)', async () => {
    const deps = depsWithSettle(async () => { throw new Error('TX_NOT_FOUND (19): some other tx') })
    await expect(renewSettle(deps)).rejects.toThrow('TX_NOT_FOUND')
  })
})

export {}
