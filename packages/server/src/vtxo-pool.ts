/** SDK-backed input holds and the house liability ledger. Rebuilt from durable games on startup. */

import { canSpendOffchain, isVtxoSpent, type NormalizedExtendedVirtualCoin, type Wallet, type VtxoReservation } from '@arkade-os/sdk'
import type { V4State } from './v4/types.js'
import type { AppDeps } from './deps.js'
import {
  type Denomination, planSplit, parseLadder, defaultLadder,
} from './vtxo-denominations.js'
import { selectableHouseVtxos } from './game-engine.js'
import { houseRenewalBufferForWalletMs, RENEWAL_EXPIRY_BUFFER_MS } from './house-renewal-policy.js'
import { timeoutReject, ARK_SYNC_TIMEOUT_MS, ARK_SUBMIT_TIMEOUT_MS } from './async-timeout.js'
import { makeLogDedup } from './log-dedup.js'

/** Worst-case house payout for a game of `tier` sats (full pot to player). */
export function maxLiabilityForTier(tier: number): number {
  return tier * 2
}

export const outpointKey = (txid: string, vout: number): string => `${txid}:${vout}`

export const isPlainHouseVtxo = (coin: Pick<NormalizedExtendedVirtualCoin, 'assets'>): boolean =>
  !coin.assets?.length

const indexerReadLog = makeLogDedup()

// The wallet store keeps listing coins a co-fund spent, so a refresh resurrected them for /play.
// The indexer is authoritative on spends; if it is unreachable, keep the wallet's list.
export async function readHouseVtxos(deps: Pick<AppDeps, 'wallet'>, label: string): Promise<NormalizedExtendedVirtualCoin[]> {
  const vtxos = await timeoutReject(deps.wallet.getVtxos(), ARK_SYNC_TIMEOUT_MS, label)
  try {
    const spent = new Set<string>()
    for (let i = 0; i < vtxos.length; i += 100) {
      const outpoints = vtxos.slice(i, i + 100).map(({ txid, vout }) => ({ txid, vout }))
      const { vtxos: indexed } = await timeoutReject(deps.wallet.indexerProvider.getVtxos({ outpoints }), ARK_SYNC_TIMEOUT_MS, `${label} (indexer)`)
      for (const coin of indexed) if (isVtxoSpent(coin)) spent.add(outpointKey(coin.txid, coin.vout))
    }
    return spent.size ? vtxos.filter((v) => !spent.has(outpointKey(v.txid, v.vout))) : vtxos
  } catch (error) {
    const message = `[house pool] indexer spend check skipped: ${error instanceof Error ? error.message : String(error)}`
    if (indexerReadLog.shouldLog(label, message)) console.warn(message)
    return vtxos
  }
}

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

/**
 * Reservation holder id used by the pool splitter to pin the coin it spends.
 *
 * Declared here (above the ledger) because `activeGames()` must exclude it —
 * it is not a game. Not restorable on purpose: `rebuildReservations` only
 * re-pins outpoints listed by PENDING GAMES, so a split killed mid-flight
 * leaves nothing behind after a restart. Failing toward "this coin is briefly
 * unusable" is the right direction; failing toward "/play may also spend it"
 * is not.
 */
export const SPLIT_RESERVATION_ID = '__house_pool_split__'

interface Reservation {
  outpoints: Set<string>
  liability: number
  holds: Map<string, VtxoReservation>
}

/** In-memory reservation ledger keyed by gameId. */
export class VtxoReservations {
  private readonly byGame = new Map<string, Reservation>()
  private wallet?: Pick<Wallet, 'reserveVtxos'>

  bindWallet(wallet: Pick<Wallet, 'reserveVtxos'>): void {
    if (this.wallet === wallet) return
    if (this.byGame.size) throw new Error('Cannot replace a wallet while game reservations exist')
    this.wallet = wallet
  }

  reserve(gameId: string, outpoints: string[], liability: number): void {
    const next = new Set(outpoints)
    const previous = this.byGame.get(gameId)
    const holds = new Map(previous?.holds)
    const acquired: string[] = []
    try {
      // Acquire the delta first: a conflict must leave the previous hold intact.
      for (const key of next) {
        if (holds.has(key)) continue
        if ([...this.byGame].some(([id, reservation]) => id !== gameId && reservation.outpoints.has(key))) {
          throw new HouseBusyError(`VTXO ${key} is already reserved`)
        }
        if (this.wallet) {
          const separator = key.lastIndexOf(':')
          const txid = key.slice(0, separator)
          const vout = Number(key.slice(separator + 1))
          if (separator < 1 || !Number.isSafeInteger(vout) || vout < 0) throw new Error('Invalid reservation outpoint')
          holds.set(key, this.wallet.reserveVtxos([{ txid, vout }]))
          acquired.push(key)
        }
      }
    } catch (error) {
      for (const key of acquired) holds.get(key)!.release()
      throw error
    }
    for (const [key, hold] of holds) {
      if (!next.has(key)) {
        hold.release()
        holds.delete(key)
      }
    }
    this.byGame.set(gameId, { outpoints: next, liability, holds })
  }

  release(gameId: string): void {
    const reservation = this.byGame.get(gameId)
    if (!reservation) return
    for (const hold of reservation.holds.values()) hold.release()
    this.byGame.delete(gameId)
  }

  trackExternal(id: string, outpoints: string[]): void {
    const previous = this.byGame.get(id)
    if (previous) {
      if (previous.outpoints.size !== outpoints.length || outpoints.some(key => !previous.outpoints.has(key))) {
        throw new Error('External reservation changed its inputs')
      }
      return
    }
    if (outpoints.some(key => this.isReserved(key))) throw new HouseBusyError('External maintenance input is already reserved')
    this.byGame.set(id, { outpoints: new Set(outpoints), liability: 0, holds: new Map() })
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

  /**
   * In-flight GAMES. Not `byGame.size`: the pool splitter also holds a
   * reservation (SPLIT_RESERVATION_ID) to pin the coin it is spending, and
   * counting that as a game made the admin dashboard's "Active Games" read one
   * too high for the duration of every split.
   */
  activeGames(): number {
    let n = 0
    for (const gameId of this.byGame.keys()) {
      if (![SPLIT_RESERVATION_ID, 'settlement:', 'withdrawal:', 'pool-maint:'].some((prefix) => gameId.startsWith(prefix))) n++
    }
    return n
  }

  /** Point-in-time view of the ledger for admin introspection (read-only). */
  snapshot(): Array<{ gameId: string; outpoints: string[]; liability: number }> {
    return [...this.byGame.entries()].map(([gameId, r]) => ({
      gameId,
      outpoints: [...r.outpoints],
      liability: r.liability,
    }))
  }
}

/** Process-wide singletons. Game-engine selection serializes through these. */
export const reservations = new VtxoReservations()
export const selectionMutex = new Mutex()

/** Caches house coins for game admission; spending paths evict consumed inputs. */
export class HouseVtxoCache {
  private snapshot: NormalizedExtendedVirtualCoin[] | null = null
  private fetchedAt = 0
  chainHeight?: number
  private inflight: Promise<NormalizedExtendedVirtualCoin[]> | null = null

  constructor(private readonly ttlMs: number) {}

  /** Snapshot if younger than the TTL, else a fresh (de-duped) fetch. */
  async get(deps: AppDeps): Promise<NormalizedExtendedVirtualCoin[]> {
    if (this.snapshot && Date.now() - this.fetchedAt < this.ttlMs) return this.snapshot.filter(isPlainHouseVtxo)
    return this.refresh(deps)
  }

  /** Force a live fetch, collapsing concurrent refreshes onto one getVtxos(). */
  async refresh(deps: AppDeps): Promise<NormalizedExtendedVirtualCoin[]> {
    if (this.inflight) return this.inflight
    // Bound the re-sync: a stalled getVtxos otherwise wedges /play (which awaits this).
    this.inflight = readHouseVtxos(deps, 'house getVtxos')
      .then(async (vtxos) => {
        const plain = vtxos.filter(isPlainHouseVtxo)
        if (plain.some((vtxo) => vtxo.expiresAtHeight !== undefined)) {
          this.chainHeight = (await deps.wallet.onchainProvider.getChainTip()).height
        }
        this.snapshot = plain
        this.fetchedAt = Date.now()
        return plain
      })
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  /** Mark the snapshot stale so the next get() fetches live. */
  invalidate(): void {
    this.fetchedAt = 0
  }

  /**
   * Drop a just-spent outpoint from the snapshot so no later selection can
   * re-pick a VTXO that's already been escrowed — the SDK would reject the
   * spend with VTXO_ALREADY_SPENT once the game's reservation is released.
   * Replaces (doesn't mutate) the array so a concurrent caller still iterating
   * the previous snapshot is unaffected. The change output minted by the spend
   * reappears on the next refresh.
   */
  removeOutpoint(txid: string, vout: number): void {
    if (!this.snapshot) return
    this.snapshot = this.snapshot.filter((v) => !(v.txid === txid && v.vout === vout))
  }

  /** Age of the current snapshot in ms (introspection/tests); Infinity if none. */
  ageMs(): number {
    return this.snapshot ? Date.now() - this.fetchedAt : Infinity
  }
}

/**
 * Hot-path VTXO snapshot TTL. Defaults to the pool-maintenance interval so the
 * background tick refreshes the snapshot before it expires and /play almost
 * never pays for a live sync.
 */
// 1.5x the 120s pool-maintenance interval, deliberately. At exactly 120s the
// TTL expires precisely as the next tick is due, so whichever loses the race
// makes /play pay for a full re-sync — the 2.5s this is meant to remove. A
// margin means the background tick always refreshes first and the hot path
// reads a snapshot that is at most one tick old.
export const HOUSE_VTXO_CACHE_TTL_MS = Number(process.env.HOUSE_VTXO_CACHE_TTL_MS || 180_000)
export const houseVtxoCache = new HouseVtxoCache(HOUSE_VTXO_CACHE_TTL_MS)

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
 * Thrown when a bet's required house stake exceeds the house's TOTAL spendable
 * balance — i.e. unaffordable regardless of concurrency. Unlike HouseBusyError
 * (transient: in-flight liability), retrying won't help, so it surfaces as a
 * non-retryable 4xx. The client caps bet options to avoid hitting this; this is
 * the server-side backstop.
 */
export class BetExceedsCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BetExceedsCapacityError'
  }
}

/**
 * Return spendable house VTXOs that are neither expiring nor already
 * reserved by an in-flight game. Pure read — does not mutate the ledger.
 */
export function freeHouseVtxos(all: NormalizedExtendedVirtualCoin[]): NormalizedExtendedVirtualCoin[] {
  const { selectable } = selectableHouseVtxos(all.filter(isPlainHouseVtxo))
  const reserved = reservations.reservedOutpoints()
  return selectable.filter((v) => !reserved.has(outpointKey(v.txid, v.vout)))
}

/**
 * Outpoints arkd has REJECTED as already spent, with the time we learned it.
 *
 * A cache eviction is not enough. `refresh()` replaces the snapshot wholesale,
 * so `removeOutpoint` is erased by the very next `/play` — and a coin stranded
 * in a settle intent that failed to delete keeps being LISTED by `getVtxos()`
 * while arkd refuses to spend it. Selection therefore picks it again, and the
 * next player's game dies the same way. Seen in production: repeated
 * "VTXO_ALREADY_SPENT (6): 8ef2dcc2…:5 already spent" at co-fund.
 *
 * So this is a deny-list that survives a refresh, keyed by outpoint. It is
 * advisory and one-directional: it only ever REMOVES coins from selection, so
 * the worst case is the house declaring itself busy — never a double-spend.
 *
 * Entries expire because "already spent" can be transient: a coin held by a
 * lingering intent becomes spendable again once arkd clears it, and we would
 * otherwise strand it until restart.
 */
export const SPENT_OUTPOINT_DENY_TTL_MS = Number(process.env.SPENT_OUTPOINT_DENY_TTL_MS || 900_000)

class SpentOutpointDenyList {
  private readonly seen = new Map<string, number>()

  /** Record that arkd refused to spend this outpoint. */
  mark(outpoint: string): void {
    this.seen.set(outpoint, Date.now())
  }

  /** True while the rejection is still recent enough to trust. */
  isDenied(outpoint: string): boolean {
    const at = this.seen.get(outpoint)
    if (at === undefined) return false
    if (Date.now() - at >= SPENT_OUTPOINT_DENY_TTL_MS) {
      this.seen.delete(outpoint)
      return false
    }
    return true
  }

  /** Currently-denied outpoints (introspection/tests); prunes as it goes. */
  active(): string[] {
    return [...this.seen.keys()].filter((op) => this.isDenied(op))
  }

  clear(): void {
    this.seen.clear()
  }
}

/** Process-wide deny-list of outpoints arkd rejected as already spent. */
export const spentOutpoints = new SpentOutpointDenyList()

/** Settled or preconfirmed — a coin state usable to fund a NEW bet. */
const settledOrPre = (v: NormalizedExtendedVirtualCoin): boolean =>
  isPlainHouseVtxo(v) && canSpendOffchain(v, { timestamp: new Date(), height: houseVtxoCache.chainHeight })

/**
 * Total house value that can back a NEW bet: settled-or-preconfirmed coins not
 * already reserved for an in-flight game.
 *
 * Shared on purpose. `/play` derives its per-bet cap from this and `/api/tiers`
 * advertises capacity from it, so a divergence here means the client offers
 * bets the server rejects with a 400. Deliberately NOT `freeHouseVtxos`, which
 * filters on near-expiry rather than coin state — neither set contains the
 * other.
 */
export function freeStakeTotal(vtxos: NormalizedExtendedVirtualCoin[]): number {
  return vtxos
    .filter((v) => settledOrPre(v)
      && !reservations.isReserved(outpointKey(v.txid, v.vout))
      // Denied coins cannot fund a bet, so advertising them would size the
      // slider off capacity /play can't actually deliver.
      && !spentOutpoints.isDenied(outpointKey(v.txid, v.vout)))
    .reduce((s, v) => s + v.value, 0)
}

/**
 * Total spendable value in a snapshot, IGNORING reservations — the pool-derived
 * equivalent of the SDK's `balance.available`.
 *
 * Distinct from `freeStakeTotal`, which additionally excludes coins pinned to an
 * in-flight game: that one answers "what can be committed to a NEW bet", this
 * one answers "what does the house hold". `/api/tiers` needs both, and taking
 * them from one snapshot means the advertised balance and the advertised
 * capacity can't be from different moments.
 *
 * Exists so the hot path never has to call `wallet.getBalance()`, which forces a
 * full SDK re-sync — that read alone was costing ~4.9s per `/api/tiers` in
 * production, roughly as much server time as placing every bet in the session.
 */
export function spendableTotal(vtxos: NormalizedExtendedVirtualCoin[]): number {
  return vtxos.filter(settledOrPre).reduce((s, v) => s + v.value, 0)
}

/**
 * Pool floor: minimum number of free VTXOs we always try to keep around.
 * Below this, splitting fires aggressively. Configurable via env.
 */
export const POOL_TARGET_COUNT = Number(process.env.HOUSE_VTXO_POOL_TARGET || 8)

/**
 * Pool ceiling: hard cap on how many free VTXOs we'll create. The split
 * step refuses to mint more than this so a giant bankroll doesn't fragment
 * into thousands of tiny pieces. Default 64; configurable via env.
 */
export const POOL_MAX_COUNT = Number(process.env.HOUSE_VTXO_POOL_MAX || 64)

/*
 * There used to be a MAX_SPLIT_OUTPUTS_PER_TX = 16 here, bounding how many
 * recipients one self-send could carry against arkd's maxTxWeight. Each split
 * send now mints exactly ONE piece (that is the shape `send` supports,
 * and it is what lets us pin the inputs), so tx weight is no longer the
 * binding constraint — SPLIT_PIECES_PER_RUN bounds a tick instead.
 */

/**
 * Only one split runs at a time.
 *
 * The background tick and an admin POST /api/wallet/fragment can fire
 * concurrently, and `reservations.reserve()` REPLACES a holder's pins rather
 * than merging them — so two runs sharing one reservation id would have the
 * second wipe the first's pin while its send was still in flight, handing the
 * coin back to /play mid-spend. That is precisely the P0 #53 hazard this
 * design closes, so it must not be reintroduced by concurrency.
 *
 * Guarded rather than queued: a second caller is told the splitter is already
 * running instead of waiting behind a run whose work makes theirs redundant.
 */
let splitInFlight = false

/** Per-run reservation id, so two runs can never collide on one ledger key. */
let splitRunSeq = 0

/** Bound the number of denomination outputs created in one maintenance run. */
export const SPLIT_PIECES_PER_RUN = Number(process.env.HOUSE_VTXO_SPLIT_PIECES_PER_RUN || 16)

/** Retry only definite indexing failures; ambiguous timed-out sends must not be repeated. */
export const SPLIT_TRANSIENT_RETRIES = Number(process.env.HOUSE_VTXO_SPLIT_RETRIES || 3)

/** Pause before re-reading the pool and retrying a transient split failure. */
export const SPLIT_RETRY_DELAY_MS = Number(process.env.HOUSE_VTXO_SPLIT_RETRY_DELAY_MS || 750)

/**
 * True when a split send failed for a reason a re-read is likely to clear.
 *
 * Narrow on purpose. `VTXO_NOT_FOUND` means arkd does not (yet) know the input
 * — for a just-minted change output that is indexing lag, and the next snapshot
 * carries either the same coin (now known) or a different one. A timeout is
 * deliberately NOT transient: a timed-out send may still land, so retrying it
 * risks minting twice. Anything else (rejected signature, dust, insufficient
 * funds) is a real refusal and still stops the run.
 */
export function isTransientSplitFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /VTXO_NOT_FOUND|vtxos not found/i.test(msg)
}

/**
 * Most coins one piece may consolidate. Each input costs tx weight and a
 * checkpoint, so this bounds a consolidation rather than letting it sweep the
 * whole pool into one send.
 */
export const SPLIT_MAX_INPUTS_PER_PIECE = Number(process.env.HOUSE_VTXO_SPLIT_MAX_INPUTS || 8)

/** What `pickSplitInputs` decided, for the log line and the tests. */
export type SplitInputKind = 'peel' | 'consolidate' | 'none'

/**
 * Choose the coins that fund ONE `amount` piece.
 *
 * Two strategies, in order:
 *
 *  1. PEEL — a single coin worth at least `amount + dust`. Least disruptive:
 *     one input, and the change stays a usable coin. Largest first, so an
 *     already correctly-sized small piece is never consumed to mint another.
 *
 *  2. CONSOLIDATE — when no single coin is big enough, combine several
 *     (largest first, capped at `maxInputs`) until they cover it.
 *
 * Consolidation is what stops the pool stranding itself. Filling smallest-rung
 * first is deliberate, but it is a one-way door without this: OBSERVED in
 * production, a run left 32 free coins of 5,000 (160,000 sat) and then reported
 * "no free coin can fund a 5000-sat piece" forever — the ladder wanted a 25,000
 * piece, no single coin could fund one, and the anti-churn rule correctly
 * refused to spend a 5,000 to remake a 5,000. The bankroll was fine; it was
 * simply the wrong SHAPE, and nothing could ever reshape it.
 *
 * The anti-churn rule still holds where it matters: a lone coin is only peeled
 * when it leaves real change, so a 5,000 is never spent to recreate a 5,000.
 * Merging six of them into a 25,000 is not churn — it is the only way to build
 * a rung the pool cannot otherwise reach.
 */
export function pickSplitInputs(
  free: NormalizedExtendedVirtualCoin[],
  amount: number,
  dust: number,
  maxInputs: number = SPLIT_MAX_INPUTS_PER_PIECE,
): { inputs: NormalizedExtendedVirtualCoin[]; kind: SplitInputKind } {
  const desc = free.filter(isPlainHouseVtxo).sort((a, b) => b.value - a.value)

  const single = desc.find((v) => v.value >= amount + dust)
  if (single) return { inputs: [single], kind: 'peel' }

  const chosen: NormalizedExtendedVirtualCoin[] = []
  let sum = 0
  for (const v of desc) {
    if (chosen.length >= maxInputs) break
    chosen.push(v)
    sum += v.value
    if (sum >= amount + dust) return { inputs: chosen, kind: 'consolidate' }
  }
  return { inputs: [], kind: 'none' }
}

/** Split outputs inherit expiry, so only shape coins outside the renewal horizon. */
export function splittableHouseVtxos(all: NormalizedExtendedVirtualCoin[], bufferMs = RENEWAL_EXPIRY_BUFFER_MS): NormalizedExtendedVirtualCoin[] {
  const reserved = reservations.reservedOutpoints()
  const unreserved = (vs: NormalizedExtendedVirtualCoin[]) =>
    vs.filter((v) => !reserved.has(outpointKey(v.txid, v.vout)))

  const { selectable } = selectableHouseVtxos(all.filter(isPlainHouseVtxo), bufferMs)
  return unreserved(selectable)
}

export interface SplitOutcome {
  /** Pieces actually minted. */
  created: number
  /**
   * Why — ALWAYS populated, including when `created` is 0. The old signature
   * returned a bare number, so four different give-up paths were
   * indistinguishable to the caller and the admin endpoint reported all of
   * them as `{created: 0}` with HTTP 200. That is the "it says it ran but
   * nothing happened, with no errors" report.
   */
  reason: string
}

/** Shape free coins toward the denomination ladder. Select and hold inputs under the mutex, then send outside it. */
export async function ensureHouseVtxoPool(
  deps: AppDeps,
  opts: {
    targetCount?: number
    maxCount?: number
    /** Single-size shaping — kept for callers/tests; becomes a one-rung ladder. */
    pieceSize?: number
    ladder?: Denomination[]
    piecesPerRun?: number
  } = {},
): Promise<SplitOutcome> {
  // Claim the run before doing any work, so a call that will be refused does
  // not first pay for a config read to resolve the ladder.
  //
  // NOT a correctness requirement, and it is worth being precise about why: the
  // check-and-set below is synchronous, so it is atomic on a single-threaded
  // event loop no matter what preceded it. Two callers arriving in the same
  // tick suspend, resume in FIFO order, and the first sets the flag before the
  // second resumes. What would actually break the guard is an `await` BETWEEN
  // the check and the assignment — never add one.
  if (splitInFlight) {
    return { created: 0, reason: 'a split is already running — skipped this attempt' }
  }
  splitInFlight = true
  const runId = `${SPLIT_RESERVATION_ID}#${++splitRunSeq}`

  try {
    const renewalBufferMs = houseRenewalBufferForWalletMs(deps.wallet, deps.arkInfo)
    const targetCount = opts.targetCount ?? POOL_TARGET_COUNT
    const maxCount = opts.maxCount ?? POOL_MAX_COUNT
      const piecesPerRun = opts.piecesPerRun ?? SPLIT_PIECES_PER_RUN
    const ladder =
      opts.ladder ??
      (opts.pieceSize ? [{ size: opts.pieceSize, weightPct: 100 }] : null) ??
      parseLadder(process.env.HOUSE_VTXO_DENOMINATIONS) ??
      defaultLadder(await pieceSizeFromTiers(deps))

    return await runSplit(deps, { targetCount, maxCount, piecesPerRun, ladder, runId, renewalBufferMs })
  } finally {
    splitInFlight = false
    // Belt and braces: the per-piece finally already releases, but a throw
    // between pinning and the try would otherwise leak a pin for this run.
    reservations.release(runId)
  }
}

async function runSplit(
  deps: AppDeps,
  cfg: {
    targetCount: number
    maxCount: number
    piecesPerRun: number
    ladder: Denomination[]
    runId: string
    renewalBufferMs: number
  },
): Promise<SplitOutcome> {
  const { targetCount, maxCount, piecesPerRun, ladder, runId, renewalBufferMs } = cfg
  const dust = Number(deps.arkInfo.dust)
  const ownAddress = await deps.wallet.getAddress()

  let created = 0
  let lastReason = 'no work planned'
  let retriesLeft = SPLIT_TRANSIENT_RETRIES

  // The splitter reads its OWN view; it does not drive the shared snapshot.
  //
  // It still needs fresh data per piece — each piece spends the previous one's
  // change, and a cold-start house has a single big coin, so a run that cannot
  // see its own change mints exactly one piece. That part was never the
  // problem. The problem was doing it THROUGH `houseVtxoCache`: /play and
  // /api/tiers read that same cache, so they joined the splitter's in-flight
  // full sync and then found it invalidated. MEASURED in production mid-run:
  // `v4/play total=4984ms wallet:getVtxos=4974` — the entire request — against
  // `wallet:getVtxos=0ms` warm, and /api/tiers at a 4,355ms median against 89ms.
  //
  // So: private reads here, and the coins this run consumes stay reserved for
  // the WHOLE run rather than being unpinned per piece. /play therefore keeps
  // its warm snapshot AND is kept off every coin we have spent, even though
  // that snapshot still lists them. The shared cache is dropped once, at the
  // end, so the next reader sees the new shape.
  const readPrivate = () => readHouseVtxos(deps, 'house getVtxos (split)')

  let working = splittableHouseVtxos(await readPrivate(), renewalBufferMs)
  /** Every outpoint this run has committed to spending. */
  const consumed = new Set<string>()

  // One send per piece. A HARD failure stops the run and reports partial
  // progress rather than half-applying a batch; a transient one (see
  // isTransientSplitFailure) costs this piece a re-read and a retry, not the
  // rest of the run.
  for (let i = 0; i < piecesPerRun; i++) {
    // Deliberately synchronous inside the lock: no `await` between reading the
    // free set and pinning it, so nothing can reserve a coin in between.
    const picked = await selectionMutex.runExclusive(async () => {
      // Reservations can change under us between pieces, so re-filter each
      // time rather than trusting the view we read a moment ago.
      const reserved = reservations.reservedOutpoints()
      const free = working.filter((v) => {
        const k = outpointKey(v.txid, v.vout)
        return isPlainHouseVtxo(v) && !consumed.has(k) && !reserved.has(k)
      })
      const plan = planSplit({
        existing: free.map((v) => v.value),
        ladder,
        maxCount,
        // One piece per send, so only the first planned amount is used; the
        // rest of the plan is what the following iterations work through.
        maxOutputsPerTx: 1,
        spendable: free.reduce((s, v) => s + v.value, 0),
        dust,
      })
      if (plan.outputs.length === 0) {
        return { inputs: [] as NormalizedExtendedVirtualCoin[], amount: 0, kind: 'none' as SplitInputKind, reason: plan.reason }
      }

      const amount = plan.outputs[0]
      // Peel from one big coin, or consolidate several small ones when no
      // single coin can fund the rung (see pickSplitInputs).
      const { inputs, kind } = pickSplitInputs(free, amount, dust)
      if (inputs.length === 0) {
        const total = free.reduce((t, v) => t + v.value, 0)
        return {
          inputs: [] as NormalizedExtendedVirtualCoin[],
          amount: 0,
          kind,
          reason: `cannot fund a ${amount}-sat piece — ${free.length} free coin(s) totalling ${total} sat, largest ${Math.max(0, ...free.map((v) => v.value))} sat`,
        }
      }
      // Pin this attempt's inputs ON TOP of everything already spent —
      // reserve() REPLACES a holder's pins, so the whole set is re-pinned each
      // time. Keeping the run's spent coins pinned is what stops /play
      // selecting one its warm snapshot still lists.
      //
      // `consumed` is NOT updated here: an attempt that fails has spent
      // nothing, and marking it consumed at selection time permanently excluded
      // the very coin a transient retry needs to try again.
      const attempt = inputs.map((v) => outpointKey(v.txid, v.vout))
      reservations.reserve(runId, [...consumed, ...attempt], 0)
      return { inputs, amount, kind, reason: plan.reason }
    })

    lastReason = picked.reason
    if (picked.inputs.length === 0) break

    // Set in the catch, acted on AFTER the finally has released the pin and
    // dropped the snapshot — so the retry re-reads a fresh view and re-pins,
    // rather than sleeping with a coin still pinned against /play.
    let retryThisPiece = false
    try {
      await timeoutReject(
        deps.wallet.send({
          recipients: [{ address: ownAddress, amount: picked.amount }],
          selectedVtxos: picked.inputs,
        }),
        ARK_SUBMIT_TIMEOUT_MS,
        'house pool split send',
      )
      created++
      // Spent for real now, so it stays excluded for the rest of the run.
      for (const v of picked.inputs) consumed.add(outpointKey(v.txid, v.vout))
      const from = picked.kind === 'consolidate'
        ? `${picked.inputs.length} coins totalling ${picked.inputs.reduce((t, v) => t + v.value, 0)} sat`
        : `${picked.inputs[0].txid.slice(0, 8)}…:${picked.inputs[0].vout} (${picked.inputs[0].value} sat)`
      console.log(`[house pool] minted a ${picked.amount}-sat piece (${picked.kind}) from ${from}`)
      // Private re-read so the next piece can spend this one's change. Costs
      // the SPLITTER a sync; costs /play nothing.
      working = splittableHouseVtxos(await readPrivate(), renewalBufferMs)
    } catch (err) {
      lastReason = `split send failed after ${created} piece(s): ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[house pool] ${lastReason}`)
      retryThisPiece = isTransientSplitFailure(err) && retriesLeft > 0
      if (!retryThisPiece) break
    }

    if (retryThisPiece) {
      retriesLeft--
      // This piece was NOT minted, so don't spend the run's budget on it.
      // `retriesLeft` is what bounds the loop here, not `piecesPerRun`.
      i--
      console.warn(
        `[house pool] transient split failure — retrying in ${SPLIT_RETRY_DELAY_MS}ms (${retriesLeft} retr${retriesLeft === 1 ? 'y' : 'ies'} left)`,
      )
      await new Promise((resolve) => setTimeout(resolve, SPLIT_RETRY_DELAY_MS))
      // Drop the failed attempt's pin (it spent nothing) so the retry can pick
      // those coins again, then re-read privately and try.
      reservations.reserve(runId, [...consumed], 0)
      working = splittableHouseVtxos(await readPrivate(), renewalBufferMs)
    }
  }

  // Release the run's pins and publish, once. The pins held for the whole run
  // so /play never selected a coin we had spent; dropping the shared snapshot
  // now means the next reader re-syncs and sees the new shape.
  reservations.release(runId)
  if (created > 0) houseVtxoCache.invalidate()

  if (created > 0) {
    const free = freeHouseVtxos(await houseVtxoCache.get(deps))
    const below = free.length < targetCount ? ' (below floor)' : ''
    lastReason = `minted ${created} piece(s) — ${free.length}/${maxCount} free${below}`
    console.log(`[house pool] ${lastReason}`)
  }
  return { created, reason: lastReason }
}

/** Fail at startup if the installed SDK cannot submit explicit inputs. */
export function assertSelectedVtxosSupported(wallet: unknown): void {
  if (typeof (wallet as { send?: unknown } | null)?.send !== 'function') {
    throw new Error('House pool requires wallet.send({ recipients, selectedVtxos })')
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
  // A healthy pool no-ops on every tick, which at 120s would be ~720 identical
  // lines a day — noise that buries the reason it exists to surface. Dedup logs
  // the first occurrence and any CHANGE immediately (the operator-relevant
  // event), then repeats an unchanged reason only on the 5-minute heartbeat.
  const noSplitLog = makeLogDedup()

  const tick = async () => {
    try {
      // No pieceSize: that would collapse the ladder to a single 50,000-sat
      // rung, which is the shape this replaced. Let ensureHouseVtxoPool read
      // HOUSE_VTXO_DENOMINATIONS, or derive the default from `tiers`.
      const { created, reason } = await ensureHouseVtxoPool(deps)
      if (created === 0) {
        if (noSplitLog.shouldLog('no-split', reason)) {
          console.log(`[house pool] no split this tick — ${reason}`)
        }
      } else {
        // A run that did work makes the next no-op worth hearing about again.
        noSplitLog.clear('no-split')
      }
    } catch (err) {
      console.warn('[house pool] maintenance tick failed:', err instanceof Error ? err.message : err)
    }
  }
  // Kick once on boot (deferred so it doesn't block startup), then on a timer.
  setTimeout(tick, 3_000)
  return setInterval(tick, intervalMs)
}

/** Rebuild pending game holds before accepting requests. Submitted pots retain liability only. */
export async function rebuildReservations(deps: AppDeps): Promise<number> {
  const pending = await deps.repos.games.listPending()
  let restored = 0
  for (const game of pending) {
    const state = JSON.parse(game.state_json) as V4State
    if (state.protocolVersion !== 'v4' || !Array.isArray(state.houseInputs) || !Number.isSafeInteger(state.houseStake)) {
      throw new Error(`Invalid durable game state: ${game.id}`)
    }
    // Submitted co-funds already consume their inputs; keep only their liability.
    const outpoints = state.cofundArkTxid || state.cofundTxid
      ? []
      : state.houseInputs.map((input) => outpointKey(input.txid, input.vout))
    reservations.reserve(game.id, outpoints, state.houseStake)
    restored++
  }
  if (restored) console.log(`[house pool] restored ${restored} pending game reservation(s)`)
  return restored
}
