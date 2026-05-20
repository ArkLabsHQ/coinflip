// Lightning & chain swap service using @arkade-os/boltz-swap
// Wraps ArkadeSwaps for LN ↔ Ark and BTC ↔ Ark swaps with automatic claim/refund

import {
  ArkadeSwaps,
  BoltzSwapProvider,
  type FeesResponse,
  type LimitsResponse,
  type PendingReverseSwap,
  type PendingSubmarineSwap,
  type CreateLightningInvoiceResponse,
  type SendLightningPaymentResponse,
  type BoltzSwapStatus,
} from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'
import type { Network } from '@arkade-os/boltz-swap'

let swaps: ArkadeSwaps | null = null

export function getSwaps(): ArkadeSwaps | null {
  return swaps
}

/**
 * Initialize the swap service with an SDK wallet.
 * Call this after the Ark wallet connects.
 *
 * For regtest/custom Boltz, pass a boltzApiUrl to override auto-detection.
 */
export async function initSwaps(
  wallet: Wallet,
  boltzApiUrl?: string,
): Promise<ArkadeSwaps> {
  // If custom Boltz URL provided (e.g. regtest), create provider manually
  const swapProvider = boltzApiUrl
    ? new BoltzSwapProvider({ apiUrl: boltzApiUrl, network: 'regtest' as Network })
    : undefined

  swaps = await ArkadeSwaps.create({
    wallet,
    ...(swapProvider ? { swapProvider } : {}),
  })

  return swaps
}

/**
 * Tear down swap service (call on disconnect/cleanup).
 */
export async function destroySwaps(): Promise<void> {
  if (swaps) {
    await swaps.dispose()
    swaps = null
  }
}

// ─── Deposit (LN → Ark): reverse swap ────────────────────────────

export async function createLnDeposit(
  amount: number,
  description?: string,
): Promise<CreateLightningInvoiceResponse> {
  if (!swaps) throw new Error('Swap service not initialized')
  return swaps.createLightningInvoice({ amount, description })
}

/**
 * Wait for a reverse swap to complete (LN payment received + VHTLC claimed).
 */
export async function waitForDeposit(
  pendingSwap: PendingReverseSwap,
): Promise<{ txid: string }> {
  if (!swaps) throw new Error('Swap service not initialized')
  return swaps.waitAndClaim(pendingSwap)
}

// ─── Withdraw (Ark → LN): submarine swap ─────────────────────────

export async function createLnWithdraw(
  invoice: string,
): Promise<SendLightningPaymentResponse> {
  if (!swaps) throw new Error('Swap service not initialized')
  return swaps.sendLightningPayment({ invoice })
}

// ─── Fee & Limit Info ─────────────────────────────────────────────

export async function getFees(): Promise<FeesResponse> {
  if (!swaps) throw new Error('Swap service not initialized')
  return swaps.getFees()
}

export async function getLimits(): Promise<LimitsResponse> {
  if (!swaps) throw new Error('Swap service not initialized')
  return swaps.getLimits()
}

// ─── Swap Status & History ────────────────────────────────────────

export async function getSwapStatus(swapId: string) {
  if (!swaps) throw new Error('Swap service not initialized')
  return swaps.getSwapStatus(swapId)
}

export async function getSwapHistory() {
  if (!swaps) throw new Error('Swap service not initialized')
  return swaps.getSwapHistory()
}

// ─── Re-exports for convenience ───────────────────────────────────

export type {
  FeesResponse,
  LimitsResponse,
  PendingReverseSwap,
  PendingSubmarineSwap,
  CreateLightningInvoiceResponse,
  SendLightningPaymentResponse,
  BoltzSwapStatus,
}
