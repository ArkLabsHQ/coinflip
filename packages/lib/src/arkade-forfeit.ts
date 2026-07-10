/**
 * Coinflip-specific arkade-script forfeit helpers.
 *
 * All primitives are now sourced from
 * `@arklabshq/contract-workflows-prototype` (the incubator for the
 * eventual `@arkade-os/contract-workflows` framework — see
 * `docs/superpowers/specs/2026-05-29-contract-workflows-framework.md`).
 * This file keeps only the coinflip-specific shaping on top.
 *
 * Re-exports under the previous names are preserved so existing
 * imports continue to work; new code should reach into the prototype
 * package directly.
 */

import { covenants, emulator } from '@arklabshq/contract-workflows-prototype'

// Thin re-exports of the prototype primitives under their existing
// names. Lets the rest of the lib + tests keep their current imports
// while the production code lives in one place.
export const arkadeScriptHash = emulator.scriptHash
export const computeArkadeScriptPublicKey = emulator.computeTweakedKey
export const encodeEmulatorWitness = emulator.encodeWitness
export const encodeOutputIndexWitness = emulator.encodeIndex
export const addEmulatorPacket = emulator.addPacket

/**
 * Build the coinflip forfeit covenant. Atomic-sweep when
 * `otherStakeValue` is supplied (the production path — binds both
 * escrows together); falls back to the canonical `payTo` shape
 * otherwise (single-input, retained for legacy HTLC-style uses).
 *
 * Delegates to the prototype's `covenants.atomicSweep` /
 * `covenants.payTo`. Keep this wrapper so the lib's caller surface
 * stays stable.
 */
export function buildForfeitArkadeScript(
  recipientPkScript: Uint8Array,
  payAmount: bigint,
  otherStakeValue?: bigint,
): Uint8Array {
  if (otherStakeValue !== undefined) {
    return covenants.atomicSweep(recipientPkScript, payAmount, otherStakeValue)
  }
  return covenants.payTo(recipientPkScript, payAmount)
}
