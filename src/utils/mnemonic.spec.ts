import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import {
  normalizeMnemonic,
  isMnemonic,
  deriveKeyFromMnemonic,
  generateMnemonicPhrase,
} from './mnemonic'

// The standard BIP39 test phrase and its m/86'/0'/0'/0/0 key — verified at
// runtime against @scure/bip39 1.2.1 + @scure/bip32 2.2.0. This vector is the
// PERMANENT backup contract: if it ever changes, every existing recovery phrase
// derives a different key and loses fund access. Lock it.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TEST_VECTOR = '41f41d69260df4cf277826a9b65a3717e4eeddbeedf637f212ca096576479361'

describe('deriveKeyFromMnemonic — locked BIP86 derivation contract', () => {
  it('derives the canonical m/86h/0h/0h/0/0 vector from the standard test phrase', () => {
    expect(deriveKeyFromMnemonic(TEST_MNEMONIC)).toBe(TEST_VECTOR)
  })

  it('normalizes whitespace: trailing newline + double internal spaces derive the SAME key', () => {
    // @scure/bip39 does NOT normalize whitespace; without the normalize step
    // these would silently derive a different (wrong) key — fund-access footgun.
    expect(deriveKeyFromMnemonic(TEST_MNEMONIC + '\n')).toBe(TEST_VECTOR)
    expect(deriveKeyFromMnemonic('  ' + TEST_MNEMONIC.replace(/ /g, '  ') + '  ')).toBe(TEST_VECTOR)
  })

  it('throws on an invalid phrase — never silently derives a wrong key', () => {
    expect(() => deriveKeyFromMnemonic('abandon abandon abandon')).toThrow()
    // checksum-breaking last word
    expect(() => deriveKeyFromMnemonic(TEST_MNEMONIC.replace(/about$/, 'abandon'))).toThrow()
  })

  it('derived key is a valid secp256k1 scalar (schnorr yields a 32-byte x-only pubkey)', () => {
    const pub = schnorr.getPublicKey(hex.decode(deriveKeyFromMnemonic(TEST_MNEMONIC)))
    expect(pub.length).toBe(32)
  })
})

describe('isMnemonic — import-branch discriminator', () => {
  it('accepts a valid phrase, normalizing whitespace', () => {
    expect(isMnemonic(TEST_MNEMONIC)).toBe(true)
    expect(isMnemonic(TEST_MNEMONIC + '\n')).toBe(true)
  })

  it('rejects a 64-hex key and an nsec string so they fall through to legacy branches', () => {
    expect(isMnemonic('a'.repeat(64))).toBe(false)
    expect(isMnemonic('nsec1qqqqqqqq')).toBe(false)
    expect(isMnemonic('')).toBe(false)
  })
})

describe('normalizeMnemonic', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeMnemonic('  a   b\tc \n')).toBe('a b c')
  })
})

describe('generateMnemonicPhrase', () => {
  it('produces a valid 12-word phrase that round-trips through derivation', () => {
    const phrase = generateMnemonicPhrase()
    expect(phrase.split(' ')).toHaveLength(12)
    expect(isMnemonic(phrase)).toBe(true)
    expect(deriveKeyFromMnemonic(phrase)).toMatch(/^[0-9a-f]{64}$/)
  })
})
