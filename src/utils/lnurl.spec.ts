/**
 * Detector-only tests for the LNURL input parser. The fetch-based
 * resolve functions are not unit-tested here (they need network), but
 * the input classifier IS load-bearing — it's what makes
 * Send-via-Lightning-Address feel instant in the WalletDrawer.
 */

import { describe, it, expect } from 'vitest'
import { detectLnurlInput } from './lnurl'

describe('detectLnurlInput', () => {
  it('returns null for empty / whitespace input', () => {
    expect(detectLnurlInput('')).toBeNull()
    expect(detectLnurlInput('   ')).toBeNull()
  })

  it('accepts a plain lightning address (user@host)', () => {
    const r = detectLnurlInput('andrew@arkade.sh')
    expect(r?.kind).toBe('lnaddr')
    expect(r?.raw).toBe('andrew@arkade.sh')
  })

  it('accepts a lightning address with subdomain host', () => {
    const r = detectLnurlInput('alice@strike.me')
    expect(r?.kind).toBe('lnaddr')
  })

  it('strips a lightning: prefix and still detects the address', () => {
    const r = detectLnurlInput('lightning:bob@getalby.com')
    expect(r?.kind).toBe('lnaddr')
    expect(r?.raw).toBe('bob@getalby.com')
  })

  it('accepts a bech32 LNURL (lowercase)', () => {
    // Real LNURL — points at https://service.com/.well-known/lnurlp/u
    // (we don't decode here, just classify it)
    const r = detectLnurlInput(
      'lnurl1dp68gurn8ghj7em9w3skccne9e3k7mf0d3h82unvwqhj7mn0wd68ytnvv5kc66xv4ek2unfd968yetv8',
    )
    expect(r?.kind).toBe('lnurl')
  })

  it('accepts a bech32 LNURL case-insensitively + lowercases the raw form', () => {
    const upper = 'LNURL1DP68GURN8GHJ7EM9W3SKCCNE9E3K7MF0D3H82UNVWQHJ7MN0WD68YTNVV5KC66XV4EK2UNFD968YETV8'
    const r = detectLnurlInput(upper)
    expect(r?.kind).toBe('lnurl')
    expect(r?.raw).toBe(upper.toLowerCase())
  })

  it('strips a lnurl: prefix', () => {
    const r = detectLnurlInput(
      'lnurl:lnurl1dp68gurn8ghj7em9w3skccne9e3k7mf0d3h82unvwqhj7mn0wd68ytnvv5kc66xv4ek2unfd968yetv8',
    )
    expect(r?.kind).toBe('lnurl')
  })

  it('accepts a raw HTTPS URL pointing at an LNURL-pay endpoint', () => {
    const r = detectLnurlInput('https://example.com/.well-known/lnurlp/andrew')
    expect(r?.kind).toBe('https')
  })

  it('rejects plain HTTP (LUD-01 requires https for clearnet)', () => {
    expect(detectLnurlInput('http://example.com/.well-known/lnurlp/andrew')).toBeNull()
  })

  it('rejects a plain bech32 string with a non-lnurl HRP', () => {
    // bc1q... is bech32 too but not LNURL.
    expect(detectLnurlInput('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')).toBeNull()
  })

  it('rejects something that looks like an email but lacks a TLD', () => {
    // user@localhost has no dot in the host. Real LN addresses always
    // have a proper domain; the strict regex matches that.
    expect(detectLnurlInput('user@localhost')).toBeNull()
  })

  it('rejects an Ark address (which contains @-less data)', () => {
    expect(detectLnurlInput('tark1q1234567890abcdef')).toBeNull()
  })
})
