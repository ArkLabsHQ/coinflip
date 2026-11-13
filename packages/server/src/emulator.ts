const EMULATOR_URL = process.env.EMULATOR_URL?.trim() || ''
// Publicly-reachable URL the browser uses to POST forfeit txs. Defaults to
// EMULATOR_URL — only override when the server's network name (e.g. inside
// docker compose: http://emulator:7073) differs from what the browser sees
// (e.g. http://localhost:7073 from the host).
const EMULATOR_PUBLIC_URL = process.env.EMULATOR_PUBLIC_URL?.trim() || EMULATOR_URL

export interface EmulatorConfig {
  /** Internal URL used by the server, e.g. `http://emulator:7073`. */
  url: string
  /** Publicly-reachable URL the client posts forfeit txs to. */
  publicUrl: string
  /** Compressed (33-byte) or x-only (32-byte) signer pubkey, hex. */
  signerPubkeyHex: string
  /** Raw bytes of signerPubkey for handoff to the lib. */
  signerPubkey: Uint8Array
  /** Server version string from /v1/info. */
  version: string
}

let cached: EmulatorConfig | null | undefined
let cacheExpiresAt = 0
let probing: Promise<EmulatorConfig | undefined> | undefined

/** Collapse concurrent probes and refresh health without restarting the server. */
export async function loadEmulatorConfig(): Promise<EmulatorConfig | undefined> {
  if (Date.now() < cacheExpiresAt) return cached ?? undefined
  if (probing) return probing
  const pending = probeEmulator()
  probing = pending
  try { return await pending }
  finally { if (probing === pending) probing = undefined }
}

async function probeEmulator(): Promise<EmulatorConfig | undefined> {
  if (!EMULATOR_URL) {
    cached = null
    cacheExpiresAt = Infinity
    return undefined
  }
  try {
    // 15s — bootstrapping the server can be CPU-bound and the initial
    // probe sometimes races a slow first-pass DNS or container-net warmup.
    // The emulator itself responds in <50ms; this is purely a startup
    // contention budget.
    const resp = await fetch(`${EMULATOR_URL}/v1/info`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const body = (await resp.json()) as { signerPubkey: string; version: string }
    if (!body.signerPubkey || typeof body.signerPubkey !== 'string') {
      throw new Error('missing signerPubkey in /v1/info response')
    }
    const decoded = hexToBytes(body.signerPubkey)
    const signerPubkey = decoded.length === 33 ? decoded.slice(1) : decoded
    if (signerPubkey.length !== 32) throw new Error('Expected a 32-byte x-only emulator signer')
    cached = {
      url: EMULATOR_URL,
      publicUrl: EMULATOR_PUBLIC_URL,
      signerPubkeyHex: Buffer.from(signerPubkey).toString('hex'),
      signerPubkey,
      version: body.version,
    }
    cacheExpiresAt = Date.now() + 30_000
    console.log(
      `[emulator] connected at ${EMULATOR_URL} (v${body.version}, signer=${body.signerPubkey.slice(0, 16)}…)`,
    )
    return cached
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[emulator] EMULATOR_URL set but probe failed (${msg}); ` +
        `v4 /play will be REJECTED until the emulator is reachable (no legacy fallback). ` +
        `A later request will retry the connection.`,
    )
    cached = null
    cacheExpiresAt = Date.now() + 5000
    return undefined
  }
}

/**
 * Test-only seam: clear the cached config so a subsequent `loadEmulatorConfig`
 * call re-probes. Never call in production code paths.
 */
export function _resetEmulatorConfigCache(): void {
  cached = undefined
  cacheExpiresAt = 0
}

function hexToBytes(s: string): Uint8Array {
  const clean = s.startsWith('0x') ? s.slice(2) : s
  if (clean.length % 2 !== 0) throw new Error(`emulator: non-even hex pubkey length ${clean.length}`)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error(`emulator: invalid hex pubkey ${s}`)
    out[i] = byte
  }
  return out
}
