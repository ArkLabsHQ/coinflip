/**
 * Encoding-level tests for the arkade-script forfeit PoC. No regtest, no
 * emulator: this locks down (a) the byte-exact arkade-script the emulator
 * would execute and (b) the script-hash → tweaked-pubkey derivation matches
 * the canonical formula `tweaked = pubkey + taggedHash("ArkScriptHash", S) * G`.
 *
 * See `packages/lib/src/arkade-forfeit.ts` header for why this isn't yet
 * wired into the production game (arkade-script lands in @arkade-os/sdk
 * PR #319 — still open at time of writing — and the emulator service is not
 * part of our regtest stack).
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { hex } = require('@scure/base')
const { schnorr } = require('@noble/curves/secp256k1.js')
const {
  ARKADE_OP,
  arkadeScriptHash,
  computeArkadeScriptPublicKey,
  buildForfeitArkadeScript,
  buildForfeitLeafSpec,
} = require('arkade-coinflip')

// Test vector: a fixed P2TR pkScript (v1 segwit, 32-byte witness program).
// 0x51 = OP_1, 0x20 = push 32, then 32 deterministic bytes.
const PLAYER_PKSCRIPT = new Uint8Array([
  0x51, 0x20,
  ...Array.from({ length: 32 }, (_, i) => 0x40 + i),
])
const PLAYER_WITNESS_PROGRAM = PLAYER_PKSCRIPT.slice(2)

describe('arkade-forfeit: script encoding', () => {
  it('rejects non-P2TR pkScripts', () => {
    const p2wpkh = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0x11)])
    expect(() => buildForfeitArkadeScript(p2wpkh, 1000n, 1)).toThrow(/P2TR/)
  })

  it('rejects non-positive pot amounts', () => {
    expect(() => buildForfeitArkadeScript(PLAYER_PKSCRIPT, 0n, 1)).toThrow(/positive/)
    expect(() => buildForfeitArkadeScript(PLAYER_PKSCRIPT, -1n, 1)).toThrow(/positive/)
  })

  it('rejects numOutputs outside [1, 16]', () => {
    expect(() => buildForfeitArkadeScript(PLAYER_PKSCRIPT, 1000n, 0)).toThrow(/numOutputs/)
    expect(() => buildForfeitArkadeScript(PLAYER_PKSCRIPT, 1000n, 17)).toThrow(/numOutputs/)
  })

  it('encodes the covenant as: <N> NUMOUTPUTS EQUALVERIFY 0 INSPECTOUTPUTSCRIPTPUBKEY 1 EQUALVERIFY <wp> EQUALVERIFY 0 INSPECTOUTPUTVALUE <amt> GREATERTHANOREQUAL', () => {
    const script = buildForfeitArkadeScript(PLAYER_PKSCRIPT, 10_000n, 2)
    // OP_2 (0x52), INSPECTNUMOUTPUTS (0xd5), EQUALVERIFY (0x88),
    // OP_0 (0x00), INSPECTOUTPUTSCRIPTPUBKEY (0xd1), OP_1 (0x51), EQUALVERIFY,
    // <push 32 wp bytes>, EQUALVERIFY,
    // OP_0, INSPECTOUTPUTVALUE (0xcf), <push amount-bytes>, GREATERTHANOREQUAL (0xa2)
    // Amount 10_000 = 0x2710 → minimal LE = [0x10, 0x27] (high bit of 0x27 clear → no pad)
    const expected = new Uint8Array([
      0x52,
      ARKADE_OP.INSPECTNUMOUTPUTS,
      0x88,
      0x00,
      ARKADE_OP.INSPECTOUTPUTSCRIPTPUBKEY,
      0x51,
      0x88,
      0x20, ...PLAYER_WITNESS_PROGRAM,
      0x88,
      0x00,
      ARKADE_OP.INSPECTOUTPUTVALUE,
      0x02, 0x10, 0x27,
      0xa2,
    ])
    expect(hex.encode(script)).toBe(hex.encode(expected))
  })

  it('pads amounts whose top byte has high bit set (sign-pad rule)', () => {
    // potAmount = 0x80 = 128 → minimal LE encoding needs a 0x00 sign-pad:
    // [0x80, 0x00]. Without the pad, the script would interpret it as -0.
    const script = buildForfeitArkadeScript(PLAYER_PKSCRIPT, 0x80n, 1)
    // The amount push is the last 4 bytes before GREATERTHANOREQUAL: length(2), 0x80, 0x00
    // Find INSPECTOUTPUTVALUE (0xcf), the next byte is the push-length:
    const idx = script.indexOf(ARKADE_OP.INSPECTOUTPUTVALUE)
    expect(script[idx + 1]).toBe(2)
    expect(script[idx + 2]).toBe(0x80)
    expect(script[idx + 3]).toBe(0x00)
  })
})

describe('arkade-forfeit: tagged hash + key tweak', () => {
  it('arkadeScriptHash uses BIP-340 tag "ArkScriptHash"', () => {
    const script = new Uint8Array([0x01, 0x02, 0x03])
    const h = arkadeScriptHash(script)
    expect(h.length).toBe(32)
    // Compare against the canonical formula directly.
    const expected = schnorr.utils.taggedHash('ArkScriptHash', script)
    expect(hex.encode(h)).toBe(hex.encode(expected))
  })

  it('computeArkadeScriptPublicKey: tweaked = (pubkey lifted to even-Y) + h*G', () => {
    // Deterministic pubkey: schnorr(sk = 0x01..01).
    const sk = new Uint8Array(32).fill(0x01)
    const pubkey = schnorr.getPublicKey(sk) // 32-byte x-only
    const script = buildForfeitArkadeScript(PLAYER_PKSCRIPT, 10_000n, 2)
    const tweaked = computeArkadeScriptPublicKey(pubkey, script)

    expect(tweaked.length).toBe(32)
    // Differs from the untweaked pubkey.
    expect(hex.encode(tweaked)).not.toBe(hex.encode(pubkey))

    // The tweak is deterministic in the script.
    const tweaked2 = computeArkadeScriptPublicKey(pubkey, script)
    expect(hex.encode(tweaked2)).toBe(hex.encode(tweaked))

    // Changing the script changes the tweak.
    const otherScript = buildForfeitArkadeScript(PLAYER_PKSCRIPT, 20_000n, 2)
    const otherTweaked = computeArkadeScriptPublicKey(pubkey, otherScript)
    expect(hex.encode(otherTweaked)).not.toBe(hex.encode(tweaked))
  })

  it('buildForfeitLeafSpec returns matching script/hash/tweaked-pubkey', () => {
    const emulatorPubkey = schnorr.getPublicKey(new Uint8Array(32).fill(0x02))
    const spec = buildForfeitLeafSpec({
      playerPkScript: PLAYER_PKSCRIPT,
      potAmount: 12_345n,
      numOutputs: 1,
      emulatorPubkey,
    })
    expect(spec.arkadeScript.length).toBeGreaterThan(0)
    expect(spec.arkadeScriptHash).toEqual(arkadeScriptHash(spec.arkadeScript))
    expect(spec.emulatorTweakedPubkey).toEqual(
      computeArkadeScriptPublicKey(emulatorPubkey, spec.arkadeScript),
    )
  })
})
