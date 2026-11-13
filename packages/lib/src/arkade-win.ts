import { sha256 } from '@scure/btc-signer/utils.js'
import { encodeReveal } from './packets'

export interface DigitCommit {
  digit: number
  salt: Uint8Array
}

export function commitDigit(digit: number, n: number): DigitCommit {
  if (!Number.isInteger(n) || n < 2 || n > 128) {
    throw new Error(`commitDigit: n must be an integer in [2, 128], got ${n}`)
  }
  if (!Number.isInteger(digit) || digit < 0 || digit >= n) {
    throw new Error(`commitDigit: digit must be in [0, ${n}), got ${digit}`)
  }
  const salt = new Uint8Array(16)
  ;(globalThis as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto.getRandomValues(salt)
  return { digit, salt }
}

export function digitHash(commit: DigitCommit): Uint8Array {
  return sha256(encodeReveal(commit.digit, commit.salt))
}
