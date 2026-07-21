import {
  ArkAddress,
  CSVMultisigTapscript,
  Estimator,
  hasBoardingTxExpired,
  isSubdust,
  isVtxoExpiringSoon,
  isExpired,
  isSpendable,
  type ExtendedCoin,
  type ExtendedVirtualCoin,
  type SettleParams,
} from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { makeSettlementHandler } from './settlement-events.js'
import {
  reservations,
  houseVtxoCache,
  selectionMutex,
  outpointKey,
} from './vtxo-pool.js'
import { timeoutReject, ARK_SYNC_TIMEOUT_MS, ARK_SUBMIT_TIMEOUT_MS } from './async-timeout.js'
import type { AppDeps } from './deps.js'
import { makeLogDedup } from './log-dedup.js'

/**
 * Minimum remaining VTXO lifetime when selecting house VTXOs for a new
 * game. The fallback path requires the input VTXO to remain spendable
 * up to `setupExpiration` (10 min) plus a safety margin for the Ark
 * server's settlement round.
 */
export const VTXO_LIFETIME_BUFFER_MS = 30 * 60_000

/**
 * How long before batch expiry the renewal timer re-anchors a house VTXO.
 * Matches the SDK's own default renewal threshold
 * (DEFAULT_SETTLEMENT_CONFIG.vtxoThreshold = 259_200 s = 3 days).
 *
 * Deliberately much larger than VTXO_LIFETIME_BUFFER_MS, which the renewal
 * gate previously reused: the SELECTION buffer only has to keep a coin
 * spendable through one game setup, but the RENEWAL buffer has to survive
 * outages. With the 30-min gate the timer had a single half-hour window in a
 * multi-day batch cycle to be alive and healthy — miss it (process down, a
 * wedged tick) and the batch is swept. Renewing 3 days early costs one settle
 * per batch cycle and buys days of margin.
 */
export const RENEWAL_EXPIRY_BUFFER_MS = 259_200_000

/**
 * True when a house VTXO needs a renewal settle: expiring within `bufferMs`,
 * OR already expired/swept. The latter is the recovery case: once arkd sweeps
 * a batch the VTXO becomes "recoverable" — spendable ONLY via a settle (arkd
 * rejects a normal offchain spend with VTXO_RECOVERABLE), so the renewal
 * settle is what reclaims those funds. `isExpired` is timestamp-based (and
 * also true for the "swept" state), so it catches a swept VTXO even when the
 * SDK's cached state still reads "preconfirmed". Note `isVtxoExpiringSoon`
 * is false once expiry has passed — only the `isExpired` clause covers the
 * already-expired/swept states.
 *
 * Exported for unit testing.
 */
export function vtxoNeedsRenewal(v: ExtendedVirtualCoin, bufferMs: number): boolean {
  return isVtxoExpiringSoon(v, bufferMs) || (isSpendable(v) && isExpired(v))
}

/**
 * Partition house VTXOs into those usable for a fresh escrow (`selectable`) and
 * those that must NOT be escrowed and should be renewed (`dropped`).
 *
 * A VTXO is dropped when it is expiring within `bufferMs` OR already
 * expired/swept. The latter is the critical case on regtest: once a batch is
 * swept the VTXO becomes "recoverable", and arkd rejects spending it in a normal
 * offchain tx with VTXO_RECOVERABLE — so it must never leak into `/play`
 * selection. `isExpired` is timestamp-based (and also true for the "swept"
 * state), so it catches a swept VTXO even when the SDK's cached state still
 * reads "preconfirmed". The `dropped` set is what the renewal path re-settles to
 * reclaim those funds.
 *
 * Exported for unit testing.
 */
export function selectableHouseVtxos(
  vtxos: ExtendedVirtualCoin[],
  bufferMs = VTXO_LIFETIME_BUFFER_MS,
): { selectable: ExtendedVirtualCoin[]; dropped: ExtendedVirtualCoin[] } {
  const selectable: ExtendedVirtualCoin[] = []
  const dropped: ExtendedVirtualCoin[] = []
  for (const v of vtxos) {
    if (vtxoNeedsRenewal(v, bufferMs)) {
      dropped.push(v)
    } else {
      selectable.push(v)
    }
  }
  return { selectable, dropped }
}

/**
 * Mirrors the SDK's internal `MAX_VTXOS_PER_SETTLEMENT` cap (not exported):
 * one settle intent takes at most this many VTXO inputs.
 */
const MAX_VTXOS_PER_SETTLEMENT = 50

/**
 * Build explicit settle params the way the SDK's no-arg `settle()` gathers
 * them — boarding UTXOs filtered to `status.confirmed && !expired`, VTXOs
 * (incl. recoverable) by value descending under the per-settlement cap, the
 * per-input intent fee subtracted from each, and a single self-output for the
 * net amount — EXCEPT that VTXOs reserved for in-flight games are excluded
 * (P0 #53). The SDK's blind gathering could pull a coin already committed to a
 * live game's co-fund, so arkd rejected the game with VTXO_ALREADY_SPENT.
 * `SettleParams.inputs` is a required explicit list with no exclude-filter, so
 * the only way to keep reserved coins out of the settle is to build the list
 * ourselves. Explicit params run the exact same downstream `settle()` code
 * path as the no-arg form (the SDK's own gathering just assigns `params` and
 * falls through), so semantics are otherwise identical.
 *
 * Always emits exactly one self-output — arkd rejects an intent proof with
 * empty outputs ("proof does not contain outputs"), and mirrors the SDK's
 * subdust throw ("Output amount is below dust limit") when the net can't
 * carry itself.
 *
 * Returns null when nothing is eligible once reserved coins are excluded
 * (the caller treats it like the SDK's "No inputs found").
 */
export interface SettleParamsOptions {
  /**
   * Restrict the VTXO leg to coins matching this predicate (applied after the
   * reservation filter; boarding UTXOs are unaffected). The renewal path
   * narrows to coins that actually need re-anchoring (`vtxoNeedsRenewal`) so a
   * renewal settles the expiring/recoverable set instead of consolidating the
   * whole healthy pool into one output — the SDK's own renewal
   * (`runPeriodicSettle`/`renewVtxos`) has the same expiring-only semantics.
   * The admin settle passes nothing and keeps settle-everything semantics.
   */
  vtxoFilter?: (v: ExtendedVirtualCoin) => boolean
}

export async function buildReservationSafeSettleParams(
  deps: AppDeps,
  opts: SettleParamsOptions = {},
): Promise<SettleParams | null> {
  const wallet = deps.wallet
  const { fees, vtxoMaxAmount } = await wallet.arkProvider.getInfo()
  const estimator = new Estimator(fees.intentFee)
  const offchainAddress = await wallet.getAddress()
  const offchainOutputScript = hex.encode(ArkAddress.decode(offchainAddress).pkScript)

  // Boarding leg — confirmed, unexpired deposits (expired ones belong to the
  // onchain sweep; including one fails the whole settle). Timelock decode and
  // chain-tip lookup stay lazy so a wallet with no boarding activity skips the
  // extra I/O. Boarding UTXOs are onchain and never reserved.
  let amount = 0
  const filteredBoardingUtxos: ExtendedCoin[] = []
  const allBoarding = await wallet.getBoardingUtxos()
  if (allBoarding.length > 0) {
    const exitScript = CSVMultisigTapscript.decode(hex.decode(wallet.boardingTapscript.exitScript))
    const boardingTimelock = exitScript.params.timelock
    let chainTipHeight: number | undefined
    if (boardingTimelock.type === 'blocks') {
      chainTipHeight = (await wallet.onchainProvider.getChainTip()).height
    }
    for (const utxo of allBoarding) {
      if (!utxo.status.confirmed || hasBoardingTxExpired(utxo, boardingTimelock, chainTipHeight)) continue
      const inputFee = estimator.evalOnchainInput({ amount: BigInt(utxo.value) })
      if (inputFee.value >= utxo.value) continue
      filteredBoardingUtxos.push(utxo)
      amount += utxo.value - inputFee.satoshis
    }
  }

  // VTXO leg — the SDK's own gathering minus reserved outpoints, optionally
  // narrowed by the caller's predicate. Value-descending under the 50-input
  // cap like the SDK's no-arg settle; if the cap ever binds, the leftovers
  // just ride the next renewal tick.
  const reserved = reservations.reservedOutpoints()
  const vtxos = (await wallet.getVtxos({ withRecoverable: true }))
    .filter((v) => !reserved.has(outpointKey(v.txid, v.vout)))
    .filter((v) => (opts.vtxoFilter ? opts.vtxoFilter(v) : true))
    .sort((a, b) => b.value - a.value)
  const filteredVtxos: ExtendedVirtualCoin[] = []
  for (const vtxo of vtxos) {
    if (filteredVtxos.length >= MAX_VTXOS_PER_SETTLEMENT) break
    const inputFee = estimator.evalOffchainInput({
      amount: BigInt(vtxo.value),
      type: vtxo.virtualStatus.state === 'swept' ? 'recoverable' : 'vtxo',
      weight: 0,
      birth: vtxo.createdAt,
      expiry: vtxo.virtualStatus.batchExpiry ? new Date(vtxo.virtualStatus.batchExpiry) : undefined,
    })
    if (inputFee.satoshis >= vtxo.value) continue
    const net = vtxo.value - inputFee.satoshis
    if (vtxoMaxAmount >= 0n) {
      const projectedAmount = BigInt(amount + net)
      const projectedOutputFee = estimator.evalOffchainOutput({
        amount: projectedAmount,
        script: offchainOutputScript,
      })
      if (projectedAmount - BigInt(projectedOutputFee.satoshis) > vtxoMaxAmount) continue
    }
    filteredVtxos.push(vtxo)
    amount += net
  }

  const inputs: ExtendedCoin[] = [...filteredBoardingUtxos, ...filteredVtxos]
  if (inputs.length === 0) return null

  const outputFee = estimator.evalOffchainOutput({ amount: BigInt(amount), script: offchainOutputScript })
  const outputAmount = BigInt(amount) - BigInt(outputFee.satoshis)
  if (isSubdust(outputAmount, wallet.dustAmount)) {
    throw new Error('Output amount is below dust limit')
  }
  return { inputs, outputs: [{ address: offchainAddress, amount: outputAmount }] }
}

/** Unique id per renewal settle for its transient reservation-ledger entry. */
let renewalReservationSeq = 0

/**
 * Settle to renew expiring/recoverable house VTXOs / confirm boarding
 * deposits.
 *
 * Passes EXPLICIT params from `buildReservationSafeSettleParams` — the SDK's
 * no-arg gathering with VTXOs reserved for in-flight games excluded (P0 #53:
 * the blind `settle(undefined)` could spend a coin already committed to a live
 * game's co-fund → VTXO_ALREADY_SPENT breaking the player's game), narrowed to
 * the coins that actually need re-anchoring (`vtxoNeedsRenewal` with the
 * renewal buffer: near-expiry, expired, or swept/recoverable — the swept case
 * IS the swept-fund recovery path, same selection the SDK's `recoverVtxos`
 * makes minus reserved coins). Healthy far-from-expiry coins stay untouched,
 * so a renewal no longer consolidates the whole pool into one output. The
 * params always carry a single non-empty self-output; an explicit
 * `outputs: []` would make arkd reject the intent proof ("proof does not
 * contain outputs").
 *
 * The chosen VTXO inputs are pinned in the reservation ledger for the
 * duration of the settle (under `selectionMutex`, sync-only): the params are
 * built against a snapshot of the ledger, so without the pin a concurrent
 * /play could reserve one of our inputs mid-settle and bake a coin this
 * settle is about to spend into a live game (the same failure P0 #53 fixed,
 * through the opposite window). A clash detected at pin time is a benign
 * skip — the next tick retries. The pin is released when the settle promise
 * settles; if the caller times out the await, the pin intentionally lingers
 * until the underlying settle resolves, keeping /play off coins a zombie
 * settle may still spend.
 *
 * Returns true if a settle round ran, false when there's nothing eligible
 * (no free inputs after the reservation filter, a pin clash, or the SDK's
 * "No inputs found" — all graceful no-ops so the renewal worker doesn't log
 * a failure).
 *
 * NOTE on phantom inputs: if the wallet's persisted DB holds a boarding UTXO
 * that arkd has lost (e.g. a regtest chain reset where the wallet volume
 * outlived the chain), the `status.confirmed` filter can still include it and
 * the settle fails with TX_NOT_FOUND. That's a stale-wallet condition that a
 * wallet resync/wipe resolves — not something the renewal path can filter
 * around, since the phantom looks confirmed in the wallet's own view.
 */
export async function renewSettle(deps: AppDeps, label = 'renewal'): Promise<boolean> {
  try {
    const params = await buildReservationSafeSettleParams(deps, {
      vtxoFilter: (v) => vtxoNeedsRenewal(v, RENEWAL_EXPIRY_BUFFER_MS),
    })
    if (!params) return false // nothing eligible once reserved coins are excluded
    // Boarding inputs are onchain-only (never in /play's selection space);
    // only the VTXO inputs need pinning.
    const inputKeys = params.inputs
      .filter((i): i is ExtendedVirtualCoin => 'virtualStatus' in i)
      .map((v) => outpointKey(v.txid, v.vout))
    const reservationId = `renewal:${++renewalReservationSeq}`
    const pinned = await selectionMutex.runExclusive(async () => {
      // Sync re-check: a /play may have reserved one of our chosen inputs
      // between the params build (which reads the ledger un-locked) and now.
      const reservedNow = reservations.reservedOutpoints()
      if (inputKeys.some((k) => reservedNow.has(k))) return false
      reservations.reserve(reservationId, inputKeys, 0)
      return true
    })
    if (!pinned) return false // input claimed by a live game mid-build — retry next tick
    try {
      // Second arg is the batch/round event handler: per-phase visibility for
      // this party's settle, and a loud BatchFailed line if the round dies
      // mid-flight.
      await deps.wallet.settle(params, makeSettlementHandler(label))
      houseVtxoCache.invalidate() // settle spent + minted house VTXOs; drop the stale snapshot
      return true
    } finally {
      reservations.release(reservationId)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/No inputs found/i.test(msg)) return false // nothing eligible — graceful no-op
    // Phantom boarding input: the wallet's cache holds a boarding UTXO whose
    // funding tx arkd can't resolve (e.g. after a chain reset), so every settle
    // dies on that input. It looks confirmed locally, so we can't filter it.
    // Skip this tick with a one-line recovery pointer rather than throwing a
    // stack trace every interval — clear it by redeploying once with
    // RESYNC_WALLET_ON_BOOT=1 (keeps the house key).
    if (/failed to (get|validate) boarding input|boarding input tx/i.test(msg)) {
      console.warn(
        `[${label}] skipped — a cached boarding input is unresolvable on the Ark server: ` +
        `${msg.split('\n')[0]}. Renewal stays stuck until the stale wallet cache is cleared; ` +
        `redeploy once with RESYNC_WALLET_ON_BOOT=1 (preserves the house key).`,
      )
      return false
    }
    throw err
  }
}

/**
 * Migrate house VTXOs minted under a now-deprecated arkd signer (operator key
 * rotation) to the active signer. A plain `settle()` REJECTS deprecated-signer
 * inputs (`INVALID_VTXO_SCRIPT`), so once arkd rotates its signer the renewal
 * jams on those inputs every tick. `migrateDeprecatedSignerVtxos()` self-refreshes
 * the signer set (so the renewal `settle()` then filters them cleanly) and
 * cooperatively migrates pre-cutoff funds; past-cutoff funds it reports as
 * `expired` and they recover on their own after the server sweeps their batch.
 * No-op when nothing is deprecated. Best-effort: a hiccup here must not block the
 * normal renewal settle.
 *
 * Exported for unit testing.
 */
export async function migrateDeprecatedSigners(
  deps: AppDeps,
  log: ReturnType<typeof makeLogDedup> = makeLogDedup(),
): Promise<void> {
  try {
    const vm = await deps.wallet.getVtxoManager()
    const report = await vm.migrateDeprecatedSignerVtxos()
    const legErr = report.vtxos?.error || report.boarding?.error
    if (report.rotated || report.expired.length > 0 || report.signers.length > 0 || legErr) {
      console.log(
        `[renewal] deprecated-signer migration: rotated=${report.rotated}, ` +
        `expired/awaiting-sweep=${report.expired.length}, deprecated-signers=${report.signers.length}` +
        (legErr ? ` (leg error: ${legErr})` : ''),
      )
    }
  } catch (err) {
    const msg = `[renewal] deprecated-signer migration failed: ${err instanceof Error ? err.message : String(err)}`
    if (log.shouldLog('migration', msg)) console.warn(msg)
  }
}

/**
 * Renew iff there's something to do: expiring/recoverable house VTXOs to
 * re-anchor, or confirmed boarding deposits to settle into Ark. This is the
 * SAME gate the installed SDK's `runPeriodicSettle` applies (it returns early
 * unless there's near-expiry or confirmable-boarding work) — we keep it
 * coinflip-side because the settle behind it must stay reservation-aware.
 */
export function shouldRenew(expiringVtxoCount: number, boardingTotalSats: number): boolean {
  return expiringVtxoCount > 0 || boardingTotalSats > 0
}

/** Timeout overrides for `runRenewalTick` (unit tests); defaults are the
 *  shared ARK_SYNC/ARK_SUBMIT bounds. */
export interface RenewalTickOptions {
  /** Bound for wallet reads (getVtxos / getBoardingUtxos). */
  syncTimeoutMs?: number
  /** Bound for the settle and deprecated-signer migration legs. */
  submitTimeoutMs?: number
}

/**
 * One renewal pass. Every await is timeout-bounded: the SDK's providers issue
 * plain fetches with no AbortSignal, and pre-fix a single black-holed
 * `getVtxos`/`getBalance` call here hung the tick forever — the in-flight
 * guard in `startRenewalTimer` then stayed latched and every later tick
 * returned silently, which is indistinguishable from "nothing to do" in the
 * logs. A bounded tick REJECTS instead (logged by the caller), and the next
 * tick runs.
 *
 * Also logs a per-tick pool status line (nearest batch expiry, coins inside
 * the renewal buffer, recoverable sats) so time-to-expiry is visible and
 * alarmable BEFORE arkd sweeps a batch — the production loss surfaced as a
 * zero balance days after the sweep, with nothing in the log ahead of it.
 *
 * Exported for unit testing (drives the full gate → settle chain without
 * timers).
 */
export async function runRenewalTick(
  deps: AppDeps,
  renewalLog: ReturnType<typeof makeLogDedup> = makeLogDedup(),
  opts: RenewalTickOptions = {},
): Promise<void> {
  const syncMs = opts.syncTimeoutMs ?? ARK_SYNC_TIMEOUT_MS
  const submitMs = opts.submitTimeoutMs ?? ARK_SUBMIT_TIMEOUT_MS
  // Key-rotation guard: cooperatively migrate any deprecated-signer VTXOs
  // BEFORE the plain settle below — settle() rejects deprecated-signer inputs
  // (INVALID_VTXO_SCRIPT), so without this the renewal jams once the operator
  // rotates arkd's signer. Self-refreshes the signer set; no-op otherwise.
  await timeoutReject(migrateDeprecatedSigners(deps, renewalLog), submitMs, 'renewal signer migration')
  // Refresh through the cache (shared with /play + pool maintenance) so the
  // tick doubles as a snapshot warmer; boarding comes straight from the
  // wallet. `getVtxos()` defaults to withRecoverable:true, so swept coins are
  // visible here.
  const [all, boardingUtxos] = await Promise.all([
    timeoutReject(houseVtxoCache.refresh(deps), syncMs, 'renewal getVtxos'),
    timeoutReject(deps.wallet.getBoardingUtxos(), syncMs, 'renewal getBoardingUtxos'),
  ])
  renewalLog.clear('renewal') // backend reachable -> reset so a future failure logs fresh
  // VTXOs needing a settle within the RENEWAL buffer (3 days — NOT /play's
  // 30-min selection buffer; see RENEWAL_EXPIRY_BUFFER_MS).
  const { dropped } = selectableHouseVtxos(all, RENEWAL_EXPIRY_BUFFER_MS)
  // A reserved VTXO can't be renewed (the settle excludes it — P0 #53), so
  // it mustn't count toward the gate either: a game's coin nearing the
  // buffer would otherwise fire a settle that can't touch it every tick.
  // It gets renewed on the first tick after the reservation is released.
  const reserved = reservations.reservedOutpoints()
  const droppedFree = dropped.filter((v) => !reserved.has(outpointKey(v.txid, v.vout)))
  // The settle can only confirm CONFIRMED, unexpired boarding deposits
  // (buildReservationSafeSettleParams filters the rest), so gate on the
  // confirmed sum — an unconfirmed deposit shouldn't fire a settle that then
  // no-ops. A confirmed-but-expired boarding UTXO still trips the gate and
  // logs the no-op warning below: that's stuck money worth alarming on.
  const confirmedBoardingSats = boardingUtxos.reduce(
    (sum, u) => sum + (u.status.confirmed ? u.value : 0), 0)
  // Expiry visibility: one status line per tick (the 5-min dedup heartbeat is
  // shorter than the 10-min tick, so this prints every tick by design) — a
  // looming sweep becomes loggable/alarmable days ahead instead of being
  // discovered as a zero balance afterwards, and the line doubles as tick
  // proof-of-life: a gap in status lines means ticks are not completing.
  const spendable = all.filter((v) => isSpendable(v))
  const recoverableSats = spendable
    .filter((v) => v.virtualStatus.state === 'swept')
    .reduce((sum, v) => sum + v.value, 0)
  // Same sanity guard the SDK's expiry helpers apply: regtest stores block
  // HEIGHTS in batchExpiry (tiny numbers → year 1970), which would print as a
  // giant negative time-to-expiry.
  const expiries = spendable
    .map((v) => v.virtualStatus.batchExpiry)
    .filter((e): e is number => typeof e === 'number' && new Date(e).getFullYear() >= 2025)
  const nearestExpiryH = expiries.length > 0 ? Math.floor((Math.min(...expiries) - Date.now()) / 3600_000) : null
  const status =
    `[renewal] pool status: ${spendable.length} vtxo(s), nearest batch expiry ` +
    `${nearestExpiryH === null ? 'n/a' : `~${nearestExpiryH}h`}, ${droppedFree.length} needing renewal ` +
    `(buffer ${Math.round(RENEWAL_EXPIRY_BUFFER_MS / 3600_000)}h), ${recoverableSats} recoverable sat(s), ` +
    `boarding ${confirmedBoardingSats} confirmed sat(s)`
  if (renewalLog.shouldLog('status', status)) console.log(status)
  if (!shouldRenew(droppedFree.length, confirmedBoardingSats)) return
  console.log(`[renewal] settling: ${droppedFree.length} expiring/recoverable VTXO(s), boarding ${confirmedBoardingSats} sats`)
  // renewSettle passes reservation-filtered explicit params through the
  // SDK's settle (proper fee + self-output math). It returns false only
  // when nothing is eligible ("No inputs found" / all reserved / a pin
  // clash) — treat that as a benign skip. On timeout the pin renewSettle
  // took on its inputs lingers until the zombie settle resolves, keeping
  // /play off coins it may still spend.
  const settled = await timeoutReject(renewSettle(deps), submitMs, 'renewal settle')
  if (!settled) {
    const msg =
      `[renewal] shouldRenew saw ${droppedFree.length} expiring + ${confirmedBoardingSats} boarding sats, ` +
      `but found no settle-eligible inputs (fees may exceed tiny VTXOs, boarding expired, or inputs newly reserved); skipping`
    if (renewalLog.shouldLog('renewal-noop', msg)) console.warn(msg)
  }
}

/**
 * Production VTXO-renewal + swept-fund-recovery timer. We keep the SDK
 * settlement poll-loop disabled (settlementConfig:false) because every SDK
 * self-settle path is reservation-blind (see bootstrapDeps in index.ts) and
 * drive the same work through `runRenewalTick` on a long cadence: it settles
 * ONLY when `shouldRenew` says so, renewing house VTXOs inside the SDK-default
 * 3-day buffer, recovering swept ones, and confirming boarding deposits.
 *
 * The in-flight guard prevents overlapping ticks; every await inside the tick
 * is timeout-bounded so the guard cannot latch forever, and a skipped tick
 * WARNS (pre-fix it returned silently, so a wedged tick looked exactly like a
 * healthy idle one).
 */
export function startRenewalTimer(deps: AppDeps, intervalMs = 600_000): NodeJS.Timeout {
  let renewingSince: number | null = null
  const renewalLog = makeLogDedup()
  const tick = async () => {
    if (renewingSince !== null) {
      console.warn(
        `[renewal] previous tick still running after ${Math.round((Date.now() - renewingSince) / 1000)}s — skipping this tick`,
      )
      return
    }
    renewingSince = Date.now()
    try {
      await runRenewalTick(deps, renewalLog)
    } catch (err) {
      const msg = `[renewal] tick failed: ${err instanceof Error ? err.message : String(err)}`
      if (renewalLog.shouldLog('renewal', msg)) console.warn(msg)
    } finally {
      renewingSince = null
    }
  }
  setTimeout(tick, 15_000) // initial pass shortly after boot
  return setInterval(tick, intervalMs)
}

// Cleanup expired pending games every 60 seconds
export function startExpiryTimer(deps: AppDeps): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const { expired, rows } = await deps.repos.games.expirePending(5)
      if (expired > 0) {
        console.log(`Expired ${expired} pending games`)
        for (const g of rows) {
          // Free the reserved house VTXOs so new games can use them.
          reservations.release(g.id)
        }
      }
    } catch (err) {
      console.error('Expiry timer error:', err)
    }
  }, 60_000)
}
