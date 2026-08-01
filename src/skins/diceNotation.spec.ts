import { describe, it, expect } from 'vitest'
import { diceNotation } from './diceNotation'

/**
 * A player reported: "Dice does not show the right face, very often an issue."
 * The screenshot read "LOSE — rolled 75, needed 86+" beside a die showing 30 /
 * 90 / 10 — every visible face a multiple of ten.
 *
 * Cause: `@3d-dice/dice-box-threejs` has no hundred-sided die. Its `d100` is a
 * "Ten-Sided Dice (Tens Digit)" — ten faces reading 10..100 — so `1d100@75` is
 * unrepresentable, and the library does not throw. It lands on a face it can
 * show and downgrades the roll's reason from "forced" to "natural".
 *
 * "Very often" because 90% of rolls are not multiples of ten.
 *
 * Each expectation below was verified against the real library in a browser.
 */
describe('diceNotation', () => {
  describe('d100 — the percentile pair', () => {
    it('splits the reported roll into tens and units', () => {
      // VERIFIED: -> d100=70 forced + d10=5 forced, total 75, and a screenshot
      // confirmed the dice rest on 70 and 5.
      expect(diceNotation(100, 75)).toBe('1d100+1d10@70,5')
    })

    it('uses a single tens die for exact multiples of ten', () => {
      // VERIFIED forced. Preferred over a pair, which would have to show 70 as
      // "60 + 10" — the units die counts 1..10 and has no zero face.
      expect(diceNotation(100, 10)).toBe('1d100@10')
      expect(diceNotation(100, 70)).toBe('1d100@70')
      expect(diceNotation(100, 100)).toBe('1d100@100')
    })

    it('uses a single units die below ten, where the tens die has no face', () => {
      expect(diceNotation(100, 1)).toBe('1d10@1')
      expect(diceNotation(100, 9)).toBe('1d10@9')
    })

    it('never emits the notation that silently lands wrong', () => {
      // `1d100@<non-multiple-of-ten>` is the exact shape of the bug.
      for (let v = 1; v <= 100; v++) {
        const n = diceNotation(100, v)
        const loneTens = n.match(/^1d100@(\d+)$/)
        if (loneTens) expect(Number(loneTens[1]) % 10).toBe(0)
      }
    })

    it('every value 1..100 is representable, and the faces sum to it', () => {
      for (let v = 1; v <= 100; v++) {
        const n = diceNotation(100, v)
        const [dice, forced] = n.split('@')
        const values = forced.split(',').map(Number)
        // One forced value per die in the expression.
        expect(values).toHaveLength(dice.split('+').length)
        // dice-box totals the faces; that total is what the player reads.
        expect(values.reduce((a, b) => a + b, 0)).toBe(v)
      }
    })
  })

  describe('other die types are untouched', () => {
    it('maps one-to-one', () => {
      expect(diceNotation(20, 17)).toBe('1d20@17')
      expect(diceNotation(6, 3)).toBe('1d6@3')
      expect(diceNotation(10, 8)).toBe('1d10@8')
    })
  })
})
