import { describe, it, expect, beforeEach } from 'vitest'
import { getSavedBetAmount, saveBetAmount, getSavedStep, saveStep } from './betPrefs'

beforeEach(() => localStorage.clear())

describe('bet amount', () => {
  it('round-trips a stake', () => {
    saveBetAmount(4200)
    expect(getSavedBetAmount()).toBe(4200)
  })

  it('reports null when nothing is stored', () => {
    expect(getSavedBetAmount()).toBeNull()
  })

  it('treats a garbage / non-positive / fractional stored value as absent', () => {
    for (const bad of ['not-a-number', '0', '-100', '1.5', '']) {
      localStorage.setItem('coinflip.bet_amount', bad)
      expect(getSavedBetAmount()).toBeNull()
    }
  })

  it('refuses to persist an unusable stake, leaving the previous one intact', () => {
    saveBetAmount(1000)
    saveBetAmount(0)
    saveBetAmount(-5)
    saveBetAmount(Number.NaN)
    expect(getSavedBetAmount()).toBe(1000)
  })
})

describe('odds step', () => {
  it('round-trips a step per skin, keeping the skins independent', () => {
    saveStep('coin', 2)
    saveStep('roulette', 7)
    expect(getSavedStep('coin')).toBe(2)
    expect(getSavedStep('roulette')).toBe(7)
    // A skin that was never played has no preference of its own.
    expect(getSavedStep('rocket')).toBeNull()
  })

  it('persists step 0 (a real ladder position, not "absent")', () => {
    saveStep('dice', 0)
    expect(getSavedStep('dice')).toBe(0)
  })

  it('overwrites one skin without disturbing the others', () => {
    saveStep('coin', 2)
    saveStep('slot', 5)
    saveStep('coin', 4)
    expect(getSavedStep('coin')).toBe(4)
    expect(getSavedStep('slot')).toBe(5)
  })

  it('survives a corrupt or wrongly-shaped map', () => {
    for (const bad of ['{not json', '[]', 'null', '"a string"']) {
      localStorage.setItem('coinflip.odds_steps', bad)
      expect(getSavedStep('coin')).toBeNull()
      // ...and a later write repairs the key rather than throwing.
      saveStep('coin', 3)
      expect(getSavedStep('coin')).toBe(3)
      localStorage.clear()
    }
  })

  it('rejects a negative / fractional step', () => {
    localStorage.setItem('coinflip.odds_steps', JSON.stringify({ coin: -1, slot: 1.5 }))
    expect(getSavedStep('coin')).toBeNull()
    expect(getSavedStep('slot')).toBeNull()
  })
})
