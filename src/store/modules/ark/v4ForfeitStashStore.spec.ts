import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  putV4Forfeit,
  loadV4Forfeits,
  deleteV4Forfeit,
  saveV4Forfeits,
} from './v4ForfeitStashStore'
import { resolveV4ForfeitStash, type StashedV4Forfeit } from './v4ForfeitStash'
import type { V4CovenantParams } from '@/services/api'

// Runtime verification of the happy-path stash LIFECYCLE through the REAL store
// (the SDK's IndexedDB adapter, against a fake-indexeddb polyfill) — the piece
// that otherwise only runs in a browser. Proves what playV4Game relies on: a
// play-time stash is written, and a settle-time clear removes it.

const PAYOUT = '5120' + 'ab'.repeat(32)

const covenant = (): V4CovenantParams => ({
  creatorPubkey: 'aa'.repeat(32),
  playerPubkey: 'bb'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  creatorHash: 'dd'.repeat(32),
  playerHash: 'ee'.repeat(32),
  finalExpiration: 1_900_000_000,
  exitDelay: 86_400,
  oddsN: 2,
  oddsTarget: 1,
  oddsLo: 0,
  emulatorPubkey: 'ff'.repeat(32),
  playerPayoutPkScript: PAYOUT,
  housePayoutPkScript: '5120' + 'cd'.repeat(32),
  playerStake: 1000,
  houseStake: 1000,
})

const stash = (gameId: string, value = 2000): StashedV4Forfeit => ({
  contractVersion: 'v4',
  gameId,
  tier: 1000,
  potOutpoint: { txid: '11'.repeat(32), vout: 0, value },
  covenant: covenant(),
  forfeitClaimableAt: 1_900_000_000,
  forfeitEmulatorUrl: 'http://emulator:7073',
  playerSecretHex: '00'.repeat(16),
  createdAt: 1_800_000_000,
})

describe('v4ForfeitStashStore lifecycle (real store, fake-indexeddb)', () => {
  beforeEach(async () => {
    await saveV4Forfeits([])
  })

  it('writes a play-time stash (resolve → put) and reads it back', async () => {
    const d = resolveV4ForfeitStash({
      emulatorUrl: 'http://emulator:7073',
      potOutpoint: { txid: '11'.repeat(32), vout: 0, value: 2000 },
      covenant: covenant(),
      expectedPayoutPkScriptHex: PAYOUT,
      playerSecretHex: '00'.repeat(16),
    })
    if (d.kind !== 'stash') throw new Error('expected a stash decision')
    await putV4Forfeit({ ...d.patch, gameId: 'g1', tier: 1000, createdAt: 1_800_000_000 })

    const list = await loadV4Forfeits()
    expect(list).toHaveLength(1)
    expect(list[0].gameId).toBe('g1')
    expect(list[0].potOutpoint).toEqual({ txid: '11'.repeat(32), vout: 0, value: 2000 })
    expect(list[0].covenant.playerPayoutPkScript).toBe(PAYOUT)
    expect(list[0].forfeitClaimableAt).toBe(1_900_000_000)
  })

  it('clears the stash on settle (delete by gameId)', async () => {
    await putV4Forfeit(stash('g1'))
    expect(await loadV4Forfeits()).toHaveLength(1)
    await deleteV4Forfeit('g1')
    expect(await loadV4Forfeits()).toHaveLength(0)
  })

  it('replaces by gameId — re-stashing the same game does not duplicate', async () => {
    await putV4Forfeit(stash('g1', 2000))
    await putV4Forfeit(stash('g1', 3000))
    const list = await loadV4Forfeits()
    expect(list).toHaveLength(1)
    expect(list[0].potOutpoint.value).toBe(3000)
  })

  it('keeps distinct games side by side; delete touches only one', async () => {
    await putV4Forfeit(stash('g1'))
    await putV4Forfeit(stash('g2'))
    expect(await loadV4Forfeits()).toHaveLength(2)
    await deleteV4Forfeit('g1')
    const list = await loadV4Forfeits()
    expect(list.map((s) => s.gameId)).toEqual(['g2'])
  })
})
