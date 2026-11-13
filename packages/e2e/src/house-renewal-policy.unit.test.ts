import { houseRenewalBufferMs, HOUSE_RENEWAL_INTERVAL_MS, RENEWAL_EXPIRY_BUFFER_MS, VTXO_LIFETIME_BUFFER_MS } from 'arkade-coinflip-server/dist/house-renewal-policy'
import { ARK_SYNC_TIMEOUT_MS, ARK_SUBMIT_TIMEOUT_MS } from 'arkade-coinflip-server/dist/async-timeout'

describe('bounded house renewal policy', () => {
  it('keeps the production 72-hour lead on a seven-day batch', () => {
    expect(houseRenewalBufferMs({ vtxoTreeExpiry: 7n * 86400n })).toBe(RENEWAL_EXPIRY_BUFFER_MS)
  })

  it('uses half of an 8192-second batch while preserving the game, timer and complete tick budgets', () => {
    const buffer = houseRenewalBufferMs({ vtxoTreeExpiry: 8192n })
    expect(buffer).toBe(4096_000)
    expect(buffer).toBeGreaterThanOrEqual(VTXO_LIFETIME_BUFFER_MS + HOUSE_RENEWAL_INTERVAL_MS + ARK_SYNC_TIMEOUT_MS + 2 * ARK_SUBMIT_TIMEOUT_MS)
  })

  it.each([undefined, {}, { vtxoTreeExpiry: 0n }, { vtxoTreeExpiry: -1n }, { vtxoTreeExpiry: 180n }])('keeps the legacy date policy for absent or non-time metadata: %s', info => {
    expect(houseRenewalBufferMs(info)).toBe(RENEWAL_EXPIRY_BUFFER_MS)
  })

  it('bounds arbitrarily large bigint lifetimes without a lossy number conversion', () => {
    expect(houseRenewalBufferMs({ vtxoTreeExpiry: 10n ** 100n })).toBe(RENEWAL_EXPIRY_BUFFER_MS)
  })

  it('refuses a known lifetime that cannot cover the complete operational lead', () => {
    expect(() => houseRenewalBufferMs({ vtxoTreeExpiry: 1024n })).toThrow(/batch lifetime 1024s is too short/)
  })

  it('honors longer configured worker budgets without lowering the game horizon', () => {
    expect(houseRenewalBufferMs({ vtxoTreeExpiry: 8192n }, { intervalMs: 3000_000 })).toBe(5025_000)
  })

  it.each([0, -1, NaN, Infinity])('rejects an invalid worker budget: %s', intervalMs => {
    expect(() => houseRenewalBufferMs({ vtxoTreeExpiry: 8192n }, { intervalMs })).toThrow(/positive finite/)
  })
})
