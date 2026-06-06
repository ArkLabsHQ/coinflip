/**
 * @arklabshq/contract-workflows-prototype
 *
 * Primitives library for building state-machine contracts on Ark via
 * arkade-script. This is the **incubator** for the eventual
 * `@arkade-os/contract-workflows` framework — see
 * `docs/superpowers/specs/2026-05-29-contract-workflows-framework.md`
 * for the architectural plan.
 *
 * Today this package ships **option B** from that spec: a primitives
 * library that contracts compose by hand. Once 2-3 contracts have
 * stabilized on the primitives, we'll extract the DSL (option A) from
 * the shapes that recur.
 *
 * Current scope (validated by `arkade-coinflip`):
 *   - `covenants.payTo` — single-output covenant (HTLC refund shape)
 *   - `covenants.atomicSweep` — cross-input + single-output covenant
 *     (coinflip R1 forfeit shape)
 *   - `covenants.selfSend` — covenant that constrains the spend to
 *     loop back to the same VTXO (banco's delegate shape; intent-proof
 *     gated)
 *   - `predicates.hash160` — preimage check that wraps inside a
 *     ConditionMultisig closure
 *   - `emulator.{computeTweakedKey, addPacket, encodeWitness}` —
 *     handoff utilities for posting transitions to the emulator
 *
 * Not yet shipped (next iterations):
 *   - DSL layer (`defineContract` / states / transitions)
 *   - `predicates.{rangeCheck, coinflipWinCondition, signedAttestation}`
 *   - `covenants.{splitRefund, nextStateBinding}`
 *   - Recovery state-machine driver
 *
 * @module @arklabshq/contract-workflows-prototype
 */

export * as covenants from './covenants'
export * as predicates from './predicates'
export * as emulator from './emulator'
export * as packets from './packets'

// Re-export the most-used arkade-script primitives directly so consumers
// don't need to hunt across @arkade-os/sdk for them.
export {
  arkade,
  EmulatorPacket,
  Extension,
  P2A,
  type ExtensionPacket,
} from '@arkade-os/sdk'
