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
  arkadeScriptHash,
  computeArkadeScriptPublicKey,
  buildForfeitArkadeScript,
  encodeEmulatorWitness,
  encodeOutputIndexWitness,
} = require('arkade-coinflip')

// Arkade-extension opcode bytes exercised by the forfeit covenant. The
// ARKADE_OP catalog was removed from the lib's public surface with the
// v2/v3 consolidation; the byte encoding under test is unchanged, so the
// values are inlined here (full catalog: arkade-os/emulator opcode.go).
const ARKADE_OP = {
  INSPECTINPUTVALUE: 0xc9,
  INSPECTOUTPUTVALUE: 0xcf,
  INSPECTOUTPUTSCRIPTPUBKEY: 0xd1,
} as const

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

  it('atomic mode: prepends INSPECTINPUTVALUE <other_stake> EQUALVERIFY before enforcePayTo', () => {
    const otherStake = 5_000n
    const pot = 15_000n
    const script = buildForfeitArkadeScript(PLAYER_PKSCRIPT, pot, otherStake)
    // Prefix: INSPECTINPUTVALUE (0xc9), push other_stake (0x88, 0x13), EQUALVERIFY.
    // 5_000 = 0x1388 → minimal LE = [0x88, 0x13, 0x00] (sign-pad because 0x13... wait 0x13 high bit is 0, no pad needed). Actually 5000 = 0x1388, MSB byte (in LE) is 0x13 (high bit 0) → no pad → [0x88, 0x13].
    expect(script[0]).toBe(ARKADE_OP.INSPECTINPUTVALUE)
    expect(script[1]).toBe(2)             // push length
    expect(script[2]).toBe(0x88)          // 5000 = 0x1388 LSB
    expect(script[3]).toBe(0x13)          // 5000 = 0x1388 MSB
    expect(script[4]).toBe(0x88)          // OP_EQUALVERIFY

    // The remainder mirrors the single-input encoding for the pot amount.
    const single = buildForfeitArkadeScript(PLAYER_PKSCRIPT, pot)
    const atomicTail = script.slice(5)
    expect(hex.encode(atomicTail)).toBe(hex.encode(single))
  })

  it('atomic mode: rejects non-positive otherStakeValue', () => {
    expect(() => buildForfeitArkadeScript(PLAYER_PKSCRIPT, 10_000n, 0n)).toThrow(/positive/)
    expect(() => buildForfeitArkadeScript(PLAYER_PKSCRIPT, 10_000n, -1n)).toThrow(/positive/)
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
})

describe('arkade-forfeit: witness encoders', () => {
  it('encodeOutputIndexWitness(0) returns empty bytes (OP_0 in numeric ctx)', () => {
    const w = encodeOutputIndexWitness(0)
    expect(w.length).toBe(0)
  })

  it('encodeOutputIndexWitness encodes 1..127 as minimal LE', () => {
    expect(Array.from(encodeOutputIndexWitness(1))).toEqual([0x01])
    expect(Array.from(encodeOutputIndexWitness(15))).toEqual([0x0f])
    expect(Array.from(encodeOutputIndexWitness(127))).toEqual([0x7f])
  })

  it('encodeOutputIndexWitness pads when high bit of MSB is set', () => {
    // 128 = 0x80 → needs sign-pad to stay positive
    expect(Array.from(encodeOutputIndexWitness(128))).toEqual([0x80, 0x00])
    expect(Array.from(encodeOutputIndexWitness(255))).toEqual([0xff, 0x00])
  })

  it('encodeOutputIndexWitness rejects negative + non-integer', () => {
    expect(() => encodeOutputIndexWitness(-1)).toThrow(/non-negative/)
    expect(() => encodeOutputIndexWitness(1.5)).toThrow(/non-negative/)
  })

  it('encodeEmulatorWitness: empty stack → varint(0)', () => {
    const w = encodeEmulatorWitness([])
    expect(Array.from(w)).toEqual([0x00])
  })

  it('encodeEmulatorWitness: single empty item → [0x01, 0x00]', () => {
    // 1 item, item length = 0 → no payload bytes
    const w = encodeEmulatorWitness([encodeOutputIndexWitness(0)])
    expect(Array.from(w)).toEqual([0x01, 0x00])
  })

  it('encodeEmulatorWitness: single 1-byte item → [num_items=1, item_len=1, item_byte]', () => {
    const w = encodeEmulatorWitness([encodeOutputIndexWitness(1)])
    expect(Array.from(w)).toEqual([0x01, 0x01, 0x01])
  })
})

export {}
