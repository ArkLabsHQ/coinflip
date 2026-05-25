/**
 * House VTXO concurrency management.
 *
 * The house serves many players at once. Two concerns arise:
 *
 *   1. Reservation — `handlePlay` bakes specific house VTXOs into a game's
 *      signed setup/final transactions (the trustless fallback). Two
 *      concurrent games must NOT bake in the same VTXO, or the second
 *      player's fallback tx would reference an already-spent input.
 *
 *   2. Liability — the per-request balance check doesn't account for
 *      games already in flight. Without it, the house can accept more
 *      concurrent games than it can pay out (e.g. balance 100k, ten 50k
 *      games). We track the worst-case payout obligation of in-flight
 *      games and reject new plays that would exceed available balance.
 *
 * Reservations live in-memory (single-process server) and are rebuilt on
 * boot from the `house_vtxos_json` column of pending games. The select +
 * reserve step is serialized through a mutex so the check-and-claim is
 * atomic across concurrent requests.
 */

import type { ExtendedVirtualCoin } from '@arkade-os/sdk'
import type { AppDeps } from './deps.js'
import { selectableHouseVtxos } from './game-engine.js'

/** Worst-case house payout for a game of `tier` sats (full pot to player). */
export function maxLiabilityForTier(tier: number): number {
  return tier * 2
}

export const outpointKey = (txid: string, vout: number): string => `${txid}:${vout}`

/** A minimal FIFO async mutex. */
export class Mutex {
  private locked = false
  private readonly waiters: Array<() => void> = []

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }
}

/**
 * Per-key FIFO mutex. Serializes async sections that share a key (e.g. all
 * `/commit` calls for one game) while letting different keys run concurrently.
 *
 * Each key's lock entry is reference-counted and dropped once idle, so the map
 * doesn't grow without bound across many distinct keys (thousands of games).
 * The ref bump and the entry lookup are synchronous (no `await` between them),
 * so concurrent callers for the same key always share one entry and the last
 * one out deletes it — a new caller never reuses a half-deleted entry.
 */
export class KeyedMutex {
  private readonly entries = new Map<string, { mutex: Mutex; refs: number }>()

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { mutex: new Mutex(), refs: 0 }
      this.entries.set(key, entry)
    }
    entry.refs++
    try {
      return await entry.mutex.runExclusive(fn)
    } finally {
      if (--entry.refs === 0) this.entries.delete(key)
    }
  }

  /** Number of live key entries (introspection / tests). */
  get size(): number {
    return this.entries.size
  }
}

interface Reservation {
  outpoints: Set<string>
  liability: number
}

/** In-memory reservation ledger keyed by gameId. */
export class VtxoReservations {
  private readonly byGame = new Map<string, Reservation>()

  reserve(gameId: string, outpoints: string[], liability: number): void {
    this.byGame.set(gameId, { outpoints: new Set(outpoints), liability })
  }

  release(gameId: string): void {
    this.byGame.delete(gameId)
  }

  has(gameId: string): boolean {
    return this.byGame.has(gameId)
  }

  isReserved(outpoint: string): boolean {
    for (const r of this.byGame.values()) {
      if (r.outpoints.has(outpoint)) return true
    }
    return false
  }

  /** All currently-reserved outpoints, flattened. */
  reservedOutpoints(): Set<string> {
    const all = new Set<string>()
    for (const r of this.byGame.values()) {
      for (const op of r.outpoints) all.add(op)
    }
    return all
  }

  totalLiability(): number {
    let sum = 0
    for (const r of this.byGame.values()) sum += r.liability
    return sum
  }

  activeGames(): number {
    return this.byGame.size
  }
}

/** Process-wide singletons. Game-engine selection serializes through these. */
export const reservations = new VtxoReservations()
export const selectionMutex = new Mutex()

export interface SelectedHouseVtxos {
  vtxos: ExtendedVirtualCoin[]
  outpoints: string[]
}

/**
 * Thrown when accepting a new game would push the house's worst-case
 * payout obligation past its available balance. Surfaced to the client
 * as a retry-able "house busy" condition.
 */
export class HouseBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HouseBusyError'
  }
}

/**
 * Return spendable house VTXOs that are neither expiring nor already
 * reserved by an in-flight game. Pure read — does not mutate the ledger.
 */
export function freeHouseVtxos(all: ExtendedVirtualCoin[]): ExtendedVirtualCoin[] {
  const { selectable } = selectableHouseVtxos(all)
  const reserved = reservations.reservedOutpoints()
  return selectable.filter((v) => !reserved.has(outpointKey(v.txid, v.vout)))
}

/**
 * Pool target: how many distinct spendable VTXOs we try to keep so
 * concurrent games can each grab their own. Configurable via env.
 */
export const POOL_TARGET_COUNT = Number(process.env.HOUSE_VTXO_POOL_TARGET || 8)

/**
 * Ensure the house holds at least `POOL_TARGET_COUNT` distinct spendable
 * VTXOs by fanning the largest free VTXO(s) out into `pieceSize`-sized
 * pieces via a self-send. No-op when the pool is already healthy or the
 * free balance is too small to split meaningfully.
 *
 * Returns the number of pieces created (0 if it didn't split).
 */
export async function ensureHouseVtxoPool(
  deps: AppDeps,
  opts: { targetCount?: number; pieceSize: number } = { pieceSize: 50_000 },
): Promise<number> {
  const targetCount = opts.targetCount ?? POOL_TARGET_COUNT
  const pieceSize = opts.pieceSize

  const all = await deps.wallet.getVtxos()
  const free = freeHouseVtxos(all)
  if (free.length >= targetCount) return 0

  const freeTotal = free.reduce((sum, v) => sum + v.value, 0)
  // Leave a piece worth of headroom for change + fees.
  const piecesAffordable = Math.floor(freeTotal / pieceSize) - 1
  const piecesNeeded = targetCount - free.length
  const piecesToCreate = Math.min(piecesNeeded, piecesAffordable)
  if (piecesToCreate < 1) return 0

  const ownAddress = await deps.wallet.getAddress()
  const recipients = Array.from({ length: piecesToCreate }, () => ({
    address: ownAddress,
    amount: pieceSize,
  }))

  try {
    await deps.wallet.send(...(recipients as [{ address: string; amount: number }]))
    console.log(`[house pool] split into ${piecesToCreate} new ${pieceSize}-sat VTXO(s)`)
    return piecesToCreate
  } catch (err) {
    console.warn('[house pool] split failed:', err instanceof Error ? err.message : err)
    return 0
  }
}

/** Largest tier from config — the piece size we split house VTXOs into. */
async function pieceSizeFromTiers(deps: AppDeps): Promise<number> {
  try {
    const tiersStr = (await deps.repos.config.get('tiers')) || '[1000,5000,10000,50000]'
    const tiers = JSON.parse(tiersStr) as number[]
    return Math.max(...tiers)
  } catch {
    return 50_000
  }
}

/**
 * Run an initial pool top-up, then keep it healthy on a timer. Each tick
 * splits the house's large free VTXO(s) into max-tier-sized pieces so
 * concurrent games can each reserve their own.
 */
export function startPoolMaintenance(deps: AppDeps, intervalMs = 120_000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const pieceSize = await pieceSizeFromTiers(deps)
      await ensureHouseVtxoPool(deps, { pieceSize })
    } catch (err) {
      console.warn('[house pool] maintenance tick failed:', err instanceof Error ? err.message : err)
    }
  }
  // Kick once on boot (deferred so it doesn't block startup), then on a timer.
  setTimeout(tick, 3_000)
  return setInterval(tick, intervalMs)
}

/**
 * Rebuild the in-memory reservation ledger from pending games after a
 * restart. Each pending game's `house_vtxos_json` lists the outpoints it
 * committed to; re-reserve them so a post-restart play can't pick a VTXO
 * still baked into a live game's fallback tx.
 */
export async function rebuildReservations(deps: AppDeps): Promise<number> {
  const pending = await deps.repos.games.list({ status: 'pending', limit: 1000 })
  let restored = 0
  for (const g of pending) {
    if (!g.house_vtxos_json) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(g.house_vtxos_json)
    } catch {
      continue // malformed — skip
    }
    if (Array.isArray(parsed)) {
      // Legacy setup/final flow: the JSON is a list of "txid:vout" house VTXOs
      // baked into the game's fallback tx. Re-reserve those outpoints so a
      // post-restart play can't pick a VTXO still committed to a live game.
      if (parsed.length > 0) {
        reservations.reserve(g.id, parsed as string[], maxLiabilityForTier(g.tier))
        restored++
      }
    } else if (parsed && typeof parsed === 'object' && 'houseEscrow' in parsed) {
      // Trustless per-party flow: the house already spent its stake into the
      // escrow address, so there's no live house VTXO to protect — but the
      // in-flight liability MUST be restored, or concurrent post-restart plays
      // would over-commit the house (the bug: this branch used to be skipped
      // because TrustlessState is an object, not an array). Mirror
      // handleTrustlessPlay's reservation: liability = the escrowed stake (tier),
      // no outpoints.
      reservations.reserve(g.id, [], g.tier)
      restored++
    }
  }
  if (restored > 0) console.log(`[house pool] rebuilt ${restored} reservation(s) from pending games`)
  return restored
}
