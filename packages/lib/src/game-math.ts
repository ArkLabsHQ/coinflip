import type { DigitCommit } from './arkade-win'

export function randomUniformInt(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`randomUniformInt: n must be a positive safe integer (got ${n})`)
  }
  if (n === 1) return 0
  const byteCount = Math.ceil(Math.log2(n) / 8) || 1
  const max = byteCount === 7 ? 2 ** 53 : 256 ** byteCount
  const limit = max - (max % n)
  const bytes = new Uint8Array(byteCount)
  for (;;) {
    ;(globalThis as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto.getRandomValues(bytes)
    if (byteCount === 7) bytes[0] &= 31
    let sample = 0
    for (const byte of bytes) sample = sample * 256 + byte
    if (sample < limit) return sample % n
  }
}

export function determineWinnerV3(
  creatorReveal: Pick<DigitCommit, 'digit'>,
  playerReveal: Pick<DigitCommit, 'digit'>,
  n: number,
  target: number,
  lo: number,
): 'creator' | 'player' {
  const houseDigit = creatorReveal.digit
  const playerDigit = playerReveal.digit
  if (houseDigit < 0 || houseDigit >= n) return 'player'
  if (playerDigit < 0 || playerDigit >= n) return 'creator'
  const roll = (houseDigit + playerDigit) % n
  return roll >= lo && roll < target ? 'player' : 'creator'
}

export function computeRollV3(creatorReveal: DigitCommit, playerReveal: DigitCommit, n: number): number | null {
  const houseDigit = creatorReveal.digit
  const playerDigit = playerReveal.digit
  if (houseDigit < 0 || houseDigit >= n || playerDigit < 0 || playerDigit >= n) return null
  return (houseDigit + playerDigit) % n
}
