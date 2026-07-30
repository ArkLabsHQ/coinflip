import { describe, it, expect } from 'vitest'
import {
  SHARED_WIN_PCTS, ROULETTE_N, SLOT_BASE, SLOT_REELS, DICE_N,
  sharedLadder, winPctOfRung, ladderIsSane,
} from './ladder'

/** The `n` each skin realises the shared ladder over. Mirrors index.ts, which
 *  can't be imported here — it pulls in the skin `.vue` components and
 *  vitest.config.ts registers no Vue plugin. */
const SKIN_RANGES: Array<[string, number]> = [
  ['dice', DICE_N],
  ['slot', SLOT_BASE ** SLOT_REELS],
  ['roulette', ROULETTE_N],
  ['rocket', 100],
]

describe('sharedLadder', () => {
  it('gives every skin the SAME number of rungs', () => {
    for (const [id, n] of SKIN_RANGES) {
      expect(sharedLadder(n).length, id).toBe(SHARED_WIN_PCTS.length)
    }
  })

  it('is strictly decreasing in win chance for every skin', () => {
    // Load-bearing: the odds slider assumes index order == risk order, and
    // nearestRungByWinPct's "ties prefer the safer rung" is only well defined
    // on a decreasing ladder. A too-coarse n silently merges two rungs.
    for (const [id, n] of SKIN_RANGES) {
      expect(ladderIsSane(sharedLadder(n)), id).toBe(true)
    }
  })

  it('lands close to the shared percentages in every skin', () => {
    for (const [id, n] of SKIN_RANGES) {
      sharedLadder(n).forEach((rung, i) => {
        const err = Math.abs(winPctOfRung(rung) - SHARED_WIN_PCTS[i])
        // Coin (n=128) is the coarsest at 0.34pp; slot (n=125) 0.40pp.
        expect(err, `${id} rung ${SHARED_WIN_PCTS[i]}%`).toBeLessThanOrEqual(0.5)
      })
    }
  })

  it('uses TOP bands, so the win band always reaches the top of the range', () => {
    for (const [id, n] of SKIN_RANGES) {
      for (const rung of sharedLadder(n)) {
        expect(rung.target, id).toBe(n)
        expect(rung.lo, id).toBeGreaterThanOrEqual(0)
        expect(rung.lo, id).toBeLessThan(rung.target)
      }
    }
  })

  it('never emits an empty or full band, which the server would reject', () => {
    for (const [, n] of SKIN_RANGES) {
      for (const rung of sharedLadder(n)) {
        const win = rung.target - rung.lo
        expect(win).toBeGreaterThanOrEqual(1)
        expect(win).toBeLessThanOrEqual(n - 1)
      }
    }
  })

  it('keeps the long-odds rung that a 37-pocket wheel could not express', () => {
    // The reason ROULETTE_N moved off 37: 1/37 = 2.70%, so 3/2/1% collapsed
    // into one rung and capped every skin at ~32x.
    for (const [id, n] of SKIN_RANGES) {
      const last = sharedLadder(n)[SHARED_WIN_PCTS.length - 1]
      expect(100 / winPctOfRung(last), `${id} max payout`).toBeGreaterThanOrEqual(90)
    }
    expect(ladderIsSane(sharedLadder(37))).toBe(false)
  })

  it('reduces to a single winning outcome at the longest odds', () => {
    // Was asserted only for the coin (its narrowest band being the old "every
    // coin must be heads"). The invariant is not coin-specific, so with the
    // coin skin retired it is asserted for EVERY skin rather than dropped.
    for (const [id, n] of SKIN_RANGES) {
      const ladder = sharedLadder(n)
      const narrowest = ladder[ladder.length - 1]
      expect(narrowest.target - narrowest.lo, `${id} narrowest band`).toBe(1)
    }
  })
})
