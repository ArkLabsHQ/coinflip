/**
 * VTXO coin selection for game funding.
 *
 * Note on duplication with the SDK: `@arkade-os/sdk` ships its own
 * `selectVirtualCoins(coins, targetAmount)` (expiry-aware) for use inside
 * the `Wallet`'s send/settle paths, but it isn't re-exported from the
 * package's main entry — it lives behind `wallet/wallet.js` as internal
 * machinery. We keep this greedy-by-amount selector because the lib's
 * portable `VtxoInput` type doesn't carry expiry metadata and the SDK
 * function operates on the wallet-side `ExtendedVirtualCoin` shape.
 * If the SDK ever exposes a generic selector that takes raw `(txid,
 * vout, amount)` tuples, this file becomes redundant.
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
