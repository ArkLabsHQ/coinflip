/**
 * `timeoutReject` bounds the arkd submit/finalize + house getVtxos calls on the money
 * path, so a wedged arkd can't hang every game through withArkSubmit/selectionMutex.
 * Pins: pass-through on resolve, no masking on reject, labelled timeout on a stall.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
export {}
const { timeoutReject } = require('arkade-coinflip-server/dist/async-timeout.js')

describe('timeoutReject', () => {
  it('passes a value through when it resolves before the timeout', async () => {
    await expect(timeoutReject(Promise.resolve('ok'), 1000, 'x')).resolves.toBe('ok')
  })
  it('passes a rejection through unchanged (never masks a real error)', async () => {
    await expect(timeoutReject(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
  })
  it('rejects with a labelled timeout when the promise stalls', async () => {
    await expect(timeoutReject(new Promise(() => {}), 20, 'arkd submitTx')).rejects.toThrow(
      /arkd submitTx timed out after 20ms/,
    )
  })
})
