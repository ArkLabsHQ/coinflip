import { describe, it, expect } from 'vitest'
import type { ArkTransaction } from '@arkade-os/sdk'
import {
  gameActivityResolver,
  loadGameRecords,
  txidOf,
  gameLabel,
  gameDetail,
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
  {
    id: 'g1', tier: 1000, winner: 'player', txids: ['cofund1', 'settle1'],
    skinId: 'rocket', skinName: 'Rocket', odds: { n: 100, lo: 0, target: 12 },
  },
  // No skin/odds — a game recorded before those were stored.
  { id: 'g2', tier: 2000, winner: 'house', txids: ['cofund2'], skinId: null, skinName: null, odds: null },
]

describe('txidOf', () => {
  it('prefers arkTxid, then commitment, then boarding', () => {
    expect(txidOf(tx({ arkTxid: 'a', commitmentTxid: 'c', boardingTxid: 'b' }))).toBe('a')
    expect(txidOf(tx({ commitmentTxid: 'c', boardingTxid: 'b' }))).toBe('c')
    expect(txidOf(tx({ boardingTxid: 'b' }))).toBe('b')
  })
})

describe('gameLabel', () => {
  it('names the skin that was played', () => {
    expect(gameLabel(games[0])).toBe('Rocket game')
  })

  it('stays generic for a record with no skin, rather than guessing "Dice"', () => {
    expect(gameLabel(games[1])).toBe('Coinflip game')
  })
})

describe('gameDetail', () => {
  it('summarises stake, win chance and outcome', () => {
    expect(gameDetail(games[0])).toBe('1,000 sats · 12% win · won')
  })

  it('drops the parts it does not know', () => {
    expect(gameDetail(games[1])).toBe('2,000 sats · lost')
    expect(gameDetail({ ...games[1], tier: 0, winner: null })).toBe('')
  })
})

describe('gameActivityResolver', () => {
  it('tags a game tx as one group labelled with the skin, carrying the params', async () => {
    const r = gameActivityResolver(() => games)
    await r.prepare!()

    const ms = r.resolve(tx({ arkTxid: 'settle1' }))
    expect(ms).toEqual([
      {
        groupId: 'game:g1',
        label: 'Rocket game',
        kind: 'game',
        metadata: {
          gameId: 'g1',
          tier: 1000,
          winner: 'player',
          skinId: 'rocket',
          odds: { n: 100, lo: 0, target: 12 },
          detail: '1,000 sats · 12% win · won',
        },
      },
    ])
  })

  it('labels each skin distinctly instead of calling everything a dice game', async () => {
    const skinned = games.map((g, i) => ({ ...g, skinName: ['Coin', 'Roulette'][i] }))
    const r = gameActivityResolver(() => skinned)
    await r.prepare!()
    expect(r.resolve(tx({ arkTxid: 'settle1' }))?.[0].label).toBe('Coin game')
    expect(r.resolve(tx({ arkTxid: 'cofund2' }))?.[0].label).toBe('Roulette game')
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
        {
          id: 'a', tier: 1000, winner: 'player', txids: ['t1'],
          skinId: 'dice', skinName: 'Dice', odds: { n: 6, lo: 0, target: 3 },
        },
        { id: 'b', txids: [] }, // no txids → skipped
        { tier: 5, txids: ['t2'] }, // no id → skipped
        'garbage',
      ]),
    )
    const recs = loadGameRecords()
    expect(recs).toEqual([{
      id: 'a', tier: 1000, winner: 'player', txids: ['t1'],
      skinId: 'dice', skinName: 'Dice', odds: { n: 6, lo: 0, target: 3 },
    }])
  })

  it('nulls the skin/odds of a record written before they were stored', () => {
    localStorage.setItem('gameHistory', JSON.stringify([
      { id: 'old', tier: 500, winner: 'house', txids: ['t9'] },
    ]))
    expect(loadGameRecords()[0]).toMatchObject({ skinId: null, skinName: null, odds: null })
  })

  it('drops a partial or unusable odds blob instead of rendering a broken win%', () => {
    localStorage.setItem('gameHistory', JSON.stringify([
      { id: 'p', tier: 500, winner: 'house', txids: ['t1'], odds: { n: 6, lo: 0 } }, // no target
      { id: 'z', tier: 500, winner: 'house', txids: ['t2'], odds: { n: 0, lo: 0, target: 1 } }, // ÷0
      { id: 'i', tier: 500, winner: 'house', txids: ['t3'], odds: { n: 6, lo: 3, target: 3 } }, // empty window
    ]))
    expect(loadGameRecords().map((g) => g.odds)).toEqual([null, null, null])
  })

  it('returns [] when the key is absent or corrupt', () => {
    localStorage.removeItem('gameHistory')
    expect(loadGameRecords()).toEqual([])
    localStorage.setItem('gameHistory', '{not json')
    expect(loadGameRecords()).toEqual([])
  })
})
