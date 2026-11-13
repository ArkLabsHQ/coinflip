import { poolGameSnapshot, poolInputPolicy, type PoolGamePosition } from 'arkade-coinflip/dist/pool-game-vault'
import type { arkade } from '@arkade-os/sdk'

it('derives the recovery margin from the actual time-based exit delay and rejects block delays', () => {
  const policy = (delay: bigint) => poolInputPolicy({ serverExitDelay: delay } as arkade.Arkade)
  expect(policy(1536n)).toEqual({ minTTL: 6000, recoveryMarginSeconds: 2400 })
  expect(policy(86528n)).toEqual({ minTTL: 90428, recoveryMarginSeconds: 86828 })
  for (const invalid of [0n, 144n, 513n, 33553920n]) expect(() => policy(invalid)).toThrow(/exit delay/)
})

it('requires the enforced 6000-second lifetime plus the quote horizon before advertising new operations', () => {
  const now = 1_900_000_000_000, clock = jest.spyOn(Date, 'now').mockReturnValue(now)
  const position = (seconds?: number): PoolGamePosition => ({ coin: { txid: '11'.repeat(32), vout: 0, value: 1330,
    ...(seconds === undefined ? {} : { expiresAt: new Date(now + seconds * 1000) }) }, sourceTx: new Uint8Array(),
  state: { navSats: 1000n, supply: 100n, accruedFeesSats: 0n, carriedLossSats: 0n, phase: 'idle' } })
  try {
    expect(poolGameSnapshot(position(6061)).readyForOperations).toBe(true)
    for (const remaining of [undefined, 3601, 5000, 6000, 6060]) {
      const snapshot = poolGameSnapshot(position(remaining))
      expect(snapshot.readyForOperations).toBe(false)
      expect(snapshot.recoveryReason).toMatch(/renewal/)
    }
    const production = { ...position(90488), minimumInputLifetimeSeconds: 90428, recoveryMarginSeconds: 86828 }
    expect(poolGameSnapshot(production)).toMatchObject({ readyForOperations: false, requiredLifetimeSeconds: 90428, recoveryMarginSeconds: 86828 })
    production.coin.expiresAt = new Date(now + 90489_000)
    expect(poolGameSnapshot(production).readyForOperations).toBe(true)
    expect(poolGameSnapshot(position(6061))).toMatchObject({ admissionClosesAt: now + 1000, rescueOpensAt: now + 61_000 })
    expect(poolGameSnapshot({ ...position(-60), coin: { ...position(-60).coin, isSwept: true } as PoolGamePosition['coin'] }))
      .toMatchObject({ readyForOperations: false, admissionClosesAt: null, rescueOpensAt: now - 6_060_000 })
  } finally { clock.mockRestore() }
})
