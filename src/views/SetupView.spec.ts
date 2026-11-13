import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createStore } from 'vuex'
import SetupView from './SetupView.vue'

vi.mock('@/utils/credentialBackup', () => ({
  isCredentialBackupSupported: () => false,
  saveWalletToBrowser: vi.fn(),
  importWalletFromBrowser: vi.fn(),
}))

const cleanups = new Set<() => void>()
afterEach(() => { cleanups.forEach(cleanup => cleanup()); cleanups.clear() })

async function mountSetup(returnTo?: string | string[], poolView?: string) {
  const create = vi.fn()
  const restore = vi.fn()
  const store = createStore({
    state: () => ({ initialized: false }),
    getters: { walletMnemonic: () => 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' },
    actions: {
      createNewWallet: async ({ state }) => { create(); state.initialized = true },
      restoreWallet: async ({ state }, input: string) => { restore(input); state.initialized = true },
    },
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/setup', component: SetupView },
      { path: '/', component: { render: () => h('div', 'Normal play') } },
      { path: '/bankroll', component: { render: () => h('div', 'Bankroll') } },
      { path: '/how-it-works', component: { render: () => h('div') } },
    ],
  })
  await router.push({ path: '/setup', query: { ...(returnTo === undefined ? {} : { returnTo }), ...(poolView === undefined ? {} : { poolView }) } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(SetupView).use(router).use(store)
  app.mount(host)
  await router.isReady()
  await nextTick()
  cleanups.add(() => { app.unmount(); host.remove() })
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find(candidate => candidate.textContent?.trim() === label)
    expect(button, `Missing button ${label}`).toBeDefined()
    button!.click()
    await Promise.resolve()
    await nextTick()
  }
  const restoreKey = async () => {
    await click('I already have a key')
    const input = host.querySelector<HTMLInputElement>('input[type="text"]')!
    input.value = 'restored-key-fixture'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    await click('Restore')
  }
  return { host, router, create, restore, click, restoreKey }
}

describe('SetupView return destination', () => {
  it('returns a new wallet to bankroll only after the recovery backup is confirmed', async () => {
    const { host, router, create, click } = await mountSetup('/bankroll')
    await click('Create wallet to watch a bankroll')
    await click('Generate Wallet')
    expect(create).toHaveBeenCalledOnce()
    expect(router.currentRoute.value.path).toBe('/setup')
    expect(host.querySelector<HTMLButtonElement>('.overlay button.btn-gold')?.disabled).toBe(true)
    const checkbox = host.querySelector<HTMLInputElement>('.overlay input[type="checkbox"]')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    await click('Continue')
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/bankroll'))
    expect(router.currentRoute.value.query.view).toBe('watch')
  })

  it('returns a restored wallet to bankroll', async () => {
    const { router, restore, restoreKey } = await mountSetup('/bankroll')
    await restoreKey()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/bankroll'))
    expect(router.currentRoute.value.query.view).toBe('watch')
    expect(restore).toHaveBeenCalledWith('restored-key-fixture')
  })

  it('returns funded-pool setup to the community mode and keeps practice available', async () => {
    const { host, router, restoreKey } = await mountSetup('/bankroll', 'pool')
    expect(host.textContent).toContain('Create wallet for bankroll')
    expect(host.querySelector('.splash-footer a')?.getAttribute('href')).toBe('/bankroll?view=practice')
    await restoreKey()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/bankroll'))
    expect(router.currentRoute.value.query.view).toBe('pool')
  })

  it.each([
    ['an external destination', 'https://example.invalid/'],
    ['multiple destinations', ['/bankroll', '/']],
    ['an unrelated local destination', '/history'],
  ] as const)('falls back to normal play for %s', async (_label, destination) => {
    const { router, restoreKey } = await mountSetup(typeof destination === 'string' ? destination : [...destination])
    await restoreKey()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))
  })

  it('keeps normal setup navigation as the default', async () => {
    const { router, restoreKey } = await mountSetup()
    await restoreKey()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'))
  })

  it('explains the bankroll context and keeps practice reachable without a wallet', async () => {
    const { host, router } = await mountSetup('/bankroll')
    expect(host.querySelector('h1')?.textContent).toContain('Your pool shares')
    expect(host.querySelector('.splash-tagline')?.textContent).toContain('watch an existing bankroll')
    const practiceLink = Array.from(host.querySelectorAll('a')).find(link => link.textContent === 'Practice without a wallet')!
    practiceLink.click()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/bankroll'))
  })

  it('keeps the normal play setup wording and describes recovery without absolute guarantees', async () => {
    const { host } = await mountSetup()
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent?.trim() === 'Create wallet to play')).toBe(true)
    expect(host.querySelector('.splash-tagline')?.textContent).toContain('recovery paths')
    expect(host.textContent).not.toMatch(/can.t cheat you|can.t stall you out|no trust required/i)
  })
})
