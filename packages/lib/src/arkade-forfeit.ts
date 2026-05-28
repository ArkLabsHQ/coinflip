/**
 * Arkade-script forfeit leaf for the R1 audit finding.
 *
 * **Status: proof-of-concept, encoding-only.**
 *
 * This module is **not wired** into the production game. It exists to evaluate
 * whether the trustless-coin's R1 forfeit leaf (today: `ConditionCSVMultisigTapscript`
 * — see `packages/lib/src/script.ts` `CoinflipEscrowScript.playerPenalty`) can be
 * replaced by an **arkade-script** leaf that lives in arkd's *execution-bucket*
 * closure family (CLTV-based, the right architectural bucket for a forfeit)
 * rather than the exit-bucket (CSV-based, which forces unilateral exit and
 * weakens the deterrent).
 *
 * ## The R1 problem
 *
 * If the player reveals first and the house then withholds its secret at
 * `/commit`, the player has revealed a winning hand but cannot claim either
 * escrow. The audit recommendation: after a short timeout (`penaltyTimelockSeconds`),
 * the player should be able to sweep BOTH escrows with only their own secret.
 *
 * ## Today's implementation (CSV-based)
 *
 * `ConditionCSVMultisigTapscript`: `<hash-check on playerHash> VERIFY <CSV>
 * DROP <player-pubkey> CSVSIG <server-pubkey> CSIG`. Works at the script level
 * but lives in arkd's `ExitClosures` partition
 * (`pkg/ark-lib/script/vtxo_script.go:213-235`). That partition is for
 * unilateral exit — the player must broadcast on-chain rather than execute
 * collaboratively. Architecturally weaker.
 *
 * ## The arkade-script approach (this PoC)
 *
 * Build the leaf as:
 *   - **tapscript closure:** `CLTVMultisigTapscript` (lands in arkd's
 *     `ForfeitClosures` / execution bucket — the right bucket).
 *   - **arkade script:** preimage check + covenant enforcing the spend pays
 *     the player's address with the full pot.
 *   - **signers:** [player, server, emulator_tweaked]. Player gates "who is
 *     spending," server cosigns CLTV satisfaction, emulator only cosigns when
 *     the arkade script (preimage + covenant) passes.
 *
 * Pattern is identical to `arkade-htlc.test.ts` (refund leaf) in the
 * arkade-script-final branch of @arkade-os/sdk PR #319.
 *
 * ## Why this isn't wired in yet
 *
 * 1. arkade-script support is on @arkade-os/sdk PR #319 (branch
 *    `arkade-script-final`) which is still OPEN as of 2026-05-28 — not in any
 *    released SDK version (currently on 0.4.30 in our repo, arkade-script
 *    lands in a later release).
 * 2. The emulator service (the off-chain validator that signs the tweaked
 *    key only after running the arkade script) is not part of the standard
 *    arkd regtest stack. It runs at :7073 alongside arkd:7070 — see
 *    `arkade-os/emulator` and `banco/docker-compose.emulator.yml`.
 *
 * Both blockers are infra, not protocol. Once the emulator is up and the SDK
 * exposes `arkade.ArkadeVtxoScript`, this module can plug straight in.
 *
 * @module arkade-forfeit
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { OP } from '@scure/btc-signer'

/**
 * Arkade-extension opcodes used by the forfeit covenant. Sourced from
 * arkade-os/emulator `pkg/arkade/opcode.go` and mirrored in the TS SDK at
 * `arkade-script-final:packages/ts-sdk/src/arkade/opcodes.ts`.
 *
 * We vendor only the ones we use; full catalog is in the emulator README.
 */
export const ARKADE_OP = {
  INSPECTOUTPUTVALUE: 0xcf,
  INSPECTOUTPUTSCRIPTPUBKEY: 0xd1,
  INSPECTNUMOUTPUTS: 0xd5,
} as const

/**
 * Compute the arkade script's BIP-340 tagged hash with tag "ArkScriptHash".
 * Used as the scalar tweak when binding an emulator key to a specific script.
 *
 * Mirrors `arkade-script-final:src/arkade/tweak.ts:arkadeScriptHash`.
 */
export function arkadeScriptHash(script: Uint8Array): Uint8Array {
  return schnorr.utils.taggedHash('ArkScriptHash', script)
}

/**
 * Tweak the emulator's pubkey with `hash(arkade_script)`:
 *   tweaked = pubkey + arkadeScriptHash(script) * G
 *
 * The emulator service holds the private key for `pubkey`; it can only
 * derive the matching tweaked secret key for a specific arkade script,
 * which it does **after** running the script and confirming it passes.
 *
 * Mirrors `arkade-script-final:src/arkade/tweak.ts:computeArkadeScriptPublicKey`.
 *
 * Returns the 32-byte x-only pubkey (BIP340 form, even-Y forced).
 */
export function computeArkadeScriptPublicKey(
  pubkey: Uint8Array,
  script: Uint8Array,
): Uint8Array {
  const tweakScalarBytes = arkadeScriptHash(script)
  const xOnly = pubkey.length === 33 ? pubkey.subarray(1) : pubkey
  const point = secp256k1.Point.fromHex('02' + hex.encode(xOnly))
  const n = secp256k1.Point.CURVE().n
  let scalar = 0n
  for (const b of tweakScalarBytes) scalar = (scalar << 8n) | BigInt(b)
  scalar = scalar % n || 1n
  const tweakPoint = secp256k1.Point.BASE.multiply(scalar)
  const result = point.add(tweakPoint)
  return result.toBytes().subarray(1) // x-only
}

/**
 * Build the **forfeit arkade script**: enforces
 *
 *   1. The transaction has exactly `numOutputs` outputs (matches the sweep
 *      shape we expect — pot to player, optional change/anchor handled by
 *      caller's `numOutputs`).
 *   2. Output 0 pays `playerPkScript` with at least `potAmount` sats.
 *
 * Witness expected at spend time: empty (the script reads everything from
 * the transaction itself via introspection).
 *
 * The **preimage check** (player must reveal a secret matching `playerHash`)
 * is **not** in the arkade script — it lives in the surrounding tapscript
 * closure as a `ConditionMultisig` condition, because that's already enforced
 * by arkd at the consensus layer and gives the player an unambiguous "I'm
 * spending this" signal in the witness.
 *
 * Layout choice rationale: covenant lives in arkade (emulator enforces),
 * preimage lives in tapscript condition (arkd enforces). Two enforcement
 * surfaces, each carrying the rule it's best suited to enforce.
 */
export function buildForfeitArkadeScript(
  playerPkScript: Uint8Array,
  potAmount: bigint,
  numOutputs: number,
): Uint8Array {
  if (playerPkScript[0] !== 0x51 || playerPkScript[1] !== 0x20) {
    throw new Error('buildForfeitArkadeScript: expected P2TR (v1 witness) pkScript')
  }
  if (potAmount <= 0n) throw new Error('buildForfeitArkadeScript: potAmount must be positive')
  if (!Number.isInteger(numOutputs) || numOutputs < 1 || numOutputs > 16) {
    throw new Error('buildForfeitArkadeScript: numOutputs must be in [1, 16]')
  }
  const witnessProgram = playerPkScript.slice(2)

  // Encode bigint potAmount as a minimal-LE byte string (Arkade BigNum).
  // For amounts <= 2^31-1 a 4-byte LE encoding is conservative and matches
  // the wire format CScriptNum-compatible encoders produce.
  const amountBytes = encodeMinimalBigInt(potAmount)

  // Encode opcode sequence: [push N, NUMOUTPUTS, EQUALVERIFY, push 0,
  //   INSPECTOUTPUTSCRIPTPUBKEY, push 1, EQUALVERIFY, push wp, EQUALVERIFY,
  //   push 0, INSPECTOUTPUTVALUE, push amount, GREATERTHANOREQUAL]
  const ops: number[] = []

  // 1) NUMOUTPUTS == numOutputs
  ops.push(OP.OP_1 - 1 + numOutputs) // OP_<numOutputs>
  ops.push(ARKADE_OP.INSPECTNUMOUTPUTS)
  ops.push(OP.EQUALVERIFY)

  // 2) output[0].scriptPubKey is P2TR(witnessProgram)
  ops.push(OP.OP_0) // output index 0
  ops.push(ARKADE_OP.INSPECTOUTPUTSCRIPTPUBKEY) // pushes (program, version)
  ops.push(OP.OP_1) // segwit version 1 (P2TR)
  ops.push(OP.EQUALVERIFY)
  // Now top of stack is the 32-byte witness program. Push our expected one:
  ops.push(witnessProgram.length, ...witnessProgram)
  ops.push(OP.EQUALVERIFY)

  // 3) output[0].value >= potAmount
  ops.push(OP.OP_0) // output index 0
  ops.push(ARKADE_OP.INSPECTOUTPUTVALUE)
  ops.push(amountBytes.length, ...amountBytes)
  ops.push(OP.GREATERTHANOREQUAL)

  return new Uint8Array(ops)
}

/**
 * Minimal-encode a positive BigInt as little-endian bytes, with a sign-pad
 * byte (0x00) appended if the MSB has the high bit set. Matches the
 * CScriptNum convention used by both Bitcoin Script and the Arkade VM.
 */
function encodeMinimalBigInt(v: bigint): Uint8Array {
  if (v <= 0n) throw new Error('encodeMinimalBigInt: expected positive bigint')
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
 * Describe the forfeit leaf without yet encoding the tapscript closure
 * (that requires the unreleased arkade-script SDK). Callers can hand this
 * struct directly to `arkade.ArkadeVtxoScript` once the SDK ships.
 *
 * The accompanying tapscript closure SHOULD be `CLTVMultisigTapscript` with
 * `pubkeys: [playerPubkey, serverPubkey]` and the absolute-locktime equal
 * to the game's `finalExpiration`. The `ArkadeVtxoScript` constructor will
 * append the emulator-tweaked key to that pubkey list automatically.
 */
export interface ForfeitLeafSpec {
  arkadeScript: Uint8Array
  arkadeScriptHash: Uint8Array
  emulatorPubkey: Uint8Array
  emulatorTweakedPubkey: Uint8Array
}

export function buildForfeitLeafSpec(args: {
  playerPkScript: Uint8Array
  potAmount: bigint
  numOutputs: number
  emulatorPubkey: Uint8Array
}): ForfeitLeafSpec {
  const arkadeScript = buildForfeitArkadeScript(
    args.playerPkScript,
    args.potAmount,
    args.numOutputs,
  )
  return {
    arkadeScript,
    arkadeScriptHash: arkadeScriptHash(arkadeScript),
    emulatorPubkey: args.emulatorPubkey,
    emulatorTweakedPubkey: computeArkadeScriptPublicKey(args.emulatorPubkey, arkadeScript),
  }
}
