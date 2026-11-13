import { readonly, ref, shallowRef, watch } from 'vue'
import type { Wallet } from '@arkade-os/sdk'
import { getSDKWallet } from '@/store/modules/ark/walletRuntime'
import {
  createBankrollVaultObserver, emptyBankrollDisplay, normalizePoolOperatorUrl, parseBankrollDescriptor,
  type BankrollPoolDescriptor,
} from '@/services/bankrollVaultObserver'

interface PoolStore {
  state: {
    wallet: { publicKey: string | null }
    ark: { status: string; server: string; info: { network: string } | null }
  }
}

interface Context {
  wallet: Wallet
  publicKey: string
  network: string
  operatorUrl: string
}

type Observer = Awaited<ReturnType<typeof createBankrollVaultObserver>>
const state = shallowRef(emptyBankrollDisplay('disconnected'))
const descriptorText = ref('')
let store: PoolStore | null = null
let context: Context | null = null
let observer: Observer | null = null
let selected: BankrollPoolDescriptor | undefined
let generation = 0
let users = 0
let stopWatching: (() => void) | null = null
let pending: Promise<void> | null = null
let teardown = Promise.resolve()

function currentContext(): Context | null {
  if (!store || store.state.ark.status !== 'connected' || !store.state.wallet.publicKey || !store.state.ark.info?.network) return null
  const wallet = getSDKWallet()
  return wallet ? {
    wallet, publicKey: store.state.wallet.publicKey,
    network: store.state.ark.info.network, operatorUrl: normalizePoolOperatorUrl(store.state.ark.server),
  } : null
}

function matches(left: Context | null, right: Context | null): boolean {
  return left === right || !!left && !!right && left.wallet === right.wallet && left.publicKey === right.publicKey &&
    left.network === right.network && left.operatorUrl === right.operatorUrl
}

function storageKey(value: Context): string {
  return `coinflip.bankroll.descriptor.v1:${encodeURIComponent(JSON.stringify([value.publicKey, value.network, value.operatorUrl]))}`
}

function dispose(previous: Observer | null): void {
  if (!previous) return
  let cleanup: Promise<void>
  try { cleanup = previous.dispose() } catch { cleanup = Promise.resolve() }
  teardown = Promise.allSettled([teardown, cleanup]).then(() => {})
}

function invalidate(): number {
  generation++
  dispose(observer)
  observer = null
  pending = null
  return generation
}

function isCurrent(value: Context, token: number): boolean {
  return token === generation && matches(context, value) && matches(currentContext(), value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to verify the pool'
}

async function activate(text: string, persist: boolean): Promise<void> {
  const value = context
  if (!value || !matches(currentContext(), value)) throw new Error('Connect your wallet before importing a pool')
  const token = invalidate()
  descriptorText.value = text
  state.value = emptyBankrollDisplay('validating', selected)
  const task = Promise.resolve().then(async () => {
    let created: Observer | null = null
    let acceptsUpdates = true
    try {
      await teardown
      if (!isCurrent(value, token)) return
      const descriptor = parseBankrollDescriptor(text, value)
      const next = await createBankrollVaultObserver({
        wallet: value.wallet, descriptor, network: value.network, operatorUrl: value.operatorUrl,
        isCurrent: () => isCurrent(value, token),
        onState: display => { if (acceptsUpdates && isCurrent(value, token)) state.value = display },
      })
      created = next
      if (!isCurrent(value, token)) { dispose(next); return }
      if (persist) localStorage.setItem(storageKey(value), JSON.stringify(descriptor))
      observer = next
      selected = descriptor
      descriptorText.value = JSON.stringify(descriptor, null, 2)
    } catch (error) {
      acceptsUpdates = false
      dispose(created)
      if (!isCurrent(value, token)) return
      state.value = emptyBankrollDisplay('error', selected, message(error))
      throw error
    } finally {
      if (token === generation) pending = null
    }
  })
  pending = task
  return task
}

function changeContext(next: Context | null, restore = true): void {
  invalidate()
  context = next
  selected = undefined
  descriptorText.value = ''
  state.value = emptyBankrollDisplay(next ? 'unconfigured' : 'disconnected')
  if (!next || !restore) return
  try {
    const saved = localStorage.getItem(storageKey(next))
    if (saved) void activate(saved, false).catch(() => {})
  } catch (error) {
    state.value = emptyBankrollDisplay('error', undefined, message(error))
  }
}

function synchronize(restore = true): void {
  try {
    const next = currentContext()
    if (!matches(context, next)) changeContext(next, restore)
  } catch (error) {
    changeContext(null)
    state.value = emptyBankrollDisplay('error', undefined, message(error))
  }
}

async function importDescriptor(text: string): Promise<void> {
  synchronize(false)
  return activate(text, true)
}

async function refresh(): Promise<void> {
  synchronize()
  if (pending) return pending
  if (observer && context) {
    const current = observer, value = context, token = generation
    try { await current.refresh() } catch (error) {
      if (!isCurrent(value, token) || observer !== current) return
      state.value = emptyBankrollDisplay('error', selected, message(error))
      throw error
    }
    return
  }
  if (context && descriptorText.value) return activate(descriptorText.value, true)
}

function forget(): void {
  synchronize(false)
  let error: unknown
  try { if (context) localStorage.removeItem(storageKey(context)) } catch (failure) { error = failure }
  invalidate()
  selected = undefined
  descriptorText.value = ''
  state.value = emptyBankrollDisplay(error ? 'error' : context ? 'unconfigured' : 'disconnected', undefined,
    error ? `Could not remove the saved pool: ${message(error)}` : undefined)
}

function start(nextStore: PoolStore): () => void {
  if (store && store !== nextStore) throw new Error('Pool observer is already attached to another store')
  if (!store) {
    store = nextStore
    stopWatching = watch(() => [
      nextStore.state.ark.status, nextStore.state.wallet.publicKey,
      nextStore.state.ark.server, nextStore.state.ark.info?.network, getSDKWallet(),
    ], () => synchronize(), { immediate: true, flush: 'sync' })
  }
  users++
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    if (--users > 0) return
    stopWatching?.()
    stopWatching = null
    store = null
    changeContext(null)
  }
}

const pool = { state: readonly(state), descriptorText, importDescriptor, refresh, forget, start }

export function useBankrollPool() {
  return pool
}
