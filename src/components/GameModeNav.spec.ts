import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import GameModeNav from './GameModeNav.vue'
import { redirectFor } from '@/router/guard'

const cleanups = new Set<() => void>()
afterEach(() => { cleanups.forEach(cleanup => cleanup()); cleanups.clear() })

async function mountNav(path: string, initialized = true) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'play', component: { render: () => h('div') }, meta: { requiresWallet: true } },
      { path: '/bankroll', name: 'bankroll', component: { render: () => h('div') } },
      { path: '/setup', name: 'setup', component: { render: () => h('div') } },
    ],
  })
  router.beforeEach(to => redirectFor(to, initialized) || true)
  await router.push(path)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(GameModeNav).use(router)
  app.mount(host)
  await router.isReady()
  await nextTick()
  cleanups.add(() => { app.unmount(); host.remove() })
  return { host, router }
}

describe('GameModeNav', () => {
  it('identifies normal play as the current mode', async () => {
    const { host } = await mountNav('/')
    const play = host.querySelector<HTMLAnchorElement>('a[href="/"]')!
    const bankroll = host.querySelector<HTMLAnchorElement>('a[href="/bankroll"]')!
    expect(play.textContent?.trim()).toBe('Play')
    expect(bankroll.textContent?.trim()).toBe('Bankroll')
    expect(play.getAttribute('aria-current')).toBe('page')
    expect(bankroll.hasAttribute('aria-current')).toBe(false)
  })

  it('navigates to bankroll and updates the accessible current mode', async () => {
    const { host, router } = await mountNav('/')
    host.querySelector<HTMLAnchorElement>('a[href="/bankroll"]')!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/bankroll'))
    await nextTick()
    expect(router.currentRoute.value.path).toBe('/bankroll')
    expect(host.querySelector('a[href="/bankroll"]')?.getAttribute('aria-current')).toBe('page')
    expect(host.querySelector('a[href="/"]')?.hasAttribute('aria-current')).toBe(false)
  })

  it('allows wallet-free bankroll practice while keeping funded play gated', async () => {
    const { host, router } = await mountNav('/bankroll', false)
    expect(router.currentRoute.value.path).toBe('/bankroll')
    host.querySelector<HTMLAnchorElement>('a[href="/"]')!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/setup'))
    await nextTick()
    expect(router.currentRoute.value.path).toBe('/setup')
    expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(0)
  })
})
