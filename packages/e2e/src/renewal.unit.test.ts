/**
 * Deterministic unit test for the renewal gating decision (no regtest). The
 * production renewal timer settles ONLY when shouldRenew says so — settling
 * blindly every poll would finalize preconfirmed game VTXOs into batch rounds
 * and pay a per-intent fee each cycle (the ~5k-sat/flip drain we disabled).
 *
 * The expiry-driven path needs a time-based-expiry network to exercise live
 * (regtest uses block-height batchExpiry), but the gating decision is pure.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { shouldRenew } = require('arkade-coinflip-server/dist/game-engine.js')

describe('shouldRenew (renewal gating)', () => {
  it('does NOT renew when there is nothing to do (no per-poll settle)', () => {
    expect(shouldRenew(0, 0)).toBe(false)
  })
  it('renews when house VTXOs are expiring soon', () => {
    expect(shouldRenew(1, 0)).toBe(true)
    expect(shouldRenew(5, 0)).toBe(true)
  })
  it('renews when there are boarding deposits to confirm into Ark', () => {
    expect(shouldRenew(0, 5000)).toBe(true)
    expect(shouldRenew(0, 1)).toBe(true)
  })
  it('renews when both conditions hold', () => {
    expect(shouldRenew(3, 20000)).toBe(true)
  })
})

export {}
