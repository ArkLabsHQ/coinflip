import { EmulatorPacket, Extension, P2A, Transaction, UnknownPacket, type ExtensionPacket } from '@arkade-os/sdk'

export const REVEAL_PLAYER_PACKET_TYPE = 0x10
export const REVEAL_CREATOR_PACKET_TYPE = 0x11
export const MIN_SALT_LEN = 16

export function encodeReveal(digit: number, salt: Uint8Array): Uint8Array {
  if (!Number.isInteger(digit) || digit < 0 || digit > 255) {
    throw new Error('encodeReveal: digit must be an integer in [0, 255]')
  }
  if (salt.length < MIN_SALT_LEN) throw new Error('encodeReveal: salt must contain at least 16 bytes')
  const reveal = new Uint8Array(salt.length + 1)
  reveal[0] = digit
  reveal.set(salt, 1)
  return reveal
}

function appendPacket(tx: Transaction, packet: ExtensionPacket): void {
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i)
    if (!output.script || !Extension.isExtension(output.script)) continue
    const existing = Extension.fromBytes(output.script).getPackets()
    if (existing.some(item => item.type() === packet.type())) {
      throw new Error(`Duplicate extension packet type ${packet.type()}`)
    }
    tx.updateOutput(i, Extension.create([...existing, packet]).txOut())
    return
  }
  const output = Extension.create([packet]).txOut()
  const lastIndex = tx.outputsLength - 1
  const last = lastIndex >= 0 ? tx.getOutput(lastIndex) : undefined
  if (last?.script && last.script.length === P2A.script.length &&
    last.script.every((byte, index) => byte === P2A.script[index])) {
    tx.updateOutput(lastIndex, output)
    tx.addOutput({ script: last.script, amount: last.amount ?? 0n })
  } else {
    tx.addOutput(output)
  }
}

export function addRevealPacket(tx: Transaction, packetType: number, data: Uint8Array): void {
  if (!Number.isInteger(packetType) || packetType < 2 || packetType > 255) {
    throw new Error('addRevealPacket: packet type must be an integer in [2, 255]')
  }
  appendPacket(tx, new UnknownPacket(packetType, data))
}

function compactSize(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('compactSize: value must be an unsigned 32-bit integer')
  }
  if (value < 0xfd) return [value]
  if (value <= 0xffff) return [0xfd, value & 255, (value >>> 8) & 255]
  return [0xfe, value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]
}

export function encodeWitness(stack: Uint8Array[]): Uint8Array {
  const bytes = compactSize(stack.length)
  for (const item of stack) {
    bytes.push(...compactSize(item.length))
    for (const byte of item) bytes.push(byte)
  }
  return Uint8Array.from(bytes)
}

export function encodeIndex(index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('encodeIndex: expected a non-negative safe integer')
  const bytes: number[] = []
  while (index > 0) {
    bytes.push(index % 256)
    index = Math.floor(index / 256)
  }
  if (bytes.length && bytes[bytes.length - 1] & 128) bytes.push(0)
  return Uint8Array.from(bytes)
}

export function addPacket(tx: Transaction, entries: { vin: number; script: Uint8Array; witness?: Uint8Array }[]): void {
  appendPacket(tx, EmulatorPacket.create(entries))
}

export const packets = { REVEAL_PLAYER_PACKET_TYPE, REVEAL_CREATOR_PACKET_TYPE, MIN_SALT_LEN, encodeReveal, addRevealPacket }
export const emulator = { encodeWitness, encodeIndex, addPacket }
