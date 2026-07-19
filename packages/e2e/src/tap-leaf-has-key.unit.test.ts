/**
 * Unit test for `tapLeafHasKey` (packages/lib) — the guard that keeps a co-fund from
 * contributing a VTXO the contributing side can't co-sign (its forfeit leaf carries a
 * different/rotated owner key), which arkd would reject at finalize with
 * INVALID_SIGNATURE. Pure — no regtest.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { tapLeafHasKey } = require('arkade-coinflip/dist/joint-pot-tx')

const A = new Uint8Array(32).fill(0xaa)
const B = new Uint8Array(32).fill(0xbb)
const C = new Uint8Array(32).fill(0xcc)

// TapLeafScript = [controlBlock, script || leafVersion]. Leaf:
// <A> OP_CHECKSIGVERIFY <B> OP_CHECKSIG, then the 0xc0 leaf-version byte.
function leaf(x: Uint8Array, y: Uint8Array): [unknown, Uint8Array] {
  const script = new Uint8Array([0x20, ...x, 0xad, 0x20, ...y, 0xac, 0xc0])
  return [{ version: 0xc0, internalKey: new Uint8Array(32), merklePath: [] }, script]
}

describe('tapLeafHasKey', () => {
  it('true when the x-only key is a push in the leaf (ignoring the version byte)', () => {
    expect(tapLeafHasKey(leaf(A, B), A)).toBe(true)
    expect(tapLeafHasKey(leaf(A, B), B)).toBe(true)
  })
  it('false when the key is absent — the cross-keyed / unsignable case', () => {
    expect(tapLeafHasKey(leaf(A, B), C)).toBe(false)
  })
  it('false for a malformed / empty / undefined leaf (no throw)', () => {
    expect(tapLeafHasKey([{}, new Uint8Array(0)], A)).toBe(false)
    expect(tapLeafHasKey([{}, new Uint8Array([0xc0])], A)).toBe(false)
    expect(tapLeafHasKey(undefined, A)).toBe(false)
  })
})
