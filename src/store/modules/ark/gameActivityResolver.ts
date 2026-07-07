/**
 * Coinflip's activity resolver for the SDK's `wallet.getActivityHistory()`.
 *
 * The SDK (arkade-os/ts-sdk activity feature) owns the generic tx→activity
 * grouping; a resolver only supplies domain knowledge — here, "these txids
 * belong to this game" — so a dice game's co-fund + settle collapse into one
 * "Dice game" row instead of scattered Sent/Received entries. Registered on
 * `wallet.activity` at connect (see store/modules/ark/ark.ts); kept in its own
 * module so the game-tagging logic is unit-testable without the Vuex store.
 */
import type { ActivityResolver, ArkTransaction } from '@arkade-os/sdk'

/** A coinflip game reduced to its display data + every on-chain txid it touched. */
export interface CoinflipGameRecord {
  id: string
  tier: number
  winner: 'player' | 'house' | null
  txids: string[]
}

/** Read stored game records (id + txids) from localStorage's `gameHistory`. */
export function loadGameRecords(): CoinflipGameRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem('gameHistory') || '[]')
    return (Array.isArray(raw) ? raw : [])
      .filter((g) => g?.id && Array.isArray(g.txids) && g.txids.length)
      .map((g) => ({
        id: String(g.id),
        tier: Number(g.tier) || 0,
        winner: g.winner ?? null,
        txids: g.txids as string[],
      }))
  } catch {
    return []
  }
}

/** Best-effort txid for an ArkTransaction — arkTxid first, then commitment, then boarding. */
export function txidOf(tx: ArkTransaction): string {
  return tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid
}

/**
 * Activity resolver that tags a dice game's transactions as one "Dice game"
 * row. `prepare()` indexes the game records by txid so `resolve()` is a pure
 * O(1) lookup. `loadGames` is injectable for testing; it defaults to reading
 * the persisted `gameHistory`. The namespaced id (`coinflip:games`) keeps it
 * from clobbering the SDK's built-in resolvers.
 */
export function gameActivityResolver(
  loadGames: () => CoinflipGameRecord[] = loadGameRecords,
): ActivityResolver {
  let byTxid = new Map<string, CoinflipGameRecord>()
  return {
    id: 'coinflip:games',
    async prepare() {
      const next = new Map<string, CoinflipGameRecord>()
      for (const g of loadGames()) {
        for (const t of g.txids) {
          if (t) next.set(t, g)
        }
      }
      byTxid = next
    },
    resolve(tx) {
      const g = byTxid.get(txidOf(tx))
      if (!g) return undefined
      return [
        {
          groupId: `game:${g.id}`,
          label: 'Dice game',
          kind: 'game',
          metadata: { gameId: g.id, tier: g.tier, winner: g.winner },
        },
      ]
    },
  }
}
