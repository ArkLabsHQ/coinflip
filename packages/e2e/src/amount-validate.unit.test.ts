/**
 * Regression unit test for the admin Send-amount classifier (no regtest).
 *
 * The field is integer SATS. Entering a BTC decimal (0.005) used to hit
 * parseInt("0.005") === 0 → failed the amount<=0 guard → misleading "Enter an
 * address and amount". classifySendAmount uses Number() so the decimal is
 * preserved and flagged as a likely BTC amount with a suggested sats value.
 * (commit 35f48dc). This imports the SAME dual-target file the dashboard loads
 * in the browser, so there's no drift between tested and shipped logic.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { classifySendAmount } = require('arkade-coinflip-server/dist/admin/amount-validate.js')

describe('classifySendAmount (admin Send field)', () => {
  it('flags empty input', () => {
    expect(classifySendAmount('')).toEqual({ state: 'empty' })
    expect(classifySendAmount('   ')).toEqual({ state: 'empty' })
    expect(classifySendAmount(null)).toEqual({ state: 'empty' })
  })

  it('rejects non-positive / non-numeric', () => {
    expect(classifySendAmount('0').state).toBe('invalid')
    expect(classifySendAmount('-5').state).toBe('invalid')
    expect(classifySendAmount('abc').state).toBe('invalid')
  })

  it('catches the BTC-in-a-sats-field mistake and suggests sats', () => {
    // The actual bug report: 0.005 typed into a sats field.
    expect(classifySendAmount('0.005')).toEqual({ state: 'fractional', suggestedSats: 500_000 })
    expect(classifySendAmount('0.1')).toEqual({ state: 'fractional', suggestedSats: 10_000_000 })
  })

  it('accepts whole sats and renders a trimmed BTC display', () => {
    expect(classifySendAmount('500000')).toEqual({ state: 'ok', sats: 500_000, btc: '0.005' })
    expect(classifySendAmount('1')).toEqual({ state: 'ok', sats: 1, btc: '0.00000001' })
    expect(classifySendAmount('100000000')).toEqual({ state: 'ok', sats: 100_000_000, btc: '1' })
  })

  it('trims trailing zeros (and the dot) off the BTC display', () => {
    // 50_000_000 sats = 0.5 BTC — not "0.50000000".
    expect(classifySendAmount('50000000').btc).toBe('0.5')
  })
})

export {}
