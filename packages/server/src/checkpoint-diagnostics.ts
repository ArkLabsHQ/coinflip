/**
 * Log-only diagnostics for the co-fund finalize path.
 *
 * When arkd rejects a checkpoint at finalizeTx with INVALID_SIGNATURE, the server
 * dumps each checkpoint's spend-leaf keys + which keys actually signed, next to the
 * house/server keys, so we can see WHOSE signature arkd found missing/invalid —
 * without changing any behaviour (the original error is always re-thrown).
 *
 * Pure (no SDK) so `leafPubkeys` is unit-testable; the caller does the PSBT parsing.
 */
import { hex } from '@scure/base'

/**
 * The 32-byte x-only pubkeys pushed in a tapscript leaf, as hex. The argument is a
 * leaf script WITH its trailing 1-byte leaf version (btc-signer's `TapLeafScript[1]`
 * shape). Heuristic scan of `OP_PUSHBYTES_32` (0x20) pushes — good enough for a log
 * line, not for consensus.
 */
export function leafPubkeys(scriptWithVersion: Uint8Array | undefined): string[] {
  if (!scriptWithVersion || scriptWithVersion.length < 34) return []
  const s = scriptWithVersion.subarray(0, -1) // drop the leaf-version byte
  const keys: string[] = []
  for (let i = 0; i + 33 <= s.length; ) {
    if (s[i] === 0x20) {
      keys.push(hex.encode(s.subarray(i + 1, i + 33)))
      i += 33
    } else {
      i += 1
    }
  }
  return keys
}
