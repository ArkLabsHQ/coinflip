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
import {
  EmulatorPacket,
  Extension,
  P2A,
  Transaction,
  type ExtensionPacket,
} from '@arkade-os/sdk'

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
 * Build the **forfeit arkade script** — a covenant enforcing that the
 * spending transaction pays `payAmount` sats to `recipientPkScript` at a
 * specific output. Layout mirrors the canonical `enforcePayTo` helper in
 * the arkade-script-final HTLC test:
 *
 *   ```
 *   DUP INSPECTOUTPUTSCRIPTPUBKEY 1 EQUALVERIFY <wp> EQUALVERIFY
 *   INSPECTOUTPUTVALUE <amount> EQUAL
 *   ```
 *
 * **Witness stack at spend time:** `[output_index]` — the spender chooses
 * which output of the tx the covenant inspects. `DUP` duplicates the index
 * so it can drive both `INSPECTOUTPUTSCRIPTPUBKEY` and `INSPECTOUTPUTVALUE`.
 *
 * Notes:
 * - No `INSPECTNUMOUTPUTS` constraint: Ark transactions carry an anchor
 *   (P2A) and OP_RETURN extension outputs that the player can't suppress,
 *   so pinning the output count would refuse all valid spends.
 * - `EQUAL` (not `GREATERTHANOREQUAL`): matches the canonical helper. Ark
 *   intent fees are charged out-of-band against the operator's fee budget,
 *   so the full `payAmount` reaches the player.
 * - The **preimage check** (player must reveal a secret matching
 *   `playerHash`) is **not** in the arkade script — it lives in the
 *   surrounding tapscript closure as a `ConditionMultisig` condition, where
 *   arkd enforces it at the consensus layer.
 *
 * Layout rationale: covenant lives in arkade (emulator enforces); preimage
 * + CLTV live in the tapscript closure (arkd enforces). Two enforcement
 * surfaces, each carrying the rule it's best suited to enforce.
 */
export function buildForfeitArkadeScript(
  recipientPkScript: Uint8Array,
  payAmount: bigint,
): Uint8Array {
  if (recipientPkScript[0] !== 0x51 || recipientPkScript[1] !== 0x20) {
    throw new Error('buildForfeitArkadeScript: expected P2TR (v1 witness) pkScript')
  }
  if (payAmount <= 0n) throw new Error('buildForfeitArkadeScript: payAmount must be positive')
  const witnessProgram = recipientPkScript.slice(2)
  const amountBytes = encodeMinimalBigInt(payAmount)

  const ops: number[] = []
  // Stack: <output_index>
  ops.push(OP.DUP)                                  // <idx> <idx>
  ops.push(ARKADE_OP.INSPECTOUTPUTSCRIPTPUBKEY)     // <idx> <program> <version>
  ops.push(OP.OP_1)                                  // <idx> <program> <version> 1
  ops.push(OP.EQUALVERIFY)                           // <idx> <program>   (asserts version==1)
  ops.push(witnessProgram.length, ...witnessProgram) // <idx> <program> <expected>
  ops.push(OP.EQUALVERIFY)                           // <idx>             (asserts program match)
  ops.push(ARKADE_OP.INSPECTOUTPUTVALUE)              // <value>           (consumes idx)
  ops.push(amountBytes.length, ...amountBytes)        // <value> <expected>
  ops.push(OP.EQUAL)                                  // bool
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
  recipientPkScript: Uint8Array
  payAmount: bigint
  emulatorPubkey: Uint8Array
}): ForfeitLeafSpec {
  const arkadeScript = buildForfeitArkadeScript(args.recipientPkScript, args.payAmount)
  return {
    arkadeScript,
    arkadeScriptHash: arkadeScriptHash(arkadeScript),
    emulatorPubkey: args.emulatorPubkey,
    emulatorTweakedPubkey: computeArkadeScriptPublicKey(args.emulatorPubkey, arkadeScript),
  }
}

/**
 * Serialize a witness stack (array of byte items) the way the emulator
 * packet expects: `varint(num_items) + varint(item_len) + item_bytes` per
 * item — i.e. `psbt.WriteTxWitness` / `txutils.ReadTxWitness` format.
 *
 * For our forfeit covenant the witness has exactly one item: the output
 * index. That index is a Bitcoin scriptnum, so:
 *   - output_index = 0  → empty bytes (encodes as OP_0 in script numeric ctx)
 *   - output_index = N  → minimal LE bytes for N
 */
export function encodeEmulatorWitness(stack: Uint8Array[]): Uint8Array {
  const out: number[] = []
  // num_items (compactSize)
  out.push(...encodeCompactSize(stack.length))
  for (const item of stack) {
    out.push(...encodeCompactSize(item.length))
    for (const b of item) out.push(b)
  }
  return new Uint8Array(out)
}

function encodeCompactSize(n: number): number[] {
  if (n < 0) throw new Error('compactSize: negative')
  if (n <= 0xfc) return [n]
  if (n <= 0xffff) return [0xfd, n & 0xff, (n >> 8) & 0xff]
  if (n <= 0xffffffff) return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
  throw new Error('compactSize: too large')
}

/**
 * Encode a non-negative integer as a Bitcoin script-numeric (CScriptNum)
 * byte string. Used for the output_index witness arg the forfeit covenant
 * reads via its leading `DUP INSPECTOUTPUTSCRIPTPUBKEY` opcodes.
 *
 *   0     → empty
 *   1..N  → minimal LE with optional 0x00 sign-pad
 */
export function encodeOutputIndexWitness(idx: number): Uint8Array {
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error('encodeOutputIndexWitness: expected non-negative integer')
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

/**
 * Attaches an EmulatorPacket to the Ark transaction's output set, in place.
 *
 * Mirrors `addEmulatorPacket` from the arkade-script-final test utilities
 * (which is test code, not exported). If the tx already has an Ark
 * extension OP_RETURN, the emulator packet is merged into it; otherwise a
 * new extension output is inserted, before the P2A anchor if present.
 *
 * `entries` are per-input (vin = input index): each carries the arkade
 * script the emulator should execute on that input and the witness blob
 * the script reads at run-time.
 */
export function addEmulatorPacket(
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
    // Overwrite the last slot with the extension and re-append the anchor.
    tx.updateOutput(lastIdx, { script: newOut.script, amount: newOut.amount })
    tx.addOutput({ script: lastOut.script, amount: lastOut.amount ?? 0n })
    return
  }

  tx.addOutput({ script: newOut.script, amount: newOut.amount })
}
