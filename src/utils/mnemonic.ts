/**
 * BIP39 recovery-phrase support for the wallet. Zero-dependency-on-vuex module
 * (like reclaimBackoff / stashPrune) so the fund-critical derivation is
 * unit-testable in isolation.
 *
 * The wallet stores a raw 32-byte secp256k1 private key (hex) and the whole game
 * signing path keys off it (SingleKey.fromHex + the x-only pubkey baked into the
 * taproot win-leaves). So a mnemonic must deterministically reduce to the SAME
 * kind of 32-byte key — we do NOT adopt an HD identity. A coinflip phrase derives
 * the BIP86 first key (m/86'/0'/0'/0/0), which is what standard BIP39/Taproot
 * wallets (and the SDK's own MnemonicIdentity) treat as "the first key", so a
 * phrase imported elsewhere yields a predictable key.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'

/** BIP86 single-key path — the permanent backup contract. Locked by a hard-coded
 *  test vector; it can never change after release or existing phrases break. */
const DERIVATION_PATH = "m/86'/0'/0'/0/0"

/**
 * Collapse surrounding + internal whitespace. @scure/bip39 does NOT normalize
 * whitespace, so a phrase pasted with a trailing newline or double spaces would
 * otherwise validate/derive differently (a silent wrong-key / fund-access bug).
 * Normalize ONCE and feed the same value to both validate and seed.
 */
export function normalizeMnemonic(input: string): string {
  return input.trim().replace(/\s+/g, ' ')
}

/**
 * True iff the (normalized) input is a valid BIP39 phrase. Used to branch import
 * between mnemonic vs legacy nsec / raw-hex: a 64-hex key or an `nsec…` string is
 * a single token, so validateMnemonic returns false and it falls through to its
 * legacy branch. A typo'd phrase also fails the checksum here (rejected, never
 * silently mis-derived).
 */
export function isMnemonic(input: string): boolean {
  return validateMnemonic(normalizeMnemonic(input), wordlist)
}

/**
 * Derive the raw 32-byte secp256k1 private key (hex) from a BIP39 phrase via
 * BIP86 m/86'/0'/0'/0/0. Normalizes first; throws on an invalid phrase so a bad
 * input fails closed rather than producing a wrong key.
 */
export function deriveKeyFromMnemonic(input: string): string {
  const norm = normalizeMnemonic(input)
  if (!validateMnemonic(norm, wordlist)) throw new Error('Invalid recovery phrase')
  const seed = mnemonicToSeedSync(norm)
  const child = HDKey.fromMasterSeed(seed).derive(DERIVATION_PATH)
  if (!child.privateKey) throw new Error('Invalid recovery phrase')
  return hex.encode(child.privateKey)
}

/** Generate a fresh 12-word (128-bit) English BIP39 phrase. */
export function generateMnemonicPhrase(): string {
  return generateMnemonic(wordlist, 128)
}
