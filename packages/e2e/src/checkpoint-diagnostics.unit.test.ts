/**
 * Unit test for the log-only finalize diagnostics helper
 * (packages/server/src/checkpoint-diagnostics.ts) — extracts the pubkeys in a
 * checkpoint's spend leaf so a finalize INVALID_SIGNATURE log shows which keys the
 * leaf requires vs which actually signed. Pure — no regtest.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { leafPubkeys } = require('arkade-coinflip-server/dist/checkpoint-diagnostics.js')

const A = new Uint8Array(32).fill(0xaa)
const B = new Uint8Array(32).fill(0xbb)

// <A> <B> OP_CHECKSIG + trailing 0xc0 leaf-version byte (each key a 0x20 push).
function leaf(...keys: Uint8Array[]): Uint8Array {
  const parts: number[] = []
  for (const k of keys) parts.push(0x20, ...k)
  parts.push(0xac, 0xc0)
  return new Uint8Array(parts)
}

describe('leafPubkeys', () => {
  it('extracts the 32-byte pushes as hex, dropping the leaf-version byte', () => {
    expect(leafPubkeys(leaf(A, B))).toEqual(['aa'.repeat(32), 'bb'.repeat(32)])
  })
  it('returns a single key for a one-key leaf', () => {
    expect(leafPubkeys(leaf(A))).toEqual(['aa'.repeat(32)])
  })
  it('returns [] for empty / too-short / undefined input', () => {
    expect(leafPubkeys(undefined)).toEqual([])
    expect(leafPubkeys(new Uint8Array([0x51]))).toEqual([])
    expect(leafPubkeys(new Uint8Array(0))).toEqual([])
  })
})
