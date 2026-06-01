/**
 * E2E test helpers for interacting with regtest infrastructure.
 */

import { execFileSync } from 'child_process'
import path from 'path'
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
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'

// arkade-regtest is embedded as a git submodule at the repo root. Tests run
// with cwd = packages/e2e, so the CLI lives two directories up. Override with
// REGTEST_CLI if the submodule lives elsewhere.
const REGTEST_CLI =
  process.env.REGTEST_CLI || path.resolve(__dirname, '../../../arkade-regtest/regtest.mjs')

/** Invoke the arkade-regtest Node CLI (replaces the old chopsticks HTTP faucet). */
function regtestCli(args: string[]): void {
  execFileSync('node', [REGTEST_CLI, ...args], { stdio: 'inherit' })
}

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
 * Fund a wallet using the regtest faucet + Ark settlement.
 * 1. Send BTC to the wallet's boarding address via the arkade-regtest CLI
 *    (`--confirm` mines 1 block so the send confirms immediately)
 * 2. Settle to create VTXOs
 */
export async function fundWallet(wallet: Wallet, amountSats: number): Promise<void> {
  const boardingAddress = await wallet.getBoardingAddress()

  // Faucet no longer mines by default — pass --confirm to mine 1 block right
  // after the send so the boarding UTXO confirms (old nigiri auto-mine behavior).
  regtestCli(['faucet', boardingAddress, String(amountSats / 1e8), '--confirm'])

  // Wait for boarding UTXO to be detected
  await waitForBalance(wallet, 'boarding', amountSats, 30_000)

  // Settle to convert boarding UTXOs to VTXOs
  await wallet.settle()

  // Wait for settlement
  await waitForBalance(wallet, 'settled', amountSats * 0.9, 30_000) // ~10% fees
}

export async function mineBlock(count = 1): Promise<void> {
  regtestCli(['mine', String(count)])
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
