import { describe, it, expect } from 'vitest'
import { pruneOnLoad } from './stashPrune'
import type { StashedRefund } from '@/store/modules/ark/ark'

const NOW = 1_000_000_000 // fixed unix-seconds reference
const DAY = 86_400

/** Minimal stash; only the fields pruneOnLoad reads matter. */
function stash(over: Partial<StashedRefund> = {}): StashedRefund {
  return {
    gameId: Math.random().toString(36).slice(2),
    tier: 1000,
    playerEscrow: { txid: 'a'.repeat(64), vout: 0, value: 1000 },
    refundPsbt: '',
    refundCheckpoints: [],
    finalExpiration: NOW,
    createdAt: NOW * 1000,
    revealed: false,
    ...over,
  } as StashedRefund
}

describe('pruneOnLoad (stash eviction)', () => {
  it('keeps a stash that just unlocked (finalExpiration == now)', () => {
    // The unlock moment is when it becomes claimable — must NOT be evicted.
    expect(pruneOnLoad([stash({ finalExpiration: NOW })], NOW)).toHaveLength(1)
  })

  it('drops an unrevealed stash past the 7-day grace', () => {
    expect(pruneOnLoad([stash({ finalExpiration: NOW - 8 * DAY })], NOW)).toHaveLength(0)
  })

  it('keeps a revealed (forfeit-eligible) stash inside the 30-day grace', () => {
    const s = stash({ finalExpiration: NOW - 8 * DAY, revealed: true })
    expect(pruneOnLoad([s], NOW)).toHaveLength(1)
  })

  it('drops a revealed stash past the 30-day grace', () => {
    const s = stash({ finalExpiration: NOW - 31 * DAY, revealed: true })
    expect(pruneOnLoad([s], NOW)).toHaveLength(0)
  })

  it('drops a stash with a non-finite finalExpiration (never immortal)', () => {
    expect(pruneOnLoad([stash({ finalExpiration: NaN })], NOW)).toHaveLength(0)
  })

  it('caps at 200 entries, keeping the newest by createdAt', () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      stash({ finalExpiration: NOW, createdAt: (NOW + i) * 1000 }),
    )
    const kept = pruneOnLoad(many, NOW)
    expect(kept).toHaveLength(200)
    // Newest survives, oldest evicted.
    expect(kept[0].createdAt).toBe((NOW + 249) * 1000)
    expect(kept.some((s) => s.createdAt === NOW * 1000)).toBe(false)
  })
})
