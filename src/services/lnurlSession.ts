/**
 * LNURL-pay receive session against the shared Arkade LNURL server.
 *
 * Architecture mirrors `arkade-os/wallet/src/providers/lnurl.tsx`:
 *
 *   1. Derive a per-wallet bearer token deterministically from the wallet's
 *      private key: `token = hex(HMAC-SHA256(privKey, "lnurl-session"))`.
 *   2. POST `{ token }` to `<lnurlServer>/lnurl/session` to open a long-lived
 *      Server-Sent-Events stream.
 *   3. The server's first event is `session_created` with the actual
 *      `lnurl1...` bech32 string — that's what the user shares to receive
 *      Lightning payments.
 *   4. Keep the SSE open: subsequent `payment_received` events fire when an
 *      LNURL payment lands. We surface that as a callback so the wallet can
 *      refresh the balance immediately.
 *
 * Per-network server defaults follow the Arkade convention
 * (`lnurl.<network>.arkade.sh` mirrors `mempool.<network>.arkade.sh` and
 * `explorer.<network>.arkade.sh`). Operators host their own by setting
 * `VUE_APP_LNURL_SERVER_URL` — same single-env-var shape arkade-os/wallet
 * uses.
 */

import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'

const ENV_OVERRIDE = (process.env.VUE_APP_LNURL_SERVER_URL || '').trim()

/** Per-network defaults — mirrors the Arkade `<service>.<network>.arkade.sh`
 *  convention used for mempool, explorer, and arkd hosts. Mainnet drops the
 *  network prefix (`lnurl.arkade.sh`). */
const LNURL_SERVER_URL: Record<string, string> = {
  bitcoin: 'https://lnurl.arkade.sh',
  mainnet: 'https://lnurl.arkade.sh',
  mutinynet: 'https://lnurl.mutinynet.arkade.sh',
  signet: 'https://lnurl.signet.arkade.sh',
  testnet: 'https://lnurl.testnet.arkade.sh',
  regtest: 'http://localhost:9090',
}

/** Returns the server URL for the given network, honouring the
 *  `VUE_APP_LNURL_SERVER_URL` env override. `null` when neither is set. */
export function lnurlServerForNetwork(network: string | null | undefined): string | null {
  if (ENV_OVERRIDE) return ENV_OVERRIDE
  if (!network) return null
  return LNURL_SERVER_URL[network] ?? null
}

/**
 * Derive the LNURL session bearer token from the wallet's private key.
 *
 * Matches arkade-os/wallet's `deriveLnurlCredentials`:
 *   `token = hex(HMAC-SHA256(privateKeyBytes, "lnurl-session"))`
 *
 * Deterministic — same key gives the same token gives (server-side) the
 * same lnurl1... bech32 string across reloads.
 */
export function deriveLnurlToken(privateKeyHex: string): string {
  const key = hex.decode(privateKeyHex)
  const tag = new TextEncoder().encode('lnurl-session')
  return hex.encode(hmac(sha256, key, tag))
}

export interface LnurlSessionConfig {
  serverUrl: string
  privateKeyHex: string
  /** Fires on receipt of a `payment_received` SSE event. */
  onPaymentReceived?: (event: unknown) => void
  /** Fires on a hard error (network drop, server 5xx, malformed event). */
  onError?: (err: Error) => void
}

export interface LnurlSession {
  /** Bech32 `lnurl1...` string the user displays. */
  lnurl: string
  /** Server-issued opaque session id; mostly for logging. */
  sessionId: string
  /** Tear down the SSE stream. Idempotent. */
  close: () => void
}

/**
 * Open a session against `<serverUrl>/lnurl/session`, wait for the
 * `session_created` event, and return a handle with the resulting
 * `lnurl1...` string. The SSE stream stays open in the background so
 * incoming `payment_received` events can be delivered to `onPaymentReceived`;
 * call `handle.close()` when the receive panel closes.
 *
 * Throws if the POST fails, the SSE stream drops before the first event,
 * or the first event isn't a `session_created`.
 */
export async function openLnurlSession(cfg: LnurlSessionConfig): Promise<LnurlSession> {
  const token = deriveLnurlToken(cfg.privateKeyHex)
  const resp = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/lnurl/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ token }),
  })
  if (!resp.ok || !resp.body) {
    throw new Error(`LNURL server returned ${resp.status}: ${await resp.text().catch(() => '')}`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let resolved = false

  // The session_created event MUST arrive first per the wallet's protocol.
  // Hold this promise until we see it; reject if the stream closes first.
  return new Promise<LnurlSession>((resolve, reject) => {
    const closeStream = () => {
      try { reader.cancel().catch(() => { /* ignore */ }) } catch { /* ignore */ }
    }
    const fail = (err: Error) => {
      if (!resolved) reject(err)
      else cfg.onError?.(err)
      closeStream()
    }

    void (async () => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read()
          if (done) {
            fail(new Error('LNURL SSE stream closed unexpectedly'))
            return
          }
          buffer += decoder.decode(value, { stream: true })
          // SSE separates events by a blank line.
          for (;;) {
            const sep = buffer.indexOf('\n\n')
            if (sep < 0) break
            const rawEvent = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            const lines = rawEvent.split('\n')
            let evtType = 'message'
            let dataStr = ''
            for (const l of lines) {
              if (l.startsWith('event:')) evtType = l.slice(6).trim()
              else if (l.startsWith('data:')) dataStr += (dataStr ? '\n' : '') + l.slice(5).trim()
            }
            if (!dataStr) continue
            let data: Record<string, unknown>
            try { data = JSON.parse(dataStr) } catch { continue }
            if (evtType === 'session_created') {
              if (!data.lnurl || !data.sessionId) {
                fail(new Error('session_created event missing lnurl/sessionId'))
                return
              }
              resolved = true
              resolve({
                lnurl: String(data.lnurl),
                sessionId: String(data.sessionId),
                close: closeStream,
              })
            } else if (evtType === 'payment_received') {
              cfg.onPaymentReceived?.(data)
            }
            // Other event types (heartbeat, server-info) are ignored.
          }
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    })()
  })
}
