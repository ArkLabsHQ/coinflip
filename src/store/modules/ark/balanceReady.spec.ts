import { describe, it, expect } from 'vitest'
import { isSyncConfirmed } from './balanceReady'

/**
 * A player reported: "Stop opening the wallet drawer on load until it actually
 * loads. It still opens because balance is 0 until it starts up as well."
 *
 * "Still" because the previous attempt waited a fixed 2s for the zero to
 * persist, and the SDK's first sync routinely takes longer than that.
 */
describe('isSyncConfirmed', () => {
  it('confirms a healthy sync that has actually run', () => {
    expect(isSyncConfirmed({ mode: 'online', lastSyncedAt: 1_700_000_000_000 })).toBe(true)
  })

  it('does NOT confirm a manager that has never synced', () => {
    // The trap this whole module exists for. `getSyncState()` reports
    // `degraded` only when a failure reason is stored, so a fresh manager --
    // one that has not synced even once -- reads back as "online". Gating on
    // mode alone would be true from the first frame and change nothing.
    expect(isSyncConfirmed({ mode: 'online' })).toBe(false)
    expect(isSyncConfirmed({ mode: 'online', lastSyncedAt: undefined })).toBe(false)
  })

  it('does NOT confirm a degraded sync, even one with an earlier success', () => {
    // syncContracts swallows retryable indexer failures and serves repository
    // state, so a degraded read can report a stale or empty balance.
    expect(isSyncConfirmed({ mode: 'degraded', lastSyncedAt: 1_700_000_000_000 })).toBe(false)
    expect(isSyncConfirmed({ mode: 'degraded' })).toBe(false)
  })

  it('does NOT confirm when the state is unavailable', () => {
    // An unknown sync is not a confirmed one: we would rather stay quiet than
    // tell a funded user they have nothing.
    expect(isSyncConfirmed(null)).toBe(false)
    expect(isSyncConfirmed(undefined)).toBe(false)
  })

  it('treats a zero timestamp as a real sync', () => {
    // Guards against a `!sync.lastSyncedAt` truthiness check creeping back in.
    expect(isSyncConfirmed({ mode: 'online', lastSyncedAt: 0 })).toBe(true)
  })
})
