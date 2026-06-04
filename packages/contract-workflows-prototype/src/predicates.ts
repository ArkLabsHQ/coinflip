/**
 * Predicate builders — tapscript condition-script fragments that wrap
 * inside `ConditionMultisigTapscript` (and variants). These are
 * enforced by arkd, not the emulator — they go in the surrounding
 * tapscript closure, alongside the multisig.
 *
 * Important: `ConditionMultisigTapscript.encode(...)` appends its own
 * `VERIFY` after the condition, so predicates here **must not** append
 * their own. Leave the boolean result on the stack.
 */

import { OP } from '@scure/btc-signer'

/**
 * SHA256-preimage check. Stack expects `[secret]`; pushes 1 if
 * `SHA256(secret) == expected`, else 0.
 *
 * Layout: `SHA256 <expected> EQUAL`
 */
export function sha256(expected: Uint8Array): Uint8Array {
  if (expected.length !== 32) throw new Error('predicates.sha256: expected 32-byte hash')
  return new Uint8Array([OP.SHA256, 0x20, ...expected, OP.EQUAL])
}

/**
 * HASH160-preimage check (BIP-141 style). Stack expects `[preimage]`;
 * pushes 1 if `HASH160(preimage) == expected`, else 0.
 *
 * Layout: `HASH160 <expected> EQUAL`
 */
export function hash160(expected: Uint8Array): Uint8Array {
  if (expected.length !== 20) throw new Error('predicates.hash160: expected 20-byte hash')
  return new Uint8Array([OP.HASH160, 0x14, ...expected, OP.EQUAL])
}
