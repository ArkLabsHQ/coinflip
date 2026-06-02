/**
 * Ark batch/round settlement-event handlers.
 *
 * The SDK's `wallet.settle(params?, eventCallback?)` streams the lifecycle of
 * the settlement round (batch) it joins. Without a callback the whole round is
 * a black box: when a settle fails we only see the final thrown error, never
 * WHICH phase failed. Every renewal-settle debugging session this codebase has
 * been through (INVALID_INTENT_PROOF, TX_NOT_FOUND, "proof does not contain
 * outputs") would have been faster with per-phase visibility.
 *
 * This module provides a phase-by-phase handler that any party's settle path
 * (house renewal, admin settle, /play fallback) wires in as its
 * `eventCallback`. It logs each batch phase with the fields that matter, and
 * elevates the terminal failure (BatchFailed) to an error with its reason.
 *
 * The handler is logging/observability only — it does NOT drive the signing
 * (the SDK's settle() owns the MuSig2 nonce/signature exchange internally).
 * It's the "every phase for every party" visibility layer over that.
 */

import { SettlementEventType, type SettlementEvent } from '@arkade-os/sdk'

/** What a settlement-event handler observed across one batch (for callers/tests). */
export interface BatchObservation {
  /** Ordered phase types seen, e.g. ['batch_started','tree_signing_started',...]. */
  phases: SettlementEventType[]
  /** The batch id(s) seen (usually one). */
  batchIds: Set<string>
  /** Set iff the batch failed; carries the arkd-reported reason. */
  failure?: { id: string; reason: string }
  /** Commitment txid once the batch finalized. */
  commitmentTxid?: string
}

export type SettlementHandler = ((event: SettlementEvent) => void) & {
  readonly observation: BatchObservation
}

/** Minimal sink so this is testable without capturing console. */
export interface SettlementLogSink {
  info: (msg: string) => void
  error: (msg: string) => void
}

const defaultSink: SettlementLogSink = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
}

/**
 * Build a settlement-event handler for a settle call.
 *
 * @param label  who is settling — surfaced in every line, e.g. 'renewal',
 *               'admin', 'play-fallback'. This is the "every party" axis.
 * @param sink   log destination (defaults to console); injectable for tests.
 *
 * The returned function is the `eventCallback` for `wallet.settle()`. It also
 * carries a live `observation` so a caller (or test) can assert what happened
 * without scraping logs.
 */
export function makeSettlementHandler(
  label: string,
  sink: SettlementLogSink = defaultSink,
): SettlementHandler {
  const observation: BatchObservation = { phases: [], batchIds: new Set() }
  const tag = `[batch:${label}]`

  const handler = ((event: SettlementEvent): void => {
    observation.phases.push(event.type)
    // Every event after StreamStarted carries a batch id.
    if ('id' in event && event.id) observation.batchIds.add(event.id)

    switch (event.type) {
      case SettlementEventType.StreamStarted:
        sink.info(`${tag} stream started`)
        break
      case SettlementEventType.BatchStarted:
        sink.info(
          `${tag} batch ${event.id} started — ${event.intentIdHashes.length} intent(s), expiry ${event.batchExpiry}`,
        )
        break
      case SettlementEventType.TreeSigningStarted:
        sink.info(
          `${tag} batch ${event.id} tree-signing started — ${event.cosignersPublicKeys.length} cosigner(s)`,
        )
        break
      case SettlementEventType.TreeNonces:
        sink.info(`${tag} batch ${event.id} tree nonces (txid ${event.txid})`)
        break
      case SettlementEventType.TreeTx:
        sink.info(`${tag} batch ${event.id} tree tx (batchIndex ${event.batchIndex})`)
        break
      case SettlementEventType.TreeSignature:
        sink.info(`${tag} batch ${event.id} tree signature (txid ${event.txid})`)
        break
      case SettlementEventType.BatchFinalization:
        sink.info(`${tag} batch ${event.id} finalizing`)
        break
      case SettlementEventType.BatchFinalized:
        observation.commitmentTxid = event.commitmentTxid
        sink.info(`${tag} batch ${event.id} FINALIZED — commitment ${event.commitmentTxid}`)
        break
      case SettlementEventType.BatchFailed:
        observation.failure = { id: event.id, reason: event.reason }
        // Terminal failure: surface the phase + reason loudly. This is the
        // line that turns "settle threw" into "the round failed at the batch
        // stage because <reason>".
        sink.error(`${tag} batch ${event.id} FAILED — ${event.reason}`)
        break
      default: {
        // Exhaustiveness guard: a new SettlementEventType added upstream
        // should surface as an unknown-phase log rather than be silently
        // dropped.
        const unknown = event as { type?: string }
        sink.info(`${tag} unhandled settlement event: ${unknown.type ?? 'unknown'}`)
      }
    }
  }) as SettlementHandler

  Object.defineProperty(handler, 'observation', { value: observation, enumerable: true })
  return handler
}
