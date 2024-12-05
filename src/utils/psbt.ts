import { ArkVTXO } from '@/store/modules/ark/ark'
import { Transaction } from '@scure/btc-signer'
import { TransactionInputUpdate, TransactionOutputUpdate } from '@scure/btc-signer/psbt'
import { UNSPENDABLE_KEY, vtxoScript } from './taproot'
import { TAP_LEAF_VERSION } from '@scure/btc-signer/payment'
import { ArkAddress } from '@/store/modules/ark/address'
import { hex } from '@scure/base'

export interface VtxoInput {
  vtxo: ArkVTXO
  leaf: string
}

export function buildRedeemTx(
  vtxos: VtxoInput[],
  outputs: Array<{ value: bigint, address: string }>
): Transaction {
  if (!vtxos.length) {
    throw new Error('Missing vtxos')
  }

  const tx = new Transaction()

  // compute the script from control block and revealed script

  // Process each input
  for (const input of vtxos) {
    tx.addInput(vtxoToInput(input))
  }

  // Add outputs
  outputs.forEach(output => {
    const address = ArkAddress.decode(output.address)

    const rawOutput: TransactionOutputUpdate = {
      script: Buffer.concat([Buffer.from([0x51, 0x20]), address.vtxoTapKey]),
      amount: output.value
    }
    tx.addOutput(rawOutput)
  })

  return tx
}

function vtxoToInput(vtxoInput: VtxoInput): TransactionInputUpdate {
  const vtxoP2TR = vtxoScript(vtxoInput.vtxo.tapscripts)
  const selectedLeaf = vtxoP2TR.leaves?.find(l => hex.encode(l.script) === vtxoInput.leaf)
  if (!selectedLeaf) {
    throw new Error('Selected leaf not found')
  }
  return {
    txid: vtxoInput.vtxo.outpoint.txid,
    index: vtxoInput.vtxo.outpoint.vout,
    witnessUtxo: {
      script: vtxoP2TR.script, // P2TR script
      amount: BigInt(vtxoInput.vtxo.amount)
    },
    tapLeafScript: [
      [
        {
          version: TAP_LEAF_VERSION,
          internalKey: UNSPENDABLE_KEY,
          merklePath: selectedLeaf.path,
        },
        Buffer.concat([selectedLeaf.script, Buffer.from([TAP_LEAF_VERSION])])
      ]
    ]
  }
}
