import { describe, it, expect, vi } from 'vitest'
import { locateEscrowVtxo, type VtxoQuerier } from './locateEscrow'

// ---------------------------------------------------------------------------
// locateEscrowVtxo — after `wallet.send` funds the shared escrow, find OUR
// specific output within that send transaction.
//
// Why this is fiddly enough to deserve its own tested unit: the SDK's send adds
// anchor + metadata outputs in arbitrary positions, so the escrow's `vout` is
// NOT guaranteed to be 0 — we must match on (txid, value) and read back the real
// vout. The indexer is also eventually-consistent, so the lookup polls until the
// VTXO appears (or a deadline). Extracting it lets us prove the matching and the
// poll/timeout behaviour with a fake querier instead of a live regtest indexer.
//
// `pollMs: 0` keeps the retry loop instant in tests; `timeoutMs: 0` forces the
// immediate-timeout path without any real waiting.
// ---------------------------------------------------------------------------

const PK = 'deadbeefpkscript'
const TXID = 'a'.repeat(64)

function querier(pages: { vtxos: { txid: string; vout: number; value: number }[] }[]): VtxoQuerier {
  // Returns successive pages on each call (last page repeats), so tests can model
  // "not there yet, then there".
  let i = 0
  return {
    getVtxos: vi.fn(async () => pages[Math.min(i++, pages.length - 1)]),
  }
}

describe('locateEscrowVtxo', () => {
  it('returns the matching outpoint, reading back the real vout (not assuming 0)', async () => {
    const indexer = querier([
      {
        vtxos: [
          { txid: TXID, vout: 2, value: 5000 }, // OUR escrow — vout 2, not 0
          { txid: TXID, vout: 0, value: 1 }, // an anchor/metadata output at 0
        ],
      },
    ])
    const out = await locateEscrowVtxo(indexer, { escrowPkHex: PK, txid: TXID, amount: 5000 })
    expect(out).toEqual({ txid: TXID, vout: 2, value: 5000 })
  })

  it('ignores outputs of the wrong value or wrong txid', async () => {
    const indexer = querier([
      {
        vtxos: [
          { txid: TXID, vout: 0, value: 4999 }, // right tx, wrong value
          { txid: 'b'.repeat(64), vout: 0, value: 5000 }, // right value, wrong tx
          { txid: TXID, vout: 1, value: 5000 }, // the real one
        ],
      },
    ])
    const out = await locateEscrowVtxo(indexer, { escrowPkHex: PK, txid: TXID, amount: 5000 })
    expect(out.vout).toBe(1)
  })

  it('polls until the VTXO appears (eventual consistency)', async () => {
    const indexer = querier([
      { vtxos: [] }, // first poll: not indexed yet
      { vtxos: [{ txid: TXID, vout: 0, value: 5000 }] }, // second poll: there
    ])
    const out = await locateEscrowVtxo(indexer, { escrowPkHex: PK, txid: TXID, amount: 5000, pollMs: 0 })
    expect(out.value).toBe(5000)
    expect(indexer.getVtxos).toHaveBeenCalledTimes(2)
  })

  it('treats a transient indexer error as a retry, not a failure', async () => {
    let calls = 0
    const indexer: VtxoQuerier = {
      getVtxos: vi.fn(async () => {
        calls++
        if (calls === 1) throw new Error('502 from indexer')
        return { vtxos: [{ txid: TXID, vout: 3, value: 5000 }] }
      }),
    }
    const out = await locateEscrowVtxo(indexer, { escrowPkHex: PK, txid: TXID, amount: 5000, pollMs: 0 })
    expect(out.vout).toBe(3)
  })

  it('throws a descriptive error when the deadline passes without a match', async () => {
    const indexer = querier([{ vtxos: [] }])
    await expect(
      locateEscrowVtxo(indexer, { escrowPkHex: PK, txid: TXID, amount: 5000, timeoutMs: 0 }),
    ).rejects.toThrow(new RegExp(`Could not locate player escrow VTXO in tx ${TXID}`))
  })
})
