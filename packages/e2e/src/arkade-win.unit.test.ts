/**
 * Unit tests for arkade-win's win-condition predicate.
 *
 *   - exhaustive correctness over the (cd, pd) matrix for several (n, lo, target)
 *   - out-of-range tiebreaks (bad creator → player wins; bad player → creator wins;
 *     both bad → player wins)
 *   - missing-packet → script fails
 *   - hash-mismatch → script fails (forged reveal)
 *   - determinism (same inputs → byte-identical script)
 *
 * The in-process walker is in packages/e2e/src/test-helpers/arkade-eval.ts.
 * The regtest in arkade-win.regtest.test.ts is the source of truth for
 * end-to-end behavior (against the actual emulator).
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  buildVariableOddsWinPredicate,
  commitDigit,
  digitHash,
} = require('arkade-coinflip')
const { packets } = require('@arklabshq/contract-workflows-prototype')
const { evalPredicate } = require('./test-helpers/arkade-eval')

/** TS oracle for the predicate. Returns true iff player wins. */
function expectedPlayerWins(cd: number, pd: number, n: number, lo: number, target: number): boolean {
  const cValid = cd >= 0 && cd < n
  const pValid = pd >= 0 && pd < n
  if (!cValid) return true                       // bad creator → player wins (matches both-bad case via outer NOTIF)
  if (!pValid) return false                      // bad player → creator wins
  const roll = (cd + pd) % n
  return roll >= lo && roll < target
}

function makeCommit(digit: number, fillByte: number) {
  const salt = new Uint8Array(16).fill(fillByte)
  return { digit, salt }
}

function bothPackets(p: { digit: number; salt: Uint8Array }, c: { digit: number; salt: Uint8Array }) {
  return {
    [packets.REVEAL_PLAYER_PACKET_TYPE]:  packets.encodeReveal(p.digit, p.salt),
    [packets.REVEAL_CREATOR_PACKET_TYPE]: packets.encodeReveal(c.digit, c.salt),
  }
}

describe('buildVariableOddsWinPredicate — exhaustive correctness', () => {
  const MATRIX = [
    { n: 2,  lo: 0, target: 1 },     // legacy coin: heads
    { n: 2,  lo: 1, target: 2 },     // legacy coin: tails
    { n: 6,  lo: 0, target: 1 },     // dice: "roll a 1"
    { n: 6,  lo: 3, target: 6 },     // dice: "4 or higher"
    { n: 6,  lo: 5, target: 6 },     // dice: "exactly a 6"
    { n: 36, lo: 0, target: 9 },     // 2-dice slice
    { n: 36, lo: 17, target: 19 },   // narrow odds
    { n: 100, lo: 0, target: 51 },   // 51% house-edge-ish
  ]

  for (const { n, lo, target } of MATRIX) {
    it(`n=${n} lo=${lo} target=${target} — full matrix matches oracle`, () => {
      for (let cd = 0; cd < n; cd++) {
        for (let pd = 0; pd < n; pd++) {
          const c = makeCommit(cd, 0xa1)
          const p = makeCommit(pd, 0xb2)
          const cHash = digitHash(c), pHash = digitHash(p)
          const playerWinScript  = buildVariableOddsWinPredicate(cHash, pHash, n, target, lo, true)
          const creatorWinScript = buildVariableOddsWinPredicate(cHash, pHash, n, target, lo, false)
          const env = bothPackets(p, c)

          const exp = expectedPlayerWins(cd, pd, n, lo, target)

          const playerResult = evalPredicate(playerWinScript, env)
          const creatorResult = evalPredicate(creatorWinScript, env)

          if (playerResult !== exp || creatorResult !== !exp) {
            throw new Error(
              `mismatch at cd=${cd} pd=${pd}: expected player=${exp}, got player=${playerResult} creator=${creatorResult}`,
            )
          }
        }
      }
    })
  }
})

describe('out-of-range tiebreaks', () => {
  const n = 6
  it('bad creator digit (cd=7) → player wins', () => {
    const c = makeCommit(7, 0xa1)
    const p = makeCommit(3, 0xb2)
    const cHash = digitHash(c), pHash = digitHash(p)
    const env = bothPackets(p, c)
    expect(evalPredicate(buildVariableOddsWinPredicate(cHash, pHash, n, 6, 0, true), env)).toBe(true)
    expect(evalPredicate(buildVariableOddsWinPredicate(cHash, pHash, n, 6, 0, false), env)).toBe(false)
  })

  it('bad player digit (pd=8) → creator wins', () => {
    const c = makeCommit(2, 0xa1)
    const p = makeCommit(8, 0xb2)
    const cHash = digitHash(c), pHash = digitHash(p)
    const env = bothPackets(p, c)
    expect(evalPredicate(buildVariableOddsWinPredicate(cHash, pHash, n, 6, 0, true), env)).toBe(false)
    expect(evalPredicate(buildVariableOddsWinPredicate(cHash, pHash, n, 6, 0, false), env)).toBe(true)
  })

  it('both digits bad (cd=7, pd=8) → player wins (outer NOTIF triggers first)', () => {
    const c = makeCommit(7, 0xa1)
    const p = makeCommit(8, 0xb2)
    const cHash = digitHash(c), pHash = digitHash(p)
    const env = bothPackets(p, c)
    expect(evalPredicate(buildVariableOddsWinPredicate(cHash, pHash, n, 6, 0, true), env)).toBe(true)
    expect(evalPredicate(buildVariableOddsWinPredicate(cHash, pHash, n, 6, 0, false), env)).toBe(false)
  })
})

describe('failure modes', () => {
  const n = 2
  const c = makeCommit(0, 0xa1)
  const p = makeCommit(1, 0xb2)
  const cHash = digitHash(c), pHash = digitHash(p)
  const playerWin = () => buildVariableOddsWinPredicate(cHash, pHash, n, 1, 0, true)
  const creatorWin = () => buildVariableOddsWinPredicate(cHash, pHash, n, 1, 0, false)

  it('missing player packet → script fails', () => {
    const env = { [packets.REVEAL_CREATOR_PACKET_TYPE]: packets.encodeReveal(c.digit, c.salt) }
    expect(() => evalPredicate(playerWin(), env)).toThrow(/VERIFY|EQUALVERIFY|stack/i)
    expect(() => evalPredicate(creatorWin(), env)).toThrow(/VERIFY|EQUALVERIFY|stack/i)
  })

  it('missing creator packet → script fails', () => {
    const env = { [packets.REVEAL_PLAYER_PACKET_TYPE]: packets.encodeReveal(p.digit, p.salt) }
    expect(() => evalPredicate(playerWin(), env)).toThrow(/VERIFY|EQUALVERIFY|stack/i)
    expect(() => evalPredicate(creatorWin(), env)).toThrow(/VERIFY|EQUALVERIFY|stack/i)
  })

  it('no packets at all → script fails', () => {
    expect(() => evalPredicate(playerWin(), {})).toThrow(/VERIFY|EQUALVERIFY|stack/i)
  })

  it('forged player reveal (wrong salt → wrong hash) → script fails', () => {
    const env = {
      [packets.REVEAL_PLAYER_PACKET_TYPE]:  packets.encodeReveal(p.digit, new Uint8Array(16).fill(0xff)),
      [packets.REVEAL_CREATOR_PACKET_TYPE]: packets.encodeReveal(c.digit, c.salt),
    }
    expect(() => evalPredicate(playerWin(), env)).toThrow(/EQUALVERIFY/i)
  })

  it('forged creator reveal → script fails', () => {
    const env = {
      [packets.REVEAL_PLAYER_PACKET_TYPE]:  packets.encodeReveal(p.digit, p.salt),
      [packets.REVEAL_CREATOR_PACKET_TYPE]: packets.encodeReveal(c.digit, new Uint8Array(16).fill(0xee)),
    }
    expect(() => evalPredicate(playerWin(), env)).toThrow(/EQUALVERIFY/i)
  })

  it('swapped reveals (player packet contains creator data + vice versa) → script fails on hash check', () => {
    const env = {
      [packets.REVEAL_PLAYER_PACKET_TYPE]:  packets.encodeReveal(c.digit, c.salt),  // creator data in player slot
      [packets.REVEAL_CREATOR_PACKET_TYPE]: packets.encodeReveal(p.digit, p.salt),
    }
    expect(() => evalPredicate(playerWin(), env)).toThrow(/EQUALVERIFY/i)
  })
})

describe('determinism', () => {
  it('same inputs → byte-identical script', () => {
    const cHash = new Uint8Array(32).fill(0x11)
    const pHash = new Uint8Array(32).fill(0x22)
    const a = buildVariableOddsWinPredicate(cHash, pHash, 6, 3, 0, true)
    const b = buildVariableOddsWinPredicate(cHash, pHash, 6, 3, 0, true)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('playerWin and creatorWin differ by exactly one trailing OP_NOT (0x91)', () => {
    const cHash = new Uint8Array(32).fill(0x11)
    const pHash = new Uint8Array(32).fill(0x22)
    const a = buildVariableOddsWinPredicate(cHash, pHash, 6, 3, 0, true)
    const b = buildVariableOddsWinPredicate(cHash, pHash, 6, 3, 0, false)
    expect(b.length).toBe(a.length + 1)
    expect(Buffer.from(b.slice(0, a.length)).equals(Buffer.from(a))).toBe(true)
    expect(b[b.length - 1]).toBe(0x91)
  })
})

describe('commitDigit / digitHash', () => {
  it('produces fresh 16-byte salts', () => {
    const c1 = commitDigit(1, 2)
    const c2 = commitDigit(1, 2)
    expect(c1.salt.length).toBe(16)
    // Astronomically unlikely to collide — assert different salts.
    expect(Buffer.from(c1.salt).equals(Buffer.from(c2.salt))).toBe(false)
  })

  it('digitHash is deterministic given (digit, salt)', () => {
    const salt = new Uint8Array(16).fill(0x37)
    expect(Buffer.from(digitHash({ digit: 3, salt })).equals(Buffer.from(digitHash({ digit: 3, salt })))).toBe(true)
  })

  it('rejects out-of-range digits', () => {
    expect(() => commitDigit(-1, 6)).toThrow()
    expect(() => commitDigit(6, 6)).toThrow()
  })

  it('rejects invalid n', () => {
    expect(() => commitDigit(0, 1)).toThrow()
    expect(() => commitDigit(0, 129)).toThrow()   // cap is 128 in v0.3
  })
})
