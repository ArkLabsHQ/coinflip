import { describe, it, expect } from 'vitest'
import { resolveSkinId } from './selection'

/** The ids that exist after the coin skin was retired, in SKINS order. */
const IDS = ['dice', 'slot', 'roulette', 'rocket'] as const
const DEFAULT = IDS[0]

describe('resolveSkinId', () => {
  // The reason this module exists: 'coin' was a real, selectable skin, so
  // players have it in localStorage. It must not leave them on nothing.
  it('sends a player holding the retired coin skin to the default', () => {
    expect(resolveSkinId('coin', IDS, DEFAULT)).toBe('dice')
  })

  it('keeps a still-valid selection', () => {
    for (const id of IDS) expect(resolveSkinId(id, IDS, DEFAULT)).toBe(id)
  })

  it('falls back for an absent or empty selection', () => {
    expect(resolveSkinId(null, IDS, DEFAULT)).toBe('dice')
    expect(resolveSkinId(undefined, IDS, DEFAULT)).toBe('dice')
    expect(resolveSkinId('', IDS, DEFAULT)).toBe('dice')
  })

  // A value written by a newer build, or hand-edited storage.
  it('falls back for an unknown id rather than trusting it', () => {
    expect(resolveSkinId('plinko', IDS, DEFAULT)).toBe('dice')
    expect(resolveSkinId('DICE', IDS, DEFAULT)).toBe('dice') // case-sensitive on purpose
  })

  it('does not treat a substring as a match', () => {
    expect(resolveSkinId('dic', IDS, DEFAULT)).toBe('dice')
    expect(resolveSkinId('dicey', IDS, DEFAULT)).toBe('dice')
  })
})
