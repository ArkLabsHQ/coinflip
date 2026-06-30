/**
 * Deterministic unit tests for the admin dashboard's cached / collapsed /
 * timeout-bounded wallet reads — no regtest. Imports the BUILT server (dist).
 *
 * Guards the fix for the admin "stuck loading balances" hang: each SDK wallet
 * read (getBalance / getVtxos / getTransactionHistory) forces a FULL re-sync of
 * the house's entire VTXO history (see HouseVtxoCache in vtxo-pool.ts), so the
 * dashboard's uncached + uncollapsed polling stacked the re-syncs faster than
 * they drained and the requests piled up forever. `collapsedTtlRead` collapses
 * concurrent polls onto one fetch, serves a short-TTL snapshot, and bounds each
 * fetch with `timeoutReject` so a genuinely stalled sync rejects instead of
 * hanging the request.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const m = require('arkade-coinflip-server/dist/admin/cached-wallet-reads.js')
const { collapsedTtlRead, timeoutReject } = m

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('timeoutReject', () => {
  it('resolves with the value when it settles before the timeout', async () => {
    await expect(timeoutReject(Promise.resolve('ok'), 1000, 'x')).resolves.toBe('ok')
  })

  it('rejects with a labelled timeout when the promise is too slow', async () => {
    await expect(timeoutReject(sleep(1000), 30, 'getBalance')).rejects.toThrow(/getBalance timed out after 30ms/)
  })

  it('propagates the underlying rejection unchanged', async () => {
    await expect(timeoutReject(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
  })
})

describe('collapsedTtlRead', () => {
  it('collapses concurrent calls onto a single fetch (no pile-up)', async () => {
    let calls = 0
    const read = collapsedTtlRead(async () => { calls++; await sleep(20); return calls }, 1000, 5000, 'x')
    const [a, b, c] = await Promise.all([read(), read(), read()])
    expect(calls).toBe(1) // one underlying re-sync for three concurrent polls
    expect([a, b, c]).toEqual([1, 1, 1])
  })

  it('serves a snapshot younger than the TTL without re-fetching', async () => {
    let calls = 0
    const read = collapsedTtlRead(async () => { calls++; return calls }, 1000, 5000, 'x')
    expect(await read()).toBe(1)
    expect(await read()).toBe(1) // cached
    expect(calls).toBe(1)
  })

  it('re-fetches once the TTL expires', async () => {
    let calls = 0
    const read = collapsedTtlRead(async () => { calls++; return calls }, 30, 5000, 'x')
    expect(await read()).toBe(1)
    await sleep(50) // TTL=30ms → snapshot expired
    expect(await read()).toBe(2)
  })

  it('does not cache a timed-out fetch — the next call retries live', async () => {
    let calls = 0
    const read = collapsedTtlRead(
      async () => { calls++; if (calls === 1) await sleep(1000); return calls },
      1000,
      40,
      'x',
    )
    await expect(read()).rejects.toThrow(/timed out/) // first fetch stalls past the 40ms bound
    expect(await read()).toBe(2) // not cached → retries, succeeds
  })

  it('does not cache a rejected fetch', async () => {
    let calls = 0
    const read = collapsedTtlRead(
      async () => { calls++; if (calls === 1) throw new Error('boom'); return calls },
      1000,
      5000,
      'x',
    )
    await expect(read()).rejects.toThrow('boom')
    expect(await read()).toBe(2)
  })
})

export {}
