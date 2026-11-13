import { createSwapClient, IndexedDbAssetSwapRepository, type SwapClient, type Swap, type Outcome } from '@arkade-os/swap'
import type { Wallet } from '@arkade-os/sdk'
import { decode } from 'light-bolt11-decoder'
import { hex } from '@scure/base'

let swaps: SwapClient | null = null
let lifetime = new AbortController()

function requireSwaps(): SwapClient {
  if (!swaps) throw new Error('Swap service is not connected')
  return swaps
}

export async function initSwaps(wallet: Wallet): Promise<SwapClient> {
  await destroySwaps()
  lifetime = new AbortController()
  const publicKey = hex.encode(await wallet.identity.xOnlyPublicKey())
  const network = wallet.network.name ?? (await wallet.getArkadeInfo()).network
  const client = createSwapClient({
    wallet,
    repository: new IndexedDbAssetSwapRepository(`coinflip-swaps-${network}-${publicKey}`),
  })
  try { await client.ready } catch (error) { await client[Symbol.asyncDispose](); throw error }
  swaps = client
  return client
}

export async function destroySwaps(): Promise<void> {
  lifetime.abort(new Error('Wallet disconnected'))
  const client = swaps
  swaps = null
  await client?.[Symbol.asyncDispose]()
}

export function requireSats(amount: number): bigint {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Enter a positive whole number of sats')
  return BigInt(amount)
}

/** Waiting ends with this view; cancelling observation never cancels a funded swap. */
export function waitForSwap(
  client: Pick<SwapClient, 'onUpdate'>,
  id: string,
  success: readonly Outcome[],
  signal: AbortSignal,
): Promise<Swap> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined
    let finished = false
    const finish = (swap?: Swap, error?: Error) => {
      if (finished) return
      finished = true
      unsubscribe?.()
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve(swap!)
    }
    const aborted = () => finish(undefined, signal.reason instanceof Error ? signal.reason : new Error('Stopped waiting for payment'))
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      unsubscribe = client.onUpdate(({ swap, outcome }) => {
        if (swap.id !== id) return
        if (success.includes(outcome)) finish(swap)
        else if (['refunded', 'lapsed', 'failed', 'cancelled', 'needs_recovery'].includes(outcome)) {
          finish(undefined, new Error(swap.failure || swap.blockedReason || `Payment ${outcome.replace(/_/g, ' ')}`))
        }
      })
      if (finished) unsubscribe()
    } catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))) }
  })
}

export async function createLnDeposit(amount: number) {
  const client = requireSwaps()
  const swap = await client.receive({ via: 'lightning', amount: requireSats(amount) })
  return { invoice: swap.artifact.bolt11, swap }
}

export function waitForDeposit(swap: Swap, signal: AbortSignal): Promise<Swap> {
  return waitForSwap(requireSwaps(), swap.id, ['claimed'], AbortSignal.any([signal, lifetime.signal]))
}

export async function sendPayment(destination: string, amount?: number): Promise<void> {
  const client = requireSwaps()
  const result = await client.pay(destination, amount === undefined ? undefined : { amount: requireSats(amount) })
  if (result.kind === 'swap') {
    await waitForSwap(client, result.swap.id, ['paid', 'claimed', 'filled'], AbortSignal.any([lifetime.signal, AbortSignal.timeout(120_000)]))
  }
}

/** BOLT11 amount is millisats; do not round a fractional sat into a different payment. */
export function invoiceSats(invoice: string): number {
  try {
    const amount = decode(invoice.replace(/^lightning:/i, '')).sections.find(section => section.name === 'amount')
    if (!amount || !('value' in amount)) return 0
    const millisats = BigInt(String(amount.value))
    if (millisats % 1000n !== 0n || millisats <= 0n || millisats > BigInt(Number.MAX_SAFE_INTEGER) * 1000n) return 0
    return Number(millisats / 1000n)
  } catch { return 0 }
}
