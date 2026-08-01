/**
 * Unit test for `tapLeafHasKey` (packages/lib) — the guard that keeps a co-fund from
 * contributing a VTXO the contributing side can't co-sign (its forfeit leaf carries a
 * different/rotated owner key), which arkd would reject at finalize with
 * INVALID_SIGNATURE. Pure — no regtest.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
export {} // module scope — these jest files are otherwise global scripts (require, no import)
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

/**
 * `tapLeafHasKey` answers "can we sign this?" and discards "then who can?".
 * When a house VTXO fails that check its funds are stuck, and the only useful
 * question is which key owns it — a previous house identity (stranded by a key
 * rotation or a DATA_DIR reset regenerating `house_wallet`) or an unrelated
 * one. `tapLeafXOnlyKeys` recovers that for the log line.
 */
describe('tapLeafXOnlyKeys', () => {
  const { tapLeafXOnlyKeys } = require('arkade-coinflip/dist/joint-pot-tx')
  const k = (b: number) => Buffer.alloc(32, b)
  /** OP_PUSHBYTES_32 <key> … then the trailing byte tapLeafHasKey strips. */
  const leafOf = (...keys: Buffer[]) => [
    { version: 0xc0, internalKey: new Uint8Array(32), merklePath: [] },
    new Uint8Array([...keys.flatMap((key) => [0x20, ...key]), 0xc0]),
  ]

  it('recovers both keys from a two-of-two forfeit leaf', () => {
    const out = tapLeafXOnlyKeys(leafOf(k(0x11), k(0x22)))
    expect(out).toEqual([k(0x11).toString('hex'), k(0x22).toString('hex')])
  })

  it('agrees with tapLeafHasKey about membership', () => {
    const { tapLeafHasKey } = require('arkade-coinflip/dist/joint-pot-tx')
    const leaf = leafOf(k(0x11), k(0x22))
    for (const b of [0x11, 0x22]) {
      expect(tapLeafHasKey(leaf, k(b))).toBe(true)
      expect(tapLeafXOnlyKeys(leaf)).toContain(k(b).toString('hex'))
    }
    // The stuck case: a key that owns nothing here.
    expect(tapLeafHasKey(leaf, k(0x99))).toBe(false)
    expect(tapLeafXOnlyKeys(leaf)).not.toContain(k(0x99).toString('hex'))
  })

  it('dedupes a key pushed twice', () => {
    expect(tapLeafXOnlyKeys(leafOf(k(0x11), k(0x11)))).toHaveLength(1)
  })

  it('returns nothing rather than throwing on an empty or malformed leaf', () => {
    expect(tapLeafXOnlyKeys(undefined as never)).toEqual([])
    expect(tapLeafXOnlyKeys([{ version: 0xc0, internalKey: new Uint8Array(32), merklePath: [] }, new Uint8Array([])] as never)).toEqual([])
    // A 0x20 with fewer than 32 bytes after it must not over-read.
    expect(tapLeafXOnlyKeys([{ version: 0xc0, internalKey: new Uint8Array(32), merklePath: [] }, new Uint8Array([0x20, 1, 2, 3, 0xc0])] as never)).toEqual([])
  })
})
