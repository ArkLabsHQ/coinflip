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
