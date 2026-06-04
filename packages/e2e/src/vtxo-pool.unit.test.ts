/**
 * Deterministic unit tests for the server's concurrency primitives — no
 * regtest needed. Imports the BUILT server (dist) directly.
 *
 * Covers:
 *   - KeyedMutex: per-key mutual exclusion + refcounted cleanup. This is the
 *     lock behind /commit idempotency; the regtest e2e only exercises the
 *     house-win double-submit path ~50% of the time (it depends on a random
 *     coin), so this nails the lock semantics deterministically.
 *   - rebuildReservations: restores in-flight liability on boot for BOTH the
 *     legacy setup/final games (JSON array of outpoints) AND the trustless
 *     per-party games (TrustlessState object) — the latter was silently
 *     dropped before, letting the house over-commit after a restart.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const pool = require('arkade-coinflip-server/dist/vtxo-pool.js')
const { KeyedMutex, reservations, rebuildReservations, maxLiabilityForTier, pickEscrowVtxo } = pool

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('KeyedMutex', () => {
  it('serializes sections sharing a key (no interleave)', async () => {
    const km = new KeyedMutex()
    const order: string[] = []
    const a = km.runExclusive('g1', async () => { order.push('a-start'); await sleep(40); order.push('a-end') })
    const b = km.runExclusive('g1', async () => { order.push('b-start'); await sleep(0); order.push('b-end') })
    await Promise.all([a, b])
    // b must wait for a to fully finish before starting.
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('runs different keys concurrently', async () => {
    const km = new KeyedMutex()
    const order: string[] = []
    const g1 = km.runExclusive('g1', async () => { order.push('1-start'); await sleep(40); order.push('1-end') })
    const g2 = km.runExclusive('g2', async () => { order.push('2-start'); await sleep(10); order.push('2-end') })
    await Promise.all([g1, g2])
    // g2 (different key) starts immediately and finishes first despite g1 holding its own lock.
    expect(order).toEqual(['1-start', '2-start', '2-end', '1-end'])
  })

  it('holds exactly one entry while contended, then drops it (bounded map)', async () => {
    const km = new KeyedMutex()
    expect(km.size).toBe(0)
    let observed = -1
    const p1 = km.runExclusive('x', async () => { await sleep(30); observed = km.size })
    const p2 = km.runExclusive('x', async () => { /* queued behind p1 */ })
    await Promise.all([p1, p2])
    expect(observed).toBe(1) // single shared entry while both in flight
    expect(km.size).toBe(0)  // cleaned up once idle
  })

  it('cleans up across many distinct keys', async () => {
    const km = new KeyedMutex()
    await Promise.all(Array.from({ length: 200 }, (_, i) => km.runExclusive(`k${i}`, async () => { await sleep(1) })))
    expect(km.size).toBe(0)
  })

  it('mutual exclusion holds under a burst on one key (no lost updates)', async () => {
    const km = new KeyedMutex()
    let counter = 0
    // Each task does a read-modify-write across an await — without the lock
    // these would race and lose updates.
    await Promise.all(Array.from({ length: 50 }, () =>
      km.runExclusive('shared', async () => {
        const v = counter
        await sleep(0)
        counter = v + 1
      }),
    ))
    expect(counter).toBe(50)
  })

  it('releases the lock even when the body throws', async () => {
    const km = new KeyedMutex()
    await expect(km.runExclusive('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(km.size).toBe(0) // entry dropped despite the throw
    // The key is reusable afterwards.
    const ok = await km.runExclusive('k', async () => 'ok')
    expect(ok).toBe('ok')
  })
})

describe('rebuildReservations', () => {
  const fakeDeps = (rows: any[]) => ({ repos: { games: { list: async () => rows } } }) as any

  it('restores trustless (object) + legacy (array) liability; skips malformed/null', async () => {
    const rows = [
      // Trustless per-party: TrustlessState object → liability = tier, 0 outpoints.
      { id: 'tl-1', tier: 1000, house_vtxos_json: JSON.stringify({ finalExpiration: 1, setupExpiration: 1, houseEscrow: { txid: 'aa', vout: 0, value: 1000 } }) },
      // Legacy setup/final: array of outpoints → reserve outpoints + maxLiabilityForTier.
      { id: 'lg-1', tier: 5000, house_vtxos_json: JSON.stringify(['deadbeef:0', 'deadbeef:1']) },
      // Malformed JSON → skipped.
      { id: 'bad-1', tier: 1000, house_vtxos_json: '{not json' },
      // Null column → skipped.
      { id: 'nul-1', tier: 1000, house_vtxos_json: null },
      // Empty legacy array → nothing to protect → skipped.
      { id: 'empty-1', tier: 1000, house_vtxos_json: '[]' },
    ]
    const before = { liability: reservations.totalLiability(), games: reservations.activeGames() }
    const restored = await rebuildReservations(fakeDeps(rows))
    try {
      expect(restored).toBe(2) // tl-1 + lg-1 only
      expect(reservations.activeGames() - before.games).toBe(2)
      expect(reservations.has('tl-1')).toBe(true)
      expect(reservations.has('lg-1')).toBe(true)
      expect(reservations.has('bad-1')).toBe(false)
      expect(reservations.has('nul-1')).toBe(false)
      expect(reservations.has('empty-1')).toBe(false)
      // Trustless liability = tier (1000); legacy = maxLiabilityForTier(5000).
      expect(reservations.totalLiability() - before.liability).toBe(1000 + maxLiabilityForTier(5000))
      // Legacy outpoints are re-protected; trustless reserves none (already spent into escrow).
      expect(reservations.isReserved('deadbeef:0')).toBe(true)
      expect(reservations.isReserved('deadbeef:1')).toBe(true)
      expect(reservations.isReserved('aa:0')).toBe(false)
    } finally {
      reservations.release('tl-1'); reservations.release('lg-1')
    }
  })

  it('reserves the escrowed HOUSE STAKE for variable-odds games, not the player tier', async () => {
    // Variable-odds: the house escrows a multiple of the player tier. The
    // escrowed amount lives in houseEscrow.value (6000), well above tier (1000).
    // rebuildReservations must restore 6000 of liability, or concurrent
    // post-restart plays would under-count and over-commit the house.
    const rows = [
      { id: 'tl-var', tier: 1000, house_vtxos_json: JSON.stringify({ finalExpiration: 1, setupExpiration: 1, houseEscrow: { txid: 'bb', vout: 0, value: 6000 } }) },
    ]
    const before = reservations.totalLiability()
    const restored = await rebuildReservations(fakeDeps(rows))
    try {
      expect(restored).toBe(1)
      expect(reservations.totalLiability() - before).toBe(6000) // houseStake, not tier
    } finally {
      reservations.release('tl-var')
    }
  })

  it('falls back to tier when an older row has no houseEscrow.value', async () => {
    const rows = [
      { id: 'tl-old', tier: 1500, house_vtxos_json: JSON.stringify({ finalExpiration: 1, setupExpiration: 1, houseEscrow: { txid: 'cc', vout: 0 } }) },
    ]
    const before = reservations.totalLiability()
    await rebuildReservations(fakeDeps(rows))
    try {
      expect(reservations.totalLiability() - before).toBe(1500) // fallback = tier
    } finally {
      reservations.release('tl-old')
    }
  })
})

describe('pickEscrowVtxo (dust-safe house VTXO selection)', () => {
  const v = (value: number) => ({ value })
  const DUST = 546

  it('picks the smallest VTXO that covers the amount with dust-safe change', () => {
    expect(pickEscrowVtxo([v(50000), v(2000), v(10000)], 1000, DUST)).toEqual(v(2000))
  })

  it('allows an exact-match VTXO (zero change)', () => {
    expect(pickEscrowVtxo([v(5000), v(1000)], 1000, DUST)).toEqual(v(1000))
  })

  it('skips VTXOs that would leave sub-dust change', () => {
    // 1300 − 1000 = 300 < dust → skip; 5000 − 1000 = 4000 is fine.
    expect(pickEscrowVtxo([v(1300), v(5000)], 1000, DUST)).toEqual(v(5000))
  })

  it('returns undefined when nothing covers the amount dust-safely', () => {
    // 900 too small; 1300 leaves sub-dust change.
    expect(pickEscrowVtxo([v(900), v(1300)], 1000, DUST)).toBeUndefined()
  })

  it('returns undefined for an empty candidate set', () => {
    expect(pickEscrowVtxo([], 1000, DUST)).toBeUndefined()
  })
})

export {}
