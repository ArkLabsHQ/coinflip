import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import { createStore } from 'vuex'
import { createMemoryHistory, createRouter } from 'vue-router'
import WalletDrawer from './WalletDrawer.vue'

vi.mock('@/store/modules/ark/walletRuntime', () => ({ getSDKWallet: () => null }))
vi.mock('@/composables/useFundedPool', async () => {
  const { ref } = await import('vue')
  return { useFundedPool: () => ({ state: ref({ descriptor: null, pending: null }) }) }
})
vi.mock('@/services/lnurlSession', () => ({ lnurlServerForNetwork: () => null, openLnurlSession: vi.fn() }))
vi.mock('@/services/swaps', () => ({ createLnDeposit: vi.fn(), waitForDeposit: vi.fn(), sendPayment: vi.fn(), invoiceSats: () => 0 }))
vi.mock('@/composables/useBankrollPool', async () => {
  const { ref } = await import('vue')
  return { useBankrollPool: () => ({ state: ref({ status: 'unconfigured' }) }) }
})
vi.mock('@/services/bankrollPractice', async () => {
  const { ref } = await import('vue')
  return { useBankrollPractice: () => ({ state: ref({ memberShares: 0n }), memberValue: ref(0n), ownershipBps: ref(0n) }) }
})

const cleanups = new Set<() => void>()
beforeEach(() => vi.clearAllMocks())
afterEach(() => { cleanups.forEach(cleanup => cleanup()); cleanups.clear() })

async function mountDrawer(options: { status?: string; synced?: boolean; formatted?: string | null; dismissible?: boolean } = {}) {
  const actions = { refresh: vi.fn(async () => {}), reconnect: vi.fn(async () => {}), send: vi.fn(async () => {}) }
  const store = createStore({
    state: {
      formatted: options.formatted === undefined ? '0' : options.formatted,
      wallet: { privateKey: null },
      ark: { status: options.status ?? 'connected', balanceSynced: options.synced ?? false,
        info: null, server: 'http://localhost:37770', lastError: null, walletBalance: null },
    },
    getters: {
      'ark/formattedBalance': state => state.formatted,
      'ark/balance': () => 0n,
      'ark/address': () => null,
      'ark/boardingAddress': () => null,
      'ark/boardingBalance': () => 0n,
      'ark/boardingUtxos': () => [],
      'ark/activityHistory': () => [],
      'ark/activityStatus': () => 'idle',
    },
    actions: { 'ark/refreshBalance': actions.refresh, 'ark/checkConnection': actions.reconnect, 'ark/sendBitcoin': actions.send },
  })
  const router = createRouter({ history: createMemoryHistory(),
    routes: ['/', '/bankroll'].map(path => ({ path, component: { render: () => h('div') } })) })
  await router.push('/')
  const open = ref(true)
  const updates = vi.fn((value: boolean) => { open.value = value })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(WalletDrawer, {
    open: open.value, dismissible: options.dismissible ?? true, 'onUpdate:open': updates,
  }) }).use(store).use(router)
  app.mount(host)
  await router.isReady()
  await nextTick()
  cleanups.add(() => { app.unmount(); host.remove() })
  const header = () => host.querySelector<HTMLElement>('.balance-amount')!
  const tab = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('.drawer-tabs button'))
    .find(button => button.textContent === name)!
  return { host, header, store, router, updates, open, actions, tab }
}

describe('WalletDrawer balance freshness', () => {
  it.each([
    { status: 'disconnected', synced: true, formatted: '52,000' },
    { status: 'connecting', synced: false, formatted: '0' },
    { status: 'connected', synced: false, formatted: '52,000' },
    { status: 'connected', synced: true, formatted: null },
  ])('shows unknown instead of a stale or unverified balance: %j', async options => {
    const { header } = await mountDrawer(options)
    expect(header().textContent?.trim()).toBe('— sats')
    expect(header().getAttribute('aria-label')).toContain('unknown')
    expect(header().title).toContain('synchronized')
  })

  it('shows real zero after sync, updates a known amount, and clears it on disconnect', async () => {
    const { header, store } = await mountDrawer()
    expect(header().textContent?.trim()).toBe('— sats')
    store.state.ark.balanceSynced = true
    await nextTick()
    expect(header().textContent?.trim()).toBe('0 sats')
    expect(header().getAttribute('aria-label')).toBe('0 sats available')
    store.state.formatted = '12,345'
    await nextTick()
    expect(header().textContent?.trim()).toBe('12,345 sats')
    store.state.ark.status = 'disconnected'
    await nextTick()
    expect(header().textContent?.trim()).toBe('— sats')
  })
})

describe('WalletDrawer bankroll integration', () => {
  it('exposes all five keyboard-accessible sections and opens the real summary', async () => {
    const { host, tab } = await mountDrawer({ synced: true })
    expect(host.querySelector('[aria-label="Wallet sections"]')).not.toBeNull()
    expect(Array.from(host.querySelectorAll('.drawer-tabs button')).map(button => button.textContent))
      .toEqual(['Receive', 'Send', 'Activity', 'Bankroll', 'Settings'])
    expect(tab('Receive').getAttribute('aria-pressed')).toBe('true')
    tab('Bankroll').click()
    await nextTick()
    expect(tab('Bankroll').getAttribute('aria-pressed')).toBe('true')
    expect(tab('Receive').getAttribute('aria-pressed')).toBe('false')
    expect(host.querySelector('[aria-label="Bankroll membership"]')?.textContent).toContain('Your bankroll positions')
    expect(host.querySelector('.practice-position')?.textContent).toContain('Simulated')
  })

  it('navigates from the summary and closes a funding-locked drawer without sending', async () => {
    const { host, tab, router, updates, open, actions } = await mountDrawer({ synced: true, dismissible: false })
    tab('Bankroll').click()
    await nextTick()
    host.querySelector<HTMLButtonElement>('.wallet-pools button')!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/bankroll'))
    await nextTick()
    expect(updates).toHaveBeenCalledWith(false)
    expect(open.value).toBe(false)
    expect(actions.send).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(host.querySelector('[role="dialog"]')).toBeNull())
  })
})
