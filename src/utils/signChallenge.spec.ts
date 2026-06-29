import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { signChallenge } from './signChallenge'

// `signChallenge` is the client half of the restore-flow signature proof. The
// security property that matters is that its output satisfies EXACTLY what the
// server verifies — `schnorr.verify(sig, sha256(utf8(nonce)), xOnlyPubkey)`
// (packages/server/src/restore-auth.ts). So each test re-derives the message
// the same way the server does and checks the produced signature against it.

/** A real x-only keypair, mirroring the server test's `keypair()` helper. */
function keypair(seed: number): { skHex: string; xonly: Uint8Array } {
  const sk = new Uint8Array(32).fill(seed)
  return { skHex: hex.encode(sk), xonly: schnorr.getPublicKey(sk) }
}

/** The message the server hashes from the nonce — sha256(utf8(nonce)). */
function serverMsg(nonce: string): Uint8Array {
  return sha256(new TextEncoder().encode(nonce))
}

describe('signChallenge', () => {
  it('produces a signature the server would accept (schnorr.verify over sha256(utf8(nonce)))', () => {
    const { skHex, xonly } = keypair(0x11)
    const nonce = '1700000000000.' + 'a'.repeat(64)
    const sigHex = signChallenge(nonce, skHex)
    // This is the exact check the server's verifyChallenge runs at step (c).
    expect(schnorr.verify(hex.decode(sigHex), serverMsg(nonce), xonly)).toBe(true)
  })

  it('emits a 64-byte (128 hex char) signature', () => {
    const { skHex } = keypair(0x22)
    const sigHex = signChallenge('1700000000000.' + 'b'.repeat(64), skHex)
    expect(sigHex).toMatch(/^[0-9a-f]{128}$/)
  })

  it('does not verify against a DIFFERENT nonce (binds the signature to the nonce)', () => {
    const { skHex, xonly } = keypair(0x33)
    const sigHex = signChallenge('1700000000000.' + 'c'.repeat(64), skHex)
    // A valid signature over our nonce must NOT satisfy a different message.
    expect(schnorr.verify(hex.decode(sigHex), serverMsg('not-the-nonce'), xonly)).toBe(false)
  })

  it('does not verify against a DIFFERENT key', () => {
    const a = keypair(0x44)
    const b = keypair(0x55)
    const nonce = '1700000000000.' + 'd'.repeat(64)
    const sigHex = signChallenge(nonce, a.skHex)
    expect(schnorr.verify(hex.decode(sigHex), serverMsg(nonce), b.xonly)).toBe(false)
  })
})
