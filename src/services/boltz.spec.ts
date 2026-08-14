import { describe, it, expect } from 'vitest'
import { arkToBtcFixedFee, arkToBtcTotal, arkToBtcMax } from './boltz'
import type { ChainFeesResponse } from '@arkade-os/boltz-swap'

/**
 * The live ARK→BTC fees from the regtest Boltz these numbers were measured
 * against: 0.4% plus 154 + 111 + 0 = 265 sats of miner fees.
 */
const FEES: ChainFeesResponse = {
  percentage: 0.4,
  minerFees: { server: 154, user: { claim: 111, lockup: 0 } },
}

describe('arkToBtcFixedFee', () => {
  it('sums every miner fee component', () => {
    expect(arkToBtcFixedFee(FEES)).toBe(265)
  })
})

describe('arkToBtcTotal', () => {
  // Each pair was read off Boltz's own `amountToPay` on regtest — these are
  // measurements, not derivations, so they pin the formula to reality.
  it.each([
    [1500, 1773],
    [2000, 2275],
    [3000, 3279],
    [4000, 4283],
  ])('charges %i sats as %i, matching Boltz', (sats, expected) => {
    expect(arkToBtcTotal(sats, FEES)).toBe(expected)
  })

  it('takes the percentage on amount PLUS miner fees, not on the amount alone', () => {
    // The bug this replaced: (sats * 0.4%) instead of ((sats + 265) * 0.4%).
    const naive = 4000 + 265 + Math.ceil((4000 * 0.4) / 100) // 4281
    expect(arkToBtcTotal(4000, FEES)).toBe(naive + 2)
  })

  it('always costs more than the amount being sent', () => {
    for (const sats of [1, 1000, 50_000, 4_000_000]) {
      expect(arkToBtcTotal(sats, FEES)).toBeGreaterThan(sats)
    }
  })

  it('charges only the miner fees when the percentage is zero', () => {
    const free: ChainFeesResponse = { ...FEES, percentage: 0 }
    expect(arkToBtcTotal(1000, free)).toBe(1265)
  })
})

describe('arkToBtcMax', () => {
  // The invariant that matters: whatever MAX offers must actually be sendable.
  it.each([600, 1000, 5000, 50_000, 414_518, 4_000_000])(
    'returns an amount that still fits a %i balance',
    (balance) => {
      const max = arkToBtcMax(balance, FEES)
      expect(arkToBtcTotal(max, FEES)).toBeLessThanOrEqual(balance)
    },
  )

  it('leaves the caller room to reserve dust', () => {
    const balance = 414_518
    const dust = 330
    const max = arkToBtcMax(balance - dust, FEES)
    // Reserving dust before solving keeps a keepable remainder, so the funding
    // send never has to create a change output too small to exist.
    expect(balance - arkToBtcTotal(max, FEES)).toBeGreaterThanOrEqual(dust)
  })

  it('is close to the ceiling, not merely safe', () => {
    // One sat more must NOT fit, otherwise MAX is leaving money unsendable.
    const balance = 50_000
    const max = arkToBtcMax(balance, FEES)
    expect(arkToBtcTotal(max + 2, FEES)).toBeGreaterThan(balance)
  })

  it('never goes negative when the balance cannot cover the fees', () => {
    for (const balance of [0, 1, 100, 265]) {
      expect(arkToBtcMax(balance, FEES)).toBe(0)
    }
  })
})
