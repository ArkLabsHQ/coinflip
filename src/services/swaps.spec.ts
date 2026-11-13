import { describe, expect, it, vi } from 'vitest'
import type { Swap, SwapClient, SwapUpdate } from '@arkade-os/swap'
import { requireSats, waitForSwap } from './swaps'

function source(replay?: SwapUpdate) {
  let listener: ((update: SwapUpdate) => void) | undefined
  const unsubscribe = vi.fn(() => { listener = undefined })
  const client: Pick<SwapClient, 'onUpdate'> = {
    onUpdate(fn) { listener = fn; if (replay) fn(replay); return unsubscribe },
  }
  return { client, unsubscribe, emit: (update: SwapUpdate) => listener?.(update) }
}
const update = (id: string, outcome: SwapUpdate['outcome']): SwapUpdate => ({
  swap: { id, outcome } as Swap,
  outcome,
  detail: {} as SwapUpdate['detail'],
})

describe('swap observation lifecycle', () => {
  it('only completes for the requested swap and releases its subscription', async () => {
    const events = source()
    const waiting = waitForSwap(events.client, 'mine', ['claimed'], new AbortController().signal)
    events.emit(update('other', 'claimed'))
    expect(events.unsubscribe).not.toHaveBeenCalled()
    events.emit(update('mine', 'claimed'))
    expect((await waiting).id).toBe('mine')
    expect(events.unsubscribe).toHaveBeenCalledOnce()
  })

  it('cleans up a terminal state replayed during subscription', async () => {
    const events = source(update('mine', 'paid'))
    await waitForSwap(events.client, 'mine', ['paid'], new AbortController().signal)
    expect(events.unsubscribe).toHaveBeenCalledOnce()
  })

  it('closing a view stops waiting and unsubscribes without cancelling the payment', async () => {
    const events = source()
    const controller = new AbortController()
    const waiting = waitForSwap(events.client, 'mine', ['claimed'], controller.signal)
    controller.abort(new Error('View closed'))
    await expect(waiting).rejects.toThrow('View closed')
    expect(events.unsubscribe).toHaveBeenCalledOnce()
    events.emit(update('mine', 'claimed'))
    expect(events.unsubscribe).toHaveBeenCalledOnce()
  })

  it('surfaces recovery instead of waiting forever or calling it paid', async () => {
    const events = source()
    const waiting = waitForSwap(events.client, 'mine', ['paid'], new AbortController().signal)
    events.emit(update('mine', 'needs_recovery'))
    await expect(waiting).rejects.toThrow('needs recovery')
    expect(events.unsubscribe).toHaveBeenCalledOnce()
  })
})

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid sats before a payment: %s', (amount) => {
  expect(() => requireSats(amount)).toThrow('positive whole number')
})
