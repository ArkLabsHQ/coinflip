/**
 * E2E test helpers for interacting with regtest infrastructure.
 */

import {
  Wallet,
  SingleKey,
  RestArkProvider,
  RestIndexerProvider,
  EsploraProvider,
  DefaultVtxo,
  ArkInfo,
  type Identity,
  type ArkProvider,
  type IndexerProvider,
} from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'

export async function createArkProvider(): Promise<ArkProvider> {
  return new RestArkProvider(ARK_SERVER_URL)
}

export async function createIndexerProvider(): Promise<IndexerProvider> {
  return new RestIndexerProvider(ARK_SERVER_URL)
}

export async function createEsploraProvider(): Promise<EsploraProvider> {
  return new EsploraProvider(ESPLORA_URL)
}

export async function getArkInfo(): Promise<ArkInfo> {
  const provider = await createArkProvider()
  return provider.getInfo()
}

export async function createFundedWallet(): Promise<{
  wallet: Wallet
  identity: SingleKey
}> {
  const identity = SingleKey.fromRandomBytes()
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARK_SERVER_URL,
    esploraUrl: ESPLORA_URL,
  })

  return { wallet, identity }
}

/**
 * Fund a wallet using the nigiri faucet + Ark settlement.
 * 1. Send BTC to the wallet's boarding address via faucet
 * 2. Mine blocks
 * 3. Settle to create VTXOs
 */
export async function fundWallet(wallet: Wallet, amountSats: number): Promise<void> {
  const boardingAddress = await wallet.getBoardingAddress()

  // Use nigiri faucet to send BTC
  const resp = await fetch(`${ESPLORA_URL}/faucet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: boardingAddress, amount: amountSats / 1e8 }),
  })

  if (!resp.ok) {
    throw new Error(`Faucet failed: ${resp.status} ${await resp.text()}`)
  }

  // Mine a block to confirm
  await mineBlock()

  // Wait for boarding UTXO to be detected
  await waitForBalance(wallet, 'boarding', amountSats, 30_000)

  // Settle to convert boarding UTXOs to VTXOs
  await wallet.settle()

  // Wait for settlement
  await waitForBalance(wallet, 'settled', amountSats * 0.9, 30_000) // ~10% fees
}

export async function mineBlock(count = 1): Promise<void> {
  const resp = await fetch(`${ESPLORA_URL}/faucet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'bcrt1qxyyy6ygnf7yzwfxlf8kp3y6aq4ey9y6rnr38uc', amount: 0.001 * count }),
  })
  if (!resp.ok) {
    // Fallback: try mining endpoint
    await fetch(`${ESPLORA_URL}/mine`, { method: 'POST' }).catch(() => {})
  }
}

async function waitForBalance(
  wallet: Wallet,
  type: 'boarding' | 'settled',
  minAmount: number,
  timeoutMs: number
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const balance = await wallet.getBalance()
    const current = type === 'boarding' ? balance.boarding.total : balance.settled
    if (current >= minAmount) return
    await sleep(1000)
  }
  throw new Error(`Timeout waiting for ${type} balance >= ${minAmount}`)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for ark server to be healthy
 */
export async function waitForArkServer(timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${ARK_SERVER_URL}/v1/info`, {
        signal: AbortSignal.timeout(3000),
      })
      if (resp.ok) return
    } catch {
      // Server not ready yet
    }
    await sleep(2000)
  }
  throw new Error('Ark server not ready')
}
