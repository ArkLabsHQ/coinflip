/**
 * Signature-proof challenge/response for the "restore my games" endpoint.
 *
 * The restore read is gated on proof that the caller controls the private key
 * behind the `playerPubkey` it's asking about — without it, anyone could pull a
 * player's game history (and, for v4, their pot/reclaim hints) by guessing the
 * pubkey. The scheme is a stateless challenge:
 *
 *   1. GET /api/games/challenge?playerPubkey=PK  -> issueChallenge(PK, now)
 *      returns nonce = "${ts}.${mac}", mac = HMAC(SERVER_SECRET, "${PK}.${ts}").
 *      The HMAC binds the nonce to BOTH the pubkey and the issue time, so the
 *      server keeps NO per-challenge state — it re-derives and checks the MAC.
 *   2. The client schnorr-signs sha256(utf8(nonce)) with PK's key and calls
 *      GET /api/games?...&nonce=NONCE&sig=SIG.
 *   3. verifyChallenge(PK, nonce, sig, now) passes only if (a) the MAC proves WE
 *      issued this nonce for THIS pubkey, (b) it's still fresh, and (c) the
 *      signature verifies against PK — i.e. the caller holds PK's key.
 *
 * SERVER_SECRET is a per-process random key, so a process restart invalidates
 * outstanding challenges (acceptable — the client just re-fetches one). It is
 * never persisted or exposed.
 *
 * SECURITY NOTES
 *  - Replay: a (nonce, sig) pair is replayable within the TTL window by anyone
 *    who observes it. That is acceptable here because the protected action is a
 *    read of the caller's OWN data over TLS; a replay reveals nothing the holder
 *    of the signature wasn't already entitled to read. The short TTL bounds it.
 *  - The verify path is wrapped so malformed input (bad hex, wrong length,
 *    empty strings) returns false rather than throwing out of the function.
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'crypto'
import { schnorr } from '@noble/curves/secp256k1.js'

/** Per-process HMAC key binding nonces to (pubkey, ts). Never persisted/exposed. */
const SERVER_SECRET = randomBytes(32)

/** A nonce is valid for this long after issuance. Short, since the client fetches
 *  a challenge immediately before signing. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000 // 2 minutes

/** Recompute the MAC that binds a nonce to (playerPubkey, ts). */
function computeMac(playerPubkey: string, ts: number): Buffer {
  return createHmac('sha256', SERVER_SECRET).update(`${playerPubkey}.${ts}`).digest()
}

/**
 * Issue a stateless challenge nonce for `playerPubkey` at `nowMs`.
 * Returns `"${ts}.${mac}"` where ts = nowMs and mac is the hex HMAC over
 * `"${playerPubkey}.${ts}"`. Pure given (pubkey, now, SERVER_SECRET).
 */
export function issueChallenge(playerPubkey: string, nowMs: number): string {
  const ts = Math.floor(nowMs)
  const mac = computeMac(playerPubkey, ts).toString('hex')
  return `${ts}.${mac}`
}

/** Normalize a pubkey hex to its 32-byte x-only form. Accepts an x-only key
 *  (64 hex) as-is or a 33-byte compressed key (66 hex), dropping the parity
 *  byte. Throws on anything else (caller catches → false). */
function toXOnlyHex(pubkeyHex: string): string {
  const pk = pubkeyHex.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(pk)) throw new Error('pubkey not hex')
  if (pk.length === 64) return pk
  if (pk.length === 66 && (pk.startsWith('02') || pk.startsWith('03'))) return pk.slice(2)
  throw new Error(`unexpected pubkey length ${pk.length}`)
}

function hexToBytes(h: string): Uint8Array {
  const clean = h.trim().toLowerCase()
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error('invalid hex')
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Verify a challenge response. Returns true ONLY if ALL hold:
 *  (a) the nonce's MAC equals HMAC(SERVER_SECRET, "${playerPubkey}.${ts}")
 *      recomputed (timing-safe) — proves we issued THIS nonce for THIS pubkey;
 *  (b) freshness: 0 <= nowMs - ts <= CHALLENGE_TTL_MS;
 *  (c) schnorr.verify(sig, sha256(utf8(nonce)), playerPubkey-x-only) — proves the
 *      caller signed the nonce with the key for this pubkey.
 *
 * Any malformed input or thrown error yields false (never throws out).
 */
export function verifyChallenge(
  playerPubkey: string,
  nonce: string,
  signatureHex: string,
  nowMs: number,
): boolean {
  try {
    if (!playerPubkey || !nonce || !signatureHex) return false

    // Split into exactly "${ts}.${mac}". ts is base-10 digits, mac is hex —
    // neither contains a '.', so a well-formed nonce has exactly 2 parts.
    const dot = nonce.indexOf('.')
    if (dot <= 0 || dot === nonce.length - 1) return false
    const tsStr = nonce.slice(0, dot)
    const macHex = nonce.slice(dot + 1)
    if (!/^\d+$/.test(tsStr)) return false
    const ts = Number(tsStr)
    if (!Number.isSafeInteger(ts)) return false

    // (a) MAC: re-derive and timing-safe compare. A length mismatch (tampered
    // nonce of the wrong size) fails before timingSafeEqual, which throws on
    // unequal-length buffers.
    const expectedMac = computeMac(playerPubkey, ts)
    let givenMac: Buffer
    try {
      givenMac = Buffer.from(hexToBytes(macHex))
    } catch {
      return false
    }
    if (givenMac.length !== expectedMac.length) return false
    if (!timingSafeEqual(givenMac, expectedMac)) return false

    // (b) Freshness. Reject expired (now - ts > TTL) AND future-dated
    // (now - ts < 0) nonces — a clock-skewed or forged-future ts must not pass.
    const age = nowMs - ts
    if (age < 0 || age > CHALLENGE_TTL_MS) return false

    // (c) Signature over sha256(utf8(nonce)) by playerPubkey's key.
    const xOnly = hexToBytes(toXOnlyHex(playerPubkey))
    if (xOnly.length !== 32) return false
    const sig = hexToBytes(signatureHex)
    if (sig.length !== 64) return false
    const msg = createHash('sha256').update(Buffer.from(nonce, 'utf8')).digest()
    return schnorr.verify(sig, msg, xOnly)
  } catch {
    // Any unexpected throw (bad hex/length, curve error) → reject, never bubble.
    return false
  }
}
