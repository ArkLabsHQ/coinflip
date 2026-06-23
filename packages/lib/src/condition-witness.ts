/**
 * ConditionWitness PSBT-field helpers — split out of transactions.ts so the
 * browser bundle (which imports the v4 builders from joint-pot-tx) can read/write
 * the SHA256-condition preimage WITHOUT pulling in transactions.ts's Node `crypto`
 * import, which webpack can't resolve. Pure PSBT field access; no hashing, no crypto.
 */
import { Transaction, setArkPsbtField, getArkPsbtFields, ConditionWitness } from '@arkade-os/sdk'

/**
 * Add condition witness (secrets) to a transaction for cashout.
 */
export function addConditionWitness(
  tx: Transaction,
  inputIndex: number,
  witnesses: Uint8Array[]
): void {
  setArkPsbtField(tx, inputIndex, ConditionWitness, witnesses)
}

/**
 * Get condition witness from a transaction.
 */
export function getConditionWitness(
  tx: Transaction,
  inputIndex: number
): Uint8Array[] | undefined {
  const witnesses = getArkPsbtFields(tx, inputIndex, ConditionWitness)
  return witnesses.length > 0 ? witnesses[0] : undefined
}
