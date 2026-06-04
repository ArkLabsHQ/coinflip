/**
 * Covenant builders — arkade-script bytecode templates that, when set
 * on an `ArkadeLeaf`, are enforced by the emulator before it co-signs.
 *
 * All covenants in this file produce raw `Uint8Array` arkade-script.
 * Pair them with a tapscript closure (e.g. `CLTVMultisigTapscript`) by
 * passing both into the `ArkadeLeaf` shape from `@arkade-os/sdk`'s
 * `arkade` module.
 *
 * Witness encoding (what to put on the EmulatorPacket entry's witness):
 *   - `payTo`: `[output_index]` (1 item)
 *   - `atomicSweep`: `[output_index, other_input_index]` (2 items; the
 *     other_input_index is on TOP of the stack at script start)
 *   - `selfSend`: `[]` (no args; covenant reads its own input + output 0)
 */

import { OP } from '@scure/btc-signer'

const ARKADE = {
  INSPECTINPUTVALUE: 0xc9,
  INSPECTINPUTSCRIPTPUBKEY: 0xca,
  INSPECTOUTPUTVALUE: 0xcf,
  INSPECTOUTPUTSCRIPTPUBKEY: 0xd1,
  INSPECTVERSION: 0xd2,
  PUSHCURRENTINPUTINDEX: 0xcd,
} as const

/** Encode a positive bigint as a minimal-LE CScriptNum byte string. */
function encodeMinBigInt(v: bigint): Uint8Array {
  if (v <= 0n) throw new Error('encodeMinBigInt: expected positive')
  const bytes: number[] = []
  let n = v
  while (n > 0n) {
    bytes.push(Number(n & 0xffn))
    n >>= 8n
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00)
  return new Uint8Array(bytes)
}

/**
 * Canonical `enforcePayTo` covenant — equivalent to the helper in the
 * arkade-script-final HTLC test. Asserts a specific output of the
 * spending tx pays `recipientPkScript` exactly `amount` sats.
 *
 *   Witness: `[output_index]`
 *   Script:  `DUP INSPECTOUTPUTSCRIPTPUBKEY 1 EQUALVERIFY <wp> EQUALVERIFY`
 *            `INSPECTOUTPUTVALUE <amount> EQUAL`
 */
export function payTo(recipientPkScript: Uint8Array, amount: bigint): Uint8Array {
  if (recipientPkScript[0] !== 0x51 || recipientPkScript[1] !== 0x20) {
    throw new Error('covenants.payTo: expected P2TR (v1 witness) pkScript')
  }
  if (amount <= 0n) throw new Error('covenants.payTo: amount must be positive')
  const wp = recipientPkScript.slice(2)
  const amt = encodeMinBigInt(amount)
  return new Uint8Array([
    OP.DUP,
    ARKADE.INSPECTOUTPUTSCRIPTPUBKEY,
    OP.OP_1,
    OP.EQUALVERIFY,
    wp.length, ...wp,
    OP.EQUALVERIFY,
    ARKADE.INSPECTOUTPUTVALUE,
    amt.length, ...amt,
    OP.EQUAL,
  ])
}

/**
 * Atomic-sweep covenant — strengthens `payTo` with a cross-input value
 * check. The spending tx MUST also have another input at a witness-
 * supplied index whose value equals `otherInputValue`. Used by the
 * coinflip R1 forfeit to bind both escrows together: each leaf pins
 * the other's stake.
 *
 *   Witness: `[output_index, other_input_index]` (other_input_index on top)
 *   Script:  `INSPECTINPUTVALUE <otherInputValue> EQUALVERIFY`  + payTo body
 *
 * The `amount` here is typically the FULL POT (sum across both
 * inputs); both leaves should pin the same `amount` to guarantee
 * consistency.
 */
export function atomicSweep(
  recipientPkScript: Uint8Array,
  amount: bigint,
  otherInputValue: bigint,
): Uint8Array {
  if (otherInputValue <= 0n) {
    throw new Error('covenants.atomicSweep: otherInputValue must be positive')
  }
  const otherBytes = encodeMinBigInt(otherInputValue)
  const body = payTo(recipientPkScript, amount)
  return new Uint8Array([
    ARKADE.INSPECTINPUTVALUE,
    otherBytes.length, ...otherBytes,
    OP.EQUALVERIFY,
    ...body,
  ])
}

/**
 * Self-send covenant — constrains the spending tx to a self-loop:
 * output 0 must preserve the input's scriptPubKey + value. Used by
 * banco's delegate pattern for batch refresh; gated to intent-proof
 * transactions (`OP_INSPECTVERSION` == 2) so it cannot be drained via
 * off-chain self-send loops.
 *
 *   Witness: `[]` (no args)
 *   Script reads its own input via `OP_PUSHCURRENTINPUTINDEX`.
 */
export function selfSend(): Uint8Array {
  return new Uint8Array([
    // tx.version == 2 (intent-proof gate)
    ARKADE.INSPECTVERSION,
    0x04, 0x02, 0x00, 0x00, 0x00,
    OP.EQUALVERIFY,
    // output[0].scriptPubKey
    OP.OP_0,
    ARKADE.INSPECTOUTPUTSCRIPTPUBKEY,
    OP.OP_1,
    OP.EQUALVERIFY,
    // == input[self].scriptPubKey
    ARKADE.PUSHCURRENTINPUTINDEX,
    ARKADE.INSPECTINPUTSCRIPTPUBKEY,
    OP.OP_1,
    OP.EQUALVERIFY,
    OP.EQUALVERIFY,
    // output[0].value == input[self].value
    OP.OP_0,
    ARKADE.INSPECTOUTPUTVALUE,
    ARKADE.PUSHCURRENTINPUTINDEX,
    ARKADE.INSPECTINPUTVALUE,
    OP.EQUAL,
  ])
}
