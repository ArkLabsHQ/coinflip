import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'vuex'
import type { Wallet } from '@arkade-os/sdk'
import {
  createBankrollVaultObserver, parseBankrollDescriptor,
  type BankrollPoolDescriptor, type BankrollPoolDisplay,
} from '@/services/bankrollVaultObserver'
import { useBankrollPool } from './useBankrollPool'

const runtime = vi.hoisted(() => ({ getWallet: vi.fn() }))
vi.mock('@/store/modules/ark/walletRuntime', () => ({ getSDKWallet: runtime.getWallet }))
vi.mock('@/services/bankrollVaultObserver', () => ({
  createBankrollVaultObserver: vi.fn(),
  normalizePoolOperatorUrl: (url: string) => url.replace(/\/$/, ''),
  parseBankrollDescriptor: vi.fn((text: string) => JSON.parse(text)),
  emptyBankrollDisplay: (status: string, descriptor?: unknown, error?: string) => ({
    status, ...(descriptor ? { descriptor } : {}), navSats: null, supply: null, memberShares: null,
    availableShares: null, estimatedClaimSats: null, verifiedAt: null, error: error ?? null,
    canDeposit: false, canRedeem: false,
  }),
}))

const factory = vi.mocked(createBankrollVaultObserver)
const parser = vi.mocked(parseBankrollDescriptor)
const pool = useBankrollPool()
const walletA = { testWallet: 'a' } as unknown as Wallet
const walletB = { testWallet: 'b' } as unknown as Wallet
const stops: Array<() => void> = []
const descriptor: BankrollPoolDescriptor = {
  version: 1, name: 'Observed pool', network: 'regtest', operatorUrl: 'http://localhost:7070',
  controlAssetId: '01'.repeat(32) + '0000', shareAssetId: '01'.repeat(32) + '0100',
  bootstrapTxid: '02'.repeat(32), checkpointPsbts: ['first', 'second'],
}
const json = (value = descriptor) => JSON.stringify(value)
function ready(value = descriptor): BankrollPoolDisplay {
  return {
    status: 'ready', descriptor: value, navSats: '100000', supply: '100000000', memberShares: '1000',
    availableShares: '1000', estimatedClaimSats: '1', verifiedAt: 123, error: null,
    canDeposit: false, canRedeem: false,
  }
}
function observer() { return { refresh: vi.fn(async () => {}), dispose: vi.fn(async () => {}) } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function tick() { for (let i = 0; i < 6; i++) await Promise.resolve() }
function start() {
  const store = createStore({ state: {
    wallet: { publicKey: 'aa'.repeat(32) },
    ark: { status: 'connected', server: 'http://localhost:7070/', info: { network: 'regtest' } },
  } })
  stops.push(pool.start(store))
  return store
}
function saved() { return Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!)) }

beforeEach(() => {
  localStorage.clear()
  runtime.getWallet.mockReturnValue(walletA)
  factory.mockReset()
  parser.mockReset().mockImplementation(text => JSON.parse(text))
  factory.mockImplementation(async options => {
    options.onState(ready(options.descriptor))
    return observer()
  })
})
afterEach(async () => { while (stops.length) stops.pop()!(); await tick() })

describe('shared read-only pool lifecycle', () => {
  it('persists only a descriptor after bootstrap verification resolves', async () => {
    start()
    const verification = deferred<ReturnType<typeof observer>>()
    factory.mockReturnValueOnce(verification.promise)
    const importing = pool.importDescriptor(json())
    await tick()
    expect(pool.state.value.status).toBe('validating')
    expect(pool.state.value.navSats).toBeNull()
    expect(localStorage.length).toBe(0)
    const options = factory.mock.calls[0][0]
    options.onState(ready())
    verification.resolve(observer())
    await importing
    expect(saved()).toEqual([json()])
    expect(saved()[0]).not.toContain('navSats')
    expect(options.wallet).toBe(walletA)
    expect(parser).toHaveBeenCalledWith(json(), expect.objectContaining({ network: 'regtest', operatorUrl: 'http://localhost:7070' }))
    expect(pool.state.value.canDeposit).toBe(false)
    expect(pool.state.value.canRedeem).toBe(false)
  })

  it('does not fetch or persist malformed or mismatched descriptors', async () => {
    start()
    await expect(pool.importDescriptor('{broken')).rejects.toThrow()
    parser.mockImplementationOnce(() => { throw new Error('Pool operator does not match wallet') })
    await expect(pool.importDescriptor(json())).rejects.toThrow('does not match')
    expect(factory).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(pool.state.value.status).toBe('error')
    expect(pool.state.value.memberShares).toBeNull()
    await pool.refresh().catch(() => {})
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('does not persist a descriptor whose bootstrap proof fails', async () => {
    start()
    factory.mockRejectedValueOnce(new Error('Invalid bootstrap proof'))
    await expect(pool.importDescriptor(json())).rejects.toThrow('bootstrap')
    expect(localStorage.length).toBe(0)
    expect(pool.state.value.status).toBe('error')
    expect(pool.state.value.estimatedClaimSats).toBeNull()
  })

  it('clears immediately on wallet changes and ignores stale verification errors and events', async () => {
    const store = start()
    const old = deferred<ReturnType<typeof observer>>()
    factory.mockReturnValueOnce(old.promise)
    const importing = pool.importDescriptor(json())
    await tick()
    const options = factory.mock.calls[0][0]
    runtime.getWallet.mockReturnValue(walletB)
    store.state.wallet.publicKey = 'bb'.repeat(32)
    expect(pool.state.value.status).toBe('unconfigured')
    expect(pool.state.value.navSats).toBeNull()
    expect(options.isCurrent()).toBe(false)
    options.onState(ready())
    old.reject(new Error('Old wallet failed'))
    await importing
    expect(pool.state.value.status).toBe('unconfigured')
    expect(pool.state.value.error).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('disposes late observers and preserves only the latest verified import', async () => {
    start()
    const late = deferred<ReturnType<typeof observer>>()
    const oldObserver = observer()
    factory.mockReturnValueOnce(late.promise)
    const first = pool.importDescriptor(json())
    await tick()
    const oldOptions = factory.mock.calls[0][0]
    const latest = { ...descriptor, name: 'Latest pool', bootstrapTxid: '03'.repeat(32) }
    await pool.importDescriptor(json(latest))
    oldOptions.onState(ready())
    late.resolve(oldObserver)
    await first
    expect(oldObserver.dispose).toHaveBeenCalledTimes(1)
    expect(pool.state.value.descriptor?.name).toBe('Latest pool')
    expect(saved()).toEqual([json(latest)])
  })

  it('scopes saved descriptors by wallet, network, and canonical operator and revalidates restores', async () => {
    const store = start()
    await pool.importDescriptor(json())
    runtime.getWallet.mockReturnValue(walletB)
    store.state.wallet.publicKey = 'bb'.repeat(32)
    expect(pool.state.value.status).toBe('unconfigured')
    expect(pool.descriptorText.value).toBe('')
    runtime.getWallet.mockReturnValue(walletA)
    store.state.wallet.publicKey = 'aa'.repeat(32)
    await tick()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(pool.state.value.status).toBe('ready')
    store.state.ark.server = 'http://another-operator:7070'
    expect(pool.state.value.status).toBe('unconfigured')
    store.state.ark.info.network = 'mutinynet'
    expect(pool.state.value.navSats).toBeNull()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(localStorage.length).toBe(1)
  })

  it('forget removes only the active context and cannot be undone by late results', async () => {
    const store = start()
    await pool.importDescriptor(json())
    runtime.getWallet.mockReturnValue(walletB)
    store.state.wallet.publicKey = 'bb'.repeat(32)
    await pool.importDescriptor(json({ ...descriptor, name: 'Second wallet' }))
    expect(localStorage.length).toBe(2)
    const late = deferred<ReturnType<typeof observer>>()
    factory.mockReturnValueOnce(late.promise)
    const importing = pool.importDescriptor(json())
    await tick()
    pool.forget()
    const lateObserver = observer()
    late.resolve(lateObserver)
    await importing
    expect(lateObserver.dispose).toHaveBeenCalledOnce()
    expect(saved()).toEqual([json()])
    expect(pool.state.value.status).toBe('unconfigured')
    expect(pool.state.value.memberShares).toBeNull()
  })

  it('shares one lifecycle until the final cleanup and ignores later events', async () => {
    const store = start()
    const secondStop = pool.start(store)
    const active = observer()
    factory.mockResolvedValueOnce(active)
    await pool.importDescriptor(json())
    const options = factory.mock.calls[0][0]
    stops.pop()!()
    expect(active.dispose).not.toHaveBeenCalled()
    secondStop()
    secondStop()
    expect(pool.state.value.status).toBe('disconnected')
    await tick()
    expect(active.dispose).toHaveBeenCalledOnce()
    options.onState(ready())
    expect(pool.state.value.navSats).toBeNull()
  })

  it('does not let a previous refresh error replace the new disconnected state', async () => {
    const store = start()
    const active = observer(), reading = deferred<void>()
    active.refresh.mockReturnValueOnce(reading.promise)
    factory.mockResolvedValueOnce(active)
    await pool.importDescriptor(json())
    const refreshing = pool.refresh()
    store.state.ark.status = 'disconnected'
    expect(pool.state.value.status).toBe('disconnected')
    reading.reject(new Error('Stale connection error'))
    await refreshing
    expect(pool.state.value.error).toBeNull()
    expect(pool.state.value.navSats).toBeNull()
  })

  it('clears stale balances when a current refresh unexpectedly fails', async () => {
    start()
    const active = observer()
    factory.mockImplementationOnce(async options => { options.onState(ready()); return active })
    await pool.importDescriptor(json())
    expect(pool.state.value.navSats).toBe('100000')
    active.refresh.mockRejectedValueOnce(new Error('Indexer unavailable'))
    await expect(pool.refresh()).rejects.toThrow('Indexer unavailable')
    expect(pool.state.value.status).toBe('error')
    expect(pool.state.value.navSats).toBeNull()
    expect(pool.state.value.memberShares).toBeNull()
  })

  it('still releases the observer and clears values when saved-descriptor deletion fails', async () => {
    start()
    const active = observer()
    factory.mockResolvedValueOnce(active)
    await pool.importDescriptor(json())
    const removal = vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new Error('Storage unavailable') })
    pool.forget()
    expect(pool.state.value.navSats).toBeNull()
    await tick()
    expect(active.dispose).toHaveBeenCalledOnce()
    expect(pool.state.value.status).toBe('error')
    expect(pool.state.value.navSats).toBeNull()
    expect(pool.state.value.error).toContain('Could not remove')
    removal.mockRestore()
  })

  it('waits for an active observer to release its watch before creating its replacement', async () => {
    start()
    const active = observer(), released = deferred<void>()
    active.dispose.mockReturnValueOnce(released.promise)
    factory.mockResolvedValueOnce(active)
    await pool.importDescriptor(json())
    const replacement = pool.importDescriptor(json({ ...descriptor, name: 'Replacement' }))
    expect(pool.state.value.status).toBe('validating')
    expect(pool.state.value.navSats).toBeNull()
    await tick()
    expect(active.dispose).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledTimes(1)
    released.resolve()
    await replacement
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('disposes a verified observer if descriptor persistence fails and ignores its later events', async () => {
    start()
    const active = observer()
    factory.mockResolvedValueOnce(active)
    const writing = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('Storage unavailable') })
    await expect(pool.importDescriptor(json())).rejects.toThrow('Storage unavailable')
    await tick()
    expect(active.dispose).toHaveBeenCalledOnce()
    expect(pool.state.value.status).toBe('error')
    factory.mock.calls[0][0].onState(ready())
    expect(pool.state.value.navSats).toBeNull()
    expect(localStorage.length).toBe(0)
    writing.mockRestore()
  })
})
