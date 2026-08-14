// Boltz swap limits, so the Send flow can pick a rail before submitting
// rather than failing at the API.

import { reactive } from 'vue'
import { getLimits } from './boltz'

enum TxType {
  lnSwap = 'lnSwap',
  arkToBtc = 'arkToBtc',
}

interface LimitAmounts { min: number; max: number }

const limits = reactive<Record<TxType, LimitAmounts>>({
  [TxType.lnSwap]: { min: 0, max: 0 },
  [TxType.arkToBtc]: { min: 0, max: 0 },
})

/** max -1 is unbounded; 0/0 means not loaded yet, so nothing is valid. */
function validAmount(sats: number, txtype: TxType): boolean {
  if (!sats) return false
  const { min, max } = limits[txtype]
  return sats >= min && (max === -1 ? true : sats <= max)
}

export const validLnSwap = (sats: number): boolean => validAmount(sats, TxType.lnSwap)
export const validArkToBtc = (sats: number): boolean => validAmount(sats, TxType.arkToBtc)

/** Load on connect — a failed rail stays at 0/0, so it reads as unusable. */
export async function loadLimits(): Promise<void> {
  getLimits().then((r) => { limits.lnSwap = r }).catch(console.warn)
  getLimits('ARK', 'BTC').then((r) => { limits.arkToBtc = r }).catch(console.warn)
}
