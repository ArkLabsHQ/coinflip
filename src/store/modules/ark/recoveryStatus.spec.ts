import { describe, expect, it } from 'vitest'
import type { IndexerProvider } from '@arkade-os/sdk'
import type { StashedV4Forfeit } from './v4ForfeitStash'
import { potIndexed } from './recoveryStatus'

const pot = { txid: 'aa'.repeat(32), vout: 0, value: 7140 }
const stash = { potOutpoint: pot } as StashedV4Forfeit
const indexer = (getVtxos: () => Promise<unknown>) => ({ getVtxos }) as unknown as Pick<IndexerProvider, 'getVtxos'>

describe('potIndexed', () => {
  it('is false when a rejected co-fund never created the pot', async () => {
    expect(await potIndexed(stash, indexer(async () => ({ vtxos: [] })))).toBe(false)
  })

  it('is true once the pot is indexed, and when the indexer cannot answer', async () => {
    expect(await potIndexed(stash, indexer(async () => ({ vtxos: [{ txid: pot.txid, vout: 0 }] })))).toBe(true)
    expect(await potIndexed(stash, indexer(async () => { throw new Error('indexer down') }))).toBe(true)
  })
})
