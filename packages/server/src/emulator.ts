/**
 * Arkade-script emulator wiring.
 *
 * The emulator (https://github.com/arkade-os/emulator) is the off-chain
 * signing service that validates arkade-script covenants and signs the
 * matching tweaked key. We use it to enable the R1 playerForfeit leaf
 * (see `packages/lib/src/arkade-forfeit.ts` and the design doc at
 * `docs/superpowers/specs/2026-05-28-r1-via-arkade-script-research.md`).
 *
 * Configuration: set `EMULATOR_URL` (e.g. `http://localhost:7073`). When
 * unset, the server runs in legacy mode — new games are minted with the
 * 4-leaf escrow and `playerPenalty` (CSV) remains the only forfeit path.
 *
 * Failure mode: if `EMULATOR_URL` is set but the service can't be reached
 * at boot, `loadEmulatorConfig` returns `undefined` (with a console
 * warning). New games fall back to the legacy escrow — the server stays
 * up, no game creation is blocked.
 */

const EMULATOR_URL = process.env.EMULATOR_URL?.trim() || ''

export interface EmulatorConfig {
  /** Raw URL, e.g. `http://localhost:7073`. */
  url: string
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
    const resp = await fetch(`${EMULATOR_URL}/v1/info`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const body = (await resp.json()) as { signerPubkey: string; version: string }
    if (!body.signerPubkey || typeof body.signerPubkey !== 'string') {
      throw new Error('missing signerPubkey in /v1/info response')
    }
    const signerPubkey = hexToBytes(body.signerPubkey)
    cached = {
      url: EMULATOR_URL,
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
        `new games will use the legacy 4-leaf escrow (CSV playerPenalty fallback). ` +
        `Once the emulator becomes reachable, restart the server to pick it up.`,
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
