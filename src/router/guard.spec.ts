import { describe, it, expect } from 'vitest'
import { redirectFor, setupReturnTo, type NavTarget } from './guard'

// Mirrors the real route table in ./index.ts.
const PLAY: NavTarget = { name: 'play', meta: { requiresWallet: true } }
const HISTORY: NavTarget = { name: 'history', meta: { requiresWallet: true } }
const SETUP: NavTarget = { name: 'setup' }
const HOW_IT_WORKS: NavTarget = { name: 'how-it-works' }
const BANKROLL: NavTarget = { name: 'bankroll' }

const ALL = [PLAY, HISTORY, SETUP, HOW_IT_WORKS, BANKROLL]
/** Where each redirect target lands, so a redirect can be followed. */
const BY_PATH: Record<string, NavTarget> = { '/': PLAY, '/setup': SETUP, '/bankroll': BANKROLL }

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
    expect(redirectFor(BANKROLL, false)).toBeNull()
    expect(redirectFor(BANKROLL, true)).toBeNull()
  })

  it('returns an initialized wallet to the selected bankroll mode', () => {
    expect(redirectFor({ ...SETUP, query: { returnTo: '/bankroll' } }, true))
      .toEqual({ path: '/bankroll', query: { view: 'watch' } })
  })

  it('preserves an explicit funded-pool setup destination', () => {
    expect(redirectFor({ ...SETUP, query: { returnTo: '/bankroll', poolView: 'pool' } }, true))
      .toEqual({ path: '/bankroll', query: { view: 'pool' } })
    expect(redirectFor({ ...SETUP, query: { returnTo: '/bankroll', poolView: '//example.com' } }, true))
      .toEqual({ path: '/bankroll', query: { view: 'watch' } })
  })

  it.each([undefined, null, '', '/history', '//example.com', 'https://example.com', ['/bankroll']])(
    'falls back to play for unsupported setup destination %j', (target) => {
      expect(setupReturnTo(target)).toBe('/')
      expect(redirectFor({ ...SETUP, query: { returnTo: target } }, true)).toBe('/')
    },
  )

  it('accepts the two application mode destinations', () => {
    expect(setupReturnTo('/')).toBe('/')
    expect(setupReturnTo('/bankroll')).toBe('/bankroll')
  })

  it('redirectsAreTerminal — following a redirect never redirects again', () => {
    // The two rules point at each other, so a wrong condition on either would
    // bounce the user between /setup and / forever. Follow every redirect from
    // every route in both wallet states and assert the destination is final.
    for (const initialized of [true, false]) {
      for (const route of ALL) {
        const first = redirectFor(route, initialized)
        if (first === null) continue
        const path = typeof first === 'string' ? first : first.path
        const destination = BY_PATH[path]
        expect(destination, `no known route for ${first}`).toBeDefined()
        expect(
          redirectFor(destination, initialized),
          `${String(route.name)} -> ${first} redirected again (wallet=${initialized})`,
        ).toBeNull()
      }
    }
  })
})
