/**
 * House VTXO concurrency management.
 *
 * The house serves many players at once. Two concerns arise:
 *
 *   1. Reservation — `handleV4Play` picks a specific house VTXO to
 *      fund a game's house escrow. Two concurrent games must NOT pick the
 *      same VTXO, or the second game's escrow tx would reference an
 *      already-spent input.
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
import {
  type Denomination, planSplit, parseLadder, defaultLadder,
} from './vtxo-denominations.js'
import { selectableHouseVtxos } from './game-engine.js'
import { timeoutReject, ARK_SYNC_TIMEOUT_MS, ARK_SUBMIT_TIMEOUT_MS } from './async-timeout.js'
import { makeLogDedup } from './log-dedup.js'

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

/**
 * Cached snapshot of the house wallet's VTXOs.
 *
 * `wallet.getVtxos()` forces the SDK to re-sync AND re-annotate the wallet's
 * FULL VTXO history on every call — including thousands of long-spent outputs
 * on the house's receive address — which costs seconds for a long-lived house.
 * /play needs the VTXO set on its hot path (to size the liability check and
 * pick an escrow VTXO), so it reads this snapshot — kept warm in the background
 * by pool maintenance — instead of paying for a full sync per request.
 *
 * Staleness is safe by construction:
 *  - Selection excludes already-reserved outpoints (`freeHouseVtxos`), so a
 *    stale snapshot can never hand the same VTXO to two concurrent games.
 *  - A VTXO spent by a settlement between refreshes that lingers in the
 *    snapshot only makes the escrow submit fail — caught by the caller and
 *    surfaced as a retryable "busy", never a double-spend or fund loss.
 *  - The liability check stays conservative: each in-flight game adds its
 *    worst-case pot to `reservations.totalLiability()` immediately, which grows
 *    at least as fast as a stale `available` can over-count, so the check never
 *    over-accepts.
 * Callers force-refresh on a selection/liability miss, so a stale snapshot
 * self-corrects within one request.
 */
export class HouseVtxoCache {
  private snapshot: ExtendedVirtualCoin[] | null = null
  private fetchedAt = 0
  private inflight: Promise<ExtendedVirtualCoin[]> | null = null

  constructor(private readonly ttlMs: number) {}

  /** Snapshot if younger than the TTL, else a fresh (de-duped) fetch. */
  async get(deps: AppDeps): Promise<ExtendedVirtualCoin[]> {
    if (this.snapshot && Date.now() - this.fetchedAt < this.ttlMs) return this.snapshot
    return this.refresh(deps)
  }

  /** Force a live fetch, collapsing concurrent refreshes onto one getVtxos(). */
  async refresh(deps: AppDeps): Promise<ExtendedVirtualCoin[]> {
    if (this.inflight) return this.inflight
    // Bound the re-sync: a stalled getVtxos otherwise wedges /play (which awaits this).
    this.inflight = timeoutReject(deps.wallet.getVtxos(), ARK_SYNC_TIMEOUT_MS, 'house getVtxos')
      .then((vtxos) => {
        this.snapshot = vtxos
        this.fetchedAt = Date.now()
        return vtxos
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
export function freeHouseVtxos(all: ExtendedVirtualCoin[]): ExtendedVirtualCoin[] {
  const { selectable } = selectableHouseVtxos(all)
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
const settledOrPre = (v: ExtendedVirtualCoin): boolean =>
  v.virtualStatus.state === 'settled' || v.virtualStatus.state === 'preconfirmed'

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
export function freeStakeTotal(vtxos: ExtendedVirtualCoin[]): number {
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
export function spendableTotal(vtxos: ExtendedVirtualCoin[]): number {
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
 * send now mints exactly ONE piece (that is the shape `sendBitcoin` supports,
 * and it is what lets us pin the inputs), so tx weight is no longer the
 * binding constraint — SPLIT_PIECES_PER_RUN bounds a tick instead.
 */

/**
 * Synthetic reservation holder for the splitter's own inputs.
 *
 * Not a game id, and deliberately not restorable: `rebuildReservations` only
 * re-pins outpoints listed by PENDING GAMES, so a split killed mid-flight
 * leaves nothing behind after a restart. Failing toward "this coin is briefly
 * unusable" is the right direction; failing toward "/play may also spend it"
 * is not.
 */
export const SPLIT_RESERVATION_ID = '__house_pool_split__'

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

/**
 * Steady-state budget: how many pieces one run mints once the pool is AT or
 * above the floor (`POOL_TARGET_COUNT`). Above the floor a split is only "nice
 * to have", so it is paced across ticks.
 */
export const SPLIT_PIECES_PER_RUN = Number(process.env.HOUSE_VTXO_SPLIT_PIECES_PER_RUN || 4)

/**
 * Hard bound on a single run, used while BELOW the floor.
 *
 * `targetCount` is a floor, not a label: below it, game throughput depends on
 * the split, so one call has to be able to catch up rather than pace itself.
 * Capping every run at SPLIT_PIECES_PER_RUN broke the v4 e2e — it asks for
 * `targetCount: 8` and got 5 free coins, and since v4 spends a WHOLE house
 * VTXO per game the later games ran the pool to zero and failed with
 * "per-bet cap is 0 sat (25% of 0 sat free)".
 */
export const SPLIT_MAX_PIECES_PER_RUN = Number(process.env.HOUSE_VTXO_SPLIT_MAX_PIECES_PER_RUN || 16)

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

/**
 * Shape the house bankroll toward the configured denomination ladder.
 *
 * Two things changed from the single-`pieceSize` design:
 *
 * 1. WHAT to mint now comes from `planSplit` (vtxo-denominations.ts), which
 *    targets a per-size count and stops when each rung is satisfied, instead
 *    of `floor(freeTotal/pieceSize) - 1` — a rule that could not split a
 *    bankroll under 2x pieceSize at all and kept minting a size the pool was
 *    already full of.
 *
 * 2. HOW it spends no longer blocks games. The old path called
 *    `wallet.send(...recipients)`, which picks its inputs internally from ALL
 *    spendable coins with no way to exclude our reservations — so the only
 *    safe option was to hold `selectionMutex` across the network send and
 *    REFUSE to split whenever any outpoint was reserved. With autoplay that is
 *    nearly always true, which is why the fragment button looked like a no-op,
 *    and the send holding the mutex is what produced a MEASURED 9,389ms
 *    `select+reserve` stall in /play.
 *
 *    Instead each piece is minted with `sendBitcoin({selectedVtxos})`, whose
 *    inputs we dictate. We pick and PIN them under the mutex (microseconds, no
 *    network) and then send OUTSIDE it: /play skips reserved coins, we only
 *    ever spend unreserved ones, so the exclusion is the same and neither side
 *    waits on the other.
 *
 * Note `sendBitcoin` is marked `@deprecated Use send` upstream, but `send` is
 * precisely the variant with no input control. `assertSelectedVtxosSupported`
 * below fails loudly if a future SDK drops it, rather than letting us fall
 * back to unconstrained selection silently. The longer-term upgrade is
 * `settle({inputs, outputs})` — it pins inputs AND takes many outputs in one
 * batch swap, producing settled rather than preconfirmed pieces — once its
 * change/intent-fee accounting for a self-split has been verified live.
 */
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
    const targetCount = opts.targetCount ?? POOL_TARGET_COUNT
    const maxCount = opts.maxCount ?? POOL_MAX_COUNT
      // An EXPLICIT piecesPerRun is a hard cap — the caller said how much work it
    // wants. Only the default gets the floor catch-up, where a run below
    // targetCount may go up to SPLIT_MAX_PIECES_PER_RUN.
    const pace = opts.piecesPerRun ?? SPLIT_PIECES_PER_RUN
    const hardCap = opts.piecesPerRun ?? SPLIT_MAX_PIECES_PER_RUN
    const ladder =
      opts.ladder ??
      (opts.pieceSize ? [{ size: opts.pieceSize, weightPct: 100 }] : null) ??
      parseLadder(process.env.HOUSE_VTXO_DENOMINATIONS) ??
      defaultLadder(await pieceSizeFromTiers(deps))

    return await runSplit(deps, { targetCount, maxCount, pace, hardCap, ladder, runId })
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
    pace: number
    hardCap: number
    ladder: Denomination[]
    runId: string
  },
): Promise<SplitOutcome> {
  const { targetCount, maxCount, pace, hardCap, ladder, runId } = cfg
  const dust = Number(deps.arkInfo.dust)
  const ownAddress = await deps.wallet.getAddress()

  let created = 0
  let lastReason = 'no work planned'
  /** Why the loop stopped, when that is more informative than the count. */
  let stopReason = ''

  // One send per piece. Each iteration re-reads the pool so the previous
  // piece's change becomes the next input, and each is independently safe —
  // a failure stops the run and reports partial progress rather than
  // half-applying a batch.
  for (let i = 0; i < hardCap; i++) {
    // Refresh through the cache so this tick doubles as the hot path's
    // snapshot warmer (a fresh, full getVtxos() either way).
    const all = await houseVtxoCache.refresh(deps)

    // Pace only once the pool has reached the floor. Below it the split is a
    // MUST (game throughput depends on a free input per concurrent game), so
    // keep going up to the hard cap; at or above it, stop after the
    // steady-state budget and leave the rest to the next tick.
    //
    // Advisory count, deliberately read outside the lock: it decides only when
    // to STOP, never which coin to spend, so a stale read cannot cause a
    // double-spend — it can only shift work to the next tick.
    const freeNow = freeHouseVtxos(all).length
    if (created >= pace && freeNow >= targetCount) {
      stopReason = `paced (floor ${targetCount} met, rest next tick)`
      break
    }

    // Deliberately synchronous inside the lock: no `await` between reading the
    // free set and pinning it, so nothing can reserve a coin in between.
    const picked = await selectionMutex.runExclusive(async () => {
      const free = freeHouseVtxos(all)
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
      if (plan.outputs.length === 0) return { input: null, amount: 0, reason: plan.reason }

      const amount = plan.outputs[0]
      // Peel from the LARGEST free coin: never consume an already
      // correctly-sized small piece just to mint another one.
      //
      // Strictly `>= amount + dust`, so there is always real change above the
      // dust floor. Allowing `value === amount` would spend a coin to recreate
      // a coin of the same size — pure churn costing a tx — and would drive
      // `sendBitcoin` down a zero-change path whose behaviour has not been
      // verified. A pool of exactly-sized coins therefore reports why it can't
      // mint rather than spinning; the plan is what says a rung is short, and
      // no single coin of that exact size can usefully serve it.
      const candidate = [...free]
        .sort((a, b) => b.value - a.value)
        .find((v) => v.value >= amount + dust)
      if (!candidate) {
        return {
          input: null,
          amount: 0,
          reason: `no free coin can fund a ${amount}-sat piece without dust change (largest free ${Math.max(0, ...free.map((v) => v.value))} sat)`,
        }
      }
      reservations.reserve(runId, [outpointKey(candidate.txid, candidate.vout)], 0)
      return { input: candidate, amount, reason: plan.reason }
    })

    lastReason = picked.reason
    if (!picked.input) break

    try {
      await timeoutReject(
        deps.wallet.sendBitcoin({
          address: ownAddress,
          amount: picked.amount,
          selectedVtxos: [picked.input],
        }),
        ARK_SUBMIT_TIMEOUT_MS,
        'house pool split send',
      )
      created++
      console.log(
        `[house pool] minted a ${picked.amount}-sat piece from ${picked.input.txid.slice(0, 8)}…:${picked.input.vout} (${picked.input.value} sat)`,
      )
    } catch (err) {
      lastReason = `split send failed after ${created} piece(s): ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[house pool] ${lastReason}`)
      break
    } finally {
      // Release the pin either way. A timed-out send may still land, which is
      // why the snapshot is dropped too — the refreshed view is what decides
      // whether the coin is really gone, and the spentOutpoints deny-list
      // catches one that arkd keeps listing after it has been spent.
      reservations.release(runId)
      houseVtxoCache.invalidate()
    }
  }

  if (created > 0) {
    const free = freeHouseVtxos(await houseVtxoCache.get(deps))
    const below = free.length < targetCount ? ' (below floor)' : ''
    lastReason =
      `minted ${created} piece(s) — ${free.length}/${maxCount} free${below}` +
      (stopReason ? ` — ${stopReason}` : '')
    console.log(`[house pool] ${lastReason}`)
  }
  return { created, reason: lastReason }
}

/**
 * Guard the one SDK affordance this design depends on.
 *
 * `sendBitcoin` is `@deprecated Use send` upstream, and `send` has no input
 * control — so if a future SDK bump removes it, the splitter must fail loudly
 * rather than quietly regress to reservation-blind selection, which is the P0
 * #53 hazard this replaced.
 */
export function assertSelectedVtxosSupported(wallet: unknown): void {
  const fn = (wallet as { sendBitcoin?: unknown } | null)?.sendBitcoin
  if (typeof fn !== 'function') {
    throw new Error(
      'house pool split requires wallet.sendBitcoin({selectedVtxos}) to pin its inputs; ' +
        'the SDK no longer exposes it — port the splitter to settle({inputs, outputs}) ' +
        'before relying on wallet.send, which cannot exclude reserved coins (P0 #53)',
    )
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
    } else if (parsed && typeof parsed === 'object' && (
      'houseEscrow' in parsed || 'houseVtxoOutpoint' in parsed || 'houseVtxoOutpoints' in parsed || 'arkadeForfeit' in parsed
    )) {
      // Trustless per-party flow — liability-only reservation (since v0.3.7).
      // We no longer pin specific outpoints: the SDK's wallet.send mutex
      // serializes its own VTXO selection at /commit, so cross-game double-
      // spend protection is the SDK's job. Our reservation just enforces the
      // bankroll over-commit ceiling. Liability is:
      //   - houseEscrow.value if the house has already funded (post-/commit
      //     or legacy ≤0.3.4 eager flow)
      //   - arkadeForfeit.houseStake otherwise (lazy-fund pending /commit)
      //   - tier as a final fallback for very old rows
      const o = parsed as {
        houseEscrow?: { value?: number }
        arkadeForfeit?: { houseStake?: number }
      }
      let liability = 0
      if (o.houseEscrow && typeof o.houseEscrow.value === 'number' && o.houseEscrow.value > 0) {
        liability = o.houseEscrow.value
      } else if (o.arkadeForfeit && typeof o.arkadeForfeit.houseStake === 'number' && o.arkadeForfeit.houseStake > 0) {
        liability = o.arkadeForfeit.houseStake
      } else {
        liability = g.tier
      }
      reservations.reserve(g.id, [], liability)
      restored++
    } else if (parsed && typeof parsed === 'object' && (parsed as { protocolVersion?: string }).protocolVersion === 'v4') {
      // v0.4 joint pot. Pre-cofund: pin the EXACT house input outpoints so a
      // post-restart /play can't re-pick a VTXO still committed to this pending
      // game (without this, the v4 state matched no branch and was silently
      // skipped → double-reservation → VTXO_ALREADY_SPENT). Post-cofund: the
      // inputs are already spent into the pot, but the house stake stays live
      // until the game resolves — reserve liability-only, as v3 does.
      const v4 = parsed as {
        houseInputs?: { txid: string; vout: number }[]
        houseStake?: number
        cofundArkTxid?: string
      }
      const outpoints = v4.cofundArkTxid
        ? []
        : (v4.houseInputs ?? []).map((h) => `${h.txid}:${h.vout}`)
      reservations.reserve(g.id, outpoints, v4.houseStake ?? g.tier)
      restored++
    }
  }
  if (restored > 0) console.log(`[house pool] rebuilt ${restored} reservation(s) from pending games`)
  return restored
}
