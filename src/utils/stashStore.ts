/**
 * IndexedDB-backed store for trustless stash data (refund + forfeit
 * PSBTs the client holds locally per active game).
 *
 * Why IDB and not localStorage:
 *   - Each entry is 4–8 KB (two base64 PSBTs + their checkpoint sets).
 *     localStorage caps at ~5 MB total per origin; under a chain-state
 *     drift + failed-auto-claim scenario, stashes accumulate fast and
 *     the cap is reachable.
 *   - IDB is async, doesn't block the main thread on read/write, and
 *     gives us hundreds of MB of headroom.
 *
 * Why reuse the SDK's adapter:
 *   - `@arkade-os/sdk` already opens an IndexedDB connection for the
 *     wallet's own state. Sharing the adapter primitive keeps the IDB
 *     surface a single API instead of one per package.
 *   - `IndexedDBStorageAdapter` is a promise-flavored KV blob store —
 *     getItem / setItem / removeItem. The right shape for our
 *     single-JSON-blob payload.
 *
 * Storage layout:
 *   - Database: `coinflip-stashes` (separate from the SDK's
 *     `arkade-service-worker` DB; clearing wallet data shouldn't blow
 *     away stashes and vice versa).
 *   - Single key `trustless-refunds` containing the entire stash list
 *     as a JSON-encoded array. Matches the localStorage shape so the
 *     existing reducer ops (filter / push / patch) stay the same.
 *
 * Migration policy (chosen for v1):
 *   - On first load after this lands, drop any existing localStorage
 *     `trustlessRefunds` key WITHOUT migrating. The user accepted the
 *     trade-off: anyone with active stashes loses them. Acceptable for
 *     the demo's user surface today.
 */

import { IndexedDBStorageAdapter } from '@arkade-os/sdk/adapters/indexedDB'
import type { StashedRefund } from '@/store/modules/ark/ark'

const DB_NAME = 'coinflip-stashes'
const STASH_KEY = 'trustless-refunds'
const LEGACY_LOCALSTORAGE_KEY = 'trustlessRefunds'

let adapter: IndexedDBStorageAdapter | null = null

function getAdapter(): IndexedDBStorageAdapter {
  if (!adapter) adapter = new IndexedDBStorageAdapter(DB_NAME)
  return adapter
}

let legacyWipeDone = false
/**
 * Wipe the localStorage entry that the pre-IDB version wrote to. Idempotent
 * after the first call. Runs lazily on first load so we don't touch
 * localStorage during module init.
 */
function wipeLegacyLocalStorageOnce(): void {
  if (legacyWipeDone) return
  legacyWipeDone = true
  try { localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY) } catch { /* private mode etc */ }
}

/**
 * Decide which stashes are safe to drop on load.
 *
 * This is a UX policy call — drop too aggressively and a user who
 * re-opened the tab after a long break loses an auto-claim they might
 * have wanted; drop too leniently and stashes from failed auto-claims
 * accumulate forever (the console spam in this session is a live
 * example of the latter).
 *
 * Knobs to consider when writing the body:
 *   - `finalExpiration` (unix seconds) is the hard limit. Past this
 *     plus a grace window, the leaves are no longer spendable via the
 *     server-cooperative paths. Only the unilateral CSV exits remain,
 *     which the client doesn't auto-fire today.
 *   - `revealed === true` stashes (forfeit eligible) are higher-value
 *     to keep than refund-only stashes (player gets back the same
 *     money via on-chain settlement either way).
 *   - A max-count cap (e.g. 100 most-recent) is belt-and-suspenders
 *     against catastrophic growth even if the time filter misses an
 *     edge case.
 *
 * Example policies (pick one and write it):
 *   - "drop anything past finalExpiration + 7 days, AND cap at 100
 *      most-recent by createdAt"
 *   - "keep only revealed stashes past expiry; drop unrevealed past
 *      expiry; no count cap"
 *   - "no time filter, just a hard cap at N entries"
 */
export function pruneOnLoad(stashes: StashedRefund[], nowSec: number): StashedRefund[] {
  void nowSec // unused until policy is written; suppress eslint-no-unused-vars
  // TODO(user): replace with the eviction policy of choice. The default
  // until then is "no prune" — every stash returned as-is, growth bounded
  // only by IndexedDB quota (hundreds of MB). Functional but wasteful.
  return stashes
}

/**
 * Read every stash from IDB, run the eviction policy, persist back if
 * anything was dropped. The returned list is what the caller should
 * treat as the canonical stash set going forward.
 */
export async function loadStashes(): Promise<StashedRefund[]> {
  wipeLegacyLocalStorageOnce()
  const raw = await getAdapter().getItem(STASH_KEY)
  let list: StashedRefund[]
  try {
    const parsed = JSON.parse(raw || '[]')
    list = Array.isArray(parsed) ? parsed : []
  } catch {
    list = []
  }
  const nowSec = Math.floor(Date.now() / 1000)
  const pruned = pruneOnLoad(list, nowSec)
  if (pruned.length !== list.length) {
    await saveStashes(pruned)
  }
  return pruned
}

/** Overwrite the stash set. Caller owns the merge semantics. */
export async function saveStashes(list: StashedRefund[]): Promise<void> {
  await getAdapter().setItem(STASH_KEY, JSON.stringify(list))
}

/** Add or replace a stash entry by gameId. */
export async function putStash(r: StashedRefund): Promise<void> {
  const list = await loadStashes()
  await saveStashes([...list.filter((x) => x.gameId !== r.gameId), r])
}

/** Remove the stash entry for a gameId, if present. */
export async function deleteStash(gameId: string): Promise<void> {
  const list = await loadStashes()
  await saveStashes(list.filter((x) => x.gameId !== gameId))
}

/**
 * Merge `patch` fields into an existing stash entry. No-op if the entry
 * isn't found (game probably already cleared).
 */
export async function patchStash(gameId: string, patch: Partial<StashedRefund>): Promise<void> {
  const list = await loadStashes()
  const idx = list.findIndex((x) => x.gameId === gameId)
  if (idx === -1) return
  list[idx] = { ...list[idx], ...patch }
  await saveStashes(list)
}
