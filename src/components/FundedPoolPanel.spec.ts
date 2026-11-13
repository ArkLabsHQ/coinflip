import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef, type ShallowRef } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createStore } from 'vuex'
import FundedPoolPanel from './FundedPoolPanel.vue'
import type { FundedPoolDisplay, FundedPoolInputRenewalDisplay, FundedPoolInputRenewalQuote, FundedPoolQuote } from '@/services/fundedPoolTypes'

let state: ShallowRef<FundedPoolDisplay>
let renewalState: ShallowRef<FundedPoolInputRenewalDisplay>
const calls = vi.hoisted(() => ({ refresh: vi.fn(), recover: vi.fn(), rescue: vi.fn(), prepareSubscribe: vi.fn(), prepareRedeem: vi.fn(), prepareBet: vi.fn(), confirm: vi.fn(), prepareRenewInputs: vi.fn(), confirmRenewInputs: vi.fn() }))
vi.mock('@/composables/useFundedPool', () => ({ useFundedPool: () => ({ state, renewalState, ...calls }) }))
const head = { txid: '11'.repeat(32), vout: 0 }
function display(patch: Partial<FundedPoolDisplay> = {}): FundedPoolDisplay {
  return { status: 'ready', fairnessTrust: 'operator', descriptor: null, name: 'Community pool', network: 'regtest', operatorFeeBps: 2000,
    minHouseEdgeBps: 100, maxStakeBps: 1000, verified: true, head, phase: 'idle', navSats: '100000',
    supply: '100000000000', memberShares: '0', availableShares: '0', estimatedClaimSats: '0',
    accruedFeesSats: '0', carriedLossSats: '0', pending: null, recovery: null, receipts: [],
    capabilities: { subscribe: true, redeem: false, bet: true, recover: false }, verifiedAt: Date.now(), error: null, ...patch }
}
function quote(patch: Partial<FundedPoolQuote> = {}): FundedPoolQuote {
  return { id: 'quote-1', kind: 'subscribe', head, expiresAt: Date.now() + 60_000, amountSats: '25000',
    feeSats: '0', mintedShares: '25000000000', burnShares: '0', minShares: '25000000000', minSats: '0',
    payoutSats: '0', equitySats: '25000', ownershipBps: '2000', playerStakeSats: '0', houseStakeSats: '0',
    expectedPayoutSats: '0', oddsN: null, oddsLo: null, oddsTarget: null, ...patch }
}
const cleanups = new Set<() => void>()
const dialogMethods = ['showModal', 'close'] as const
const originals = dialogMethods.map(name => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name))
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } })
})
afterAll(() => dialogMethods.forEach((name, index) => { const original = originals[index]; if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, name) }))
beforeEach(() => {
  vi.resetAllMocks()
  state = shallowRef(display())
  renewalState = shallowRef({ status: 'idle', error: null, intentId: null })
  calls.refresh.mockResolvedValue(undefined)
  calls.recover.mockResolvedValue(undefined)
  calls.prepareSubscribe.mockResolvedValue(quote())
  calls.prepareRedeem.mockResolvedValue(quote({ kind: 'redeem', burnShares: '12500000000', payoutSats: '13300', minSats: '13300' }))
  calls.prepareBet.mockResolvedValue(quote({ kind: 'openGame', playerStakeSats: '1000', houseStakeSats: '970', expectedPayoutSats: '1970', oddsN: 100, oddsLo: 0, oddsTarget: 50 }))
  calls.confirm.mockResolvedValue(undefined)
  calls.confirmRenewInputs.mockResolvedValue(undefined)
})
afterEach(() => { cleanups.forEach(cleanup => cleanup()); cleanups.clear() })

async function mount(initialized = true) {
  const store = createStore({ state: () => ({ wallet: { isInitialized: initialized, publicKey: '22'.repeat(32) } }) })
  const router = createRouter({ history: createMemoryHistory(), routes: ['/bankroll', '/setup'].map(path => ({ path, component: { render: () => h('div') } })) })
  await router.push('/bankroll')
  const host = document.createElement('div'); document.body.appendChild(host)
  const open = vi.fn()
  const app = createApp(FundedPoolPanel, { onOpenWallet: open }).use(store).use(router)
  app.mount(host); await nextTick()
  cleanups.add(() => { app.unmount(); host.remove() })
  return { host, store, router, open }
}
function button(scope: ParentNode, label: string) {
  const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label)
  expect(value, `Missing button ${label}`).toBeDefined(); return value!
}
async function submit(host: HTMLElement, index = 0) { host.querySelectorAll('form')[index].dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); await nextTick() }
function modal(host: HTMLElement) { const value = host.querySelector<HTMLDialogElement>('dialog'); expect(value?.open).toBe(true); return value! }

describe('FundedPoolPanel', () => {
  it('offers an unchanged pool renewal only once the rescue window is open', async () => {
    const { host } = await mount()
    const labels = () => [...host.querySelectorAll('button')].map(element => element.textContent?.trim())
    expect(labels()).not.toContain('Renew pool now')
    calls.rescue.mockResolvedValue(undefined)
    state.value = display({ capabilities: { subscribe: false, redeem: false, bet: false, recover: false, rescue: true } })
    await nextTick()
    button(host, 'Renew pool now').click()
    await vi.waitFor(() => expect(calls.rescue).toHaveBeenCalledTimes(1))
    expect(calls.confirm).not.toHaveBeenCalled()
  })

  it('resumes a saved wallet renewal without requesting a replacement quote', async () => {
    renewalState.value = { status: 'recovery', error: 'The saved batch needs reconciliation', intentId: 'saved-intent' }
    const { host } = await mount()
    button(host, 'Resume wallet renewal').click(); await Promise.resolve(); await nextTick()
    expect(calls.recover).toHaveBeenCalledOnce()
    expect(calls.prepareRenewInputs).not.toHaveBeenCalled()
    expect(calls.confirmRenewInputs).not.toHaveBeenCalled()
  })

  it('reviews exact wallet sources and maximum renewal costs before signing', async () => {
    const renewal: FundedPoolInputRenewalQuote = { id: 'renewal-1', expiresAt: Date.now() + 60_000, network: 'regtest', operatorUrl: 'http://localhost:37770',
      inputs: [{ outpoint: head, valueSats: '1330', expiresAt: Date.now() + 5_000_000, assets: [{ assetId: '33'.repeat(32), amount: '2500' }] }],
      inputTotalSats: '1330', estimatedFeeSats: '10', estimatedOutputSats: '1320', feeEstimateOnly: false }
    calls.prepareRenewInputs.mockResolvedValue(renewal)
    renewalState.value = { status: 'needed', error: 'Renew these wallet coins before contributing', intentId: null }
    const { host } = await mount()
    button(host, 'Review wallet renewal').click(); await Promise.resolve(); await nextTick()
    expect(modal(host).textContent).toContain('Maximum batch fee')
    expect(modal(host).textContent).toContain('cannot charge more than the reviewed fee')
    expect(modal(host).textContent).toContain((2500n).toLocaleString())
    expect(calls.confirmRenewInputs).not.toHaveBeenCalled()
    button(modal(host), 'Sign wallet renewal').click(); await Promise.resolve(); await nextTick()
    expect(calls.confirmRenewInputs).toHaveBeenCalledExactlyOnceWith(renewal)
    expect(host.querySelector('dialog')).toBeNull()
  })

  it('routes wallet setup back to the funded pool and never signs for an anonymous visitor', async () => {
    const { host } = await mount(false)
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/setup?returnTo=/bankroll&poolView=pool')
    expect(host.querySelector('form')).toBeNull()
    expect(calls.prepareSubscribe).not.toHaveBeenCalled()
    expect(calls.confirm).not.toHaveBeenCalled()
  })

  it('withholds amounts when verification is unavailable and retries discovery', async () => {
    state.value = display({ verified: false, status: 'unconfigured', navSats: null, estimatedClaimSats: null })
    const { host } = await mount()
    expect(host.textContent).toContain('has not opened this pool')
    expect(host.querySelector('.position-amount')).toBeNull()
    button(host, 'Check again').click(); await nextTick()
    expect(calls.refresh).toHaveBeenCalledOnce()
  })

  it('previews exact contribution shares and signs only after confirmation', async () => {
    const { host } = await mount()
    await submit(host)
    expect(calls.prepareSubscribe).toHaveBeenCalledExactlyOnceWith(25_000n)
    expect(modal(host).textContent).toContain((25_000_000_000n).toLocaleString())
    expect(modal(host).textContent).toContain('20.00%')
    expect(calls.confirm).not.toHaveBeenCalled()
    expect(button(modal(host), 'Sign contribution').disabled).toBe(true)
    const acknowledgment = modal(host).querySelector<HTMLInputElement>('input[type=checkbox]')!
    acknowledgment.checked = true; acknowledgment.dispatchEvent(new Event('change', { bubbles: true })); await nextTick()
    button(modal(host), 'Sign contribution').click(); await Promise.resolve(); await nextTick()
    expect(calls.confirm).toHaveBeenCalledOnce()
    expect(host.querySelector('dialog')).toBeNull()
  })

  it('rejects invalid amounts before requesting a quote', async () => {
    const { host } = await mount()
    const input = host.querySelector<HTMLInputElement>('#funded-contribution')!
    input.value = '-1'; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick(); await submit(host)
    expect(calls.prepareSubscribe).not.toHaveBeenCalled()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('positive whole number')
  })

  it('shows a partial redemption in sats and burns the selected share units', async () => {
    state.value = display({ navSats: '133000', supply: '125000000000', memberShares: '25000000000', availableShares: '25000000000', estimatedClaimSats: '26600', capabilities: { subscribe: true, redeem: true, bet: true, recover: false } })
    const { host } = await mount()
    button(host, 'Redeem').click(); await nextTick()
    const slider = host.querySelector<HTMLInputElement>('#funded-redemption')!
    slider.value = '50'; slider.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
    expect(host.querySelector('.membership-preview')?.textContent).toContain((13_300n).toLocaleString())
    await submit(host)
    expect(calls.prepareRedeem).toHaveBeenCalledExactlyOnceWith(12_500_000_000n)
    expect(modal(host).textContent).toContain((13_300n).toLocaleString())
    expect(modal(host).textContent).toContain((12_500_000_000n).toLocaleString())
  })

  it('disables stale or expired confirmations without asking for a signature', async () => {
    const { host } = await mount(); await submit(host)
    state.value = display({ head: { ...head, vout: 1 } }); await nextTick()
    expect(button(modal(host), 'Sign contribution').disabled).toBe(true)
    expect(modal(host).textContent).toContain('pool changed')
    expect(calls.confirm).not.toHaveBeenCalled()
  })

  it('closes a preview on wallet switch even if the pool and network match', async () => {
    const { host, store } = await mount(); await submit(host)
    store.state.wallet.publicKey = '33'.repeat(32); await nextTick()
    expect(host.querySelector('dialog')).toBeNull()
    expect(calls.confirm).not.toHaveBeenCalled()
  })

  it('preserves the read-only preview across an unchanged descriptor refresh', async () => {
    const { host } = await mount(); await submit(host)
    state.value = display({ verifiedAt: Date.now() + 1 }); await nextTick()
    expect(modal(host).textContent).toContain('Review contribution')
  })

  it('previews a real committed wager with its exact payout and selected side', async () => {
    const { host } = await mount()
    button(host, 'Tails').click(); await nextTick(); await submit(host, 1)
    expect(calls.prepareBet).toHaveBeenCalledExactlyOnceWith({ playerStakeSats: 1000n, oddsN: 100, oddsLo: 50, oddsTarget: 100 })
    expect(modal(host).textContent).toContain((1970n).toLocaleString())
    expect(modal(host).textContent).toContain('Winning payout, including stake')
    expect(host.textContent).not.toContain('House wins')
    expect(calls.confirm).not.toHaveBeenCalled()
  })

  it('keeps ambiguous operations visible and checks the same status without preparing another spend', async () => {
    state.value = display({ status: 'pending', pending: { id: 'operation-1', kind: 'openGame', stage: 'confirming', arkTxid: head.txid, error: 'Response lost; checking transaction' }, capabilities: { subscribe: false, redeem: false, bet: false, recover: true } })
    const { host } = await mount()
    expect(host.querySelector('[role=status]')?.textContent).toContain('Response lost')
    expect(button(host, 'Preview contribution').disabled).toBe(true)
    expect(button(host, 'Preview 50% wager').disabled).toBe(true)
    button(host, 'Check status').click(); await Promise.resolve(); await nextTick()
    expect(calls.refresh).toHaveBeenCalledOnce()
    expect(calls.confirm).not.toHaveBeenCalled()
    expect(calls.prepareBet).not.toHaveBeenCalled()
  })

  it('resumes signing only after an explicit recovery action', async () => {
    state.value = display({ status: 'recovery', recovery: { operationId: 'saved-1', reason: 'Signature was not completed' }, capabilities: { subscribe: false, redeem: false, bet: false, recover: true } })
    const { host } = await mount()
    expect(calls.recover).not.toHaveBeenCalled()
    button(host, 'Resume recovery').click(); await Promise.resolve(); await nextTick()
    expect(calls.recover).toHaveBeenCalledOnce()
    expect(calls.refresh).not.toHaveBeenCalled()
    expect(calls.prepareSubscribe).not.toHaveBeenCalled()
  })
})
