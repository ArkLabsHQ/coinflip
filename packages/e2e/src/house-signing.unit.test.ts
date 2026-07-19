/**
 * Unit test for the house-signing guards (packages/server/src/house-signing.ts).
 *
 * They fix the intermittent flip failure that surfaced as a cryptic
 * `INVALID_SIGNATURE (18)` at cofund-finalize: a house VTXO whose 2-of-2 forfeit
 * leaf `<house> CHECKSIGVERIFY <arkServer> CHECKSIG` carries a stale/rotated house
 * key, so the house can't produce its mandatory checkpoint co-signature and arkd
 * rejects the whole co-fund. The guards (a) keep such a VTXO out of house-stake
 * selection and (b) detect a missing house sig before it's forwarded to finalize.
 *
 * Pure — no regtest — against the compiled server helpers.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  xOnlyInTapscript,
  partitionHouseSignable,
  houseSigAttached,
} = require('arkade-coinflip-server/dist/house-signing.js')

const A = new Uint8Array(32).fill(0xaa) // "house" key
const B = new Uint8Array(32).fill(0xbb) // "arkServer" key
const C = new Uint8Array(32).fill(0xcc) // some other/rotated key

// <x> OP_CHECKSIGVERIFY <y> OP_CHECKSIG + trailing 0xc0 leaf-version byte
// (btc-signer's TapLeafScript[1] shape: script WITH the version appended).
function leaf(x: Uint8Array, y: Uint8Array): Uint8Array {
  return new Uint8Array([0x20, ...x, 0xad, 0x20, ...y, 0xac, 0xc0])
}

describe('xOnlyInTapscript', () => {
  it('finds a key present as a push in the leaf, ignoring the version byte', () => {
    expect(xOnlyInTapscript(leaf(A, B), A)).toBe(true)
    expect(xOnlyInTapscript(leaf(A, B), B)).toBe(true)
  })
  it('returns false when the key is absent (the rotated/stale-key case)', () => {
    expect(xOnlyInTapscript(leaf(C, B), A)).toBe(false)
  })
})

describe('partitionHouseSignable', () => {
  it('splits VTXOs by whether the house key is in their forfeit leaf', () => {
    const good = { id: 'good', forfeitTapLeafScript: [null, leaf(A, B)] } // house = A ✓
    const bad = { id: 'bad', forfeitTapLeafScript: [null, leaf(C, B)] } // house A absent ✗
    const { signable, unsignable } = partitionHouseSignable([good, bad], A)
    expect(signable.map((v: { id: string }) => v.id)).toEqual(['good'])
    expect(unsignable.map((v: { id: string }) => v.id)).toEqual(['bad'])
  })
  it('nothing unsignable when every leaf carries the house key', () => {
    const vtxos = [{ id: '1', forfeitTapLeafScript: [null, leaf(A, B)] }]
    expect(partitionHouseSignable(vtxos, A).unsignable).toHaveLength(0)
  })
  it('treats a missing/malformed forfeit leaf as unsignable (no throw)', () => {
    const vtxos = [{ id: 'x', forfeitTapLeafScript: undefined }]
    const { signable, unsignable } = partitionHouseSignable(vtxos, A)
    expect(signable).toHaveLength(0)
    expect(unsignable.map((v: { id: string }) => v.id)).toEqual(['x'])
  })
})

describe('houseSigAttached', () => {
  const sig = new Uint8Array(64)
  it('true iff a signature for the house key is attached to the input', () => {
    expect(houseSigAttached([[{ pubKey: A }, sig]], A)).toBe(true)
    expect(houseSigAttached([[{ pubKey: B }, sig]], A)).toBe(false) // arkd cosig only
  })
  it('false for an empty / absent tapScriptSig', () => {
    expect(houseSigAttached([], A)).toBe(false)
    expect(houseSigAttached(undefined, A)).toBe(false)
  })
})
