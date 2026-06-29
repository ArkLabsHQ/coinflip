import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'

/**
 * Sign a restore-flow challenge nonce, producing the hex schnorr signature the
 * server's `/api/games` auth verifies.
 *
 * This MUST match the server's verify byte-for-byte (packages/server/src/
 * restore-auth.ts → `verifyChallenge`), which checks:
 *
 *   schnorr.verify(sig, sha256(utf8(nonce)), xOnlyPubkey)
 *
 * So we hash the UTF-8 bytes of the nonce STRING with SHA-256 (a 32-byte
 * digest) and schnorr-sign that digest with the raw 32-byte secp256k1 private
 * key. `sha256(utf8Bytes(nonce))` is identical to the server's
 * `createHash('sha256').update(Buffer.from(nonce, 'utf8')).digest()` — same
 * bytes in, same digest out — and `@noble/curves`' `schnorr` is the same
 * implementation the server signs/verifies with. The authoritative reference is
 * the server's own test helper `sign()` in
 * packages/e2e/src/restore-auth.unit.test.ts.
 *
 * BIP-340 mixes in fresh aux randomness, so the signature differs each call;
 * every one verifies against the same (nonce, pubkey).
 *
 * @param nonce       the `"${ts}.${mac}"` challenge string from GET /api/games/challenge
 * @param privKeyHex  the wallet's raw 32-byte secp256k1 private key, hex-encoded
 * @returns the 64-byte schnorr signature, hex-encoded (128 hex chars)
 */
export function signChallenge(nonce: string, privKeyHex: string): string {
  const msg = sha256(new TextEncoder().encode(nonce))
  return hex.encode(schnorr.sign(msg, hex.decode(privKeyHex)))
}
