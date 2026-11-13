import { describe, expect, it } from 'vitest'
import {
  BANKROLL_PRACTICE_STORAGE_KEY, createBankrollPractice, type BankrollPracticeStorage,
} from './bankrollPractice'

function memoryStorage(): BankrollPracticeStorage {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}

describe('bankroll practice session', () => {
  it('quotes without spending cash and preserves basis through a partial redemption', () => {
    const practice = createBankrollPractice()
    const quote = practice.quoteJoin(25_000n)
    expect(quote).toEqual({ mintedShares: 25_000_000_000n, ownershipBps: 2000n,
      nextPoolNavSats: 125_000n, memberValueSats: 25_000n })
    expect(practice.state.value.cashSats).toBe(100_000n)
    practice.join(25_000n, 0)
    practice.playRound('house', 10_000n)
    expect(practice.memberValue.value).toBe(26_600n)
    const redeem = practice.quoteRedeem(10_000_000_000n)
    expect(redeem.payoutSats).toBe(10_640n)
    practice.redeemShares(10_000_000_000n, practice.state.value.version)
    expect(practice.state.value).toMatchObject({ cashSats: 85_640n, contributedSats: 25_000n,
      redeemedSats: 10_640n, memberShares: 15_000_000_000n })
    expect(practice.memberValue.value).toBe(15_960n)
    expect(practice.memberPnl.value).toBe(1600n)
  })

  it('charges performance fees only after losses are recovered', () => {
    const practice = createBankrollPractice()
    practice.join(25_000n)
    practice.playRound('player', 10_000n)
    expect(practice.state.value.pool.carriedLossSats).toBe(10_000n)
    practice.playRound('house', 10_000n)
    expect(practice.state.value.operatorFeesSats).toBe(0n)
    expect(practice.state.value.pool.carriedLossSats).toBe(0n)
    practice.playRound('house', 10_000n)
    expect(practice.state.value.operatorFeesSats).toBe(2000n)
    expect(practice.state.value.activity[0]).toMatchObject({ kind: 'round', outcome: 'house',
      amountSats: 10_000n, pnlSats: 10_000n, operatorFeeSats: 2000n, memberValueSats: 26_600n })
    expect(practice.state.value.pool.phase).toBe('admission')
    expect(practice.state.value.pool.liquidSats).toBe(practice.state.value.pool.navSats)
  })

  it('rejects stale confirmations, including a confirmation held across reset', () => {
    const practice = createBankrollPractice()
    const version = practice.state.value.version
    practice.playRound('refund', 1000n)
    expect(() => practice.join(25_000n, version)).toThrow(/changed|stale/i)
    practice.join(25_000n)
    const beforeReset = practice.state.value.version
    practice.reset()
    expect(practice.state.value.version).toBe(beforeReset + 1)
    expect(() => practice.join(25_000n, beforeReset)).toThrow(/changed|stale/i)
    expect(practice.state.value).toMatchObject({ memberShares: 0n, cashSats: 100_000n,
      contributedSats: 0n, redeemedSats: 0n, operatorFeesSats: 0n, activity: [] })
  })

  it('leaves the complete state unchanged when a round or a balance check fails', () => {
    const practice = createBankrollPractice()
    practice.join(25_000n)
    const before = practice.state.value
    expect(() => practice.playRound('house', 25_001n)).toThrow(/stake limit/i)
    expect(() => practice.playRound('invalid' as 'house', 1000n)).toThrow(/outcome/i)
    expect(() => practice.join(75_001n)).toThrow(/cash/i)
    expect(() => practice.redeemShares(before.memberShares + 1n)).toThrow(/shares/i)
    expect(practice.state.value).toBe(before)
    expect(practice.state.value.pool.epoch).toBe(0n)
  })

  it.each([0n, -1n, 1.5, '100', Number.NaN])('rejects non-positive or non-bigint amounts: %s', amount => {
    const practice = createBankrollPractice()
    const before = practice.state.value
    expect(() => practice.join(amount as bigint)).toThrow(/positive whole/i)
    expect(() => practice.playRound('house', amount as bigint)).toThrow(/positive whole/i)
    expect(() => practice.redeemShares(amount as bigint)).toThrow(/positive whole/i)
    expect(practice.state.value).toBe(before)
  })

  it('replays persisted joins, rounds and partial redemptions with exact bigint accounting', () => {
    const storage = memoryStorage()
    const practice = createBankrollPractice(storage)
    practice.join(25_000n)
    practice.playRound('player', 10_000n)
    practice.redeemShares(10_000_000_000n)
    const restored = createBankrollPractice(storage)
    expect(restored.state.value).toEqual(practice.state.value)
    expect(restored.memberPnl.value).toBe(practice.memberPnl.value)
    expect(restored.storageWarning.value).toBeNull()
    const saved = JSON.parse(storage.getItem(BANKROLL_PRACTICE_STORAGE_KEY)!)
    expect(saved.journal[0].amount).toBe('25000')
    expect(saved.pool).toBeUndefined()
    expect(() => JSON.stringify(saved)).not.toThrow()
  })

  it('keeps integer share rounding and rejects a redemption that pays zero sats', () => {
    const practice = createBankrollPractice()
    practice.join(25_000n)
    practice.playRound('player', 1n)
    expect(practice.quoteJoin(1n).mintedShares).toBe(1_000_008n)
    const before = practice.state.value
    expect(() => practice.quoteRedeem(1n)).toThrow(/zero sats/i)
    expect(() => practice.redeemShares(1n)).toThrow(/zero sats/i)
    expect(practice.state.value).toBe(before)
  })

  it('records redeemed sats separately from the burned share units', () => {
    const storage = memoryStorage()
    const practice = createBankrollPractice(storage)
    practice.join(25_000n)
    practice.redeemShares(20_000_000_000n)
    expect(practice.state.value.activity[0]).toMatchObject({ kind: 'redeem', amountSats: 20_000n,
      shareUnits: 20_000_000_000n })
    expect(practice.state.value.activity[1]).toMatchObject({ kind: 'join', amountSats: 25_000n,
      shareUnits: 25_000_000_000n })
    expect(createBankrollPractice(storage).state.value.activity).toEqual(practice.state.value.activity)
  })

  it('persists a reset without reviving the previous balances or confirmations', () => {
    const storage = memoryStorage()
    const practice = createBankrollPractice(storage)
    practice.join(25_000n)
    const version = practice.state.value.version
    practice.reset()
    const restored = createBankrollPractice(storage)
    expect(restored.state.value).toEqual(practice.state.value)
    expect(restored.state.value.memberShares).toBe(0n)
    expect(() => restored.join(25_000n, version)).toThrow(/changed|stale/i)
  })

  it('restores nothing when a later saved command is invalid', () => {
    const storage = memoryStorage()
    const practice = createBankrollPractice(storage)
    practice.join(25_000n)
    const saved = JSON.parse(storage.getItem(BANKROLL_PRACTICE_STORAGE_KEY)!)
    saved.journal.push({ kind: 'join', amount: '999999999', at: saved.journal[0].at })
    storage.setItem(BANKROLL_PRACTICE_STORAGE_KEY, JSON.stringify(saved))
    const restored = createBankrollPractice(storage)
    expect(restored.state.value.memberShares).toBe(0n)
    expect(restored.state.value.pool.navSats).toBe(100_000n)
    expect(restored.state.value.activity).toEqual([])
    expect(restored.storageWarning.value).toMatch(/saved|verify|invalid/i)
    expect(storage.getItem(BANKROLL_PRACTICE_STORAGE_KEY)).toBe(JSON.stringify(saved))
  })

  it.each(['{', '{"schemaVersion":2}', '{"schemaVersion":1,"journal":[]}'])('rejects malformed persistence: %s', saved => {
    const storage = memoryStorage()
    storage.setItem(BANKROLL_PRACTICE_STORAGE_KEY, saved)
    const practice = createBankrollPractice(storage)
    expect(practice.state.value.cashSats).toBe(100_000n)
    expect(practice.storageWarning.value).toBeTruthy()
  })

  it.each(['startedAt', 'activity'])('rejects saved %s timestamps outside the Date range', field => {
    const storage = memoryStorage()
    createBankrollPractice(storage).join(25_000n)
    const saved = JSON.parse(storage.getItem(BANKROLL_PRACTICE_STORAGE_KEY)!)
    if (field === 'startedAt') { saved.startedAt = Number.MAX_SAFE_INTEGER; saved.journal = [] }
    else saved.journal[0].at = Number.MAX_SAFE_INTEGER
    storage.setItem(BANKROLL_PRACTICE_STORAGE_KEY, JSON.stringify(saved))
    const restored = createBankrollPractice(storage)
    expect(restored.state.value.memberShares).toBe(0n)
    expect(restored.state.value.activity).toEqual([])
    expect(restored.storageWarning.value).toMatch(/saved|verify|invalid/i)
    const format = new Intl.DateTimeFormat('en', { timeStyle: 'short' })
    expect(() => restored.state.value.history.map(point => format.format(new Date(point.at)))).not.toThrow()
  })

  it('accepts the Date boundary while keeping version validation independent of dates', () => {
    const storage = memoryStorage()
    createBankrollPractice(storage).join(25_000n)
    const saved = JSON.parse(storage.getItem(BANKROLL_PRACTICE_STORAGE_KEY)!)
    saved.startedAt = 8_640_000_000_000_000
    saved.journal[0].at = saved.startedAt
    saved.initialVersion = saved.startedAt + 1
    storage.setItem(BANKROLL_PRACTICE_STORAGE_KEY, JSON.stringify(saved))
    const restored = createBankrollPractice(storage)
    expect(restored.storageWarning.value).toBeNull()
    expect(restored.state.value.version).toBe(saved.initialVersion + 1)
    const format = new Intl.DateTimeFormat('en', { timeStyle: 'short' })
    expect(() => format.format(new Date(restored.state.value.activity[0].at))).not.toThrow()
  })

  it('keeps a successful local action when persistence fails and reports session-only mode', () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('quota exceeded') } }
    const practice = createBankrollPractice(storage)
    practice.join(25_000n)
    expect(practice.state.value.memberShares).toBe(25_000_000_000n)
    expect(practice.storageWarning.value).toMatch(/session|tab/i)
    practice.playRound('refund', 1000n)
    expect(practice.state.value.version).toBe(2)
  })

  it('runs only in this tab when reading browser storage fails', () => {
    const storage = { getItem: () => { throw new Error('storage disabled') }, setItem: () => undefined }
    const practice = createBankrollPractice(storage)
    expect(practice.storageWarning.value).toMatch(/tab|session/i)
    practice.join(1000n)
    expect(practice.state.value.cashSats).toBe(99_000n)
  })

  it('bounds displayed activity and history without truncating restore accounting', () => {
    const storage = memoryStorage()
    const practice = createBankrollPractice(storage)
    practice.join(25_000n)
    for (let i = 0; i < 65; i++) practice.playRound('refund', 1n)
    expect(practice.state.value.activity).toHaveLength(60)
    expect(practice.state.value.history).toHaveLength(60)
    expect(practice.state.value.activity[0].id).not.toBe(practice.state.value.activity[59].id)
    expect(createBankrollPractice(storage).state.value).toEqual(practice.state.value)
  })
})
