/**
 * Adversarial unit tests for the restore-endpoint signature-proof auth.
 *
 * This is the security boundary for "restore my games": it must let the real
 * key-holder in and keep everyone else out. We mint real schnorr keypairs and
 * exercise the full round-trip plus every failure mode the spec calls out —
 * tampered MAC, expired/future timestamps, wrong key, cross-pubkey reuse, and
 * malformed input (which must return false, never throw).
 *
 * SERVER_SECRET is per-process and private, so valid nonces can only come from
 * the module's own issueChallenge — exactly the property the design relies on
 * (a forger can't fabricate a MAC). No regtest.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { issueChallenge, verifyChallenge, CHALLENGE_TTL_MS } =
  require('arkade-coinflip-server/dist/restore-auth.js')
const { schnorr } = require('@noble/curves/secp256k1.js')
const { createHash } = require('crypto')

const T0 = 1_700_000_000_000 // fixed "now" for determinism

/** A real x-only keypair. */
function keypair(seed: number): { sk: Uint8Array; xonly: string } {
  const sk = new Uint8Array(32).fill(seed)
  return { sk, xonly: Buffer.from(schnorr.getPublicKey(sk)).toString('hex') }
}

/** Sign sha256(utf8(nonce)) with sk, exactly as the client must. */
function sign(sk: Uint8Array, nonce: string): string {
  const msg = createHash('sha256').update(Buffer.from(nonce, 'utf8')).digest()
  return Buffer.from(schnorr.sign(msg, sk)).toString('hex')
}

describe('restore-auth verifyChallenge', () => {
  it('accepts a real keypair round-trip', () => {
    const { sk, xonly } = keypair(0x11)
    const nonce = issueChallenge(xonly, T0)
    const sig = sign(sk, nonce)
    expect(verifyChallenge(xonly, nonce, sig, T0)).toBe(true)
    // Still valid partway through the TTL window.
    expect(verifyChallenge(xonly, nonce, sig, T0 + CHALLENGE_TTL_MS - 1)).toBe(true)
  })

  it('rejects a tampered MAC', () => {
    const { sk, xonly } = keypair(0x11)
    const nonce = issueChallenge(xonly, T0)
    const sig = sign(sk, nonce)
    const dot = nonce.indexOf('.')
    const ts = nonce.slice(0, dot)
    const mac = nonce.slice(dot + 1)
    // Flip the last hex nibble of the MAC.
    const lastHex = mac.slice(-1)
    const flipped = mac.slice(0, -1) + (lastHex === '0' ? '1' : '0')
    const tampered = `${ts}.${flipped}`
    // Re-sign the tampered nonce so ONLY the MAC is wrong (isolates the MAC check).
    expect(verifyChallenge(xonly, tampered, sign(sk, tampered), T0)).toBe(false)
  })

  it('rejects a MAC of the wrong length (truncated/padded)', () => {
    const { sk, xonly } = keypair(0x11)
    const nonce = issueChallenge(xonly, T0)
    const dot = nonce.indexOf('.')
    const ts = nonce.slice(0, dot)
    const mac = nonce.slice(dot + 1)
    const short = `${ts}.${mac.slice(0, -2)}`
    const long = `${ts}.${mac}ab`
    expect(verifyChallenge(xonly, short, sign(sk, short), T0)).toBe(false)
    expect(verifyChallenge(xonly, long, sign(sk, long), T0)).toBe(false)
  })

  it('rejects an expired timestamp', () => {
    const { sk, xonly } = keypair(0x22)
    const nonce = issueChallenge(xonly, T0)
    const sig = sign(sk, nonce)
    expect(verifyChallenge(xonly, nonce, sig, T0 + CHALLENGE_TTL_MS + 1)).toBe(false)
  })

  it('rejects a future-dated timestamp', () => {
    const { sk, xonly } = keypair(0x22)
    // Issue a nonce stamped in the future relative to the verify "now".
    const nonce = issueChallenge(xonly, T0 + 60_000)
    const sig = sign(sk, nonce)
    expect(verifyChallenge(xonly, nonce, sig, T0)).toBe(false)
  })

  it('rejects a signature from a DIFFERENT key', () => {
    const a = keypair(0x33)
    const b = keypair(0x44)
    const nonce = issueChallenge(a.xonly, T0)
    // Valid nonce for A, but signed by B's key.
    expect(verifyChallenge(a.xonly, nonce, sign(b.sk, nonce), T0)).toBe(false)
  })

  it('rejects a nonce issued for pubkey A but verified for pubkey B', () => {
    const a = keypair(0x55)
    const b = keypair(0x66)
    const nonceForA = issueChallenge(a.xonly, T0)
    // B signs it and presents it as its own — the MAC is bound to A, so it fails
    // for B even though B's signature over the nonce is valid.
    expect(verifyChallenge(b.xonly, nonceForA, sign(b.sk, nonceForA), T0)).toBe(false)
  })

  it('rejects a valid signature over a DIFFERENT message than the nonce', () => {
    const { sk, xonly } = keypair(0x77)
    const nonce = issueChallenge(xonly, T0)
    // A real schnorr signature, but over some other message — must not satisfy
    // the nonce challenge.
    const wrongSig = sign(sk, 'not-the-nonce')
    expect(verifyChallenge(xonly, nonce, wrongSig, T0)).toBe(false)
  })

  it('returns false (never throws) for malformed / empty inputs', () => {
    const { sk, xonly } = keypair(0x88)
    const nonce = issueChallenge(xonly, T0)
    const sig = sign(sk, nonce)
    const cases: Array<[string, string, string]> = [
      ['', nonce, sig],                       // empty pubkey
      [xonly, '', sig],                       // empty nonce
      [xonly, nonce, ''],                     // empty sig
      ['zz', nonce, sig],                     // non-hex pubkey
      [xonly, 'no-dot-here', sig],            // nonce without a '.'
      [xonly, `.${'a'.repeat(64)}`, sig],     // empty ts
      [xonly, `${T0}.`, sig],                 // empty mac
      [xonly, `notanumber.${'a'.repeat(64)}`, sig], // non-numeric ts
      [xonly, nonce, 'xyz'],                  // non-hex sig
      [xonly, nonce, 'ab'],                   // too-short sig
      ['02' + 'c'.repeat(63), nonce, sig],    // odd-length compressed pubkey
    ]
    for (const [pk, n, s] of cases) {
      expect(() => verifyChallenge(pk, n, s, T0)).not.toThrow()
      expect(verifyChallenge(pk, n, s, T0)).toBe(false)
    }
  })

  it('accepts a 33-byte compressed pubkey by normalizing to x-only', () => {
    const { sk, xonly } = keypair(0x99)
    // schnorr x-only key with an even-parity (0x02) prefix is the valid
    // compressed encoding the client may send instead of the bare x-only key.
    const compressed = '02' + xonly
    const nonce = issueChallenge(compressed, T0)
    // The client signs with the underlying key; verify normalizes both the
    // challenge pubkey and the verify pubkey to x-only, so this round-trips.
    expect(verifyChallenge(compressed, nonce, sign(sk, nonce), T0)).toBe(true)
  })
})

describe('restore-auth issueChallenge', () => {
  it('produces a "${ts}.${mac}" nonce bound to the issue time', () => {
    const { xonly } = keypair(0xaa)
    const nonce = issueChallenge(xonly, T0)
    const dot = nonce.indexOf('.')
    expect(nonce.slice(0, dot)).toBe(String(T0))
    expect(nonce.slice(dot + 1)).toMatch(/^[0-9a-f]{64}$/) // HMAC-SHA256 → 32 bytes hex
  })

  it('binds the MAC to the pubkey (different pubkey → different MAC at same ts)', () => {
    const a = keypair(0xab)
    const b = keypair(0xac)
    expect(issueChallenge(a.xonly, T0)).not.toBe(issueChallenge(b.xonly, T0))
  })
})

export {}
