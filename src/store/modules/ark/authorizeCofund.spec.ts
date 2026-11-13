import { describe, expect, it, vi } from 'vitest'
import { DefaultVtxo, SingleKey, Transaction } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { base64 } from '@scure/base'
import { assertFinalizedPot, signPlayerCheckpoints } from './authorizeCofund'

const key = (seed: number) => new Uint8Array(32).fill(seed)
const locking = new DefaultVtxo.Script({
  pubKey: schnorr.getPublicKey(key(1)), serverPubKey: schnorr.getPublicKey(key(2)),
  csvTimelock: { type: 'seconds', value: 86_528n },
})
function checkpoint(seed: number): Transaction {
  const tx = new Transaction()
  tx.addInput({ txid: key(seed), index: 0, witnessUtxo: { script: locking.pkScript, amount: 2000n }, tapLeafScript: [locking.forfeit()] })
  tx.addOutput({ script: locking.pkScript, amount: 1900n })
  return tx
}
const encoded = (tx: Transaction) => base64.encode(tx.toPSBT())
const response = (cofund: Transaction, checkpoints: Transaction[]) => ({ arkTxid: cofund.id, playerCheckpoints: checkpoints.map(encoded) })

describe('co-fund checkpoint authorization', () => {
  it('accepts reordered checkpoints and preserves operator partial signatures', async () => {
    const a = checkpoint(11), b = checkpoint(12), cofund = checkpoint(99)
    const operator = SingleKey.fromHex('02'.repeat(32))
    const aSigned = await operator.sign(a, [0])
    const identity = { sign: vi.fn(async (tx: Transaction) => tx) }
    const signed = await signPlayerCheckpoints(response(cofund, [b, aSigned]), cofund, [a, b], identity)
    expect(signed.map(psbt => Transaction.fromPSBT(base64.decode(psbt)).id)).toEqual([b.id, a.id])
    expect(Transaction.fromPSBT(base64.decode(signed[1])).getInput(0).tapScriptSig).toEqual(aSigned.getInput(0).tapScriptSig)
    expect(identity.sign).toHaveBeenCalledTimes(2)
  })

  it.each(['substituted', 'missing', 'duplicate', 'wrong-cofund'] as const)('rejects %s responses before asking for any signature', async kind => {
    const a = checkpoint(11), b = checkpoint(12), cofund = checkpoint(99)
    const returned = kind === 'substituted' ? [a, checkpoint(13)] : kind === 'missing' ? [a] : kind === 'duplicate' ? [a, a] : [a, b]
    const answer = response(cofund, returned)
    if (kind === 'wrong-cofund') answer.arkTxid = 'ff'.repeat(32)
    const identity = { sign: vi.fn(async (tx: Transaction) => tx) }
    await expect(signPlayerCheckpoints(answer, cofund, [a, b], identity)).rejects.toThrow()
    expect(identity.sign).not.toHaveBeenCalled()
  })

  it.each(['sighash', 'amount', 'script', 'leaf'] as const)('rejects altered %s even with the same unsigned transaction id', async kind => {
    const local = checkpoint(11), cofund = checkpoint(99)
    let changed = Transaction.fromPSBT(local.toPSBT())
    if (kind === 'sighash') changed.updateInput(0, { sighashType: 0x82 })
    if (kind === 'amount') changed.updateInput(0, { witnessUtxo: { script: locking.pkScript, amount: 3000n } })
    if (kind === 'script') {
      const other = new DefaultVtxo.Script({
        pubKey: schnorr.getPublicKey(key(1)), serverPubKey: schnorr.getPublicKey(key(5)),
        csvTimelock: { type: 'seconds', value: 86_528n },
      })
      changed = new Transaction()
      changed.addInput({ ...local.getInput(0), witnessUtxo: { script: other.pkScript, amount: 2000n }, tapLeafScript: [other.forfeit()] })
      changed.addOutput(local.getOutput(0))
    }
    if (kind === 'leaf') changed.updateInput(0, { tapLeafScript: [locking.exit()] })
    expect(changed.id).toBe(local.id)
    const identity = { sign: vi.fn(async (tx: Transaction) => tx) }
    await expect(signPlayerCheckpoints(response(cofund, [changed]), cofund, [local], identity)).rejects.toThrow()
    expect(identity.sign).not.toHaveBeenCalled()
  })

  it('rejects changed outputs before signing', async () => {
    const local = checkpoint(11), changed = checkpoint(11), cofund = checkpoint(99)
    changed.updateOutput(0, { amount: 1800n })
    const identity = { sign: vi.fn(async (tx: Transaction) => tx) }
    await expect(signPlayerCheckpoints(response(cofund, [changed]), cofund, [local], identity)).rejects.toThrow()
    expect(identity.sign).not.toHaveBeenCalled()
  })
})

describe('finalized pot binding', () => {
  it('accepts only the authorized transaction output zero and amount', () => {
    const tx = checkpoint(99)
    const valid = { cofundTxid: tx.id, potOutpoint: { txid: tx.id, vout: 0, value: 1900 } }
    expect(() => assertFinalizedPot(valid, tx)).not.toThrow()
    for (const patch of [{ txid: '11'.repeat(32) }, { vout: 1 }, { value: 2000 }]) {
      expect(() => assertFinalizedPot({ ...valid, potOutpoint: { ...valid.potOutpoint, ...patch } }, tx)).toThrow('authorized funding')
    }
    expect(() => assertFinalizedPot({ ...valid, cofundTxid: '11'.repeat(32) }, tx)).toThrow('authorized funding')
  })
})
