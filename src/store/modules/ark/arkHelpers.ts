/**
 * Stateless helpers for the Ark wallet store module.
 *
 * Small, side-effect-free functions relocated verbatim from `ark.ts` — the RNG,
 * the single-party offchain submit, address/checkpoint decoders, the claim-payload
 * normaliser, the stash lookup, and the forfeit-readiness predicate. None of them
 * touch the module-scoped `sdkWallet`/timer state, so they live here where they can
 * be imported (and unit-tested) without the Vuex store. `ark.ts` re-exports
 * `hasStashedForfeit` + `ForfeitClaimable` so external import paths are unchanged.
 */
import { hex, base64 } from '@scure/base'
import {
  ConditionWitness, setArkPsbtField, Transaction, ArkAddress,
  type ArkProvider, type Identity,
} from '@arkade-os/sdk'
import { withTimeout, TIMEOUTS } from '@/utils/withTimeout'
import { loadStashes as loadRefunds } from '@/utils/stashStore'
import type { StashedRefund, ClaimMode } from './arkTypes'

/**
 * Cryptographically-uniform integer in `[0, n)` via `crypto.getRandomValues`
 * (CSPRNG) with rejection sampling. The variable-odds digit the player picks is
 * encoded into its revealed secret length, so a `Math.random()`-derived digit
 * would leak the non-crypto PRNG's state across games and let an observer
 * predict the next pick. Mirrors the lib's server-side `randomUniformInt`.
 */
export function uniformRandomInt(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`uniformRandomInt: n must be a positive integer (got ${n})`)
  if (n === 1) return 0
  const bytes = Math.ceil(Math.log2(n) / 8) || 1
  const max = 256 ** bytes
  const limit = max - (max % n)
  const buf = new Uint8Array(bytes)
  for (;;) {
    crypto.getRandomValues(buf)
    let x = 0
    for (const b of buf) x = x * 256 + b
    if (x < limit) return x % n
  }
}

/**
 * The structural fields a forfeit-claim needs, read off a stashed-refund record.
 * A loose subset of `StashedRefund` so this predicate keeps a narrow shape.
 */
export type ForfeitClaimable = {
  revealed?: boolean
  forfeitPsbt?: string
  forfeitCheckpoints?: string[]
  forfeitEmulatorUrl?: string
  forfeitClaimableAt?: number
}

/**
 * Does this stash hold a COMPLETE, revealed forfeit ready to be claimed?
 *
 * Single source of truth shared by the StalledBets "Claim full pot" button, the
 * `claimForfeit` action's precondition guard, and the background auto-claim poll.
 * Purely STRUCTURAL — it answers "is a forfeit stashed and revealed?", NOT "is
 * the CLTV mature yet?" (that time gate is layered on by the callers). It is a
 * TYPE GUARD, so callers that pass the check may read the forfeit fields as
 * defined. Relocated here when the legacy per-party-escrow (v2/v3) creation flow
 * was removed; it still backs recovery of already-escrowed stalled bets.
 */
export function hasStashedForfeit<T extends ForfeitClaimable>(
  stash: T,
): stash is T & {
  revealed: true
  forfeitPsbt: string
  forfeitCheckpoints: string[]
  forfeitEmulatorUrl: string
  forfeitClaimableAt: number
} {
  return (
    stash.revealed === true &&
    !!stash.forfeitPsbt &&
    Array.isArray(stash.forfeitCheckpoints) && stash.forfeitCheckpoints.length > 0 &&
    !!stash.forfeitEmulatorUrl &&
    stash.forfeitClaimableAt !== undefined
  )
}

/**
 * Single-party offchain submit: sign `signInputs` on the ark tx + every
 * checkpoint with `identity`, optionally attaching a condition witness (revealed
 * secrets) to the signed inputs. arkd co-signs the server leg. Mirrors the
 * server's submitOffchain (both proven by the regtest e2e). SDK-only, so it
 * bundles for the browser (the lib's tx-builders are Node-crypto bound).
 */
export async function submitOffchain(
  arkProvider: ArkProvider,
  identity: Identity,
  arkTx: Transaction,
  checkpoints: Transaction[],
  signInputs: number[],
  witness?: Uint8Array[],
): Promise<string> {
  if (witness) for (const i of signInputs) setArkPsbtField(arkTx, i, ConditionWitness, witness)
  const signed = await identity.sign(arkTx, signInputs)
  const { arkTxid, signedCheckpointTxs } = await withTimeout(
    arkProvider.submitTx(
      base64.encode(signed.toPSBT()),
      checkpoints.map((c) => base64.encode(c.toPSBT())),
    ),
    TIMEOUTS.submit,
    'submit transaction',
  )
  const finals: string[] = []
  for (const c of signedCheckpointTxs) {
    const tx = Transaction.fromPSBT(base64.decode(c))
    const idx: number[] = []
    for (let i = 0; i < tx.inputsLength; i++) idx.push(i)
    if (witness) for (const i of idx) setArkPsbtField(tx, i, ConditionWitness, witness)
    finals.push(base64.encode((await identity.sign(tx, idx)).toPSBT()))
  }
  await withTimeout(arkProvider.finalizeTx(arkTxid, finals), TIMEOUTS.submit, 'finalize transaction')
  return arkTxid
}

/** Address → pkScript hex — the dense `ArkAddress.decode(...).pkScript` chain,
 *  named once so its three call sites read as intent, not bit-twiddling. */
export function addressToPkScriptHex(address: string): string {
  return hex.encode(ArkAddress.decode(address).pkScript)
}

/** Load the stashed refund for a game, if any. The stash is the trustless
 *  backstop; several actions look it up by the same `gameId` find. */
export async function getRefundStash(gameId: string): Promise<StashedRefund | undefined> {
  return (await loadRefunds()).find((x) => x.gameId === gameId)
}

/**
 * Both claim actions accept either a bare gameId (legacy callers) or a
 * `{ gameId, mode }` object. Normalise to the object form, defaulting `mode` to
 * 'manual' (a user click) when unspecified.
 */
export function parseClaimPayload(
  payload: string | { gameId: string; mode?: ClaimMode },
): { gameId: string; mode: ClaimMode } {
  return typeof payload === 'string'
    ? { gameId: payload, mode: 'manual' }
    : { gameId: payload.gameId, mode: payload.mode ?? 'manual' }
}

/** Decode an array of checkpoint PSBTs (hex) into Transactions — the shape both
 *  the refund and forfeit claim submissions need before co-signing. */
export function decodeCheckpointTxs(checkpointsHex: string[]): Transaction[] {
  return checkpointsHex.map((c) => Transaction.fromPSBT(hex.decode(c)))
}
