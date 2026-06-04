/**
 * Broadcast an Ark off-chain transaction (submit + finalize), re-attaching any
 * condition witness to both the ark tx and its checkpoints.
 *
 * Extracted from the submit/finalize dance in `auto-claim.ts` so the trustless
 * happy path (broadcast setup → final → winner-claim) and the fallback share
 * one implementation. The condition witness (revealed secrets) is supplied as
 * stack data, not signed over — so the same data must be set on the checkpoint
 * txs before re-signing, or arkd rejects with INVALID_SIGNATURE at finalizeTx.
 */

import { base64 } from '@scure/base'
import {
  ConditionWitness,
  Transaction,
  setArkPsbtField,
  type Identity,
  type Wallet,
} from '@arkade-os/sdk'

export interface BroadcastInput {
  arkTx: Transaction
  checkpoints: Transaction[]
  /** Input indices the house identity must sign on the ark tx. */
  signInputs: number[]
  /** Optional condition witness (e.g. revealed secrets) for a specific input. */
  conditionWitness?: { index: number; data: Uint8Array[] }
}

export async function broadcastArkTx(
  wallet: Wallet,
  identity: Identity,
  input: BroadcastInput,
): Promise<string> {
  if (input.conditionWitness) {
    setArkPsbtField(input.arkTx, input.conditionWitness.index, ConditionWitness, input.conditionWitness.data)
  }

  const signed = await identity.sign(input.arkTx, input.signInputs)
  const { arkTxid, signedCheckpointTxs } = await wallet.arkProvider.submitTx(
    base64.encode(signed.toPSBT()),
    input.checkpoints.map((c) => base64.encode(c.toPSBT())),
  )

  const finalCheckpoints = await Promise.all(
    signedCheckpointTxs.map(async (c) => {
      const tx = Transaction.fromPSBT(base64.decode(c))
      const indices: number[] = []
      for (let i = 0; i < tx.inputsLength; i++) indices.push(i)
      if (input.conditionWitness) {
        setArkPsbtField(tx, input.conditionWitness.index, ConditionWitness, input.conditionWitness.data)
      }
      const sc = await identity.sign(tx, indices)
      return base64.encode(sc.toPSBT())
    }),
  )

  await wallet.arkProvider.finalizeTx(arkTxid, finalCheckpoints)
  return arkTxid
}
