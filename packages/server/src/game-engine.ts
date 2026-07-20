import { isVtxoExpiringSoon, isExpired, isSpendable, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import { makeSettlementHandler } from './settlement-events.js'
import {
  reservations,
  houseVtxoCache,
} from './vtxo-pool.js'
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
    if (isVtxoExpiringSoon(v, bufferMs) || (isSpendable(v) && isExpired(v))) {
      dropped.push(v)
    } else {
      selectable.push(v)
    }
  }
  return { selectable, dropped }
}

/**
 * Settle to renew expiring house VTXOs / confirm boarding deposits.
 *
 * Delegates to the SDK's no-arg `settle()`, which already does the right
 * thing: it filters boarding UTXOs to `status.confirmed && !expired`, filters
 * VTXOs (incl. recoverable), subtracts the per-input intent fee from each, and
 * builds a single self-output for the net amount. We must NOT pass an explicit
 * `{ inputs, outputs: [] }` — empty outputs makes arkd reject the intent proof
 * ("proof does not contain outputs"), and hand-rolling the fee + self-output
 * math would duplicate version-specific SDK internals that drift.
 *
 * Returns true if a settle round ran, false when there's nothing eligible
 * (the SDK throws "No inputs found", which we treat as a graceful no-op so the
 * renewal worker doesn't log it as a failure).
 *
 * NOTE on phantom inputs: if the wallet's persisted DB holds a boarding UTXO
 * that arkd has lost (e.g. a regtest chain reset where the wallet volume
 * outlived the chain), the SDK's `status.confirmed` filter can still include
 * it and the settle fails with TX_NOT_FOUND. That's a stale-wallet condition
 * that a wallet resync/wipe resolves — not something the renewal path can
 * filter around, since the phantom looks confirmed in the wallet's own view.
 */
export async function renewSettle(deps: AppDeps, label = 'renewal'): Promise<boolean> {
  try {
    // First arg stays undefined → SDK does its default input gathering + fee +
    // self-output math (do NOT pass an explicit empty-outputs set). Second arg
    // is the batch/round event handler: per-phase visibility for this party's
    // settle, and a loud BatchFailed line if the round dies mid-flight.
    await deps.wallet.settle(undefined, makeSettlementHandler(label))
    houseVtxoCache.invalidate() // settle spent + minted house VTXOs; drop the stale snapshot
    return true
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
 * Renew iff there's something to do: expiring house VTXOs to re-anchor, or
 * boarding deposits to confirm into Ark. This is the SAME gate the installed
 * SDK's `runPeriodicSettle` now applies (it returns early unless there's
 * near-expiry or confirmable-boarding work, and prices the intent fee) — so the
 * old "blind poll-loop finalizes every preconfirmed VTXO and drains ~5k/flip"
 * fear no longer describes the SDK. We keep the gate coinflip-side because
 * `/play`'s coin-selection needs renewal coupled to its own 30-min buffer (see
 * startRenewalTimer + selectableHouseVtxos).
 */
export function shouldRenew(expiringVtxoCount: number, boardingTotalSats: number): boolean {
  return expiringVtxoCount > 0 || boardingTotalSats > 0
}

/**
 * Production VTXO-renewal timer. We keep the SDK settlement poll-loop disabled
 * (settlementConfig:false) and drive renewal on a long cadence that fires ONLY
 * when `shouldRenew` says so — renewing house VTXOs before their batch expiry and
 * confirming boarding deposits. NB: the installed SDK's poll-loop is itself gated
 * + fee-aware now, so this is NOT about avoiding a per-poll fee drain; we own the
 * renewal so it stays coupled to `/play`'s selection buffer (below).
 * A `renewing` guard prevents overlapping settles if one runs long.
 *
 * `selectableHouseVtxos` flags VTXOs expiring within the buffer OR already
 * expired/swept (recoverable), so the renewal re-settles them before `/play`
 * could pick one — arkd rejects spending a swept VTXO with VTXO_RECOVERABLE.
 * This works on regtest too (where batches are swept by block height), via the
 * timestamp/`swept`-state checks in `isExpired`.
 */
export function startRenewalTimer(deps: AppDeps, intervalMs = 600_000): NodeJS.Timeout {
  let renewing = false
  const renewalLog = makeLogDedup()
  const tick = async () => {
    if (renewing) return
    renewing = true
    try {
      // Key-rotation guard: cooperatively migrate any deprecated-signer VTXOs
      // BEFORE the plain settle below — settle() rejects deprecated-signer inputs
      // (INVALID_VTXO_SCRIPT), so without this the renewal jams once the operator
      // rotates arkd's signer. Self-refreshes the signer set; no-op otherwise.
      await migrateDeprecatedSigners(deps, renewalLog)
      const [balance, all] = await Promise.all([deps.wallet.getBalance(), deps.wallet.getVtxos()])
      renewalLog.clear('renewal') // backend reachable -> reset so a future failure logs fresh
      const { dropped } = selectableHouseVtxos(all) // VTXOs expiring within the buffer
      if (!shouldRenew(dropped.length, balance.boarding.total)) return
      console.log(`[renewal] settling: ${dropped.length} expiring VTXO(s), boarding ${balance.boarding.total} sats`)
      // renewSettle delegates to the SDK's no-arg settle() (proper fee +
      // self-output math). It returns false only when the SDK finds nothing
      // eligible ("No inputs found") — treat that as a benign skip.
      const settled = await renewSettle(deps)
      if (!settled) {
        console.warn(
          `[renewal] shouldRenew saw ${dropped.length} expiring + ${balance.boarding.total} boarding sats, ` +
          `but the SDK found no settle-eligible inputs (fees may exceed tiny VTXOs, or boarding unconfirmed); skipping`,
        )
      }
    } catch (err) {
      const msg = `[renewal] tick failed: ${err instanceof Error ? err.message : String(err)}`
      if (renewalLog.shouldLog('renewal', msg)) console.warn(msg)
    } finally {
      renewing = false
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
