import {
  Transaction, assertAllowedSighashTypes, assertSubmittedArkTxid, matchServerCheckpoints,
  type Identity,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import type { V4CofundResponse, V4CofundFinalizeResponse } from '@/services/api'

function canonical(value: unknown): string {
  if (value instanceof Uint8Array) return `bytes:${hex.encode(value)}`
  if (typeof value === 'bigint') return `bigint:${value}`
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${key}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function signingInput(tx: Transaction, index: number) {
  const { tapScriptSig, partialSig, tapKeySig, ...input } = tx.getInput(index)
  void tapScriptSig; void partialSig; void tapKeySig
  return { ...input, sighashType: input.sighashType ?? 0 }
}

/** Validate the whole batch before asking the identity to sign even one checkpoint. */
export async function signPlayerCheckpoints(
  response: V4CofundResponse,
  cofund: Transaction,
  checkpoints: Transaction[],
  identity: Pick<Identity, 'sign'>,
): Promise<string[]> {
  assertSubmittedArkTxid(response, cofund, 'Coinflip co-fund')
  const pairs = matchServerCheckpoints(response.playerCheckpoints, checkpoints, 'Coinflip co-fund')
  const approved = pairs.map(({ server, local }) => {
    assertAllowedSighashTypes(server)
    for (let i = 0; i < local.inputsLength; i++) {
      if (canonical(signingInput(server, i)) !== canonical(signingInput(local, i))) {
        throw new Error('The house changed checkpoint signing data')
      }
    }
    for (let i = 0; i < local.outputsLength; i++) {
      if (canonical(server.getOutput(i)) !== canonical(local.getOutput(i))) throw new Error('The house changed checkpoint outputs')
    }
    // Sign our local transaction, copying only the operator's partial signatures.
    const trusted = Transaction.fromPSBT(local.toPSBT())
    for (let i = 0; i < trusted.inputsLength; i++) {
      const { tapScriptSig, partialSig } = server.getInput(i)
      trusted.updateInput(i, { ...(tapScriptSig ? { tapScriptSig } : {}), ...(partialSig ? { partialSig } : {}) })
    }
    return trusted
  })
  return Promise.all(approved.map(async checkpoint => {
    const signed = await identity.sign(checkpoint, Array.from({ length: checkpoint.inputsLength }, (_, index) => index))
    return base64.encode(signed.toPSBT())
  }))
}

export function assertFinalizedPot(response: V4CofundFinalizeResponse, cofund: Transaction): void {
  const pot = response.potOutpoint
  if (response.cofundTxid !== cofund.id || pot.txid !== cofund.id || pot.vout !== 0 ||
      !Number.isSafeInteger(pot.value) || BigInt(pot.value) !== cofund.getOutput(0).amount) {
    throw new Error('The finalized pot does not match the authorized funding transaction')
  }
}
