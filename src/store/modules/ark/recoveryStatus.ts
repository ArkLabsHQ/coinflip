import { Transaction, isVtxoSpent, type IndexerProvider, type OnchainProvider } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import type { StashedV4Forfeit, V4PotOutpoint } from './v4ForfeitStash'
import { rebuildJointPot } from './v4SelfRefund'
import { deleteV4Forfeit, putV4Forfeit } from './v4ForfeitStashStore'

export type RecoveryStatus = { kind: 'pending' | 'unspent' | 'spent' } | { kind: 'staged'; outpoint: V4PotOutpoint }

function spends(tx: Transaction, outpoint: { txid: string; vout: number }): boolean {
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i)
    if (input.txid && hex.encode(input.txid) === outpoint.txid && input.index === outpoint.vout) return true
  }
  return false
}

/** Absence, a house status, and an error message never prove that recovery is obsolete. */
export async function recoveryStatus(
  stash: StashedV4Forfeit,
  indexer: Pick<IndexerProvider, 'getVtxos' | 'getVirtualTxs'>,
  onchain?: Pick<OnchainProvider, 'getTxOutspends' | 'getTxStatus' | 'getRawTransaction'>,
): Promise<RecoveryStatus> {
  const pot = rebuildJointPot(stash.covenant)
  const target = stash.stageTwoOutpoint ?? stash.potOutpoint
  const expectedScript = stash.stageTwoOutpoint ? pot.stageTwo.pkScript : pot.pkScript
  const classify = (tx: Transaction): RecoveryStatus => {
    if (!stash.stageTwoOutpoint) {
      for (let vout = 0; vout < tx.outputsLength; vout++) {
        const output = tx.getOutput(vout)
        if (output.script && hex.encode(output.script) === hex.encode(pot.stageTwo.pkScript) && output.amount === BigInt(target.value)) {
          return { kind: 'staged', outpoint: { txid: tx.id, vout, value: target.value } }
        }
      }
    }
    return { kind: 'spent' }
  }
  try {
    const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid: target.txid, vout: target.vout }] })
    const coin = vtxos.find(vtxo => vtxo.txid === target.txid && vtxo.vout === target.vout)
    if (coin && coin.script === hex.encode(expectedScript) && coin.value === target.value) {
      if (!isVtxoSpent(coin) && !coin.isUnrolled) return { kind: 'unspent' }
      if (isVtxoSpent(coin) && coin.spentBy && coin.arkTxId) {
        const { txs } = await indexer.getVirtualTxs([coin.arkTxId])
        for (const encoded of txs) {
          const tx = Transaction.fromPSBT(base64.decode(encoded))
          if (tx.id === coin.arkTxId && spends(tx, { txid: coin.spentBy, vout: 0 })) return classify(tx)
        }
      }
    }
  } catch { /* Indexing can lag a broadcast; preserve the record and retry. */ }

  if (onchain) {
    try {
      const spending = (await onchain.getTxOutspends(target.txid))[target.vout]
      if (spending?.spent && spending.txid && (await onchain.getTxStatus(spending.txid)).confirmed) {
        const tx = Transaction.fromRaw(await onchain.getRawTransaction(spending.txid))
        if (tx.id === spending.txid && spends(tx, target)) return classify(tx)
      }
    } catch { /* Not unrolled, not mined, or explorer unavailable. */ }
  }
  return { kind: 'pending' }
}

export async function reconcileRecovery(
  stash: StashedV4Forfeit,
  indexer: Pick<IndexerProvider, 'getVtxos' | 'getVirtualTxs'>,
  onchain?: Pick<OnchainProvider, 'getTxOutspends' | 'getTxStatus' | 'getRawTransaction'>,
): Promise<RecoveryStatus> {
  const status = await recoveryStatus(stash, indexer, onchain)
  if (status.kind === 'spent') await deleteV4Forfeit(stash.gameId)
  else if (status.kind === 'staged') await putV4Forfeit({ ...stash, stageTwoOutpoint: status.outpoint, confirmationPending: false })
  else if (status.kind === 'pending' || stash.confirmationPending) await putV4Forfeit({ ...stash, confirmationPending: true })
  return status
}
