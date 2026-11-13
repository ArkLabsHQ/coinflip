import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createStore } from 'vuex'
import RootApp from './App.vue'

const pool = vi.hoisted(() => {
  const dispose = vi.fn()
  return { dispose, start: vi.fn(() => dispose) }
})
const funded = vi.hoisted(() => {
  const dispose = vi.fn()
  return { dispose, start: vi.fn(() => dispose) }
})
vi.mock('@/composables/useBankrollPool', () => ({ useBankrollPool: () => ({ start: pool.start }) }))
vi.mock('@/composables/useFundedPool', () => ({ useFundedPool: () => ({ start: funded.start }) }))
vi.mock('@/components/WalletDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: { open: Boolean, dismissible: Boolean },
      emits: ['update:open'],
      setup(props, { emit }) {
        return () => h('aside', {
          'data-test': 'wallet-drawer', 'data-open': String(props.open),
          'data-dismissible': String(props.dismissible),
        }, [h('button', { 'data-test': 'dismiss-wallet', onClick: () => {
          if (props.dismissible) emit('update:open', false)
        } }, 'Close wallet')])
      },
    }),
  }
})

const cleanups = new Set<() => void>()
beforeEach(() => vi.clearAllMocks())
afterEach(() => cleanups.forEach(cleanup => cleanup()))

async function mountShell(path: string, options: { initialized?: boolean; synced?: boolean; balance?: number; status?: string } = {}) {
  const connect = vi.fn()
  const store = createStore({
    state: () => ({
      wallet: { isInitialized: options.initialized ?? true },
      balance: options.balance ?? 0,
      ark: { status: options.status ?? 'connected', balanceSynced: options.synced ?? false },
    }),
    getters: { 'ark/balance': state => state.balance },
    actions: { 'ark/checkConnection': connect },
  })
  const page = defineComponent({
    emits: ['open-wallet'],
    setup(_props, { emit }) {
      return () => h('button', { 'data-test': 'open-wallet', onClick: () => emit('open-wallet') }, 'Wallet')
    },
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['/', '/bankroll', '/history', '/setup'].map(route => ({ path: route, component: page })),
  })
  await router.push(path)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(RootApp).use(router).use(store)
  app.mount(host)
  await router.isReady()
  await nextTick()
  const unmount = () => { app.unmount(); host.remove(); cleanups.delete(unmount) }
  cleanups.add(unmount)
  const drawer = () => host.querySelector<HTMLElement>('[data-test="wallet-drawer"]')!
  return { host, router, store, drawer, unmount, connect }
}

describe('App wallet and mode lifecycle', () => {
  it('connects an existing wallet on a direct funded bankroll visit without opening its drawer', async () => {
    const { connect, drawer, store } = await mountShell('/bankroll', { status: 'disconnected' })
    expect(connect).toHaveBeenCalledOnce()
    expect(drawer().dataset.open).toBe('false')
    store.state.ark.status = 'error'
    await nextTick()
    expect(connect).toHaveBeenCalledOnce()
  })

  it.each([{ initialized: false, path: '/bankroll' }, { initialized: true, path: '/bankroll?view=practice' }])('keeps $path wallet access optional when initialized=$initialized', async ({ initialized, path }) => {
    const { connect, drawer } = await mountShell(path, { initialized, status: 'disconnected' })
    expect(connect).not.toHaveBeenCalled()
    expect(drawer().dataset.open).toBe('false')
  })

  it('does not open funding before the zero balance is synchronized', async () => {
    const { drawer } = await mountShell('/')
    expect(drawer().dataset.open).toBe('false')
    expect(drawer().dataset.dismissible).toBe('true')
  })

  it('opens the funding drawer only after an empty wallet is confirmed', async () => {
    const { store, drawer } = await mountShell('/')
    store.state.ark.balanceSynced = true
    await nextTick()
    expect(drawer().dataset.open).toBe('true')
    expect(drawer().dataset.dismissible).toBe('false')
  })

  it('closes automatic funding on bankroll navigation and ignores later empty balance updates', async () => {
    const { router, store, drawer } = await mountShell('/', { synced: true })
    expect(drawer().dataset.open).toBe('true')
    await router.push('/bankroll')
    await nextTick()
    expect(drawer().dataset.open).toBe('false')
    expect(drawer().dataset.dismissible).toBe('true')
    store.state.ark.balanceSynced = false
    await nextTick()
    store.state.ark.balanceSynced = true
    await nextTick()
    expect(drawer().dataset.open).toBe('false')
  })

  it('keeps wallet-free bankroll practice free of automatic funding UI', async () => {
    const { host, drawer } = await mountShell('/bankroll', { initialized: false, synced: true })
    expect(drawer().dataset.open).toBe('false')
    expect(drawer().dataset.dismissible).toBe('true')
    expect(host.querySelector('.float-pill')).toBeNull()
  })

  it('does not duplicate the bankroll header wallet button', async () => {
    const { host } = await mountShell('/bankroll', { synced: true, balance: 12_000 })
    expect(host.querySelector('.float-pill')).toBeNull()
  })

  it('withholds the floating wallet balance until sync and clears it on disconnect', async () => {
    const { host, store } = await mountShell('/history', { balance: 12_000 })
    const balance = () => host.querySelector('.balance-num')?.textContent
    expect(balance()).toBe('—')
    store.state.ark.balanceSynced = true
    await nextTick()
    expect(balance()).toBe((12_000).toLocaleString())
    store.state.ark.status = 'disconnected'
    await nextTick()
    expect(balance()).toBe('—')
    store.state.balance = 0
    store.state.ark.status = 'connected'
    await nextTick()
    expect(balance()).toBe('0')
  })

  it('preserves explicit wallet requests in bankroll mode', async () => {
    const { drawer } = await mountShell('/bankroll?wallet=open', { synced: true })
    expect(drawer().dataset.open).toBe('true')
    expect(drawer().dataset.dismissible).toBe('true')
  })

  it('allows the funding drawer to close once funds arrive', async () => {
    const { host, store, drawer } = await mountShell('/', { synced: true })
    store.state.balance = 10_000
    await nextTick()
    expect(drawer().dataset.dismissible).toBe('true')
    host.querySelector<HTMLButtonElement>('[data-test="dismiss-wallet"]')!.click()
    await nextTick()
    expect(drawer().dataset.open).toBe('false')
  })

  it('starts pool observation once per app mount and disposes it on unmount', async () => {
    const { router, store, unmount } = await mountShell('/bankroll')
    expect(pool.start).toHaveBeenCalledExactlyOnceWith(store)
    expect(funded.start).toHaveBeenCalledExactlyOnceWith(store)
    await router.push('/history')
    await nextTick()
    expect(pool.start).toHaveBeenCalledTimes(1)
    expect(funded.start).toHaveBeenCalledTimes(1)
    expect(pool.dispose).not.toHaveBeenCalled()
    expect(funded.dispose).not.toHaveBeenCalled()
    unmount()
    expect(pool.dispose).toHaveBeenCalledOnce()
    expect(funded.dispose).toHaveBeenCalledOnce()
  })
})
