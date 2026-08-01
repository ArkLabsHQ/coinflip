import { describe, it, expect } from 'vitest'
import { redirectFor, type NavTarget } from './guard'

// Mirrors the real route table in ./index.ts.
const PLAY: NavTarget = { name: 'play', meta: { requiresWallet: true } }
const HISTORY: NavTarget = { name: 'history', meta: { requiresWallet: true } }
const SETUP: NavTarget = { name: 'setup' }
const HOW_IT_WORKS: NavTarget = { name: 'how-it-works' }

const ALL = [PLAY, HISTORY, SETUP, HOW_IT_WORKS]
/** Where each redirect target lands, so a redirect can be followed. */
const BY_PATH: Record<string, NavTarget> = { '/': PLAY, '/setup': SETUP }

describe('redirectFor', () => {
  describe('without a wallet', () => {
    it('sends wallet-gated routes to setup', () => {
      expect(redirectFor(PLAY, false)).toBe('/setup')
      expect(redirectFor(HISTORY, false)).toBe('/setup')
    })

    it('leaves setup alone — there is nowhere else to send them', () => {
      expect(redirectFor(SETUP, false)).toBeNull()
    })
  })

  describe('with a wallet', () => {
    it('sends setup to the game', () => {
      // The reported behaviour: "Setup page should redirect to the game play if
      // we already have a wallet."
      expect(redirectFor(SETUP, true)).toBe('/')
    })

    it('leaves wallet-gated routes alone', () => {
      expect(redirectFor(PLAY, true)).toBeNull()
      expect(redirectFor(HISTORY, true)).toBeNull()
    })
  })

  it('never touches public routes', () => {
    expect(redirectFor(HOW_IT_WORKS, false)).toBeNull()
    expect(redirectFor(HOW_IT_WORKS, true)).toBeNull()
  })

  it('redirectsAreTerminal — following a redirect never redirects again', () => {
    // The two rules point at each other, so a wrong condition on either would
    // bounce the user between /setup and / forever. Follow every redirect from
    // every route in both wallet states and assert the destination is final.
    for (const initialized of [true, false]) {
      for (const route of ALL) {
        const first = redirectFor(route, initialized)
        if (first === null) continue
        const destination = BY_PATH[first]
        expect(destination, `no known route for ${first}`).toBeDefined()
        expect(
          redirectFor(destination, initialized),
          `${String(route.name)} -> ${first} redirected again (wallet=${initialized})`,
        ).toBeNull()
      }
    }
  })
})
