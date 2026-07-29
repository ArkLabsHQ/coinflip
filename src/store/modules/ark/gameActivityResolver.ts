/**
 * Coinflip's activity resolver for the SDK's `wallet.getActivityHistory()`.
 *
 * The SDK (arkade-os/ts-sdk activity feature) owns the generic tx→activity
 * grouping; a resolver only supplies domain knowledge — here, "these txids
 * belong to this game, which was a Rocket game at 12% for 1,000 sats" — so a
 * game's co-fund + settle collapse into one labelled row instead of scattered
 * Sent/Received entries. Registered on
 * `wallet.activity` at connect (see store/modules/ark/ark.ts); kept in its own
 * module so the game-tagging logic is unit-testable without the Vuex store.
 */
import type { ActivityResolver, ArkTransaction } from '@arkade-os/sdk'
import { formatWinPct } from '@/utils/rungSnap'

/** The odds a game was played at — the skin ladder rung, as the server saw it. */
export interface GameOdds {
  n: number
  lo: number
  target: number
}

/** A coinflip game reduced to its display data + every on-chain txid it touched. */
export interface CoinflipGameRecord {
  id: string
  tier: number
  winner: 'player' | 'house' | null
  txids: string[]
  /** Which skin was played. Null on games recorded before skins were stored. */
  skinId: string | null
  skinName: string | null
  /** Null for pre-slider games, and for any record missing a full odds triple. */
  odds: GameOdds | null
}

/** Narrow a stored odds blob to a usable triple; anything partial is dropped. */
function asOdds(v: unknown): GameOdds | null {
  const o = v as Partial<GameOdds> | null | undefined
  if (!o) return null
  const [n, lo, target] = [Number(o.n), Number(o.lo), Number(o.target)]
  if (![n, lo, target].every(Number.isFinite)) return null
  // A rung the win-chance formula can't read (zero-sided die, empty or
  // inverted window) is worse than showing no odds at all.
  if (n <= 0 || target <= lo) return null
  return { n, lo, target }
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
        skinId: g.skinId ? String(g.skinId) : null,
        skinName: g.skinName ? String(g.skinName) : null,
        odds: asOdds(g.odds),
      }))
  } catch {
    return []
  }
}

// Re-exported from the shared ladder math. It used to be duplicated here to
// keep this module Vue-free; `@/utils/rungSnap` is Vue-free too, so the copy
// is gone and the formatting rule now lives in exactly one place.
export { formatWinPct }

/** Row label for a game — the skin actually played, e.g. "Rocket game". */
export function gameLabel(g: CoinflipGameRecord): string {
  // Games recorded before the skin was stored can't be attributed to one, and
  // guessing (they were not all dice) would be worse than staying generic.
  return g.skinName ? `${g.skinName} game` : 'Coinflip game'
}

/**
 * One-line summary of what was actually bet, e.g. "1,000 sats · 49.5% win · won".
 * Each part is dropped when unknown, so an old record degrades to just its stake.
 */
export function gameDetail(g: CoinflipGameRecord): string {
  const parts: string[] = []
  if (g.tier > 0) parts.push(`${g.tier.toLocaleString()} sats`)
  if (g.odds) parts.push(`${formatWinPct(g.odds)} win`)
  if (g.winner) parts.push(g.winner === 'player' ? 'won' : 'lost')
  return parts.join(' · ')
}

/** Best-effort txid for an ArkTransaction — arkTxid first, then commitment, then boarding. */
export function txidOf(tx: ArkTransaction): string {
  return tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid
}

/**
 * Activity resolver that tags a game's transactions as one row, labelled with
 * the skin played. `prepare()` indexes the game records by txid so `resolve()` is a pure
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
          label: gameLabel(g),
          kind: 'game',
          metadata: {
            gameId: g.id,
            tier: g.tier,
            winner: g.winner,
            skinId: g.skinId,
            odds: g.odds,
            // Pre-formatted so the drawer can render the params without
            // re-deriving win-chance from the raw ladder rung.
            detail: gameDetail(g),
          },
        },
      ]
    },
  }
}
