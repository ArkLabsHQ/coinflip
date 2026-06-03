/**
 * Lightning rails e2e: exercise the two halves of the @arkade-os/boltz-swap
 * SDK against the live arkade-regtest Boltz + LND stack.
 *
 *   - Reverse swap (LN → Ark):
 *       lib creates a Boltz reverse swap with a fresh invoice, the user's
 *       `lnd` container pays it, Boltz locks the VHTLC, the lib claims it
 *       and the VTXO lands in the player wallet.
 *   - Submarine swap (Ark → LN):
 *       user's `lnd` issues an invoice, the lib initiates a submarine
 *       swap that locks our VTXO at the Boltz address; Boltz pays the
 *       invoice from `boltz-lnd`; the lib's `waitForSwapSettlement`
 *       resolves once Boltz claims the VHTLC.
 *
 * Container topology comes from arkade-regtest:
 *   - `boltz` (REST :9001) is the Boltz API
 *   - `boltz-lnd` is Boltz's own LND
 *   - `lnd` is the "user" LND that talks to boltz-lnd over a Lightning channel
 */

import { execSync } from 'child_process'
import { cliFaucet } from './helpers'
import { hex } from '@scure/base'
import {
  Wallet,
  SingleKey,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  RestIndexerProvider,
} from '@arkade-os/sdk'
import {
  ArkadeSwaps,
  BoltzSwapProvider,
  type Network as BoltzNetwork,
  type SwapRepository,
  type BoltzSwap,
} from '@arkade-os/boltz-swap'

/**
 * In-memory SwapRepository — the default `IndexedDbSwapRepository` requires
 * a browser, which Jest's Node environment doesn't provide. We don't care
 * about persistence across test runs, just about satisfying the interface.
 */
class InMemorySwapRepository implements SwapRepository {
  readonly version = 1
  private store = new Map<string, BoltzSwap>()
  async saveSwap<T extends BoltzSwap>(swap: T): Promise<void> {
    this.store.set(swap.id, swap)
  }
  async deleteSwap(id: string): Promise<void> {
    this.store.delete(id)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAllSwaps<T extends BoltzSwap>(filter?: any): Promise<T[]> {
    let out = Array.from(this.store.values()) as T[]
    const t = filter?.type
    if (Array.isArray(t)) out = out.filter((s) => t.includes(s.type))
    else if (typeof t === 'string') out = out.filter((s) => s.type === t)
    return out
  }
  async clear(): Promise<void> {
    this.store.clear()
  }
  async [Symbol.asyncDispose](): Promise<void> { /* no-op */ }
}

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
// Boltz REST is at :9001 and WebSocket is at :9004; the SDK's BoltzSwapProvider
// derives wsUrl from apiUrl by swapping `9069` → `9004` (the nginx convention).
// Pointing apiUrl at the nginx proxy (:9069) makes both halves resolve cleanly.
const BOLTZ_API_URL = process.env.BOLTZ_API_URL || 'http://localhost:9069'

const FUND_AMOUNT_BTC = 0.005 // 500k sats — enough headroom for swaps + fees
// Submarine runs first to pre-warm the channel; it must shift enough
// outbound liquidity from boltz-lnd to lnd to cover the reverse swap.
// Keep submarine ≥ 2× reverse + fees so a fresh arkade-regtest channel
// (which opens with all outbound on the boltz-lnd side) has room to
// route the subsequent reverse swap.
const SUBMARINE_INVOICE_SATS = 150_000
const REVERSE_INVOICE_SATS = 50_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function faucet(address: string, amountBtc: number): Promise<void> {
  cliFaucet(address, amountBtc)
}

async function waitForBoarding(wallet: Wallet, minSats: number, timeoutMs = 60_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const b = await wallet.getBalance()
    if (b.boarding.total >= minSats) return
    await sleep(2000)
  }
  throw new Error('Timeout waiting for boarding balance')
}

async function waitForSettled(wallet: Wallet, minSats: number, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const b = await wallet.getBalance()
    if (b.settled >= minSats) return
    await sleep(2000)
  }
  throw new Error('Timeout waiting for settled balance')
}

/** Run `docker exec <container> lncli ...` and return the trimmed stdout. */
function lncli(container: string, args: string[]): string {
  const cmd = ['docker', 'exec', container, 'lncli', '--network=regtest', ...args].join(' ')
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

function lndAddInvoice(container: string, satoshis: number, memo: string): string {
  const json = lncli(container, ['addinvoice', '--amt', String(satoshis), '--memo', JSON.stringify(memo)])
  const payReq = JSON.parse(json).payment_request
  if (!payReq) throw new Error(`addinvoice did not return a payment_request: ${json}`)
  return payReq
}

function lndPayInvoiceAsync(container: string, invoice: string): void {
  // Fire-and-forget — the call blocks until the payment settles, which
  // can be after Boltz locks the VHTLC on our side. Spawning detached
  // lets the test loop drive the claim while LND finishes.
  const cmd = `docker exec -d ${container} lncli --network=regtest payinvoice --force ${invoice}`
  execSync(cmd, { encoding: 'utf8' })
}

let arkAvailable = false
let boltzAvailable = false
let lnReady = false

/**
 * Does `boltz-lnd` show at least one channel that's currently `active`?
 * If not, neither a reverse swap (lnd → boltz-lnd) nor a submarine swap
 * (boltz-lnd → lnd) can complete and the tests will hang waiting for
 * routing. Detecting this up-front lets us skip with a clear message
 * instead of timing out at 3 minutes a piece.
 */
function lnChannelActive(): boolean {
  try {
    const out = execSync(
      'docker exec boltz-lnd lncli --network=regtest listchannels',
      { encoding: 'utf8' },
    )
    const parsed = JSON.parse(out) as { channels?: Array<{ active: boolean }> }
    return Boolean(parsed.channels?.some((c) => c.active))
  } catch { return false }
}

beforeAll(async () => {
  try {
    const ark = await fetch(`${ARK_SERVER_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })
    arkAvailable = ark.ok
  } catch { arkAvailable = false }
  try {
    const boltz = await fetch(`${BOLTZ_API_URL}/v2/swap/submarine`, { signal: AbortSignal.timeout(5000) })
    // Even an error body counts as "Boltz is up" — we only need a TCP reply.
    boltzAvailable = boltz.ok || boltz.status >= 400
  } catch { boltzAvailable = false }
  // Verify the LND containers exist before any test tries to docker exec.
  if (boltzAvailable) {
    try {
      const out = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8' })
      if (!out.includes('boltz-lnd') || !out.includes('lnd')) boltzAvailable = false
    } catch { boltzAvailable = false }
  }
  lnReady = boltzAvailable && lnChannelActive()
  if (boltzAvailable && !lnReady) {
    console.warn(
      '[lightning.test] boltz-lnd ↔ lnd channel is not active; skipping Lightning rail tests. ' +
      'Run `clean-env.sh && start-env.sh` (or `docker exec boltz-lnd lncli connect <lnd-pubkey>@lnd:9735`) to restore.',
    )
  }
}, 15_000)

describe('Lightning rails: Boltz reverse + submarine swaps against arkade-regtest', () => {
  let identity: SingleKey
  let wallet: Wallet
  let swaps: ArkadeSwaps

  beforeAll(async () => {
    if (!arkAvailable || !boltzAvailable || !lnReady) return

    identity = SingleKey.fromRandomBytes()
    wallet = await Wallet.create({
      identity,
      arkServerUrl: ARK_SERVER_URL,
      esploraUrl: ESPLORA_URL,
      storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
      },
      settlementConfig: false,
    })

    const boardingAddr = await wallet.getBoardingAddress()
    await faucet(boardingAddr, FUND_AMOUNT_BTC)
    await waitForBoarding(wallet, FUND_AMOUNT_BTC * 1e8 * 0.9)
    await wallet.settle()
    await waitForSettled(wallet, FUND_AMOUNT_BTC * 1e8 * 0.7)

    const swapProvider = new BoltzSwapProvider({
      apiUrl: BOLTZ_API_URL,
      network: 'regtest' as BoltzNetwork,
    })
    // Use SwapManager (default): it auto-claims reverse swaps on
    // `transaction.mempool`/`confirmed` and auto-refunds submarines that
    // fail. We still bypass `waitAndClaim` / `waitForSwapCompletion`
    // because Boltz can't reach `invoice.settled` in arkade-regtest's
    // pinned image (fulmine RPC gap) — but we let SwapManager do the
    // actual claim broadcast so the test exercises the production path.
    swaps = await ArkadeSwaps.create({
      wallet,
      swapProvider,
      swapManager: true,
      swapRepository: new InMemorySwapRepository(),
    })
  }, 240_000)

  // Submarine swap runs FIRST. It does two jobs at once: validates the
  // Ark→LN half of the rails, and pre-warms the boltz-lnd ↔ lnd channel
  // by shifting outbound liquidity from boltz-lnd to lnd. A freshly-
  // bootstrapped arkade-regtest opens the channel boltz-lnd → lnd, so
  // initially lnd has no outbound; the submarine swap fixes that.
  it('submarine swap: lib pays LN invoice → user lnd receives → wallet balance down', async () => {
    if (!arkAvailable || !boltzAvailable || !lnReady) return

    // Ensure we still have enough spendable to cover the swap + fees.
    const beforeBalance = (await wallet.getBalance()).total
    if (beforeBalance < SUBMARINE_INVOICE_SATS * 1.5) {
      throw new Error(`Wallet too thin for submarine swap: ${beforeBalance} sats`)
    }

    // The user-side `lnd` mints a fresh invoice. boltz-lnd will pay it
    // via its existing channel.
    const invoice = lndAddInvoice('lnd', SUBMARINE_INVOICE_SATS, 'arkade-coinflip e2e submarine')
    expect(invoice).toMatch(/^lnbcrt/)

    // sendLightningPayment does the full flow: createSubmarineSwap →
    // lock VTXO at Boltz's VHTLC → wait for settlement → resolve with
    // the preimage.
    const result = await swaps.sendLightningPayment({ invoice })
    expect(result.preimage).toMatch(/^[0-9a-f]{64}$/i)

    // The user lnd should now show the invoice as paid. Some lncli builds
    // don't have `--reversed`/`--max_invoices`; do a basic `listinvoices`
    // and pick the most recent matching `payment_request`.
    const listed = JSON.parse(lncli('lnd', ['listinvoices']))
    const matched = (listed.invoices ?? []).find((inv: { payment_request: string; settled: boolean }) =>
      inv.payment_request === invoice,
    )
    expect(matched?.settled).toBe(true)

    // Wallet balance went down by ~ invoice amount + swap fees.
    const afterBalance = (await wallet.getBalance()).total
    const debited = beforeBalance - afterBalance
    expect(debited).toBeGreaterThanOrEqual(SUBMARINE_INVOICE_SATS)
  }, 180_000)

  it('reverse swap: pays LN invoice → VHTLC lockup → claim → wallet balance up', async () => {
    if (!arkAvailable || !boltzAvailable || !lnReady) return

    const beforeBalance = (await wallet.getBalance()).total

    // Lib creates a reverse swap. The returned object carries the BOLT11
    // invoice on `swap.response.invoice` that Boltz expects to receive
    // on its `boltz-lnd` node. Pre-warmed by the submarine swap above —
    // `lnd` now has outbound liquidity to route this payment.
    const swap = await swaps.createReverseSwap({
      amount: REVERSE_INVOICE_SATS,
      description: 'arkade-coinflip e2e reverse swap',
    })
    const invoice = swap.response.invoice
    const lockupAddress = swap.response.lockupAddress
    expect(invoice).toMatch(/^lnbcrt/) // regtest BOLT11 prefix
    expect(typeof swap.id).toBe('string')
    expect(typeof lockupAddress).toBe('string')

    // Register the swap with the SwapManager so it auto-claims when the
    // VHTLC lockup confirms. `createReverseSwap` already added it via the
    // ArkadeSwaps path, but be defensive: addSwap is idempotent on swap id.
    if (swaps.swapManager) await swaps.swapManager.addSwap(swap)

    // Observe SwapManager's auto-claim — `onActionExecuted` fires the
    // moment SwapManager calls our claim callback (which under the hood
    // is `swaps.claimVHTLC`). That's the production-grade signal: claim
    // broadcast. We don't wait for `invoice.settled` (the SDK's
    // `waitForSwapCompletion` does) because Boltz can't reach that
    // status in arkade-regtest's pinned image — it queries
    // `fulmine.v1.Service/GetVHTLCSpendingTx`, which the pinned fulmine
    // binary doesn't implement. Once the SwapManager has fired the
    // claim, the on-chain effect is independent of further Boltz state.
    let claimedSwapId: string | undefined
    if (swaps.swapManager) {
      await swaps.swapManager.onActionExecuted((s, action) => {
        if (action === 'claim' && s.id === swap.id) claimedSwapId = s.id
      })
    }

    // Pay the invoice from the user-side `lnd` (NOT boltz-lnd). Fire-and-
    // forget — payinvoice blocks until the HTLC settles on LN.
    lndPayInvoiceAsync('lnd', invoice)

    // Wait for SwapManager's auto-claim to fire (it polls/listens for the
    // VHTLC lockup itself, so we don't have to). If WS is flaky in CI,
    // SwapManager's polling fallback (~30s cadence) still gets there.
    const claimWaitStart = Date.now()
    while (Date.now() - claimWaitStart < 90_000) {
      if (claimedSwapId === swap.id) break
      await sleep(1000)
    }
    expect(claimedSwapId).toBe(swap.id)

    const indexer = new RestIndexerProvider(ARK_SERVER_URL)
    void lockupAddress // keep for potential diagnostics; SwapManager already handled the lockup-side wait

    // The claim creates a VTXO at the wallet's primary Ark address. The
    // wallet's internal ContractWatcher should pick it up eventually, but
    // in CI the polling interval can be slower than the test deadline.
    // Hit the indexer directly for the wallet's pkScript — that's the
    // authoritative answer for "did the claim land on-Ark".
    const walletAddrHex = hex.encode(
      (await import('@arkade-os/sdk')).ArkAddress.decode(await wallet.getAddress()).pkScript,
    )
    // Filter to VTXOs in a tight band around REVERSE_INVOICE_SATS so we
    // don't match the wallet's existing change VTXOs (which can be many
    // hundreds of k sats).
    const minClaim = REVERSE_INVOICE_SATS * 0.8
    const maxClaim = REVERSE_INVOICE_SATS
    const claimStart = Date.now()
    let claimLanded = false
    let claimedVtxoValue = 0
    while (Date.now() - claimStart < 90_000) {
      const res = await indexer.getVtxos({ scripts: [walletAddrHex] })
      const fresh = res.vtxos.find((v) => v.value >= minClaim && v.value <= maxClaim)
      if (fresh) {
        claimLanded = true
        claimedVtxoValue = fresh.value
        break
      }
      await sleep(2000)
    }
    expect(claimLanded).toBe(true)
    expect(claimedVtxoValue).toBeGreaterThan(REVERSE_INVOICE_SATS * 0.8)
    expect(claimedVtxoValue).toBeLessThanOrEqual(REVERSE_INVOICE_SATS)
  }, 180_000)
})
