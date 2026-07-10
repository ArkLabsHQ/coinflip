import { describe, it, expect } from 'vitest'
import type { ArkTransaction } from '@arkade-os/sdk'
import {
  gameActivityResolver,
  loadGameRecords,
  txidOf,
  type CoinflipGameRecord,
} from './gameActivityResolver'

/** Minimal ArkTransaction; only the fields the resolver reads (key.*) matter. */
function tx(key: Partial<ArkTransaction['key']>): ArkTransaction {
  return {
    key: { arkTxid: '', commitmentTxid: '', boardingTxid: '', ...key },
    type: 'RECEIVED',
    amount: 1000,
    settled: true,
    createdAt: 1_000_000,
  } as ArkTransaction
}

const games: CoinflipGameRecord[] = [
  { id: 'g1', tier: 1000, winner: 'player', txids: ['cofund1', 'settle1'] },
  { id: 'g2', tier: 2000, winner: 'house', txids: ['cofund2'] },
]

describe('txidOf', () => {
  it('prefers arkTxid, then commitment, then boarding', () => {
    expect(txidOf(tx({ arkTxid: 'a', commitmentTxid: 'c', boardingTxid: 'b' }))).toBe('a')
    expect(txidOf(tx({ commitmentTxid: 'c', boardingTxid: 'b' }))).toBe('c')
    expect(txidOf(tx({ boardingTxid: 'b' }))).toBe('b')
  })
})

describe('gameActivityResolver', () => {
  it('tags a game tx as one "Dice game" group with the game metadata', async () => {
    const r = gameActivityResolver(() => games)
    await r.prepare!()

    const ms = r.resolve(tx({ arkTxid: 'settle1' }))
    expect(ms).toEqual([
      {
        groupId: 'game:g1',
        label: 'Dice game',
        kind: 'game',
        metadata: { gameId: 'g1', tier: 1000, winner: 'player' },
      },
    ])
  })

  it('groups every txid of a game under the same groupId', async () => {
    const r = gameActivityResolver(() => games)
    await r.prepare!()
    // Both the co-fund and the settle tx of g1 map to the one game group.
    expect(r.resolve(tx({ arkTxid: 'cofund1' }))?.[0].groupId).toBe('game:g1')
    expect(r.resolve(tx({ arkTxid: 'settle1' }))?.[0].groupId).toBe('game:g1')
  })

  it('matches a game txid seen as a commitmentTxid (not just arkTxid)', async () => {
    const r = gameActivityResolver(() => games)
    await r.prepare!()
    expect(r.resolve(tx({ commitmentTxid: 'cofund2' }))?.[0].groupId).toBe('game:g2')
  })

  it('leaves an unrelated tx untagged (undefined → its own plain row)', async () => {
    const r = gameActivityResolver(() => games)
    await r.prepare!()
    expect(r.resolve(tx({ arkTxid: 'some-deposit' }))).toBeUndefined()
  })

  it('re-reads games on every prepare (new games appear without reconnect)', async () => {
    let current: CoinflipGameRecord[] = []
    const r = gameActivityResolver(() => current)
    await r.prepare!()
    expect(r.resolve(tx({ arkTxid: 'settle1' }))).toBeUndefined()

    current = games // a game gets played
    await r.prepare!()
    expect(r.resolve(tx({ arkTxid: 'settle1' }))?.[0].groupId).toBe('game:g1')
  })

  it('uses the namespaced id so it cannot clobber SDK built-ins', () => {
    expect(gameActivityResolver(() => []).id).toBe('coinflip:games')
  })
})

describe('loadGameRecords', () => {
  it('reads well-formed records from localStorage and skips malformed ones', () => {
    localStorage.setItem(
      'gameHistory',
      JSON.stringify([
        { id: 'a', tier: 1000, winner: 'player', txids: ['t1'] },
        { id: 'b', txids: [] }, // no txids → skipped
        { tier: 5, txids: ['t2'] }, // no id → skipped
        'garbage',
      ]),
    )
    const recs = loadGameRecords()
    expect(recs).toEqual([{ id: 'a', tier: 1000, winner: 'player', txids: ['t1'] }])
  })

  it('returns [] when the key is absent or corrupt', () => {
    localStorage.removeItem('gameHistory')
    expect(loadGameRecords()).toEqual([])
    localStorage.setItem('gameHistory', '{not json')
    expect(loadGameRecords()).toEqual([])
  })
})
