import {
  ArkAddress,
  CSVMultisigTapscript,
  Estimator,
  hasBoardingTxExpired,
  isSubdust,
  isVtxoExpiringSoon,
  canRecoverOnchain,
  isVtxoSpent,
  isVirtualCoin,
  VtxoReservedError,
  SettlementEventType,
  type ExtendedCoin,
  type NormalizedExtendedVirtualCoin,
  type SettleParams,
} from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { makeSettlementHandler } from './settlement-events.js'
import {
  reservations,
  HouseBusyError,
  houseVtxoCache,
  selectionMutex,
  outpointKey,
} from './vtxo-pool.js'
import { timeoutReject, ARK_SYNC_TIMEOUT_MS, ARK_SUBMIT_TIMEOUT_MS } from './async-timeout.js'
import type { AppDeps } from './deps.js'
import { makeLogDedup } from './log-dedup.js'
import { HOUSE_RENEWAL_INTERVAL_MS, houseRenewalBufferForWalletMs, rememberCompletedHouseBatchLifetime, VTXO_LIFETIME_BUFFER_MS } from './house-renewal-policy.js'
export { RENEWAL_EXPIRY_BUFFER_MS, VTXO_LIFETIME_BUFFER_MS } from './house-renewal-policy.js'

/** Renew near-expiry outputs and recover unspent swept/expired outputs. */
export function vtxoNeedsRenewal(v: NormalizedExtendedVirtualCoin, bufferMs: number): boolean {
  return isVtxoExpiringSoon(v, bufferMs) || canRecoverOnchain(v, { timestamp: new Date(), height: houseVtxoCache.chainHeight })
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
  vtxos: NormalizedExtendedVirtualCoin[],
  bufferMs = VTXO_LIFETIME_BUFFER_MS,
): { selectable: NormalizedExtendedVirtualCoin[]; dropped: NormalizedExtendedVirtualCoin[] } {
  const selectable: NormalizedExtendedVirtualCoin[] = []
  const dropped: NormalizedExtendedVirtualCoin[] = []
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
  vtxoFilter?: (v: NormalizedExtendedVirtualCoin) => boolean
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
    .filter((v) => !v.assets?.length)
    .filter((v) => !reserved.has(outpointKey(v.txid, v.vout)))
    .filter((v) => (opts.vtxoFilter ? opts.vtxoFilter(v) : true))
    .sort((a, b) => b.value - a.value)
  const filteredVtxos: NormalizedExtendedVirtualCoin[] = []
  for (const vtxo of vtxos) {
    if (filteredVtxos.length >= MAX_VTXOS_PER_SETTLEMENT) break
    const inputFee = estimator.evalOffchainInput({
      amount: BigInt(vtxo.value),
      type: vtxo.isSwept ? 'recoverable' : 'vtxo',
      weight: 0,
      birth: vtxo.createdAt,
      expiry: vtxo.expiresAt,
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

/** Renew only due inputs. A competing hold defers work; all other failures remain visible. */
export async function renewSettle(deps: AppDeps, label = 'renewal', bufferMs = houseRenewalBufferForWalletMs(deps.wallet, deps.arkInfo)): Promise<boolean> {
  try {
    const params = await buildReservationSafeSettleParams(deps, {
      vtxoFilter: (v) => vtxoNeedsRenewal(v, bufferMs),
    })
    if (!params) return false // nothing eligible once reserved coins are excluded
    await settleHeldInputs(deps, params, label)
    return true
  } catch (err) {
    if (err instanceof HouseBusyError || err instanceof VtxoReservedError) return false
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

/** Hold explicit settlement inputs until the underlying operation completes. */
export async function settleHeldInputs(deps: AppDeps, params: SettleParams, label: string): Promise<string> {
  const inputKeys = params.inputs
    .filter(isVirtualCoin)
    .map((input) => outpointKey(input.txid, input.vout))
  const reservationId = `settlement:${++renewalReservationSeq}`
  await selectionMutex.runExclusive(async () => reservations.reserve(reservationId, inputKeys, 0))
  try {
    const log = makeSettlementHandler(label), started = new Map<string, bigint>(), finalized = new Map<string, string>()
    const txid = await deps.wallet.settle(params, event => {
      log(event)
      if (event.type === SettlementEventType.BatchStarted) started.set(event.id, event.batchExpiry)
      if (event.type === SettlementEventType.BatchFinalized) finalized.set(event.id, event.commitmentTxid)
    })
    for (const [id, commitment] of finalized) {
      const lifetime = started.get(id)
      if (commitment === txid && lifetime !== undefined) rememberCompletedHouseBatchLifetime(deps.wallet, lifetime)
    }
    houseVtxoCache.invalidate()
    return txid
  } finally {
    reservations.release(reservationId)
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
    // Aggregate the PER-SIGNER recovery numbers. Logging only `signers.length`
    // hid exactly the case that matters: VTXOs stranded under a ROTATED signer
    // live on a different script, so they never appear in the wallet's balance
    // or in `getRecoverableBalance()` — a bare "deprecated-signers=1" told an
    // operator nothing about whether value was sitting there. `recoverable*`
    // drains on the next recovery pass; `awaitingSweep*` is wait-only.
    const sum = (pick: (s: (typeof report.signers)[number]) => number | undefined): number =>
      report.signers.reduce((acc, s) => acc + (pick(s) ?? 0), 0)
    const recoverableValue = sum((s) => s.recoverableValue)
    const recoverableCount = sum((s) => s.recoverableCount)
    const awaitingSweepValue = sum((s) => s.awaitingSweepValue)
    const awaitingSweepCount = sum((s) => s.awaitingSweepCount)
    if (report.rotated || report.expired.length > 0 || report.signers.length > 0 || legErr) {
      console.log(
        `[renewal] deprecated-signer migration: rotated=${report.rotated}, ` +
        `expired/awaiting-sweep=${report.expired.length}, deprecated-signers=${report.signers.length}, ` +
        `recoverable=${recoverableValue} sat(s)/${recoverableCount} vtxo(s), ` +
        `awaiting-sweep=${awaitingSweepValue} sat(s)/${awaitingSweepCount} vtxo(s)` +
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
  intervalMs?: number
  /** Bound for wallet reads (getVtxos / getBoardingUtxos). */
  syncTimeoutMs?: number
  /** Bound for the settle and deprecated-signer migration legs. */
  submitTimeoutMs?: number
}

/** Run migration, recovery and renewal with bounded waits. An unavailable provider must not wedge later ticks. */
export async function runRenewalTick(
  deps: AppDeps,
  renewalLog: ReturnType<typeof makeLogDedup> = makeLogDedup(),
  opts: RenewalTickOptions = {},
): Promise<void> {
  const syncMs = opts.syncTimeoutMs ?? ARK_SYNC_TIMEOUT_MS
  const submitMs = opts.submitTimeoutMs ?? ARK_SUBMIT_TIMEOUT_MS
  const bufferMs = houseRenewalBufferForWalletMs(deps.wallet, deps.arkInfo, { intervalMs: opts.intervalMs, syncTimeoutMs: syncMs, submitTimeoutMs: submitMs })
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
  const { dropped } = selectableHouseVtxos(all, bufferMs)
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
  const spendable = all.filter((v) => !isVtxoSpent(v) && !v.isUnrolled)
  const recoverableSats = spendable
    .filter((v) => v.isSwept)
    .reduce((sum, v) => sum + v.value, 0)
  // Same sanity guard the SDK's expiry helpers apply: regtest stores block
  // HEIGHTS in batchExpiry (tiny numbers → year 1970), which would print as a
  // giant negative time-to-expiry.
  const expiries = spendable
    .map((v) => v.expiresAt?.getTime())
    .filter((e): e is number => typeof e === 'number' && new Date(e).getFullYear() >= 2025)
  const nearestExpiryH = expiries.length > 0 ? Math.floor((Math.min(...expiries) - Date.now()) / 3600_000) : null
  const status =
    `[renewal] pool status: ${spendable.length} vtxo(s), nearest batch expiry ` +
    `${nearestExpiryH === null ? 'n/a' : `~${nearestExpiryH}h`}, ${droppedFree.length} needing renewal ` +
    `(buffer ${Math.round(bufferMs / 60_000)}m), ${recoverableSats} recoverable sat(s), ` +
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
  const settled = await timeoutReject(renewSettle(deps, 'renewal', bufferMs), submitMs, 'renewal settle')
  if (!settled) {
    const msg =
      `[renewal] shouldRenew saw ${droppedFree.length} expiring + ${confirmedBoardingSats} boarding sats, ` +
      `but found no settle-eligible inputs (fees may exceed tiny VTXOs, boarding expired, or inputs newly reserved); skipping`
    if (renewalLog.shouldLog('renewal-noop', msg)) console.warn(msg)
  }
}

/** Drive house renewal separately so it preserves the denomination pool. SDK holds also protect games from automatic selection. */
export function startRenewalTimer(deps: AppDeps, intervalMs = HOUSE_RENEWAL_INTERVAL_MS): NodeJS.Timeout {
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
      await runRenewalTick(deps, renewalLog, { intervalMs })
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
