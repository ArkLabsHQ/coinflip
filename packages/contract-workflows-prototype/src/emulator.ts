/**
 * Emulator handoff — utilities for binding an arkade-script covenant
 * to an emulator key, encoding witness blobs the way the emulator
 * packet expects, and attaching the packet to a transaction.
 *
 * All functions are pure (no network). The runtime POST-to-emulator
 * flow is the caller's responsibility — see the consumer's `claimX`
 * action for the typical pattern:
 *
 *   const resp = await fetch(`${emulatorUrl}/v1/tx`, {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({
 *       arkTx: base64.encode(signedPsbt),
 *       checkpointTxs: checkpoints.map(c => base64.encode(c.toPSBT())),
 *     }),
 *   })
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import {
  EmulatorPacket,
  Extension,
  P2A,
  Transaction,
  type ExtensionPacket,
} from '@arkade-os/sdk'

/**
 * BIP-340 tagged hash with the `"ArkScriptHash"` tag — the scalar
 * tweak that binds an emulator key to a specific arkade script.
 */
export function scriptHash(script: Uint8Array): Uint8Array {
  return schnorr.utils.taggedHash('ArkScriptHash', script)
}

/**
 * Tweak the emulator's pubkey with `hash(arkade_script)`. The emulator
 * holds the private key for `pubkey`; it derives the matching tweaked
 * secret key for a specific arkade script only AFTER running the script
 * and confirming it passes.
 *
 *   tweaked = pubkey + scriptHash(script) * G    (mod n)
 *
 * Returns the 32-byte x-only pubkey (BIP340 form, even-Y forced).
 */
export function computeTweakedKey(pubkey: Uint8Array, script: Uint8Array): Uint8Array {
  const h = scriptHash(script)
  const xOnly = pubkey.length === 33 ? pubkey.subarray(1) : pubkey
  const point = secp256k1.Point.fromHex('02' + hex.encode(xOnly))
  const n = secp256k1.Point.CURVE().n
  let scalar = 0n
  for (const b of h) scalar = (scalar << 8n) | BigInt(b)
  scalar = scalar % n || 1n
  const tweak = secp256k1.Point.BASE.multiply(scalar)
  return point.add(tweak).toBytes().subarray(1) // x-only
}

/**
 * Serialize a witness stack the way the EmulatorPacket expects:
 * `varint(num_items) + varint(item_len) + item_bytes` per item —
 * i.e. `psbt.WriteTxWitness` / `txutils.ReadTxWitness` format.
 *
 * Order matters: the items are pushed onto the script's stack in array
 * order, so the **last** item is on **top** at script start.
 */
export function encodeWitness(stack: Uint8Array[]): Uint8Array {
  const out: number[] = []
  out.push(...compactSize(stack.length))
  for (const item of stack) {
    out.push(...compactSize(item.length))
    for (const b of item) out.push(b)
  }
  return new Uint8Array(out)
}

/**
 * Encode a non-negative integer as a Bitcoin script-numeric byte
 * string (the form most introspection opcodes read for indices):
 *
 *   0       → empty bytes
 *   1..N    → minimal LE with optional 0x00 sign-pad
 */
export function encodeIndex(idx: number): Uint8Array {
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error('encodeIndex: expected non-negative integer')
  }
  if (idx === 0) return new Uint8Array(0)
  const bytes: number[] = []
  let n = idx
  while (n > 0) {
    bytes.push(n & 0xff)
    n >>>= 8
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00)
  return new Uint8Array(bytes)
}

function compactSize(n: number): number[] {
  if (n < 0) throw new Error('compactSize: negative')
  if (n <= 0xfc) return [n]
  if (n <= 0xffff) return [0xfd, n & 0xff, (n >> 8) & 0xff]
  if (n <= 0xffffffff)
    return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
  throw new Error('compactSize: too large')
}

/**
 * Attach an EmulatorPacket to a transaction's output set, in place.
 * Mirrors the test helper from `arkade-script-final`: merges into an
 * existing Ark-extension OP_RETURN if present, otherwise inserts a new
 * one before the P2A anchor (or appends at the end if no anchor).
 */
export function addPacket(
  tx: Transaction,
  entries: { vin: number; script: Uint8Array; witness?: Uint8Array }[],
): void {
  const packet = EmulatorPacket.create(
    entries.map((e) => ({
      vin: e.vin,
      script: e.script,
      witness: e.witness ?? new Uint8Array(0),
    })),
  )

  // Merge into existing extension if present.
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)
    if (!out?.script) continue
    if (!Extension.isExtension(out.script)) continue
    const existing = Extension.fromBytes(out.script)
    const merged = Extension.create([
      ...existing.getPackets(),
      packet as unknown as ExtensionPacket,
    ])
    tx.updateOutput(i, { script: merged.serialize(), amount: 0n })
    return
  }

  // No existing extension — insert a new one.
  const ext = Extension.create([packet as unknown as ExtensionPacket])
  const newOut = ext.txOut()

  const lastIdx = tx.outputsLength - 1
  const lastOut = lastIdx >= 0 ? tx.getOutput(lastIdx) : null
  const anchorScript = P2A.script
  const isAnchorLast =
    lastOut?.script &&
    lastOut.script.length === anchorScript.length &&
    lastOut.script.every((b, j) => b === anchorScript[j])

  if (isAnchorLast && lastOut) {
    tx.updateOutput(lastIdx, { script: newOut.script, amount: newOut.amount })
    tx.addOutput({ script: lastOut.script, amount: lastOut.amount ?? 0n })
    return
  }

  tx.addOutput({ script: newOut.script, amount: newOut.amount })
}
