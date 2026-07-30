import { describe, it, expect, vi } from 'vitest'
import { createTxTimeCache, isLoneTxTimeRead, TX_TIME_BATCH_SIZE } from './txTimeCache'

/* eslint-disable @typescript-eslint/no-explicit-any */

const vtxo = (txid: string, ms = 1_700_000_000_000) => ({
  txid, vout: 0, value: 1000, createdAt: new Date(ms),
})

/** Records every getVtxos call so we can assert on request COUNT and shape. */
function fakeProvider(known: string[] = []) {
  const calls: any[] = []
  const provider: any = {
    getVtxos: vi.fn(async (opts: any) => {
      calls.push(opts)
      const ops = opts?.outpoints ?? []
      return { vtxos: ops.filter((o: any) => known.includes(o.txid)).map((o: any) => vtxo(o.txid)) }
    }),
    // A second method, to prove the proxy passes non-getVtxos through.
    getVtxoTree: vi.fn(async () => ({ vtxoTree: [] })),
    serverUrl: 'http://indexer.test',
  }
  return { provider, calls }
}

describe('isLoneTxTimeRead', () => {
  it('recognises exactly the getTxCreatedAt read', () => {
    expect(isLoneTxTimeRead({ outpoints: [{ txid: 'a'.repeat(64), vout: 0 }] })).toBe(true)
  })

  // Strictness is the whole safety argument: anything else must pass through
  // rather than be answered from a cache built for a different question.
  it.each([
    ['two outpoints', { outpoints: [{ txid: 'a', vout: 0 }, { txid: 'b', vout: 0 }] }],
    ['vout != 0', { outpoints: [{ txid: 'a', vout: 1 }] }],
    ['an extra filter key', { outpoints: [{ txid: 'a', vout: 0 }], pendingOnly: true }],
    ['a scripts query', { scripts: ['deadbeef'] }],
    ['paging', { outpoints: [{ txid: 'a', vout: 0 }], 'page.index': 0 }],
    ['empty outpoints', { outpoints: [] }],
    ['no opts', undefined],
    ['null', null],
    ['non-object', 'outpoints'],
  ])('does not claim %s', (_label, opts) => {
    expect(isLoneTxTimeRead(opts)).toBe(false)
  })
})

describe('createTxTimeCache', () => {
  it('batches priming into one request instead of one per txid', async () => {
    const txids = Array.from({ length: 12 }, (_v, i) => String(i).padStart(64, '0'))
    const { provider, calls } = fakeProvider(txids)
    const cache = createTxTimeCache()

    await cache.prime(txids, provider)

    expect(calls).toHaveLength(1)                       // not 12
    expect(calls[0].outpoints).toHaveLength(12)
    expect(cache.stats()).toMatchObject({ batches: 1, cached: 12 })
  })

  it('chunks at the SDK\'s own batch size', async () => {
    const n = TX_TIME_BATCH_SIZE * 2 + 5
    const txids = Array.from({ length: n }, (_v, i) => String(i).padStart(64, '0'))
    const { provider, calls } = fakeProvider(txids)
    const cache = createTxTimeCache()

    await cache.prime(txids, provider)

    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.outpoints.length)).toEqual([TX_TIME_BATCH_SIZE, TX_TIME_BATCH_SIZE, 5])
  })

  it('dedupes, drops blanks, and skips already-cached txids', async () => {
    const a = 'a'.repeat(64)
    const { provider, calls } = fakeProvider([a])
    const cache = createTxTimeCache()

    await cache.prime([a, a, undefined, null, '', a], provider)
    expect(calls[0].outpoints).toHaveLength(1)

    // A second prime for the same txid must not re-request it.
    await cache.prime([a], provider)
    expect(calls).toHaveLength(1)
  })

  // The point of the whole module.
  it('serves the primed single-outpoint read without touching the network', async () => {
    const a = 'a'.repeat(64)
    const { provider } = fakeProvider([a])
    const cache = createTxTimeCache()
    await cache.prime([a], provider)
    const wrapped = cache.wrap(provider)
    ;(provider.getVtxos as any).mockClear()

    const res = await wrapped.getVtxos({ outpoints: [{ txid: a, vout: 0 }] } as never)

    expect(provider.getVtxos).not.toHaveBeenCalled()
    expect((res.vtxos[0] as any).txid).toBe(a)
    // The real object from the batch, so other fields are truthful too.
    expect((res.vtxos[0] as any).value).toBe(1000)
    expect(cache.stats().hits).toBe(1)
  })

  it('falls through for an unprimed txid rather than inventing a result', async () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    const { provider } = fakeProvider([a, b])
    const cache = createTxTimeCache()
    await cache.prime([a], provider)
    const wrapped = cache.wrap(provider)
    ;(provider.getVtxos as any).mockClear()

    await wrapped.getVtxos({ outpoints: [{ txid: b, vout: 0 }] } as never)

    expect(provider.getVtxos).toHaveBeenCalledTimes(1)
    expect(cache.stats().passthrough).toBe(1)
  })

  it('never answers a query shape it was not built for', async () => {
    const a = 'a'.repeat(64)
    const { provider } = fakeProvider([a])
    const cache = createTxTimeCache()
    await cache.prime([a], provider)
    const wrapped = cache.wrap(provider)
    ;(provider.getVtxos as any).mockClear()

    // Same txid, but a scripts query and a multi-outpoint query.
    await wrapped.getVtxos({ scripts: ['deadbeef'] } as never)
    await wrapped.getVtxos({ outpoints: [{ txid: a, vout: 0 }, { txid: a, vout: 1 }] } as never)

    expect(provider.getVtxos).toHaveBeenCalledTimes(2)
    expect(cache.stats().hits).toBe(0)
  })

  it('passes non-getVtxos methods through to the real provider', async () => {
    const { provider } = fakeProvider([])
    const wrapped = cache_wrap(provider)
    await (wrapped as any).getVtxoTree({ txid: 'x', vout: 0 })
    expect(provider.getVtxoTree).toHaveBeenCalledTimes(1)
    expect((wrapped as any).serverUrl).toBe('http://indexer.test')
  })

  it('a failed prime degrades to pass-through instead of breaking history', async () => {
    const a = 'a'.repeat(64)
    const { provider } = fakeProvider([a])
    ;(provider.getVtxos as any).mockRejectedValueOnce(new Error('indexer down'))
    const cache = createTxTimeCache()

    await expect(cache.prime([a], provider)).resolves.toBeUndefined()
    expect(cache.stats().cached).toBe(0)

    const wrapped = cache.wrap(provider)
    await wrapped.getVtxos({ outpoints: [{ txid: a, vout: 0 }] } as never)
    expect(cache.stats().passthrough).toBe(1)
  })

  it('clear() releases the batch so a later load re-primes', async () => {
    const a = 'a'.repeat(64)
    const { provider } = fakeProvider([a])
    const cache = createTxTimeCache()
    await cache.prime([a], provider)
    expect(cache.stats().cached).toBe(1)
    cache.clear()
    expect(cache.stats().cached).toBe(0)
  })
})

/** Helper for the pass-through test, which needs a cache with no priming. */
function cache_wrap(provider: unknown) {
  return createTxTimeCache().wrap(provider as never)
}
