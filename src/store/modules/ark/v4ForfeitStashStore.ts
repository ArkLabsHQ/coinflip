/**
 * IndexedDB-backed store for v0.4 joint-pot forfeit stashes.
 *
 * Kept SEPARATE from the v3 stash store (`stashStore.ts`) — v4 records are a
 * different shape (covenant params + pot outpoint, no PSBTs) and isolating them
 * means the v4 recovery never has to touch v3's working money-handling path.
 * Reuses the same IDB database + adapter primitive as v3, under its own key.
 *
 * Layout: database `coinflip-stashes` (shared with v3), key
 * `trustless-v4-forfeits` holding the whole list as a JSON array — same
 * single-blob shape as the v3 store so the reducer ops stay trivial.
 *
 * No pruning: a v4 forfeit is valid until the pot is actually spent, so age
 * alone can't safely evict it (a past-CLTV-but-unclaimed stash is still a live
 * recovery). Entries are cleared explicitly on settle/claim success; the
 * auto-claim poll GCs any whose pot turns out already-spent.
 */

import { IndexedDBStorageAdapter } from '@arkade-os/sdk/adapters/indexedDB'
import type { StashedV4Forfeit } from './v4ForfeitStash'

const DB_NAME = 'coinflip-stashes'
const V4_STASH_KEY = 'trustless-v4-forfeits'

let adapter: IndexedDBStorageAdapter | null = null

function getAdapter(): IndexedDBStorageAdapter {
  if (!adapter) adapter = new IndexedDBStorageAdapter(DB_NAME)
  return adapter
}

/** Read every v4 forfeit stash. Tolerates a missing/corrupt blob (→ []). */
export async function loadV4Forfeits(): Promise<StashedV4Forfeit[]> {
  const raw = await getAdapter().getItem(V4_STASH_KEY)
  try {
    const parsed = JSON.parse(raw || '[]')
    if (Array.isArray(parsed)) return parsed
    // A non-array hides EVERY v4 recovery record (no auto-claim, no UI). Surface
    // it loudly rather than masquerading as "no stalled bets".
    console.error('[v4] forfeit stash is not an array — recovery records hidden:', raw)
    return []
  } catch (e) {
    // A corrupt blob hides ALL recovery records. Log loudly and do NOT overwrite
    // the raw value, so a funded pot's covenant params remain recoverable.
    console.error('[v4] forfeit stash blob is corrupt; recovery records hidden until repaired:', e)
    return []
  }
}

/** Overwrite the v4 forfeit stash set. */
export async function saveV4Forfeits(list: StashedV4Forfeit[]): Promise<void> {
  await getAdapter().setItem(V4_STASH_KEY, JSON.stringify(list))
}

/** Add or replace a v4 forfeit stash by gameId. */
export async function putV4Forfeit(r: StashedV4Forfeit): Promise<void> {
  const list = await loadV4Forfeits()
  await saveV4Forfeits([...list.filter((x) => x.gameId !== r.gameId), r])
}

/** Remove the v4 forfeit stash for a gameId, if present. */
export async function deleteV4Forfeit(gameId: string): Promise<void> {
  const list = await loadV4Forfeits()
  await saveV4Forfeits(list.filter((x) => x.gameId !== gameId))
}
