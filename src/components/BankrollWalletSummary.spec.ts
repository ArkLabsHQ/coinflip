import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, readonly, ref, shallowRef } from 'vue'
import BankrollWalletSummary from './BankrollWalletSummary.vue'
import { createBankrollPractice, useBankrollPractice } from '@/services/bankrollPractice'
import { useBankrollPool } from '@/composables/useBankrollPool'
import type { BankrollPoolDescriptor, BankrollPoolDisplay } from '@/services/bankrollVaultObserver'

vi.mock('@/composables/useBankrollPool', () => ({ useBankrollPool: vi.fn() }))
vi.mock('@/composables/useFundedPool', async () => {
  const { ref } = await import('vue')
  return { useFundedPool: () => ({ state: ref({ descriptor: null, pending: null }) }) }
})
vi.mock('@/services/bankrollPractice', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/bankrollPractice')>(), useBankrollPractice: vi.fn(),
}))

const descriptor: BankrollPoolDescriptor = {
  version: 1, name: 'Verified community vault', network: 'regtest', operatorUrl: 'http://localhost:37770',
  controlAssetId: '11'.repeat(32) + '0000', shareAssetId: '11'.repeat(32) + '0100',
  bootstrapTxid: '22'.repeat(32), checkpointPsbts: ['first', 'second'],
}

function display(patch: Partial<BankrollPoolDisplay> = {}): BankrollPoolDisplay {
  return { status: 'ready', descriptor, navSats: '125000', supply: '125000000000', memberShares: '25000000000',
    availableShares: '25000000000', estimatedClaimSats: '25000', verifiedAt: 1, error: null,
    canDeposit: false, canRedeem: false, ...patch }
}

const watched = shallowRef<BankrollPoolDisplay>(display())
let practice = createBankrollPractice(null)
const pool = {
  state: readonly(watched), descriptorText: ref(''), importDescriptor: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}), forget: vi.fn(), start: vi.fn(() => () => {}),
}
const cleanups = new Set<() => void>()
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

function mountSummary() {
  const open = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(BankrollWalletSummary, { onOpenBankroll: open })
  app.mount(host)
  cleanups.add(() => { app.unmount(); host.remove() })
  return { host, open }
}

beforeEach(() => {
  vi.clearAllMocks()
  watched.value = display()
  practice = createBankrollPractice(null)
  vi.mocked(useBankrollPool).mockReturnValue(pool)
  vi.mocked(useBankrollPractice).mockReturnValue(practice)
})

afterEach(() => { cleanups.forEach(cleanup => cleanup()); cleanups.clear() })

describe('BankrollWalletSummary', () => {
  it('renders verified equity separately from real practice accounting', async () => {
    const { host } = mountSummary()
    expect(text(host.querySelector('.watched-position .position-value'))).toBe(`${25_000n.toLocaleString()} sats estimated equity`)
    expect(text(host.querySelector('.practice-position'))).toContain('without moving Bitcoin')
    expect(text(host.querySelector('.practice-position'))).not.toContain('sats estimated equity')
    practice.join(25_000n)
    await nextTick()
    expect(text(host.querySelector('.practice-position .position-value'))).toBe(`${25_000n.toLocaleString()} practice sats`)
    expect(text(host.querySelector('.practice-position'))).toContain('20.00% ownership')
    expect(text(host.querySelector('.practice-position'))).toContain('No Bitcoin is held')
    expect(text(host.querySelector('.watched-position .position-value'))).toBe(`${25_000n.toLocaleString()} sats estimated equity`)
    expect(host.querySelector('[aria-label="Bankroll membership"]')).not.toBeNull()
  })

  it('updates known equity to unknown and preserves a subsequently verified zero', async () => {
    const { host } = mountSummary()
    watched.value = display({ estimatedClaimSats: null, memberShares: null })
    await nextTick()
    expect(text(host.querySelector('.watched-position .position-value'))).toBe('— sats estimated equity')
    expect(text(host.querySelector('.watched-position'))).toContain('— share units held')
    expect(text(host.querySelector('.watched-position'))).not.toContain('0 sats estimated equity')
    watched.value = display({ estimatedClaimSats: '0', memberShares: '0', availableShares: '0' })
    await nextTick()
    expect(text(host.querySelector('.watched-position .position-value'))).toBe('0 sats estimated equity')
    expect(text(host.querySelector('.watched-position'))).toContain('0 share units held')
  })

  it.each(['loading', 'validating'] as const)('does not display a cached value while %s', async status => {
    const { host } = mountSummary()
    watched.value = display({ status })
    await nextTick()
    expect(text(host.querySelector('.watched-position'))).toContain('Checking the vault and your shares')
    expect(host.querySelector('.watched-position .position-value')).toBeNull()
    expect(text(host.querySelector('.watched-position'))).toContain('Observation only')
  })

  it('keeps unavailable observations distinct from an indexed absence and practice ownership', async () => {
    practice.join(25_000n)
    const { host } = mountSummary()
    watched.value = display({ status: 'unavailable', error: 'Control coin needs recovery', estimatedClaimSats: null, memberShares: null })
    await nextTick()
    expect(text(host.querySelector('.watched-position'))).toContain('Control coin needs recovery')
    expect(host.querySelector('.watched-position .position-value')).toBeNull()
    expect(text(host.querySelector('.practice-position .position-value'))).toBe(`${25_000n.toLocaleString()} practice sats`)
    watched.value = display({ status: 'absent', estimatedClaimSats: null })
    await nextTick()
    expect(text(host.querySelector('.watched-position'))).toContain('This does not prove the pool has retired')
    expect(host.querySelector('.watched-position .position-value')).toBeNull()
    watched.value = display({ status: 'disconnected', descriptor: undefined, estimatedClaimSats: null })
    await nextTick()
    expect(host.querySelector('.watched-position')).toBeNull()
    expect(text(host.querySelector('.practice-position .position-value'))).toBe(`${25_000n.toLocaleString()} practice sats`)
  })

  it('only emits navigation when opening bankroll', async () => {
    const { host, open } = mountSummary()
    const buttons = host.querySelectorAll<HTMLButtonElement>('button')
    expect(buttons).toHaveLength(1)
    expect(text(buttons[0])).toBe('Open bankroll')
    buttons[0].click()
    await nextTick()
    expect(open).toHaveBeenCalledOnce()
    expect(pool.importDescriptor).not.toHaveBeenCalled()
    expect(pool.refresh).not.toHaveBeenCalled()
    expect(pool.start).not.toHaveBeenCalled()
    expect(practice.state.value.memberShares).toBe(0n)
  })
})
