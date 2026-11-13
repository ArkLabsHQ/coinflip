import { createHash } from 'crypto'
import { commitDigit, digitHash, encodeReveal } from 'arkade-coinflip'

describe('game reveal commitments', () => {
  it('hashes the digit byte followed by the entire salt using SHA256', () => {
    const salt = new Uint8Array(16).fill(0x37)
    const expected = createHash('sha256').update(Buffer.from([3, ...salt])).digest('hex')
    expect(Buffer.from(digitHash({ digit: 3, salt })).toString('hex')).toBe(expected)
    expect(Buffer.from(encodeReveal(3, salt))).toEqual(Buffer.from([3, ...salt]))
  })

  it('generates independent 128-bit salts', () => {
    const a = commitDigit(1, 2)
    const b = commitDigit(1, 2)
    expect(a.salt.length).toBe(16)
    expect(b.salt.length).toBe(16)
    expect(Buffer.from(a.salt)).not.toEqual(Buffer.from(b.salt))
    expect(Buffer.from(digitHash(a))).not.toEqual(Buffer.from(digitHash(b)))
  })

  it('commits both the digit and every salt byte', () => {
    const salt = new Uint8Array(16).fill(0x37)
    const hash = Buffer.from(digitHash({ digit: 3, salt }))
    expect(Buffer.from(digitHash({ digit: 4, salt }))).not.toEqual(hash)
    for (let i = 0; i < salt.length; i++) {
      const changed = salt.slice()
      changed[i] ^= 1
      expect(Buffer.from(digitHash({ digit: 3, salt: changed }))).not.toEqual(hash)
    }
  })

  it.each([-1, 6, 1.5, NaN, Infinity])('rejects an invalid digit: %s', digit => {
    expect(() => commitDigit(digit, 6)).toThrow(/digit/)
  })

  it.each([0, 1, 129, 2.5, NaN])('rejects an unsupported odds denominator: %s', n => {
    expect(() => commitDigit(0, n)).toThrow(/n must/)
  })

  it('accepts the highest supported digit without signed-byte truncation', () => {
    const commit = commitDigit(127, 128)
    expect(encodeReveal(commit.digit, commit.salt)[0]).toBe(127)
    const invalidReveal = encodeReveal(255, commit.salt)
    expect(invalidReveal[0]).toBe(255)
    expect(Buffer.from(digitHash({ digit: 255, salt: commit.salt })))
      .toEqual(createHash('sha256').update(invalidReveal).digest())
  })
})
