import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hex } from '@scure/base'
import { ArkAddress, RestIndexerProvider, SingleKey, getAllNormalizedVtxos, isVtxoSpent, type Wallet } from '@arkade-os/sdk'
import { createSwapClient, InMemoryAssetSwapRepository, type Outcome, type Swap, type SwapClient } from '@arkade-os/swap'
import { createNostrTransportFactory, discoveryIndex } from '@arkade-os/swap/advanced'
import { closeSharedNostrPool } from '@arkade-os/swap/nostr'
import { createTestWallet, fundWallet, sleep } from './helpers'

const docker = promisify(execFile)
const prefix = process.env.REGTEST_CONTAINER_PREFIX || ''
const relayPort = process.env.STRFRY_PORT || '7777'
const relay = `wss://localhost:${relayPort}`
const operatorUrl = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const solverPort = process.env.INTENT_SOLVER_PORT || '8787'
const sendSats = 150_000n
const receiveSats = 50_000n

type SolverCard = {
  discovery_pubkey: string
  sig: string
  markets: unknown[]
  transports: { nostr: { relays: string[] } }
}

describe('Lightning swaps through the authenticated intent-solver relay', () => {
  let wallet: Wallet | undefined
  let client: SwapClient | undefined
  const repository = new InMemoryAssetSwapRepository()

  afterAll(async () => {
    try { await client?.[Symbol.asyncDispose]() } finally {
      closeSharedNostrPool()
      await wallet?.dispose()
    }
  })

  it('pays an invoice, restores the paid record, and claims an incoming payment', async () => {
    const health = await fetch(`http://127.0.0.1:${solverPort}/api/healthz`, { signal: AbortSignal.timeout(10_000) })
    expect(health.ok).toBe(true)
    expect((await health.json() as { mode: string }).mode).toBe('relay')
    const channels = await lncli<{ channels: { active: boolean }[] }>(['listchannels'])
    expect(channels.channels.some(channel => channel.active)).toBe(true)
    const card = await liveCard()
    const nostr = createNostrTransportFactory()
    const transportFor: Parameters<typeof createSwapClient>[0]['transportFor'] = rendezvous => {
      if (rendezvous.solverPubkey !== card.discovery_pubkey || !rendezvous.relays.length ||
        rendezvous.relays.some(url => new URL(url).href !== new URL(relay).href)) {
        throw new Error('Unexpected regtest solver rendezvous')
      }
      // Only the local test relay lacks TLS; Nostr author/decryption checks remain intact.
      return nostr({ ...rendezvous, relays: [`ws://localhost:${relayPort}`] })
    }

    wallet = await createTestWallet(SingleKey.fromRandomBytes(), { concurrentSpending: true })
    expect((await wallet.getArkadeInfo()).network).toBe('regtest')
    const discovery = {
      transportCards: null,
      localCards: [{ card, network: 'regtest' as const }], network: 'regtest' as const,
    }
    const pinned = await discoveryIndex({ network: 'regtest', config: discovery }).peek()
    expect(pinned.markets.length).toBeGreaterThan(0)
    const config = {
      wallet, repository, transportFor,
      discovery: { ...discovery, snapshot: pinned.markets },
    }
    client = createSwapClient(config)
    await client.ready
    expect((await client.markets()).length).toBeGreaterThan(0)
    await fundWallet(wallet, 500_000)
    const indexer = new RestIndexerProvider(operatorUrl)
    const script = hex.encode(ArkAddress.decode(await wallet.getAddress()).pkScript)
    const initial = await waitForBalance(indexer, script, balance => balance >= 450_000n)

    const invoice = await lncli<{ payment_request: string }>(['addinvoice', '--amt', String(sendSats), '--memo', 'coinflip swap send'])
    expect(invoice.payment_request).toMatch(/^lnbcrt/)
    const payment = await client.pay(invoice.payment_request)
    expect(payment.kind).toBe('swap')
    if (payment.kind !== 'swap') throw new Error('Lightning invoice did not produce a swap')
    const paid = await outcome(client, payment.swap.id, 'paid')
    expect(paid.fundingTxid).toMatch(/^[0-9a-f]{64}$/)
    const invoices = await lncli<{ invoices: { payment_request: string; settled: boolean; amt_paid_sat: string }[] }>(['listinvoices'])
    const received = invoices.invoices.find(item => item.payment_request === invoice.payment_request)
    expect(received?.settled).toBe(true)
    expect(BigInt(received!.amt_paid_sat)).toBe(sendSats)
    const afterSend = await waitForBalance(indexer, script, balance => initial - balance >= sendSats)
    expect(initial - afterSend).toBe(paid.give.amount)

    await client[Symbol.asyncDispose]()
    client = createSwapClient(config)
    await client.ready
    expect((await client.swaps()).find(swap => swap.id === paid.id)?.outcome).toBe('paid')

    const incoming = await client.receive({ via: 'lightning', amount: receiveSats })
    expect(incoming.artifact.bolt11).toMatch(/^lnbcrt/)
    expect(incoming.take.amount).toBe(receiveSats)
    const claimedPromise = outcome(client, incoming.id, 'claimed')
    const payPromise = runLncli(['payinvoice', '--force', incoming.artifact.bolt11])
    const [claimed] = await Promise.all([claimedPromise, payPromise])
    expect(claimed.lock?.hash).toMatch(/^[0-9a-f]{64}$/)
    const payments = await lncli<{ payments: { payment_request: string; status: string }[] }>(['listpayments'])
    expect(payments.payments.find(item => item.payment_request === incoming.artifact.bolt11)?.status).toBe('SUCCEEDED')
    const afterReceive = await waitForBalance(indexer, script, balance => balance - afterSend >= receiveSats)
    expect(afterReceive - afterSend).toBe(receiveSats)
  }, 600_000)
})

async function lncli<T>(args: string[]): Promise<T> {
  return JSON.parse(await runLncli(args)) as T
}

async function runLncli(args: string[]): Promise<string> {
  const { stdout } = await docker('docker', ['exec', `${prefix}lnd-peer`, 'lncli', '--network=regtest', ...args], {
    encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

async function liveCard(): Promise<SolverCard> {
  const { stdout } = await docker('docker', [
    'exec', '-e', `RELAY_URL=${relay}`, `${prefix}intent-solver`,
    'node', '--enable-source-maps', '--experimental-eventsource', 'packages/solver-app/dist/cli.js', 'card', 'regtest',
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })
  const card = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)) as SolverCard
  expect(card.discovery_pubkey).toMatch(/^[0-9a-f]{64}$/)
  expect(card.sig).toMatch(/^[0-9a-f]{128}$/)
  expect(card.markets.length).toBeGreaterThan(0)
  expect(card.transports.nostr.relays.map(url => new URL(url).href)).toEqual([new URL(relay).href])
  return card
}

function outcome(client: SwapClient, id: Swap['id'], expected: Outcome): Promise<Swap> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined
    let finished = false
    const finish = (swap?: Swap, error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      unsubscribe?.()
      if (error) reject(error)
      else resolve(swap!)
    }
    const timer = setTimeout(() => finish(undefined, new Error(`Swap ${id} did not become ${expected}`)), 180_000)
    try {
      unsubscribe = client.onUpdate(update => {
        if (update.swap.id !== id) return
        if (update.outcome === expected) finish(update.swap)
        else if (['failed', 'refunded', 'lapsed', 'cancelled', 'needs_recovery'].includes(update.outcome)) {
          finish(undefined, new Error(`Swap ${id}: ${update.outcome}: ${update.swap.failure || update.swap.blockedReason || ''}`))
        }
      })
      if (finished) unsubscribe()
    } catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))) }
  })
}

async function waitForBalance(indexer: RestIndexerProvider, script: string, matches: (balance: bigint) => boolean): Promise<bigint> {
  const deadline = Date.now() + 45_000
  let balance = 0n
  do {
    const coins = await getAllNormalizedVtxos(indexer, [script])
    balance = coins.filter(coin => !isVtxoSpent(coin) && !coin.isUnrolled && !coin.isSwept)
      .reduce((sum, coin) => sum + BigInt(coin.value), 0n)
    if (matches(balance)) return balance
    await sleep(500)
  } while (Date.now() < deadline)
  throw new Error(`Indexed balance did not reach the expected value (last ${balance} sats)`)
}
