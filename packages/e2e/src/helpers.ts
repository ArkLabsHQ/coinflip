/**
 * E2E test helpers for interacting with regtest infrastructure.
 */

import { execSync } from 'child_process'
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
 * settle() can throw a transient "No inputs found" when arkd hasn't yet indexed
 * a just-fauceted boarding UTXO — the balance probe sees it before settle's
 * input gathering does. Retry ONLY that signal; rethrow anything else
 * immediately so real failures aren't masked.
 */
export async function settleWithRetry(wallet: Wallet, tries = 3): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await wallet.settle()
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('No inputs found') || i === tries - 1) throw e
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

/**
 * Fund a wallet using the nigiri faucet + Ark settlement.
 * 1. Send BTC to the wallet's boarding address via faucet
 * 2. Mine blocks
 * 3. Settle to create VTXOs
 */
export async function fundWallet(wallet: Wallet, amountSats: number): Promise<void> {
  const boardingAddress = await wallet.getBoardingAddress()

  // denigiri arkade-regtest has no HTTP faucet (the old nigiri esplora /faucet
  // is gone) — funding is bitcoin-cli sendtoaddress via the orchestrator CLI.
  // `--confirm` mines a block so the boarding UTXO confirms immediately.
  regtestCli(['faucet', boardingAddress, String(amountSats / 1e8), '--confirm'])

  // Wait for boarding UTXO to be detected
  await waitForBalance(wallet, 'boarding', amountSats, 30_000)

  // Settle to convert boarding UTXOs to VTXOs
  await settleWithRetry(wallet)

  // Wait for settlement
  await waitForBalance(wallet, 'settled', amountSats * 0.9, 30_000) // ~10% fees
}

export async function mineBlock(count = 1): Promise<void> {
  regtestCli(['mine', String(count)])
}

/**
 * Fast-forward the regtest chain's block time so an absolute (time-based) CLTV
 * timelock matures without a real wall-clock wait. Sets bitcoind's mocktime to
 * `toUnixSeconds`, then mines `blocks` (>= 12) so the median-time-past (median of
 * the last 11 block timestamps) — the value consensus uses to evaluate CLTV —
 * advances past the target.
 *
 * Shells `docker exec bitcoin bitcoin-cli` directly (the same container + RPC
 * creds the orchestrator's chain helpers use) rather than the regtest.mjs CLI,
 * because the orchestrator is a pinned submodule we don't extend. Override the
 * container name with REGTEST_BTC_CONTAINER if the stack renames it.
 *
 * NOTE: mocktime freezes the node clock; after using this, restart the regtest
 * stack before relying on real-time behaviour again.
 */
export async function setChainTime(toUnixSeconds: number, blocks = 12): Promise<void> {
  const container = process.env.REGTEST_BTC_CONTAINER || 'bitcoin'
  const cli = `docker exec ${container} bitcoin-cli -regtest -rpcuser=admin1 -rpcpassword=123`
  execSync(`${cli} setmocktime ${Math.floor(toUnixSeconds)}`, { stdio: ['ignore', 'pipe', 'pipe'] })
  await mineBlock(blocks)
}

/** Re-enable real chain time after setChainTime (mocktime → 0). Best-effort;
 *  the median-time-past self-heals as the wall clock catches the mocked future. */
export function resetChainTime(): void {
  const container = process.env.REGTEST_BTC_CONTAINER || 'bitcoin'
  const cli = `docker exec ${container} bitcoin-cli -regtest -rpcuser=admin1 -rpcpassword=123`
  try { execSync(`${cli} setmocktime 0`, { stdio: ['ignore', 'pipe', 'pipe'] }) } catch { /* best effort */ }
}

/**
 * Fund a (boarding) address with `amountBtc` and confirm it in a block.
 * Shared by every live e2e test — replaces the per-file `fetch(ESPLORA/faucet)`
 * copies that targeted the old nigiri HTTP faucet (gone on the denigiri stack).
 * Returns the orchestrator's stdout (informational; callers that logged a txid
 * still get a non-undefined string).
 */
export async function faucet(address: string, amountBtc: number): Promise<string> {
  return regtestCli(['faucet', address, String(amountBtc), '--confirm'])
}

/**
 * Shell the arkade-regtest Node orchestrator (the denigiri stack's control
 * plane) for faucet/mine. Resolves the script relative to the jest working
 * dir (packages/e2e → repo root is two up); override the whole command with
 * REGTEST_CLI if the layout differs. Synchronous because funding/mining must
 * complete before the test proceeds, and these are short bitcoin-cli calls.
 * Returns trimmed stdout.
 */
function regtestCli(args: string[]): string {
  const joined = args.map((a) => JSON.stringify(a)).join(' ')
  const cmd = process.env.REGTEST_CLI
    ? `${process.env.REGTEST_CLI} ${joined}`
    : `node ${JSON.stringify(path.resolve(process.cwd(), '../../arkade-regtest/regtest.mjs'))} ${joined}`
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
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
