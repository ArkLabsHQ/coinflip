/**
 * Pure classifier for the admin "Move funds out" amount field. Dual-target so
 * ONE source of truth serves both the browser (dashboard.html loads it as a
 * classic <script> and calls window.AmountValidate.classifySendAmount) and the
 * Node test suite (require()). No drift between what ships and what's tested.
 *
 * Regression context: the field is integer SATS, but entering a BTC-style
 * decimal (0.005) hit parseInt("0.005") === 0, which failed the amount<=0
 * guard and surfaced the misleading "Enter an address and amount" — the field
 * wasn't empty, the value was silently truncated to zero. Number() (not
 * parseInt) preserves the decimal so we can detect the unit mistake and
 * suggest the sats value. (commit 35f48dc)
 *
 * Returns one of:
 *   { state: 'empty' }                       — nothing entered
 *   { state: 'invalid' }                     — not a positive number
 *   { state: 'fractional', suggestedSats }   — looks like BTC; suggest sats
 *   { state: 'ok', sats, btc }               — valid whole sats + BTC display
 */
(function (root) {
  function classifySendAmount(raw) {
    const s = String(raw == null ? '' : raw).trim()
    if (s === '') return { state: 'empty' }
    const n = Number(s)
    if (!Number.isFinite(n) || n <= 0) return { state: 'invalid' }
    if (!Number.isInteger(n)) {
      // A decimal in a sats field is almost always a BTC amount.
      return { state: 'fractional', suggestedSats: Math.round(n * 1e8) }
    }
    // Valid whole sats. Trim trailing zeros off the BTC display.
    const btc = (n / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
    return { state: 'ok', sats: n, btc: btc }
  }

  const api = { classifySendAmount: classifySendAmount }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.AmountValidate = api
})(typeof window !== 'undefined' ? window : globalThis)
