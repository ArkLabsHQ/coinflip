import { createLnurlClient } from '@arkade-os/lnurl-client'
import { requireSats } from '@/services/swaps'

/** Email-shaped Lightning Address. RFC 5322 is overkill — match the
 *  common case (`user@host` with at least one `.` in the host) and let
 *  the server reject anything weirder. */
const LN_ADDR_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** bech32 LNURL — case-insensitive, must start with the `lnurl` HRP. */
const LNURL_BECH32_RE = /^lnurl1[ac-hj-np-z02-9]+$/i

/** What `isValidLnurlInput` returns when the string parses cleanly into
 *  one of the supported shapes. */
export interface LnurlInput {
  kind: 'lnaddr' | 'lnurl' | 'https'
  /** The original input, lowercased + trimmed (canonical form). */
  raw: string
}

/** Cheap detector — does NOT contact the network. Use this before calling
 *  `resolveLnurl` to flip on the "Lightning address" UI branch. */
export function detectLnurlInput(raw: string): LnurlInput | null {
  const s = (raw || '').trim()
  if (!s) return null
  // Strip a `lightning:` prefix some QR codes / wallets prepend.
  const stripped = s.replace(/^lightning:/i, '').replace(/^lnurl:/i, '').trim()
  const low = stripped.toLowerCase()
  if (LN_ADDR_RE.test(stripped)) return { kind: 'lnaddr', raw: stripped }
  if (LNURL_BECH32_RE.test(low)) return { kind: 'lnurl', raw: low }
  // Plain HTTPS URL is also valid per LUD-01.
  if (/^https:\/\/[^/]+\/.+/i.test(stripped)) return { kind: 'https', raw: stripped }
  return null
}

/** The package validates the LNURL response; the wallet also binds the invoice amount. */
export async function resolveLnurlToInvoice(input: LnurlInput, amountSats: number): Promise<{ invoice: string }> {
  requireSats(amountSats)
  const client = createLnurlClient()
  const params = await client.resolve(input.raw)
  const result = await client.requestInvoice(params, { amountSat: amountSats, paymentOption: 'lightning' })
  if (result.kind !== 'bolt11') throw new Error('Recipient did not return a Lightning invoice')
  return { invoice: result.pr }
}
