/**
 * Collapse the Activity page's per-transaction indexer lookups into batches.
 *
 * MEASURED on mutinynet (HAR, 2026-07-30): opening Activity issued **379**
 * `/v1/indexer/vtxos` calls — 92% of all page traffic — of which **348 carried
 * exactly one outpoint**, covering only **123 distinct** txids. Median 181ms
 * each, 23.9 seconds of sequential network time in one burst.
 *
 * The cause is in the SDK, not here. `ReadonlyWallet.getTransactionHistory()`
 * builds
 *
 *     const getTxCreatedAt = (txid) =>
 *       this.indexerProvider.getVtxos({ outpoints: [{ txid, vout: 0 }] })
 *
 * and `buildTransactionHistory` awaits it **inside** its `for (const vtxo of
 * …)` loop — once per VTXO, not per unique txid, which is where the ~2.8x
 * duplication comes from. Nothing runs concurrently, so coalescing in-flight
 * requests cannot help; only knowing the txids up front can.
 *
 * Notably the SDK already contains the right implementation — the
 * service-worker `WalletMessageHandler` collects `uncachedTxids` and batches
 * them at `BATCH_SIZE = 100` — it just was never ported to the plain `Wallet`
 * path we use. This module is the local stand-in until that lands upstream.
 *
 * Why this matters beyond latency: `refreshHistory` bounds the load with
 * `TIMEOUTS.api` (60s). At 23.9s for 123 txids the cost grows linearly with
 * games played, so a player with roughly 2.5x this history exceeds the timeout
 * and Activity fails outright (`activityStatus: 'error'`) — permanently, and
 * worsening. Heaviest players break first.
 *
 * Approach: `prime()` batch-fetches the timestamps we know will be asked for,
 * and `wrap()` decorates the provider so those single-outpoint reads are served
 * from that batch. 348 sequential calls become ~2.
 */

import type { IndexerProvider } from '@arkade-os/sdk'

/** Matches the SDK's own batch size in WalletMessageHandler. */
export const TX_TIME_BATCH_SIZE = 100

/** Just the shape this cache stores and replays. */
type CachedVtxo = { txid: string; createdAt: Date } & Record<string, unknown>

export interface TxTimeCacheStats {
  /** Single-outpoint reads served from the batch. */
  hits: number
  /** Calls handed straight to the real provider. */
  passthrough: number
  /** Batched requests `prime()` issued. */
  batches: number
  /** Distinct txids currently cached. */
  cached: number
}

export interface TxTimeCache {
  /**
   * Batch-fetch and cache the vtxo behind each txid at vout 0. Unknown or
   * duplicate txids are skipped; a failing batch is swallowed so history still
   * loads (those txids simply fall through to the SDK's own per-txid reads).
   */
  prime(txids: Array<string | undefined | null>, provider: IndexerProvider): Promise<void>
  /** Decorate a provider so primed single-outpoint reads skip the network. */
  wrap(provider: IndexerProvider): IndexerProvider
  clear(): void
  stats(): TxTimeCacheStats
}

/**
 * True when `opts` is exactly the lone-outpoint-at-vout-0 read that
 * `getTxCreatedAt` performs, and nothing else.
 *
 * Deliberately strict: ANY other key (scripts, pendingOnly, paging, …) means a
 * different query whose semantics we must not fake, so it passes through. Being
 * conservative here is what keeps this safe to sit in front of every read.
 */
export function isLoneTxTimeRead(opts: unknown): opts is { outpoints: [{ txid: string; vout: number }] } {
  if (!opts || typeof opts !== 'object') return false
  const keys = Object.keys(opts as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== 'outpoints') return false
  const ops = (opts as { outpoints?: unknown }).outpoints
  if (!Array.isArray(ops) || ops.length !== 1) return false
  const o = ops[0] as { txid?: unknown; vout?: unknown }
  return typeof o?.txid === 'string' && o.vout === 0
}

export function createTxTimeCache(): TxTimeCache {
  const byTxid = new Map<string, CachedVtxo>()
  let hits = 0
  let passthrough = 0
  let batches = 0

  return {
    async prime(txids, provider) {
      const wanted = [...new Set(txids.filter((t): t is string => typeof t === 'string' && t.length > 0))]
        .filter((t) => !byTxid.has(t))
      for (let i = 0; i < wanted.length; i += TX_TIME_BATCH_SIZE) {
        const chunk = wanted.slice(i, i + TX_TIME_BATCH_SIZE)
        try {
          batches++
          const res = await provider.getVtxos({ outpoints: chunk.map((txid) => ({ txid, vout: 0 })) })
          for (const v of res.vtxos as unknown as CachedVtxo[]) {
            if (v?.txid && v.createdAt) byTxid.set(v.txid, v)
          }
        } catch {
          // Priming is an optimisation, never a requirement. A failed batch
          // leaves those txids uncached and the SDK reads them individually —
          // slower, still correct.
        }
      }
    },

    wrap(provider) {
      // A Proxy rather than a hand-written decorator: IndexerProvider has many
      // methods and gains more over time; enumerating them would break silently
      // on the next SDK addition. Everything except getVtxos passes through
      // bound to the real provider.
      return new Proxy(provider, {
        get(target, prop, receiver) {
          if (prop !== 'getVtxos') {
            const v = Reflect.get(target, prop, receiver)
            return typeof v === 'function' ? v.bind(target) : v
          }
          return (opts?: unknown) => {
            if (isLoneTxTimeRead(opts)) {
              const cached = byTxid.get(opts.outpoints[0].txid)
              if (cached) {
                hits++
                // The real object the batch returned, not a synthetic stub, so
                // a caller reading any other field still gets the truth.
                return Promise.resolve({ vtxos: [cached] })
              }
            }
            passthrough++
            return (target as IndexerProvider).getVtxos(opts as never)
          }
        },
      }) as IndexerProvider
    },

    clear() {
      byTxid.clear()
    },

    stats() {
      return { hits, passthrough, batches, cached: byTxid.size }
    },
  }
}
