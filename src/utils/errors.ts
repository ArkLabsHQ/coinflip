/**
 * Normalise any thrown value into a human-readable string.
 *
 * JavaScript lets code `throw` literally anything — an Error, a string, a
 * number, null, a plain object — so every `catch` that wants to log or surface
 * a reason has to handle the non-Error case. This codebase did that inline
 * ~13 times as `e instanceof Error ? e.message : e` (and a couple as
 * `... : String(e)`), an easy spot for drift. Centralising it here fixes the
 * policy in one place:
 *
 *   - a real `Error` (or subclass) ⇒ its `.message` (the useful part);
 *   - anything else ⇒ `String(value)` (so `null` → "null", `503` → "503",
 *     a plain object → "[object Object]"), which never throws.
 *
 * Pure and total: returns a string for every possible input.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Map a raw (usually arkd) error message to a short, plain-English explanation
 * for a toast. Falls back to the raw string so nothing is hidden — the verbatim
 * message is always in the diagnostics log regardless (see diagnosticsLog.ts).
 * Pure + total: returns a string for every input.
 */
export function friendlyError(raw: string): string {
  // arkd rejects a settle/reclaim whose input set includes a VTXO whose signer
  // was rotated and is PAST its migration cutoff ("invalid vtxo script … since
  // <date>"). Those funds are NOT lost — they auto-recover on-chain once their
  // batch is swept; the user need do nothing. (See coinflip-server renewal
  // signer-rotation handling + the pre-settle migrateDeprecatedSignerVtxos.)
  if (/invalid[_ ]vtxo[_ ]script/i.test(raw)) {
    return "Some funds can't be reclaimed right now — a server key rotation left them pending on-chain. They return automatically once their batch is swept, so no action is needed."
  }
  return raw
}
