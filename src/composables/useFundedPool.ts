import { readonly, shallowRef, watch } from 'vue'
import type { Wallet } from '@arkade-os/sdk'
import { getSDKWallet } from '@/store/modules/ark/walletRuntime'
import { normalizePoolOperatorUrl } from '@/services/bankrollVaultObserver'
import { createFundedPoolRuntime, emptyFundedPoolDisplay } from '@/services/fundedPoolRuntime'
import type { FundedPoolBetInput, FundedPoolInputRenewalDisplay, FundedPoolInputRenewalQuote, FundedPoolQuote } from '@/services/fundedPoolTypes'
import type { FundedPoolContext } from '@/services/fundedPoolJournal'

interface PoolStore {
  state: {
    wallet: { publicKey: string | null }
    ark: { status: string; server: string; info: { network: string } | null }
  }
}
interface Context extends FundedPoolContext { wallet: Wallet }
type Runtime = ReturnType<typeof createFundedPoolRuntime>
const state = shallowRef(emptyFundedPoolDisplay('disconnected'))
const renewalState = shallowRef<FundedPoolInputRenewalDisplay>({ status: 'idle', error: null, intentId: null })
let store: PoolStore | null = null, context: Context | null = null, runtime: Runtime | null = null
let generation = 0, users = 0
let stopWatching: (() => void) | undefined
let teardown = Promise.resolve()

function currentContext(): Context | null {
  if (!store || store.state.ark.status !== 'connected' || !store.state.wallet.publicKey || !store.state.ark.info?.network) return null
  const wallet = getSDKWallet()
  return wallet ? { wallet, publicKey: store.state.wallet.publicKey, network: store.state.ark.info.network,
    operatorUrl: normalizePoolOperatorUrl(store.state.ark.server) } : null
}
function matches(a: Context | null, b: Context | null): boolean {
  return a === b || !!a && !!b && a.wallet === b.wallet && a.publicKey === b.publicKey && a.network === b.network && a.operatorUrl === b.operatorUrl
}
function synchronize(): void {
  let next: Context | null
  try { next = currentContext() } catch { next = null }
  if (matches(context, next)) return
  const previous = runtime
  generation++
  runtime = null; context = next
  state.value = emptyFundedPoolDisplay(next ? 'loading' : 'disconnected')
  renewalState.value = { status: 'idle', error: null, intentId: null }
  if (previous) {
    const closing = previous.dispose()
    teardown = Promise.allSettled([teardown, closing]).then(() => {})
  }
  if (!next) return
  const value = next, token = generation
  const current = () => token === generation && matches(context, value) && matches(currentContext(), value)
  const created = createFundedPoolRuntime({ wallet: value.wallet, context: value, isCurrent: current,
    onState: display => { if (current()) state.value = display },
    onRenewalState: display => { if (current()) renewalState.value = display } })
  runtime = created
  void teardown.then(async () => { if (current()) await created.refresh() }).catch(() => {})
}

function active(): Runtime {
  synchronize()
  if (!runtime) throw new Error('Connect your wallet before using the funded pool')
  return runtime
}
async function refresh(): Promise<void> {
  synchronize()
  if (!runtime) return
  const selected = runtime, token = generation
  await teardown
  if (selected === runtime && token === generation) await selected.refresh()
}
function start(nextStore: PoolStore): () => void {
  if (store && store !== nextStore) throw new Error('Funded pool is already attached to another wallet store')
  if (!store) {
    store = nextStore
    stopWatching = watch(() => [nextStore.state.ark.status, nextStore.state.wallet.publicKey, nextStore.state.ark.server,
      nextStore.state.ark.info?.network, getSDKWallet()], synchronize, { immediate: true, flush: 'sync' })
  }
  users++
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    if (--users > 0) return
    stopWatching?.(); stopWatching = undefined
    store = null
    synchronize()
  }
}
const pool = { state: readonly(state), renewalState: readonly(renewalState), start, refresh, recover: () => active().recover(),
  rescue: () => active().rescue(),
  prepareRenewInputs: () => active().prepareRenewInputs(),
  confirmRenewInputs: (quote: FundedPoolInputRenewalQuote) => active().confirmRenewInputs(quote),
  prepareSubscribe: (amount: bigint) => active().prepareSubscribe(amount),
  prepareRedeem: (amount: bigint) => active().prepareRedeem(amount),
  prepareBet: (bet: FundedPoolBetInput) => active().prepareBet(bet),
  confirm: (quote: FundedPoolQuote) => active().confirm(quote) }
export function useFundedPool() { return pool }
