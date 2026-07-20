/**
 * Arkade-script emulator wiring.
 *
 * The emulator (https://github.com/arkade-os/emulator) is the off-chain
 * signing service that validates arkade-script covenants and signs the
 * matching tweaked key. We use it for the v4 joint-pot settle + playerForfeit
 * covenants (see `packages/lib/src/arkade-forfeit.ts`).
 *
 * Configuration: set `EMULATOR_URL` (e.g. `http://localhost:7073`). v4 REQUIRES the
 * emulator — the joint-pot settle/forfeit path is arkade-script, so there is NO legacy
 * CSV fallback for new v4 games.
 *
 * Failure mode: if `EMULATOR_URL` is unset or the service can't be reached at boot,
 * `loadEmulatorConfig` returns `undefined` (with a console warning) and `handleV4Play`
 * REJECTS new games ("Emulator not configured…") — the server stays up, but no new
 * games can be created until the emulator is reachable (restart to re-probe).
 */

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

/**
 * Probe the emulator's `/v1/info` once and cache the result. Returns
 * `undefined` if `EMULATOR_URL` is unset or the probe failed. Safe to
 * call repeatedly — only the first call hits the network.
 */
export async function loadEmulatorConfig(): Promise<EmulatorConfig | undefined> {
  if (cached !== undefined) return cached ?? undefined
  if (!EMULATOR_URL) {
    cached = null
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
    const signerPubkey = hexToBytes(body.signerPubkey)
    cached = {
      url: EMULATOR_URL,
      publicUrl: EMULATOR_PUBLIC_URL,
      signerPubkeyHex: body.signerPubkey,
      signerPubkey,
      version: body.version,
    }
    console.log(
      `[emulator] connected at ${EMULATOR_URL} (v${body.version}, signer=${body.signerPubkey.slice(0, 16)}…)`,
    )
    return cached
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[emulator] EMULATOR_URL set but probe failed (${msg}); ` +
        `v4 /play will be REJECTED until the emulator is reachable (no legacy fallback). ` +
        `Restart the server once it's reachable to re-probe.`,
    )
    cached = null
    return undefined
  }
}

/**
 * Test-only seam: clear the cached config so a subsequent `loadEmulatorConfig`
 * call re-probes. Never call in production code paths.
 */
export function _resetEmulatorConfigCache(): void {
  cached = undefined
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
