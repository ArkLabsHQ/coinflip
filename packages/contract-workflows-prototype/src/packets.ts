/**
 * Typed extension packets for the arkade-script side-channel.
 *
 * `OP_INSPECTPACKET` (0xf4) and its input-variant `OP_INSPECTINPUTPACKET`
 * (0xf5) let an arkade-script read named packets attached to the spending
 * tx via a 1-byte type tag. Packet types `0x00` (`Packet`) and `0x01`
 * (`EmulatorPacket`) are reserved by the SDK. This module ships:
 *
 *   - constants for the coinflip-specific reveal packet types (0x10, 0x11)
 *   - `encodeReveal(digit, salt)` — single-byte digit + ≥16-byte salt
 *   - `addRevealPacket(tx, type, data)` — typed packet attachment helper
 *     that mirrors `addPacket`'s merge-or-insert behaviour
 *
 * The SDK's `Extension.fromBytes` parser already routes unknown type tags
 * to `UnknownPacket(packetType, data)`, so we don't need a custom subclass.
 */

import {
  Extension,
  P2A,
  Transaction,
  UnknownPacket,
  type ExtensionPacket,
} from '@arkade-os/sdk'

/** 1-byte packet types. 0x00 (Packet), 0x01 (EmulatorPacket) reserved. */
export const REVEAL_PLAYER_PACKET_TYPE = 0x10
export const REVEAL_CREATOR_PACKET_TYPE = 0x11

/** Minimum salt length: 128-bit hiding for the SHA256 commit. */
export const MIN_SALT_LEN = 16

/**
 * Encode the per-party reveal payload: `[digit_byte] ‖ salt`.
 *
 * Caller picks the digit's semantic meaning (the win-condition's `n` range);
 * we only enforce it fits in a single byte. Salt MUST be ≥ 16 bytes for
 * 128-bit hiding to keep the SHA256 commit brute-force-resistant.
 */
export function encodeReveal(digit: number, salt: Uint8Array): Uint8Array {
  if (!Number.isInteger(digit) || digit < 0 || digit > 0xff) {
    throw new Error(
      `encodeReveal: digit must be an integer in [0, 255], got ${digit}`,
    )
  }
  if (salt.length < MIN_SALT_LEN) {
    throw new Error(
      `encodeReveal: salt must be ≥ ${MIN_SALT_LEN} bytes, got ${salt.length}`,
    )
  }
  const out = new Uint8Array(1 + salt.length)
  out[0] = digit
  out.set(salt, 1)
  return out
}

/**
 * Attach a custom-typed extension packet to a tx in place.
 *
 * Merges into an existing OP_RETURN extension if present, otherwise inserts
 * a new one before the P2A anchor (matches the existing `addPacket` helper).
 * Rejects reserved type tags `0x00` and `0x01`.
 */
export function addRevealPacket(
  tx: Transaction,
  packetType: number,
  data: Uint8Array,
): void {
  if (!Number.isInteger(packetType) || packetType < 0x02 || packetType > 0xff) {
    throw new Error(
      `addRevealPacket: packetType ${packetType} reserved or out of range (use 0x02..0xff)`,
    )
  }
  const packet = new UnknownPacket(packetType, data) as unknown as ExtensionPacket

  // Merge into existing extension if present.
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)
    if (!out?.script) continue
    if (!Extension.isExtension(out.script)) continue
    const existing = Extension.fromBytes(out.script)
    const merged = Extension.create([...existing.getPackets(), packet])
    tx.updateOutput(i, { script: merged.serialize(), amount: 0n })
    return
  }

  // No existing extension — insert a new one.
  const ext = Extension.create([packet])
  const newOut = ext.txOut()

  const lastIdx = tx.outputsLength - 1
  const lastOut = lastIdx >= 0 ? tx.getOutput(lastIdx) : null
  const anchorScript = P2A.script
  const isAnchorLast =
    lastOut?.script !== undefined &&
    lastOut.script.length === anchorScript.length &&
    lastOut.script.every((b: number, j: number) => b === anchorScript[j])

  if (isAnchorLast && lastOut) {
    tx.updateOutput(lastIdx, { script: newOut.script, amount: newOut.amount })
    tx.addOutput({ script: lastOut.script, amount: lastOut.amount ?? 0n })
    return
  }
  tx.addOutput({ script: newOut.script, amount: newOut.amount })
}
