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
 *      no-op → returns false, NOT a thrown failure. Any other error rethrows
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
  it('calls the SDK settle() with NO arguments (not an explicit empty-outputs set)', async () => {
    const calls: any[][] = []
    const deps = depsWithSettle(async (...args: any[]) => {
      calls.push(args)
      return 'txid-abc'
    })
    const ok = await renewSettle(deps)
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    // The load-bearing assertion: zero args. A regression to
    // settle({ inputs, outputs: [] }) would put one object here and arkd
    // would reject with "proof does not contain outputs".
    expect(calls[0]).toEqual([])
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

  it('rethrows TX_NOT_FOUND (the stale-wallet phantom-boarding failure)', async () => {
    const deps = depsWithSettle(async () => { throw new Error('TX_NOT_FOUND (19): failed to get boarding input tx') })
    await expect(renewSettle(deps)).rejects.toThrow('TX_NOT_FOUND')
  })
})
