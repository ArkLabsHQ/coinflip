/**
 * Detector-only tests for the LNURL input parser. The fetch-based
 * resolve functions are not unit-tested here (they need network), but
 * the input classifier IS load-bearing — it's what makes
 * Send-via-Lightning-Address feel instant in the WalletDrawer.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import { bech32, hex } from '@scure/base'
import { detectLnurlInput, resolveLnurlToInvoice } from './lnurl'

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

/** Structurally valid BOLT11 fixture: decoder validation, not a payable invoice. */
function invoice(amount: number): string {
  const words = [0, 0, 0, 0, 0, 0, 0]
  const description = bech32.toWords(new TextEncoder().encode('test'))
  words.push(13, description.length >> 5, description.length & 31, ...description)
  words.push(1, 1, 20, ...bech32.toWords(hex.decode('11'.repeat(32))))
  words.push(...Array(104).fill(0))
  return bech32.encode(`lnbc${amount * 10}n`, words, 2000)
}

describe('LNURL payment boundary through the real client', () => {
  afterEach(() => vi.unstubAllGlobals())

  function endpoint(amount: number) {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const callback = String(url).includes('/callback')
      return new Response(JSON.stringify(callback ? { pr: invoice(amount), routes: [] } : {
        tag: 'payRequest', callback: 'https://example.com/callback',
        minSendable: 1000, maxSendable: 10_000_000, metadata: '[["text/plain","test"]]',
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('asks for exact millisats and returns an invoice bound to that amount', async () => {
    const fetch = endpoint(1000)
    const result = await resolveLnurlToInvoice({ kind: 'lnaddr', raw: 'user@example.com' }, 1000)
    expect(result.invoice).toBe(invoice(1000))
    expect(String(fetch.mock.calls[1][0])).toContain('amount=1000000')
  })

  it('refuses a recipient invoice for a different amount', async () => {
    endpoint(2000)
    await expect(resolveLnurlToInvoice({ kind: 'lnaddr', raw: 'user@example.com' }, 1000)).rejects.toThrow(/requested/i)
  })

  it('rejects fractional sats before contacting the recipient', async () => {
    const fetch = endpoint(1000)
    await expect(resolveLnurlToInvoice({ kind: 'lnaddr', raw: 'user@example.com' }, 1.5)).rejects.toThrow('whole number')
    expect(fetch).not.toHaveBeenCalled()
  })
})
