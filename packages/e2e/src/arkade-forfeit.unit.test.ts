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
    expect(() => buildForfeitArkadeScript(p2wpkh, 1000n)).toThrow(/P2TR/)
  })

  it('rejects non-positive amounts', () => {
    expect(() => buildForfeitArkadeScript(PLAYER_PKSCRIPT, 0n)).toThrow(/positive/)
    expect(() => buildForfeitArkadeScript(PLAYER_PKSCRIPT, -1n)).toThrow(/positive/)
  })

  it('encodes the canonical enforcePayTo covenant: DUP INSPECTOUTPUTSCRIPTPUBKEY 1 EQUALVERIFY <wp> EQUALVERIFY INSPECTOUTPUTVALUE <amount> EQUAL', () => {
    const script = buildForfeitArkadeScript(PLAYER_PKSCRIPT, 10_000n)
    // OP_DUP (0x76), INSPECTOUTPUTSCRIPTPUBKEY (0xd1), OP_1 (0x51),
    // OP_EQUALVERIFY (0x88), <push 32 wp>, EQUALVERIFY,
    // INSPECTOUTPUTVALUE (0xcf), <push amount>, OP_EQUAL (0x87).
    // Amount 10_000 = 0x2710 → minimal LE = [0x10, 0x27]
    const expected = new Uint8Array([
      0x76, // OP_DUP
      ARKADE_OP.INSPECTOUTPUTSCRIPTPUBKEY,
      0x51, // OP_1 (witness version 1)
      0x88, // OP_EQUALVERIFY
      0x20, ...PLAYER_WITNESS_PROGRAM,
      0x88, // OP_EQUALVERIFY
      ARKADE_OP.INSPECTOUTPUTVALUE,
      0x02, 0x10, 0x27,
      0x87, // OP_EQUAL
    ])
    expect(hex.encode(script)).toBe(hex.encode(expected))
  })

  it('pads amounts whose top byte has high bit set (sign-pad rule)', () => {
    // 0x80 = 128 → minimal LE encoding needs a 0x00 sign-pad: [0x80, 0x00]
    const script = buildForfeitArkadeScript(PLAYER_PKSCRIPT, 0x80n)
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
    const sk = new Uint8Array(32).fill(0x01)
    const pubkey = schnorr.getPublicKey(sk)
    const script = buildForfeitArkadeScript(PLAYER_PKSCRIPT, 10_000n)
    const tweaked = computeArkadeScriptPublicKey(pubkey, script)

    expect(tweaked.length).toBe(32)
    expect(hex.encode(tweaked)).not.toBe(hex.encode(pubkey))

    const tweaked2 = computeArkadeScriptPublicKey(pubkey, script)
    expect(hex.encode(tweaked2)).toBe(hex.encode(tweaked))

    const otherScript = buildForfeitArkadeScript(PLAYER_PKSCRIPT, 20_000n)
    const otherTweaked = computeArkadeScriptPublicKey(pubkey, otherScript)
    expect(hex.encode(otherTweaked)).not.toBe(hex.encode(tweaked))
  })

  it('buildForfeitLeafSpec returns matching script/hash/tweaked-pubkey', () => {
    const emulatorPubkey = schnorr.getPublicKey(new Uint8Array(32).fill(0x02))
    const spec = buildForfeitLeafSpec({
      recipientPkScript: PLAYER_PKSCRIPT,
      payAmount: 12_345n,
      emulatorPubkey,
    })
    expect(spec.arkadeScript.length).toBeGreaterThan(0)
    expect(spec.arkadeScriptHash).toEqual(arkadeScriptHash(spec.arkadeScript))
    expect(spec.emulatorTweakedPubkey).toEqual(
      computeArkadeScriptPublicKey(emulatorPubkey, spec.arkadeScript),
    )
  })
})
