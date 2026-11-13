import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'vuex'
import type { Wallet } from '@arkade-os/sdk'
import type { FundedPoolDisplay, FundedPoolInputRenewalQuote, FundedPoolQuote } from '@/services/fundedPoolTypes'
import { createFundedPoolRuntime, emptyFundedPoolDisplay } from '@/services/fundedPoolRuntime'
import { useFundedPool } from './useFundedPool'

const walletAccess = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/store/modules/ark/walletRuntime', () => ({ getSDKWallet: walletAccess.get }))
vi.mock('@/services/fundedPoolRuntime', () => ({
  createFundedPoolRuntime: vi.fn(),
  emptyFundedPoolDisplay: (status: string) => ({ status, navSats: null, pending: null, receipts: [],
    capabilities: { subscribe: false, redeem: false, bet: false, recover: false } }),
}))
const factory = vi.mocked(createFundedPoolRuntime)
const pool = useFundedPool()
const walletA = {} as Wallet, walletB = {} as Wallet
const stops: Array<() => void> = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { resolve, promise }
}
function runtime() {
  return { refresh: vi.fn(async () => {}), recover: vi.fn(async () => {}), rescue: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    prepareSubscribe: vi.fn(async () => ({ id: 'reviewed' } as FundedPoolQuote)),
    prepareRedeem: vi.fn(async () => ({ id: 'redeem' } as FundedPoolQuote)),
    prepareBet: vi.fn(async () => ({ id: 'bet' } as FundedPoolQuote)), confirm: vi.fn(async () => {}),
    prepareRenewInputs: vi.fn(async () => ({ id: 'renew' } as FundedPoolInputRenewalQuote)), confirmRenewInputs: vi.fn(async () => {}) }
}
function start() {
  const store = createStore({ state: { wallet: { publicKey: 'aa'.repeat(32) },
    ark: { status: 'connected', server: 'http://localhost:37770', info: { network: 'regtest' } } } })
  stops.push(pool.start(store))
  return store
}
async function tick() { for (let i = 0; i < 8; i++) await Promise.resolve() }
beforeEach(() => {
  walletAccess.get.mockReturnValue(walletA)
  factory.mockReset().mockImplementation(() => runtime())
})
afterEach(async () => { while (stops.length) stops.pop()!(); await tick() })

describe('funded pool wallet lifecycle', () => {
  it('shares a runtime between consumers and disposes only after the final user stops', async () => {
    const store = start(), second = pool.start(store)
    await tick()
    const created = factory.mock.results[0].value
    expect(factory).toHaveBeenCalledOnce()
    stops.pop()!()
    expect(created.dispose).not.toHaveBeenCalled()
    second()
    expect(created.dispose).toHaveBeenCalledOnce()
    expect(pool.state.value.status).toBe('disconnected')
  })

  it('clears funds synchronously on disconnect and refuses late old-wallet updates', async () => {
    const store = start()
    await tick()
    const old = factory.mock.calls[0][0]
    old.onState({ ...emptyFundedPoolDisplay('ready'), navSats: '50000' } as FundedPoolDisplay)
    expect(pool.state.value.navSats).toBe('50000')
    store.state.ark.status = 'disconnected'
    expect(pool.state.value.navSats).toBeNull()
    expect(old.isCurrent()).toBe(false)
    old.onRenewalState?.({ status: 'recovery', error: 'old wallet', intentId: 'old' })
    expect(pool.renewalState.value.status).toBe('idle')
    old.onState({ ...emptyFundedPoolDisplay('ready'), navSats: '99999' } as FundedPoolDisplay)
    expect(pool.state.value.navSats).toBeNull()
  })

  it('waits for prior cleanup and rejects a replaced wallet reference even with the same public key', async () => {
    const closing = deferred<void>(), first = runtime()
    first.dispose.mockReturnValue(closing.promise)
    factory.mockReturnValueOnce(first)
    const store = start()
    await tick()
    walletAccess.get.mockReturnValue(walletB)
    await Promise.resolve()
    const refreshing = pool.refresh()
    await tick()
    expect(factory.mock.calls[0][0].isCurrent()).toBe(false)
    expect(pool.state.value.navSats).toBeNull()
    const second = factory.mock.results[1].value
    expect(second.refresh).not.toHaveBeenCalled()
    closing.resolve()
    await refreshing
    expect(second.refresh).toHaveBeenCalled()
    expect(factory.mock.calls[1][0].wallet).toBe(walletB)
    expect(store.state.wallet.publicKey).toBe('aa'.repeat(32))
  })

  it('uses explicit recovery for signing authorization and forwards the original quote unchanged', async () => {
    start()
    await tick()
    const created = factory.mock.results[0].value
    const quote = await pool.prepareSubscribe(1234n)
    await pool.confirm(quote)
    expect(created.prepareSubscribe).toHaveBeenCalledWith(1234n)
    expect(created.confirm).toHaveBeenCalledWith(quote)
    await pool.refresh()
    expect(created.recover).not.toHaveBeenCalled()
    await pool.recover()
    expect(created.recover).toHaveBeenCalledOnce()
    const renewal = await pool.prepareRenewInputs()
    await pool.confirmRenewInputs(renewal)
    expect(created.confirmRenewInputs).toHaveBeenCalledWith(renewal)
  })

  it('keeps an in-flight operation alive when another consumer stops', async () => {
    const confirming = deferred<void>(), created = runtime()
    created.confirm.mockReturnValue(confirming.promise)
    factory.mockReturnValueOnce(created)
    const store = start(), second = pool.start(store)
    await tick()
    const quote = await pool.prepareSubscribe(1000n)
    const done = pool.confirm(quote)
    second()
    expect(created.dispose).not.toHaveBeenCalled()
    confirming.resolve()
    await done
    expect(created.confirm).toHaveBeenCalledOnce()
  })
})
