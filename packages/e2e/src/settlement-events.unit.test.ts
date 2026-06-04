/**
 * Unit tests for the Ark batch/round settlement-event handler (no regtest).
 *
 * The handler is the per-phase observability layer over wallet.settle() — it
 * turns the black-box round into a logged sequence and elevates BatchFailed to
 * an error line with arkd's reason. These tests assert it records every phase,
 * captures the failure reason, and never throws (a logging handler must not
 * break the settle it's observing).
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const { makeSettlementHandler } = require('arkade-coinflip-server/dist/settlement-events.js')
const { SettlementEventType } = require('@arkade-os/sdk')

function captureSink() {
  const info: string[] = []
  const error: string[] = []
  return { info: (m: string) => info.push(m), error: (m: string) => error.push(m), _info: info, _error: error }
}

describe('makeSettlementHandler (batch/round event handler)', () => {
  it('records the ordered phase sequence and batch id of a successful round', () => {
    const sink = captureSink()
    const h = makeSettlementHandler('renewal', sink)
    h({ type: SettlementEventType.StreamStarted, id: 'b1' } as any)
    h({ type: SettlementEventType.BatchStarted, id: 'b1', intentIdHashes: ['x'], batchExpiry: 1024n } as any)
    h({ type: SettlementEventType.TreeSigningStarted, id: 'b1', cosignersPublicKeys: ['k1', 'k2'], unsignedCommitmentTx: '' } as any)
    h({ type: SettlementEventType.BatchFinalized, id: 'b1', commitmentTxid: 'deadbeef' } as any)

    expect(h.observation.phases).toEqual([
      SettlementEventType.StreamStarted,
      SettlementEventType.BatchStarted,
      SettlementEventType.TreeSigningStarted,
      SettlementEventType.BatchFinalized,
    ])
    expect([...h.observation.batchIds]).toEqual(['b1'])
    expect(h.observation.commitmentTxid).toBe('deadbeef')
    expect(h.observation.failure).toBeUndefined()
    // Label appears in the lines so concurrent settles are distinguishable.
    expect(sink._info.some((l) => l.includes('[batch:renewal]'))).toBe(true)
  })

  it('captures the failure reason and logs it to error on BatchFailed', () => {
    const sink = captureSink()
    const h = makeSettlementHandler('admin', sink)
    h({ type: SettlementEventType.BatchStarted, id: 'b9', intentIdHashes: [], batchExpiry: 0n } as any)
    h({ type: SettlementEventType.BatchFailed, id: 'b9', reason: 'INVALID_INTENT_PROOF (23): missing signature' } as any)

    expect(h.observation.failure).toEqual({ id: 'b9', reason: 'INVALID_INTENT_PROOF (23): missing signature' })
    expect(sink._error.some((l) => l.includes('FAILED') && l.includes('missing signature'))).toBe(true)
  })

  it('never throws on an unknown/future event type (forward-compatible)', () => {
    const sink = captureSink()
    const h = makeSettlementHandler('play-fallback', sink)
    expect(() => h({ type: 'some_future_event' } as any)).not.toThrow()
    expect(sink._info.some((l) => l.includes('unhandled settlement event'))).toBe(true)
  })

  it('isolates observations per handler instance (no shared state)', () => {
    const a = makeSettlementHandler('a', captureSink())
    const b = makeSettlementHandler('b', captureSink())
    a({ type: SettlementEventType.BatchStarted, id: 'ba', intentIdHashes: [], batchExpiry: 0n } as any)
    expect(a.observation.phases).toHaveLength(1)
    expect(b.observation.phases).toHaveLength(0)
  })
})

export {}
