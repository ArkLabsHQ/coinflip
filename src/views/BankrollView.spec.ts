import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createStore } from 'vuex'
import { createBankrollPractice, type BankrollPractice } from '@/services/bankrollPractice'
import type { BankrollPoolDescriptor, BankrollPoolDisplay } from '@/services/bankrollVaultObserver'
import BankrollView from './BankrollView.vue'
vi.mock('@/components/FundedPoolPanel.vue', () => ({ default: { template: '<section aria-label="Community pool">Funded pool</section>' } }))

let practice: BankrollPractice
let watched: ShallowRef<BankrollPoolDisplay>
let descriptorText: Ref<string>
const pool = vi.hoisted(() => ({ importDescriptor: vi.fn(), refresh: vi.fn(), forget: vi.fn() }))
vi.mock('@/services/bankrollPractice', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/bankrollPractice')>(),
  useBankrollPractice: () => practice,
}))
vi.mock('@/composables/useBankrollPool', () => ({
  useBankrollPool: () => ({ state: watched, descriptorText, ...pool }),
}))

const descriptor: BankrollPoolDescriptor = {
  version: 1, name: 'Community vault', network: 'regtest', operatorUrl: 'http://localhost:37770',
  controlAssetId: `${'11'.repeat(32)}:0`, shareAssetId: `${'22'.repeat(32)}:0`,
  bootstrapTxid: '33'.repeat(32), checkpointPsbts: ['checkpoint-a', 'checkpoint-b'],
}
function display(status: BankrollPoolDisplay['status'], values: Partial<BankrollPoolDisplay> = {}): BankrollPoolDisplay {
  return { status, navSats: null, supply: null, memberShares: null, availableShares: null,
    estimatedClaimSats: null, verifiedAt: null, error: null, canDeposit: false, canRedeem: false, ...values }
}
function ready(): BankrollPoolDisplay {
  return display('ready', { descriptor, navSats: '125000', supply: '125000000000',
    memberShares: '25000000000', availableShares: '25000000000', estimatedClaimSats: '25000',
    verifiedAt: 1_794_400_000_000 })
}
const cleanups = new Set<() => void>()
const dialogMethods = ['showModal', 'close'] as const
const originalDialogMethods = dialogMethods.map(name => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name))
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute('open') } })
})
afterAll(() => dialogMethods.forEach((name, index) => {
  const original = originalDialogMethods[index]
  if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
}))
beforeEach(() => {
  vi.clearAllMocks()
  const storage = new Map<string, string>()
  practice = createBankrollPractice({ getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value) } })
  watched = shallowRef(display('unconfigured'))
  descriptorText = ref('')
  pool.importDescriptor.mockResolvedValue(undefined)
  pool.refresh.mockResolvedValue(undefined)
})
afterEach(() => { cleanups.forEach(cleanup => cleanup()); cleanups.clear() })

async function mountBankroll(initialized = false, path = '/bankroll?view=practice') {
  const store = createStore({ state: () => ({ wallet: { isInitialized: initialized },
    ark: { status: 'connected', balanceSynced: true }, balance: 50_000 }),
  getters: { 'ark/balance': state => state.balance } })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/bankroll', component: BankrollView },
    ...['/', '/setup', '/how-it-works'].map(path => ({ path, component: { render: () => h('div') } })),
  ] })
  await router.push(path)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const openWallet = vi.fn()
  const app = createApp(BankrollView, { onOpenWallet: openWallet }).use(router).use(store)
  app.mount(host)
  await router.isReady()
  await nextTick()
  cleanups.add(() => { app.unmount(); host.remove() })
  return { host, router, store, openWallet }
}
function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find(value => value.textContent?.trim() === label)
  expect(found, `Missing button: ${label}`).toBeDefined()
  return found!
}
async function click(scope: ParentNode, label: string) {
  button(scope, label).click()
  await nextTick()
}
async function watchVault(host: ParentNode) {
  host.querySelector<HTMLButtonElement>('#watch-tab')!.click()
  await vi.waitFor(() => expect(host.querySelector('#watch-panel')).not.toBeNull())
}
async function input(host: ParentNode, selector: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  expect(field).not.toBeNull()
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
function dialog(host: ParentNode): HTMLDialogElement {
  const result = host.querySelector<HTMLDialogElement>('dialog')
  expect(result?.open).toBe(true)
  return result!
}
function detail(scope: ParentNode, label: string): string {
  const row = Array.from(scope.querySelectorAll('dl > div')).find(value => value.querySelector('dt')?.textContent?.trim() === label)
  expect(row, `Missing detail: ${label}`).toBeDefined()
  return row!.querySelector('dd')!.textContent!.trim().replace(/\s+/g, ' ')
}
const sats = (value: bigint) => value.toLocaleString().replace(/\s+/g, ' ')
async function join(host: HTMLElement) {
  await click(host, 'Preview contribution')
  await click(dialog(host), 'Confirm practice contribution')
}

describe('BankrollView practice', () => {
  it('quotes and cancels without spending, then contributes only after confirmation without a wallet', async () => {
    const { host } = await mountBankroll()
    await click(host, 'Preview contribution')
    expect(detail(dialog(host), 'Contribution')).toBe(`${sats(25_000n)} sats`)
    expect(detail(dialog(host), 'Shares received')).toBe(`${sats(25_000_000_000n)} units`)
    expect(detail(dialog(host), 'Your ownership after')).toBe('20.00%')
    expect(practice.state.value).toMatchObject({ cashSats: 100_000n, memberShares: 0n, version: 0 })
    await click(dialog(host), 'Cancel')
    expect(host.querySelector('dialog')).toBeNull()
    await join(host)
    expect(practice.state.value).toMatchObject({ cashSats: 75_000n, memberShares: 25_000_000_000n, version: 1 })
    expect(host.querySelector('.member-equity')?.textContent).toContain(sats(25_000n))
    expect(host.querySelector('.activity-row')?.textContent).toContain('Contribution confirmed')
    expect(pool.importDescriptor).not.toHaveBeenCalled()
    expect(pool.refresh).not.toHaveBeenCalled()
  })

  it('disables a stale confirmation and requires a new quote after a pool update', async () => {
    const { host } = await mountBankroll()
    await click(host, 'Preview contribution')
    practice.playRound('refund', 1000n)
    await nextTick()
    expect(dialog(host).textContent).toContain('The practice pool changed')
    expect(button(dialog(host), 'Confirm practice contribution').disabled).toBe(true)
    await click(dialog(host), 'Confirm practice contribution')
    expect(practice.state.value.memberShares).toBe(0n)
    await click(dialog(host), 'Cancel')
    await join(host)
    expect(practice.state.value.version).toBe(2)
    expect(practice.state.value.memberShares).toBe(25_000_000_000n)
  })

  it('shows the house win, net equity, operator fee and the round receipt', async () => {
    const { host } = await mountBankroll()
    await join(host)
    await click(host, 'House wins')
    expect(host.querySelector('.pool-amount')?.textContent).toContain(sats(133_000n))
    expect(host.querySelector('.pool-change')?.textContent).toContain(`+${sats(8000n)}`)
    expect(host.querySelector('.member-equity')?.textContent).toContain(sats(26_600n))
    expect(detail(host, 'Fees paid this session')).toBe(`${sats(2000n)} sats`)
    host.querySelector<HTMLButtonElement>('.activity-row')!.click()
    await nextTick()
    expect(dialog(host).textContent).toContain('House won the round')
    expect(detail(dialog(host), 'Operator fee')).toBe(`${sats(2000n)} sats`)
    expect(detail(dialog(host), 'Your equity afterward')).toBe(`${sats(26_600n)} sats`)
  })

  it('redeems part of the shares and records actual sats in its activity and receipt', async () => {
    const { host } = await mountBankroll()
    await join(host)
    await click(host, 'House wins')
    await click(host, 'Redeem')
    await input(host, '#practice-redemption', '40')
    await click(host, 'Preview redemption')
    expect(detail(dialog(host), 'You receive')).toBe(`${sats(10_640n)} sats`)
    expect(detail(dialog(host), 'Shares redeemed')).toBe(`${sats(10_000_000_000n)} units`)
    await click(dialog(host), 'Confirm practice redemption')
    expect(practice.state.value).toMatchObject({ memberShares: 15_000_000_000n, redeemedSats: 10_640n, cashSats: 85_640n })
    expect(host.querySelector('.member-equity')?.textContent).toContain(sats(15_960n))
    const receipt = host.querySelector<HTMLButtonElement>('.activity-row')!
    expect(receipt.querySelector('.activity-number')?.textContent).toContain(sats(10_640n))
    expect(receipt.querySelector('.activity-number')?.textContent).not.toContain(sats(10_000_000_000n))
    receipt.click()
    await nextTick()
    expect(detail(dialog(host), 'Amount')).toBe(`${sats(10_640n)} sats`)
    expect(detail(dialog(host), 'Your equity afterward')).toBe(`${sats(15_960n)} sats`)
  })

  it('requires reset confirmation and leaves the wallet and watched vault untouched', async () => {
    watched.value = ready()
    const watchedBefore = watched.value
    const { host, store } = await mountBankroll(true)
    await join(host)
    await click(host, 'House wins')
    await click(host, 'Start over')
    expect(practice.state.value.memberShares).toBe(25_000_000_000n)
    await click(dialog(host), 'Cancel')
    expect(practice.state.value.operatorFeesSats).toBe(2000n)
    await click(host, 'Start over')
    await click(dialog(host), 'Reset practice session')
    expect(practice.state.value).toMatchObject({ memberShares: 0n, cashSats: 100_000n, contributedSats: 0n,
      redeemedSats: 0n, operatorFeesSats: 0n, activity: [] })
    expect(host.querySelector('.activity-empty')?.textContent).toContain('Your seat is waiting')
    expect(watched.value).toBe(watchedBefore)
    expect(store.state.balance).toBe(50_000)
    expect(pool.forget).not.toHaveBeenCalled()
  })
})

describe('BankrollView watched vault', () => {
  it('opens a watch deep link and keeps tab changes synchronized with the URL', async () => {
    watched.value = ready()
    const { host, router } = await mountBankroll(true, '/bankroll?view=watch')
    expect(host.querySelector('#watch-panel')).not.toBeNull()
    expect(host.querySelector('#watch-tab')?.getAttribute('aria-selected')).toBe('true')
    host.querySelector<HTMLButtonElement>('#practice-tab')!.click()
    await vi.waitFor(() => expect(host.querySelector('#practice-panel')).not.toBeNull())
    expect(router.currentRoute.value.query.view).toBe('practice')
    await watchVault(host)
    expect(router.currentRoute.value.query.view).toBe('watch')
    await router.push('/bankroll')
    await nextTick()
    expect(host.querySelector('#pool-panel')).not.toBeNull()
  })

  it('keeps practice public and routes wallet setup back to bankroll', async () => {
    const { host, router } = await mountBankroll()
    await watchVault(host)
    expect(host.querySelector('.watch-empty')?.textContent).toContain('You can use the practice pool without one')
    const setup = host.querySelector<HTMLAnchorElement>('.watch-empty a')!
    expect(setup.getAttribute('href')).toBe('/setup?returnTo=/bankroll&poolView=watch')
    setup.click()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/setup'))
    expect(router.currentRoute.value.query.returnTo).toBe('/bankroll')
    expect(pool.importDescriptor).not.toHaveBeenCalled()
  })

  it('shows an empty connection form and passes public descriptors for verification', async () => {
    const { host } = await mountBankroll(true)
    await watchVault(host)
    expect(host.querySelector('.watch-balances')).toBeNull()
    expect(button(host, 'Verify and watch pool').disabled).toBe(true)
    const publicDetails = JSON.stringify(descriptor)
    await input(host, '#pool-descriptor', publicDetails)
    await click(host, 'Verify and watch pool')
    expect(pool.importDescriptor).toHaveBeenCalledExactlyOnceWith(publicDetails)
  })

  it.each(['loading', 'validating'] as const)('hides prior amounts while %s', async status => {
    watched.value = { ...ready(), status }
    const { host } = await mountBankroll(true)
    await watchVault(host)
    expect(host.querySelector('.watch-balances')).toBeNull()
    expect(host.querySelector('.watch-message')?.textContent).toContain('Amounts stay hidden until verification finishes')
    expect(host.querySelector('.watch-quote')).toBeNull()
  })

  it('describes indexer absence without declaring retirement and permits a fresh check', async () => {
    watched.value = display('absent', { descriptor })
    const { host } = await mountBankroll(true)
    await watchVault(host)
    expect(host.querySelector('.watch-message')?.textContent).toContain('This does not prove the pool has retired')
    expect(host.querySelector('.watch-balances')).toBeNull()
    await click(host, 'Check again')
    expect(pool.refresh).toHaveBeenCalledOnce()
  })

  it.each(['error', 'unavailable'] as const)('shows a %s state with no unverified balances', async status => {
    watched.value = display(status, { descriptor, error: 'Bootstrap ownership could not be verified' })
    const { host } = await mountBankroll(true)
    await watchVault(host)
    expect(host.querySelector('.error-state')?.textContent).toContain('Bootstrap ownership could not be verified')
    expect(host.querySelector('.watch-balances')).toBeNull()
    await click(host, 'Try again')
    expect(pool.refresh).toHaveBeenCalledOnce()
  })

  it('shows verified equity and offers contribution and partial redemption estimates without signing', async () => {
    watched.value = ready()
    const { host } = await mountBankroll(true)
    await watchVault(host)
    expect(detail(host, 'Pool equity')).toBe(`${sats(125_000n)} sats`)
    expect(detail(host, 'Your estimated equity')).toBe(`${sats(25_000n)} sats`)
    expect(detail(host, 'Your available shares')).toBe(`${sats(25_000_000_000n)} units`)
    await click(host, 'Preview estimate')
    expect(detail(dialog(host), 'Contribution')).toBe(`${sats(25_000n)} sats`)
    expect(detail(dialog(host), 'Estimated shares')).toBe(`${sats(25_000_000_000n)} units`)
    expect(dialog(host).querySelector('footer .btn-gold')).toBeNull()
    await click(dialog(host), 'Close preview')
    await click(host, 'Redemption estimate')
    await input(host, '#vault-redemption', '40')
    await click(host, 'Preview estimate')
    expect(detail(dialog(host), 'Estimated return')).toBe(`${sats(10_000n)} sats`)
    expect(detail(dialog(host), 'Shares to redeem')).toBe(`${sats(10_000_000_000n)} units`)
    expect(dialog(host).textContent).toContain('No transaction is prepared, signed or broadcast')
    expect(dialog(host).querySelector('footer .btn-gold')).toBeNull()
    expect(practice.state.value.version).toBe(0)
    expect(pool.importDescriptor).not.toHaveBeenCalled()
  })

  it('opens the existing wallet UI without claiming an unsynchronized balance', async () => {
    const { host, store, openWallet } = await mountBankroll(true)
    store.state.ark.balanceSynced = false
    await nextTick()
    expect(host.querySelector('.bankroll-wallet')?.textContent).toBe('Wallet')
    host.querySelector<HTMLButtonElement>('.bankroll-wallet')!.click()
    expect(openWallet).toHaveBeenCalledOnce()
    store.state.ark.balanceSynced = true
    await nextTick()
    expect(host.querySelector('.bankroll-wallet')?.textContent).toContain(sats(50_000n))
  })

  it('closes a stale watch estimate during refresh and quotes from the new verified snapshot', async () => {
    watched.value = ready()
    const { host } = await mountBankroll(true)
    await watchVault(host)
    await click(host, 'Preview estimate')
    expect(dialog(host)).not.toBeNull()
    watched.value = display('loading', { descriptor })
    await nextTick()
    expect(host.querySelector('dialog')).toBeNull()
    expect(host.querySelector('.watch-balances')).toBeNull()
    watched.value = { ...ready(), navSats: '133000', estimatedClaimSats: '26600', verifiedAt: 1_794_400_001_000 }
    await nextTick()
    await click(host, 'Redemption estimate')
    await input(host, '#vault-redemption', '40')
    await click(host, 'Preview estimate')
    expect(detail(dialog(host), 'Estimated return')).toBe(`${sats(10_640n)} sats`)
    expect(dialog(host).querySelector('footer .btn-gold')).toBeNull()
  })

  it('surfaces a descriptor verification failure without changing practice funds', async () => {
    pool.importDescriptor.mockRejectedValueOnce(new Error('Pool network does not match your wallet'))
    const { host } = await mountBankroll(true)
    await watchVault(host)
    await input(host, '#pool-descriptor', JSON.stringify(descriptor))
    await click(host, 'Verify and watch pool')
    await vi.waitFor(() => expect(host.querySelector('.pool-import [role="alert"]')?.textContent)
      .toContain('Pool network does not match your wallet'))
    expect(practice.state.value).toMatchObject({ cashSats: 100_000n, memberShares: 0n, version: 0 })
    expect(host.querySelector('.watch-balances')).toBeNull()
  })
})
