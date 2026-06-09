/**
 * BIP-21 encode/decode for the unified-receive QR.
 *
 *   bitcoin:<bcAddr>?ark=<arkAddr>&lightning=<bolt11OrLnurl>&amount=<btc>
 *
 * Mirrors the encoding arkade-os/wallet uses (`src/lib/bip21.ts`): we
 * keep an on-chain Bitcoin address as the leading scheme/host so legacy
 * BIP-21 wallets that don't speak Ark can still pay; arkd / Ark-aware
 * wallets read the `ark=` parameter; Lightning-capable wallets read the
 * `lightning=` parameter (BOLT11 invoice or LNURL).
 *
 * If `btc` is empty, the URI degrades to `ark:<arkAddr>?lightning=...`
 * so we never emit a malformed `bitcoin:?...` URI.
 */

export interface Bip21Parts {
  /** Onchain Bitcoin address (boarding / withdraw destination). */
  btc?: string
  /** Off-chain Ark address — most wallets won't understand this; included
   *  for Ark-aware receivers. */
  ark?: string
  /** BOLT11 invoice OR bech32 `lnurl1...` string for Lightning-capable
   *  wallets. The receiver chooses which path to use. */
  lightning?: string
  /** Amount in SATS (we convert to BTC for the URI per BIP-21). 0/undef
   *  means amountless. */
  amountSats?: number
}

/** Format sats as a BTC decimal with up to 8 decimals, trimming trailing
 *  zeros — what BIP-21 expects. */
function satsToBtcDecimal(sats: number): string {
  if (!Number.isFinite(sats) || sats <= 0) return ''
  const whole = Math.floor(sats / 1e8)
  const frac = sats - whole * 1e8
  const fracStr = String(frac).padStart(8, '0').replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : String(whole)
}

export function encodeBip21(parts: Bip21Parts): string {
  const { btc, ark, lightning, amountSats } = parts
  // Pick the scheme/host. Prefer bitcoin: so generic wallets work; fall
  // back to ark: when there's no on-chain address; fall back to plain
  // lightning: when neither's available.
  const params = new URLSearchParams()
  if (ark) params.set('ark', ark)
  if (lightning) params.set('lightning', lightning)
  if (amountSats && amountSats > 0) {
    const dec = satsToBtcDecimal(amountSats)
    if (dec) params.set('amount', dec)
  }
  const query = params.toString()
  if (btc) {
    return query ? `bitcoin:${btc}?${query}` : `bitcoin:${btc}`
  }
  if (ark) {
    // ark scheme: keep the same parameter shape, just drop the now-redundant
    // `ark=<ark>` from the query (it's the host).
    const arkParams = new URLSearchParams()
    if (lightning) arkParams.set('lightning', lightning)
    if (amountSats && amountSats > 0) {
      const dec = satsToBtcDecimal(amountSats)
      if (dec) arkParams.set('amount', dec)
    }
    const q = arkParams.toString()
    return q ? `ark:${ark}?${q}` : `ark:${ark}`
  }
  if (lightning) return `lightning:${lightning}`
  return ''
}

/** Parse a BIP-21 URI (or a plain ark/lightning URI) back into its parts.
 *  Returns `null` if the scheme is unrecognised. Tolerates a missing
 *  scheme — a bare bech32 / hex string returns `null`, leaving classification
 *  to the caller. */
export function decodeBip21(raw: string): Bip21Parts | null {
  const s = (raw || '').trim()
  if (!s) return null
  const colon = s.indexOf(':')
  if (colon < 0) return null
  const scheme = s.slice(0, colon).toLowerCase()
  const rest = s.slice(colon + 1)
  const qIdx = rest.indexOf('?')
  const host = qIdx >= 0 ? rest.slice(0, qIdx) : rest
  const params = new URLSearchParams(qIdx >= 0 ? rest.slice(qIdx + 1) : '')
  const amountBtc = params.get('amount')
  const amountSats = amountBtc ? Math.round(parseFloat(amountBtc) * 1e8) : 0
  if (scheme === 'bitcoin') {
    return {
      btc: host || undefined,
      ark: params.get('ark') || undefined,
      lightning: params.get('lightning') || undefined,
      amountSats: amountSats || undefined,
    }
  }
  if (scheme === 'ark') {
    return {
      ark: host || undefined,
      lightning: params.get('lightning') || undefined,
      amountSats: amountSats || undefined,
    }
  }
  if (scheme === 'lightning') {
    return { lightning: host || undefined }
  }
  return null
}
