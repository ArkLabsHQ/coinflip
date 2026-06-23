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

import { OP } from '@scure/btc-signer'
import { covenants, emulator } from '@arklabshq/contract-workflows-prototype'

/**
 * Arkade-extension opcode values used by the forfeit covenant.
 * Vendored constants (full catalog lives in arkade-os/emulator's
 * `pkg/arkade/opcode.go`). Kept here for back-compat with tests that
 * assert byte-exact encoding.
 */
export const ARKADE_OP = {
  INSPECTINPUTVALUE: 0xc9,
  INSPECTOUTPUTVALUE: 0xcf,
  INSPECTOUTPUTSCRIPTPUBKEY: 0xd1,
  INSPECTNUMOUTPUTS: 0xd5,
} as const

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

/**
 * Build the REFUND split covenant — asserts the spending tx pays EXACTLY the
 * player's stake to `playerPkScript` (at the witness's first output index) AND
 * the house's stake to `housePkScript` (at the second index, checked first).
 * The emulator co-signs only a tx that makes BOTH outputs, so the refund needs
 * no pre-signing — the covenant alone guarantees the fair split-back.
 *
 * Composes two `payTo` bodies: the house output is VERIFY'd (its bool consumed)
 * so the player output's check is the script's final result.
 *
 *   Witness: `[playerOutputIndex, houseOutputIndex]` (house index on top of the
 *   stack at script start, so it's checked first — matches `atomicSweep`'s
 *   "second witness item on top" convention).
 */
export function buildSplitArkadeScript(
  playerPkScript: Uint8Array,
  playerAmount: bigint,
  housePkScript: Uint8Array,
  houseAmount: bigint,
): Uint8Array {
  const houseBody = covenants.payTo(housePkScript, houseAmount) // ends OP_EQUAL
  const playerBody = covenants.payTo(playerPkScript, playerAmount) // ends OP_EQUAL
  return new Uint8Array([...houseBody.slice(0, -1), OP.EQUALVERIFY, ...playerBody])
}

/**
 * Pre-compute the leaf-spec a caller would attach to an
 * `ArkadeVtxoScript`: the arkade-script bytes, their tagged hash, and
 * the emulator-tweaked pubkey that goes into the surrounding multisig.
 */
export interface ForfeitLeafSpec {
  arkadeScript: Uint8Array
  arkadeScriptHash: Uint8Array
  emulatorPubkey: Uint8Array
  emulatorTweakedPubkey: Uint8Array
}

export function buildForfeitLeafSpec(args: {
  recipientPkScript: Uint8Array
  payAmount: bigint
  emulatorPubkey: Uint8Array
  otherStakeValue?: bigint
}): ForfeitLeafSpec {
  const arkadeScript = buildForfeitArkadeScript(
    args.recipientPkScript,
    args.payAmount,
    args.otherStakeValue,
  )
  return {
    arkadeScript,
    arkadeScriptHash: emulator.scriptHash(arkadeScript),
    emulatorPubkey: args.emulatorPubkey,
    emulatorTweakedPubkey: emulator.computeTweakedKey(args.emulatorPubkey, arkadeScript),
  }
}
