// Lightning & chain swap service using @arkade-os/boltz-swap
// Wraps ArkadeSwaps for LN ↔ Ark and BTC ↔ Ark swaps with automatic claim/refund

import {
  ArkadeSwaps,
  BoltzSwapProvider,
  getInvoiceSatoshis,
  type FeesResponse,
  type LimitsResponse,
  type PendingReverseSwap,
  type PendingSubmarineSwap,
  type CreateLightningInvoiceResponse,
  type SendLightningPaymentResponse,
  type BoltzSwapStatus,
  type ArkToBtcResponse,
  type BoltzChainSwap,
} from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'
import type { Chain, Network } from '@arkade-os/boltz-swap'

let swaps: ArkadeSwaps | null = null

export function getSwaps(): ArkadeSwaps | null {
  return swaps
}

/**
 * Return the live swap service, or throw if it has not been initialised yet.
 * Every swap operation needs a connected wallet behind `ArkadeSwaps`; routing
 * them all through one guard keeps the seven call sites to a single readable
 * line each and gives them one consistent "not initialized" error.
 */
function requireSwaps(): ArkadeSwaps {
  if (!swaps) throw new Error('Swap service not initialized')
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
  return requireSwaps().createLightningInvoice({ amount, description })
}

/**
 * Wait for a reverse swap to complete (LN payment received + VHTLC claimed).
 */
export async function waitForDeposit(
  pendingSwap: PendingReverseSwap,
): Promise<{ txid: string }> {
  return requireSwaps().waitAndClaim(pendingSwap)
}

// ─── Withdraw (Ark → onchain): chain swap ─────────────────────────

/** Creates the swap only — fund `arkAddress`, then `waitForOnchainSwap`. */
export async function createOnchainSwap(
  address: string,
  amount: number,
): Promise<ArkToBtcResponse> {
  return requireSwaps().arkToBtc({ btcAddress: address, receiverLockAmount: amount })
}

/** Wait for an Ark→BTC chain swap to confirm, then claim it. */
export async function waitForOnchainSwap(
  pendingSwap: BoltzChainSwap,
): Promise<{ txid: string }> {
  return requireSwaps().waitAndClaimChain(pendingSwap)
}

// ─── Withdraw (Ark → LN): submarine swap ─────────────────────────

export async function createLnWithdraw(
  invoice: string,
): Promise<SendLightningPaymentResponse> {
  return requireSwaps().sendLightningPayment({ invoice })
}

/** Amount encoded in a BOLT11 invoice (0 for amountless invoices / parse error). */
export function invoiceSats(invoice: string): number {
  try {
    return Number(getInvoiceSatoshis(invoice)) || 0
  } catch {
    return 0
  }
}

// ─── Fee & Limit Info ─────────────────────────────────────────────

export async function getFees(): Promise<FeesResponse> {
  return requireSwaps().getFees()
}

/** Lightning limits by default; pass a pair for chain-swap limits. */
export async function getLimits(
  from?: Chain,
  to?: Chain,
): Promise<LimitsResponse> {
  return from && to
    ? requireSwaps().getLimits(from, to)
    : requireSwaps().getLimits()
}

// ─── Swap Status & History ────────────────────────────────────────

export async function getSwapStatus(swapId: string) {
  return requireSwaps().getSwapStatus(swapId)
}

export async function getSwapHistory() {
  return requireSwaps().getSwapHistory()
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
