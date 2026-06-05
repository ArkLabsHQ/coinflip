/**
 * Unit tests for the cwp `packets` module: encodeReveal + addRevealPacket
 * round-trip via the SDK's Extension parser.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  packets: { encodeReveal, addRevealPacket, REVEAL_PLAYER_PACKET_TYPE, REVEAL_CREATOR_PACKET_TYPE, MIN_SALT_LEN },
} = require('@arklabshq/contract-workflows-prototype')
const { Extension, Transaction } = require('@arkade-os/sdk')

function emptyTx(): InstanceType<typeof Transaction> {
  return new Transaction()
}

describe('encodeReveal', () => {
  it('produces [digit_byte] ‖ salt (17 bytes for a 16-byte salt)', () => {
    const salt = new Uint8Array(16).fill(0xaa)
    const out = encodeReveal(7, salt)
    expect(out.length).toBe(17)
    expect(out[0]).toBe(7)
    expect(Array.from(out.slice(1))).toEqual(Array.from(salt))
  })

  it('accepts 32-byte salts (overshoot is fine)', () => {
    const out = encodeReveal(0, new Uint8Array(32).fill(0xbb))
    expect(out.length).toBe(33)
  })

  it('rejects non-byte digits', () => {
    expect(() => encodeReveal(-1, new Uint8Array(16))).toThrow()
    expect(() => encodeReveal(256, new Uint8Array(16))).toThrow()
    expect(() => encodeReveal(1.5, new Uint8Array(16))).toThrow()
    expect(() => encodeReveal(NaN, new Uint8Array(16))).toThrow()
  })

  it('rejects short salts', () => {
    expect(() => encodeReveal(0, new Uint8Array(0))).toThrow()
    expect(() => encodeReveal(0, new Uint8Array(15))).toThrow()
  })

  it('exposes the constants', () => {
    expect(REVEAL_PLAYER_PACKET_TYPE).toBe(0x10)
    expect(REVEAL_CREATOR_PACKET_TYPE).toBe(0x11)
    expect(MIN_SALT_LEN).toBe(16)
  })
})

describe('addRevealPacket', () => {
  it('rejects reserved packet types 0x00 and 0x01', () => {
    expect(() => addRevealPacket(emptyTx(), 0x00, new Uint8Array(17))).toThrow()
    expect(() => addRevealPacket(emptyTx(), 0x01, new Uint8Array(17))).toThrow()
  })

  it('rejects out-of-range types', () => {
    expect(() => addRevealPacket(emptyTx(), -1, new Uint8Array(17))).toThrow()
    expect(() => addRevealPacket(emptyTx(), 256, new Uint8Array(17))).toThrow()
  })

  it('accepts custom types 0x02..0xff', () => {
    expect(() => addRevealPacket(emptyTx(), 0x02, new Uint8Array(17))).not.toThrow()
    expect(() => addRevealPacket(emptyTx(), 0xff, new Uint8Array(17))).not.toThrow()
  })

  it('round-trips: attached payload is recoverable via Extension.fromBytes / getPacketByType', () => {
    const tx = emptyTx()
    const playerData = encodeReveal(3, new Uint8Array(16).fill(0xaa))
    const creatorData = encodeReveal(5, new Uint8Array(16).fill(0xbb))
    addRevealPacket(tx, REVEAL_PLAYER_PACKET_TYPE, playerData)
    addRevealPacket(tx, REVEAL_CREATOR_PACKET_TYPE, creatorData)

    let ext: InstanceType<typeof Extension> | null = null
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i)
      if (o?.script && Extension.isExtension(o.script)) {
        ext = Extension.fromBytes(o.script)
        break
      }
    }
    expect(ext).not.toBeNull()

    const p = ext!.getPacketByType(REVEAL_PLAYER_PACKET_TYPE)
    const c = ext!.getPacketByType(REVEAL_CREATOR_PACKET_TYPE)
    expect(p).not.toBeNull()
    expect(c).not.toBeNull()
    // SDK's UnknownPacket exposes `data` and `serialize()` — both should
    // return our payload bytes verbatim.
    expect(Array.from((p as { data: Uint8Array }).data)).toEqual(Array.from(playerData))
    expect(Array.from((c as { data: Uint8Array }).data)).toEqual(Array.from(creatorData))
    expect(Array.from((p as { serialize(): Uint8Array }).serialize())).toEqual(Array.from(playerData))
  })

  it('merges into an existing extension rather than creating a second one', () => {
    const tx = emptyTx()
    addRevealPacket(tx, REVEAL_PLAYER_PACKET_TYPE, encodeReveal(1, new Uint8Array(16).fill(1)))
    const beforeOutputs = tx.outputsLength
    addRevealPacket(tx, REVEAL_CREATOR_PACKET_TYPE, encodeReveal(2, new Uint8Array(16).fill(2)))
    expect(tx.outputsLength).toBe(beforeOutputs)

    let extCount = 0
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i)
      if (o?.script && Extension.isExtension(o.script)) extCount++
    }
    expect(extCount).toBe(1)
  })
})
