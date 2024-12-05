import type { ArkVTXO } from '@/store/modules/ark/ark'
import { defaultVtxoTapscripts } from './taproot'
import { VtxoInput } from './psbt'

export function coinSelect(vtxos: VtxoInput[], targetAmount: bigint): {
  inputs: VtxoInput[] | null
  changeAmount: bigint
} {
  // Sort VTXOs by amount in descending order
  const sortedVtxos = [...vtxos].sort((a, b) => {
    const amountA = BigInt(a.vtxo.amount)
    const amountB = BigInt(b.vtxo.amount)
    return Number(amountB - amountA)
  })

  const selectedVtxos: VtxoInput[] = []
  let selectedAmount = BigInt(0)

  // Select VTXOs until we have enough
  for (const vtxo of sortedVtxos) {
    selectedVtxos.push(vtxo)
    selectedAmount += BigInt(vtxo.vtxo.amount)

    if (selectedAmount >= targetAmount) {
      break
    }
  }

  // Check if we have enough
  if (selectedAmount < targetAmount) {
    return { inputs: null, changeAmount: BigInt(0) }
  }

  // Calculate change
  const changeAmount = selectedAmount - targetAmount

  return {
    inputs: selectedVtxos,
    changeAmount
  }
}

// Helper function to convert ArkVTXO to VtxoInput
export function arkVtxoToInput(vtxo: ArkVTXO, walletPubkey: Uint8Array, serverPubkey: Uint8Array): VtxoInput {
  const tapscripts = vtxo.tapscripts.length > 0 
    ? vtxo.tapscripts 
    : defaultVtxoTapscripts(walletPubkey, serverPubkey)

  return {
    vtxo: {
      ...vtxo,
      tapscripts
    },
    leaf: tapscripts[0] // Use first tapscript as leaf
  }
} 