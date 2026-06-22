import { describe, it, expect } from 'vitest'
import {
  resolveV4ForfeitStash,
  hasClaimableV4Forfeit,
  type StashedV4Forfeit,
} from './v4ForfeitStash'
import type { V4CovenantParams } from '@/services/api'

// Deterministic fixtures — no SDK/network. The v4 forfeit decision is a pure
// guard chain (emulator reachable + covenant pays us), mirroring v3's
// resolveForfeitStash but for the client-built joint-pot claim.

const PAYOUT = '5120' + 'ab'.repeat(32)

const covenant = (): V4CovenantParams => ({
  creatorPubkey: 'aa'.repeat(32),
  playerPubkey: 'bb'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  creatorHash: 'dd'.repeat(32),
  playerHash: 'ee'.repeat(32),
  finalExpiration: 1_900_000_000,
  cancelDelay: 1_800_000_000,
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

const potOutpoint = { txid: '11'.repeat(32), vout: 0, value: 2000 }

const baseArgs = () => ({
  emulatorUrl: 'http://emulator:7073',
  potOutpoint,
  covenant: covenant(),
  expectedPayoutPkScriptHex: PAYOUT,
  playerSecretHex: '00'.repeat(16),
})

describe('resolveV4ForfeitStash', () => {
  it('skips with no-emulator when there is no emulator URL', () => {
    const d = resolveV4ForfeitStash({ ...baseArgs(), emulatorUrl: undefined })
    expect(d).toEqual({ kind: 'skip', reason: 'no-emulator' })
  })

  it('skips with payout-mismatch when the covenant pays someone else', () => {
    const d = resolveV4ForfeitStash({
      ...baseArgs(),
      expectedPayoutPkScriptHex: '5120' + '99'.repeat(32),
    })
    expect(d).toEqual({ kind: 'skip', reason: 'payout-mismatch' })
  })

  it('reports no-emulator BEFORE payout-mismatch (most fundamental first)', () => {
    const d = resolveV4ForfeitStash({
      ...baseArgs(),
      emulatorUrl: undefined,
      expectedPayoutPkScriptHex: 'deadbeef',
    })
    expect(d).toEqual({ kind: 'skip', reason: 'no-emulator' })
  })

  it('stashes a complete patch when the emulator is present and the covenant pays us', () => {
    const d = resolveV4ForfeitStash(baseArgs())
    expect(d.kind).toBe('stash')
    if (d.kind !== 'stash') throw new Error('expected stash')
    expect(d.patch).toEqual({
      contractVersion: 'v4',
      potOutpoint,
      covenant: covenant(),
      forfeitClaimableAt: 1_900_000_000,
      forfeitEmulatorUrl: 'http://emulator:7073',
      playerSecretHex: '00'.repeat(16),
    })
  })
})

describe('hasClaimableV4Forfeit', () => {
  const complete: StashedV4Forfeit = {
    contractVersion: 'v4',
    gameId: 'g1',
    tier: 1000,
    potOutpoint,
    covenant: covenant(),
    forfeitClaimableAt: 1_900_000_000,
    forfeitEmulatorUrl: 'http://emulator:7073',
    playerSecretHex: '00'.repeat(16),
    createdAt: 1_800_000_000,
  }

  it('accepts a structurally complete v4 forfeit', () => {
    expect(hasClaimableV4Forfeit(complete)).toBe(true)
  })

  it('rejects when the emulator URL is missing', () => {
    expect(hasClaimableV4Forfeit({ ...complete, forfeitEmulatorUrl: '' })).toBe(false)
  })

  it('rejects when the pot outpoint is missing', () => {
    const partial: Partial<StashedV4Forfeit> = { ...complete }
    delete partial.potOutpoint
    expect(hasClaimableV4Forfeit(partial)).toBe(false)
  })

  it('rejects when the covenant is missing', () => {
    const partial: Partial<StashedV4Forfeit> = { ...complete }
    delete partial.covenant
    expect(hasClaimableV4Forfeit(partial)).toBe(false)
  })
})
