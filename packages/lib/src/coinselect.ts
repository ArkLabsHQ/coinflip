/**
 * VTXO coin selection for game funding.
 */

import { VtxoInput } from './types'

/**
 * Greedy coin selection: sort by amount descending, pick until target is met.
 */
export function coinSelect(
  vtxos: VtxoInput[],
  targetAmount: bigint
): { inputs: VtxoInput[] | null; changeAmount: bigint } {
  const sorted = [...vtxos].sort((a, b) => {
    return Number(BigInt(b.vtxo.amount) - BigInt(a.vtxo.amount))
  })

  const selected: VtxoInput[] = []
  let total = 0n

  for (const vtxo of sorted) {
    selected.push(vtxo)
    total += BigInt(vtxo.vtxo.amount)
    if (total >= targetAmount) break
  }

  if (total < targetAmount) {
    return { inputs: null, changeAmount: 0n }
  }

  return { inputs: selected, changeAmount: total - targetAmount }
}
