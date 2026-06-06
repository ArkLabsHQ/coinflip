/**
 * Resolve a Lightning Address or LNURL-pay string into a usable BOLT11
 * invoice that we can hand to Boltz for the Ark→LN submarine swap.
 *
 * Supports three input shapes (per LUD-16 + LUD-06):
 *   - `user@host`              — Lightning Address (most common)
 *   - `LNURL1...` / `lnurl1...` — bech32-encoded HTTPS URL pointing at an
 *                                 LNURL-pay endpoint (LUD-01)
 *   - `https://...`            — raw HTTPS URL pointing at an LNURL-pay
 *                                 endpoint (allowed by some wallets)
 *
 * No external library needed — `bech32` from `@scure/base` covers the
 * decode. We don't ship lnurl-rfc since we only consume the LNURL-pay
 * subset (no auth, no withdraw, no channel — just pay).
 *
 * @see https://github.com/lnurl/luds/blob/luds/06.md
 * @see https://github.com/lnurl/luds/blob/luds/16.md
 */
import { bech32 } from '@scure/base'

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

/** The LNURL-pay first-stage response shape we care about (a strict
 *  subset of LUD-06). The endpoint may return more fields; we ignore them. */
export interface LnurlPayParams {
  tag: 'payRequest'
  callback: string
  minSendable: number  // millisats
  maxSendable: number  // millisats
  metadata: string     // JSON-encoded array, per LUD-06
  /** "comment allowed" (LUD-12). Optional; we ignore comments for now. */
  commentAllowed?: number
}

/** The LNURL-pay second-stage response — a BOLT11 invoice to pay. */
export interface LnurlPaySecondStage {
  pr: string
  routes?: unknown[]
  /** Optional success action (LUD-09); we just display it after pay. */
  successAction?: { tag: string; message?: string; url?: string }
}

/** Convert a Lightning Address (`user@host`) to its LNURL-pay HTTPS URL.
 *  Per LUD-16: `https://<host>/.well-known/lnurlp/<user>`. */
function lnAddrToUrl(addr: string): string {
  const [user, host] = addr.split('@')
  if (!user || !host) throw new Error(`Invalid lightning address: ${addr}`)
  // Per LUD-04: clearnet hosts are HTTPS, .onion hosts may be HTTP.
  const scheme = host.toLowerCase().endsWith('.onion') ? 'http' : 'https'
  return `${scheme}://${host}/.well-known/lnurlp/${user}`
}

/** Decode a bech32 `lnurl1...` string back into its HTTPS URL. The bech32
 *  data is the URL bytes — UTF-8 — packed into 5-bit groups. */
function decodeLnurlBech32(lnurl: string): string {
  // bech32 max length is 90 chars by default; LNURLs can be longer.
  // @scure/base's `bech32.decode` accepts a `limit` arg for exactly this.
  const decoded = bech32.decode(lnurl as `${string}1${string}`, 2000)
  if (decoded.prefix !== 'lnurl') throw new Error(`Bad LNURL HRP: ${decoded.prefix}`)
  const bytes = bech32.fromWords(decoded.words)
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** Step 1 of LNURL-pay: resolve the input to an HTTPS URL, hit it, parse
 *  the payRequest. Throws on any non-`payRequest` response or HTTP error. */
export async function fetchLnurlPayParams(input: LnurlInput): Promise<LnurlPayParams & { url: string }> {
  let url: string
  if (input.kind === 'lnaddr') url = lnAddrToUrl(input.raw)
  else if (input.kind === 'lnurl') url = decodeLnurlBech32(input.raw)
  else url = input.raw
  const resp = await fetch(url, { method: 'GET' })
  if (!resp.ok) throw new Error(`LNURL endpoint returned ${resp.status}: ${await resp.text().catch(() => '')}`)
  const body = (await resp.json()) as Partial<LnurlPayParams> & { status?: string; reason?: string }
  if (body.status === 'ERROR') throw new Error(`LNURL error: ${body.reason || 'unknown'}`)
  if (body.tag !== 'payRequest') throw new Error(`Not a payRequest endpoint (tag=${body.tag})`)
  if (!body.callback || !body.minSendable || !body.maxSendable) {
    throw new Error('LNURL response missing required payRequest fields')
  }
  return {
    tag: 'payRequest',
    callback: body.callback,
    minSendable: body.minSendable,
    maxSendable: body.maxSendable,
    metadata: body.metadata || '[]',
    commentAllowed: body.commentAllowed,
    url,
  }
}

/** Step 2 of LNURL-pay: ask the callback for a BOLT11 invoice for our
 *  desired amount (sats → millisats). Throws on out-of-range, error
 *  response, or invoice/amount mismatch. */
export async function requestLnurlInvoice(params: LnurlPayParams, amountSats: number): Promise<string> {
  const amountMsat = amountSats * 1000
  if (amountMsat < params.minSendable || amountMsat > params.maxSendable) {
    throw new Error(
      `Amount ${amountSats.toLocaleString()} sats is outside the recipient's range ` +
      `(${Math.ceil(params.minSendable / 1000).toLocaleString()}–${Math.floor(params.maxSendable / 1000).toLocaleString()} sats).`,
    )
  }
  const callback = new URL(params.callback)
  callback.searchParams.set('amount', String(amountMsat))
  const resp = await fetch(callback.toString(), { method: 'GET' })
  if (!resp.ok) {
    throw new Error(`LNURL callback returned ${resp.status}: ${await resp.text().catch(() => '')}`)
  }
  const body = (await resp.json()) as Partial<LnurlPaySecondStage> & { status?: string; reason?: string }
  if (body.status === 'ERROR') throw new Error(`LNURL error: ${body.reason || 'unknown'}`)
  if (!body.pr || typeof body.pr !== 'string') throw new Error('LNURL callback returned no invoice')
  return body.pr
}

/** Convenience: full LNURL-pay round-trip. Caller picks the amount in sats. */
export async function resolveLnurlToInvoice(input: LnurlInput, amountSats: number): Promise<{ invoice: string; params: LnurlPayParams }> {
  const params = await fetchLnurlPayParams(input)
  const invoice = await requestLnurlInvoice(params, amountSats)
  return { invoice, params }
}
