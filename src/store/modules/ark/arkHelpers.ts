import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import type { ClaimMode } from './arkTypes'

/**
 * Cryptographically-uniform integer in `[0, n)` via `crypto.getRandomValues`
 * (CSPRNG) with rejection sampling. The variable-odds digit the player picks is
 * encoded into its revealed secret length, so a `Math.random()`-derived digit
 * would leak the non-crypto PRNG's state across games and let an observer
 * predict the next pick. Mirrors the lib's server-side `randomUniformInt`.
 */
export function uniformRandomInt(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`uniformRandomInt: n must be a positive integer (got ${n})`)
  if (n === 1) return 0
  const bytes = Math.ceil(Math.log2(n) / 8) || 1
  const max = 256 ** bytes
  const limit = max - (max % n)
  const buf = new Uint8Array(bytes)
  for (;;) {
    crypto.getRandomValues(buf)
    let x = 0
    for (const b of buf) x = x * 256 + b
    if (x < limit) return x % n
  }
}

/** Address → pkScript hex — the dense `ArkAddress.decode(...).pkScript` chain,
 *  named once so its three call sites read as intent, not bit-twiddling. */
export function addressToPkScriptHex(address: string): string {
  return hex.encode(ArkAddress.decode(address).pkScript)
}

/**
 * Both claim actions accept either a bare gameId (legacy callers) or a
 * `{ gameId, mode }` object. Normalise to the object form, defaulting `mode` to
 * 'manual' (a user click) when unspecified.
 */
export function parseClaimPayload(
  payload: string | { gameId: string; mode?: ClaimMode },
): { gameId: string; mode: ClaimMode } {
  return typeof payload === 'string'
    ? { gameId: payload, mode: 'manual' }
    : { gameId: payload.gameId, mode: payload.mode ?? 'manual' }
}
