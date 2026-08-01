/**
 * Dice-box notation for showing an exact roll — pure, so the mapping is testable.
 *
 * `@3d-dice/dice-box-threejs` has no hundred-sided die. Its `d100` is, in the
 * library's own words, a **"Ten-Sided Dice (Tens Digit)"**: ten faces reading
 * 10, 20, … 90, 100. So `1d100@75` cannot be honoured, and the library does not
 * complain — it quietly lands on a face it *can* show and downgrades the roll's
 * reason from `"forced"` to `"natural"`.
 *
 * VERIFIED against the real library in a browser:
 *
 *   1d100@70        -> 70, forced      (multiples of ten are fine)
 *   1d100@75        -> 10, NATURAL     <- the bug: silently wrong face
 *   1d100@70 1d10@5 -> one die, natural (space-separated groups lose the force)
 *   1d100+1d10@70,5 -> 70 forced + 5 forced, total 75   <- what we want
 *
 * That last form is a true percentile pair, and a screenshot confirmed it rests
 * on 70 and 5. The `@` list applies across the whole expression in die order.
 *
 * A player reported it as "dice does not show the right face, very often" —
 * "very often" because 90% of rolls are not multiples of ten.
 */

/** The tens die can show these exactly, as a single die. */
const isTensFace = (v: number) => v % 10 === 0 && v >= 10 && v <= 100

/**
 * Notation that lands `value` face-up on a `sides`-sided die.
 *
 * `value` is 1-based (a roll of 0 is shown as 1), matching the "rolled N" text.
 */
export function diceNotation(sides: number, value: number): string {
  // Every other die type maps one-to-one and needs no special handling.
  if (sides !== 100) return `1d${sides}@${value}`

  // 1..9 — below the tens die's range, so the units die alone reads correctly.
  if (value < 10) return `1d10@${value}`

  // 10, 20, … 100 — one tens die shows these exactly. Preferred over a pair,
  // which would have to render 70 as "60 + 10" because the units die counts
  // 1..10 and has no zero face.
  if (isTensFace(value)) return `1d100@${value}`

  // The general case: tens die + units die, e.g. 75 -> "70" and "5".
  const units = value % 10
  return `1d100+1d10@${value - units},${units}`
}
