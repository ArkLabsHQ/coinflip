import { ArkAddress, Estimator, isVtxoSpent, toOffchainInputFeeParams,
  type NormalizedExtendedVirtualCoin, type Wallet } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import type { PoolRenewalSessionJournal } from 'arkade-coinflip/dist/pool-renewal-session.js'
import type { PoolBatchReplayJournal } from 'arkade-coinflip/dist/pool-batch-replay.js'
import type { PoolInputRenewalJournal, PoolInputRenewalPersistence } from 'arkade-coinflip/dist/pool-input-renewal.js'
import { fundedPoolContextKey, releaseFundedPoolInput, reserveFundedPoolInput, type FundedPoolContext } from './fundedPoolJournal'
import type { FundedPoolInputRenewalDisplay, FundedPoolInputRenewalQuote } from './fundedPoolTypes'

type Requirement = { kind: 'plain' | 'shares'; amount: bigint }
interface SavedRenewal {
  key: string; version: 3; context: FundedPoolContext; quote: FundedPoolInputRenewalQuote
  journal?: PoolInputRenewalJournal; state: 'pending' | 'confirmed' | 'aborted'
}
interface Plan { quote: FundedPoolInputRenewalQuote; address: string; coins: NormalizedExtendedVirtualCoin[] }
const DATABASE = 'coinflip-pool-input-renewal-v1', STORE = 'renewals', SESSIONS = 'sessions', REPLAY = 'replay'
const pointKey = (point: { txid: string; vout: number }) => `${point.txid}:${point.vout}`
let connection: Promise<IDBDatabase> | undefined
async function database(): Promise<IDBDatabase> {
  if (!connection) connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2)
    request.onupgradeneeded = () => {
      for (const name of [STORE, SESSIONS, REPLAY]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'key' })
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); connection = undefined }; resolve(db) }
  }).catch(error => { connection = undefined; throw error })
  return connection
}
async function records(context: FundedPoolContext): Promise<SavedRenewal[]> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE), request = transaction.objectStore(STORE).getAll()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve((request.result as SavedRenewal[]).filter(record => fundedPoolContextKey(record.context) === fundedPoolContextKey(context)))
  })
}
async function save(record: SavedRenewal): Promise<void> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite'), table = transaction.objectStore(STORE), existing = table.get(record.key)
    let failure: Error | undefined
    existing.onsuccess = () => {
      const before = existing.result as SavedRenewal | undefined
      if (before && (before.state === 'confirmed' && record.state !== 'confirmed' || before.state === 'aborted' && record.state === 'pending' || before.journal && (!record.journal ||
        before.journal.proof !== record.journal.proof || before.journal.registrationAttempted && !record.journal.registrationAttempted))) {
        failure = new Error('Wallet renewal recovery cannot discard its saved intent'); transaction.abort(); return
      }
      try { table.put(record) } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); transaction.abort() }
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Wallet renewal recovery could not be saved'))
  })
}
function hold(wallet: Wallet, quote: FundedPoolInputRenewalQuote): ReturnType<Wallet['reserveVtxos']> {
  try { quote.inputs.forEach((input, index) => reserveFundedPoolInput(wallet, `wallet-renew:${quote.id}:${index}`, input.outpoint)) }
  catch (error) { release(wallet, quote); throw error }
  return { outpoints: quote.inputs.map(input => input.outpoint), release: () => release(wallet, quote) }
}
function release(wallet: Wallet, quote: FundedPoolInputRenewalQuote): void {
  quote.inputs.forEach((_, index) => releaseFundedPoolInput(wallet, `wallet-renew:${quote.id}:${index}`))
}
export async function restorePoolInputRenewalHolds(wallet: Wallet, context: FundedPoolContext): Promise<void> {
  for (const record of await records(context)) {
    if (record.version !== 3 || record.key !== `${fundedPoolContextKey(context)}:${record.quote.id}`) throw new Error('Invalid wallet renewal recovery context')
    if (record.state === 'pending') hold(wallet, record.quote)
  }
}
async function loadRevision<T>(store: string, key: string): Promise<T | undefined> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key)
    request.onsuccess = () => resolve(request.result?.value as T | undefined)
    request.onerror = () => reject(request.error)
  })
}
async function saveRevision<T extends { revision: number }>(store: string, key: string, value: T, expected: number | null): Promise<boolean> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite'), table = transaction.objectStore(store), request = table.get(key)
    let accepted = false
    request.onsuccess = () => {
      if ((request.result?.value.revision ?? null) !== expected) return
      table.put({ key, value }); accepted = true
    }
    transaction.oncomplete = () => resolve(accepted)
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Wallet renewal signing state could not be saved'))
  })
}
function snapshot(coin: NormalizedExtendedVirtualCoin) {
  return { outpoint: { txid: coin.txid, vout: coin.vout }, valueSats: String(coin.value), expiresAt: coin.expiresAt?.getTime() ?? null,
    assets: (coin.assets ?? []).map(asset => ({ assetId: asset.assetId, amount: asset.amount.toString() })) }
}
function sameSource(coin: NormalizedExtendedVirtualCoin, expected: FundedPoolInputRenewalQuote['inputs'][number]): boolean {
  return JSON.stringify(snapshot(coin)) === JSON.stringify(expected)
}
async function feeFor(wallet: Wallet, coins: NormalizedExtendedVirtualCoin[], address: string): Promise<bigint> {
  const info = await wallet.getArkadeInfo({ requireLive: true }), estimator = new Estimator(info.fees.intentFee)
  const total = coins.reduce((sum, coin) => sum + BigInt(coin.value), 0n), script = hex.encode(ArkAddress.decode(address).pkScript)
  let fee = 0n
  for (let i = 0; i < 16; i++) {
    if (total - fee < 330n) throw new Error('Selected wallet inputs cannot cover the batch fee and a 330-sat carrier')
    const outputs = coins.some(coin => coin.assets?.length) && total - fee >= 660n ? [{ amount: 330n, script }, { amount: total - fee - 330n, script }] : [{ amount: total - fee, script }]
    const next = BigInt(estimator.evaluate(coins.map(toOffchainInputFeeParams), [], outputs, []).satoshis)
    if (next < 0n) throw new Error('The operator returned an invalid batch fee')
    if (next === fee) return fee
    fee = next
  }
  throw new Error('The batch fee estimate did not converge')
}

export function createFundedPoolInputRenewal(options: {
  wallet: Wallet; context: FundedPoolContext; shareAssetId: string; minimumLifetimeSeconds: number; isCurrent(): boolean
  onState(state: FundedPoolInputRenewalDisplay): void
}) {
  const { wallet } = options, plans = new Map<string, Plan>()
  const context: FundedPoolContext = Object.freeze({ publicKey: options.context.publicKey, network: options.context.network, operatorUrl: options.context.operatorUrl })
  if (Object.values(context).some(value => typeof value !== 'string')) throw new Error('Invalid wallet renewal recovery context')
  let disposed = false, busy = false, active: AbortController | undefined
  const current = () => !disposed && options.isCurrent()
  const assertCurrent = () => { if (!current()) throw new Error('Wallet context changed during input renewal') }
  const publish = (status: FundedPoolInputRenewalDisplay['status'], error: string | null = null, intentId: string | null = null) => {
    if (current()) options.onState({ status, error, intentId })
  }
  const eligible = (coin: NormalizedExtendedVirtualCoin) => !coin.isUnrolled && !isVtxoSpent(coin) &&
    (!coin.assets?.length || coin.assets.length === 1 && coin.assets[0].assetId === options.shareAssetId && coin.assets[0].amount > 0n)
  function persistence(record: SavedRenewal): PoolInputRenewalPersistence {
    return {
      load: async () => (await records(context)).find(value => value.key === record.key)?.journal,
      save: async journal => { assertCurrent(); await save({ ...record, journal, state: journal.status === 'confirmed' ? 'confirmed' : 'pending' }) },
      loadSession: () => loadRevision<PoolRenewalSessionJournal>(SESSIONS, record.key),
      saveSession: (next, revision) => saveRevision(SESSIONS, record.key, next, revision),
      loadReplay: () => loadRevision<PoolBatchReplayJournal>(REPLAY, record.key),
      saveReplay: (next, revision) => saveRevision(REPLAY, record.key, next, revision),
    }
  }
  async function refresh(): Promise<void> {
    if (busy) return
    const pending = (await records(context)).filter(record => record.state === 'pending'); assertCurrent()
    if (!pending.length) { if (!busy) publish('idle'); return }
    const core = await import('arkade-coinflip/dist/pool-input-renewal.js'); assertCurrent()
    for (const record of pending) {
      if (record.version !== 3) throw new Error('Unsupported wallet renewal recovery data')
      hold(wallet, record.quote)
      if (!record.journal) { await save({ ...record, state: 'aborted' }); release(wallet, record.quote); publish('needed'); continue }
      const receipt = await core.readPoolInputRenewalReceipt(wallet, record.journal); assertCurrent()
      if (receipt) {
        const confirmed: PoolInputRenewalJournal = { ...record.journal, status: 'confirmed', commitmentTxid: receipt.commitmentTxid }
        await persistence(record).save(confirmed); core.restorePoolInputRenewalHolds(wallet, confirmed)
        release(wallet, record.quote); publish('idle'); continue
      }
      if (core.renewalAbandonable(record.journal.message)) {
        await save({ ...record, state: 'aborted' }); release(wallet, record.quote)
        publish('needed', 'A saved wallet renewal lapsed without a batch outcome; its inputs are released'); continue
      }
      publish('recovery', record.journal.registrationAttempted && !record.journal.intentId ?
        'Wallet renewal registration is unknown; its exact inputs remain reserved for operator recovery' :
        'Resume the saved wallet renewal; its exact inputs remain reserved', record.journal.intentId ?? null)
    }
  }
  async function prepare(requirement?: Requirement): Promise<FundedPoolInputRenewalQuote> {
    assertCurrent()
    if (busy || (await records(context)).some(record => record.state === 'pending')) throw new Error('Reconcile the pending wallet renewal first')
    publish('preparing')
    try {
    const available = (await wallet.getSpendableVtxos({ requireSynced: true, withRecoverable: true, genericallySpendableOnly: true })).filter(eligible); assertCurrent()
    const aging = available.filter(coin => !coin.expiresAt || coin.expiresAtHeight != null || coin.expiresAt.getTime() <= Date.now() + (options.minimumLifetimeSeconds + 120) * 1000)
    const source = requirement?.kind === 'shares' ? aging.filter(coin => coin.assets?.length) : requirement?.kind === 'plain' ? aging.filter(coin => !coin.assets?.length) : aging
    source.sort((a, b) => requirement?.kind === 'shares' ? Number((b.assets?.[0].amount ?? 0n) - (a.assets?.[0].amount ?? 0n)) : b.value - a.value)
    if (!source.length) throw new Error('No eligible aging wallet input needs renewal')
    const chosen: NormalizedExtendedVirtualCoin[] = []
    let quantity = 0n
    for (const coin of source) {
      chosen.push(coin); quantity += requirement?.kind === 'shares' ? coin.assets![0].amount : BigInt(coin.value)
      if (!requirement || quantity >= requirement.amount) break
    }
    if (requirement && quantity < requirement.amount) throw new Error('The selected aging wallet inputs cannot fund this pool action')
    const address = await wallet.getAddress(); assertCurrent()
    let fee: bigint
    try { fee = await feeFor(wallet, chosen, address) }
    catch (error) {
      if (!chosen.some(coin => coin.assets?.length)) throw error
      const sponsor = available.filter(coin => !coin.assets?.length && !chosen.includes(coin)).sort((a, b) => a.value - b.value).find(coin => coin.value >= 660)
      if (!sponsor) throw error
      chosen.push(sponsor); fee = await feeFor(wallet, chosen, address)
    }
    assertCurrent()
    const total = chosen.reduce((sum, coin) => sum + BigInt(coin.value), 0n)
    if (requirement?.kind === 'plain' && total - fee < requirement.amount) throw new Error('The reviewed renewal fee leaves too little bitcoin for this pool action')
    const quote: FundedPoolInputRenewalQuote = Object.freeze({ id: crypto.randomUUID(), expiresAt: Date.now() + 60_000, network: context.network,
      operatorUrl: context.operatorUrl, inputs: Object.freeze(chosen.map(coin => {
        const input = snapshot(coin)
        return Object.freeze({ ...input, outpoint: Object.freeze(input.outpoint), assets: Object.freeze(input.assets.map(value => Object.freeze(value))) })
      })), inputTotalSats: String(total),
      estimatedFeeSats: String(fee), estimatedOutputSats: String(total - fee), feeEstimateOnly: false })
    plans.set(quote.id, { quote, address, coins: chosen }); publish('needed')
    return quote
    } catch (error) { publish('needed', error instanceof Error ? error.message : String(error)); throw error }
  }
  async function confirm(quote: FundedPoolInputRenewalQuote): Promise<void> {
    assertCurrent()
    if (busy) throw new Error('A wallet renewal is already running')
    const plan = plans.get(quote.id)
    if (!plan || quote !== plan.quote || quote.expiresAt <= Date.now()) throw new Error('Review a fresh wallet renewal quote')
    busy = true
    let record: SavedRenewal | undefined, held = false
    const controller = new AbortController(); active = controller
    try {
      const available = await wallet.getSpendableVtxos({ requireSynced: true, withRecoverable: true, genericallySpendableOnly: true }); assertCurrent()
      const coins = quote.inputs.map(input => available.find(coin => pointKey(coin) === pointKey(input.outpoint)))
      if (coins.some((coin, index) => !coin || !eligible(coin) || !sameSource(coin, quote.inputs[index]))) throw new Error('Wallet renewal inputs changed; review them again')
      const reservation = hold(wallet, quote); held = true
      if (await wallet.getAddress() !== plan.address) throw new Error('The wallet receive address changed; review the renewal again')
      const fee = await feeFor(wallet, coins as NormalizedExtendedVirtualCoin[], plan.address); assertCurrent()
      if (fee > BigInt(quote.estimatedFeeSats)) throw new Error('The batch fee increased; review a new maximum fee')
      const core = await import('arkade-coinflip/dist/pool-input-renewal.js'); assertCurrent()
      record = { key: `${fundedPoolContextKey(context)}:${quote.id}`, version: 3, context, quote, state: 'pending' }
      await save(record); assertCurrent(); publish('renewing')
      await core.renewPoolInputs(wallet, persistence(record), { signal: controller.signal, reservation, plan: {
        inputs: coins as NormalizedExtendedVirtualCoin[], address: plan.address, outputSats: BigInt(quote.estimatedOutputSats), maximumFeeSats: BigInt(quote.estimatedFeeSats) } })
      assertCurrent(); plans.delete(quote.id); release(wallet, quote); publish('idle')
    } catch (error) {
      const stored = record ? (await records(context)).find(value => value.key === record!.key) : undefined
      if (held && !stored?.journal?.registrationAttempted) {
        if (stored) await save({ ...stored, state: 'aborted' })
        release(wallet, quote)
      }
      publish(stored?.journal?.registrationAttempted ? 'recovery' : 'needed', error instanceof Error ? error.message : String(error))
      throw error
    } finally { busy = false; if (active === controller) active = undefined }
  }
  async function recover(): Promise<void> {
    assertCurrent()
    if (busy) throw new Error('A wallet renewal is already running')
    busy = true
    const controller = new AbortController(); active = controller
    try {
      const core = await import('arkade-coinflip/dist/pool-input-renewal.js'); assertCurrent()
      for (const record of (await records(context)).filter(value => value.state === 'pending')) {
        if (!record.journal) throw new Error('No saved wallet renewal intent is available; refresh its recovery state')
        const reservation = hold(wallet, record.quote); publish('renewing', null, record.journal.intentId ?? null)
        try { await core.renewPoolInputs(wallet, persistence(record), { signal: controller.signal, reservation }); assertCurrent() }
        catch (error) {
          const latest = (await records(context)).find(value => value.key === record.key), lapsed = core.isPoolRenewalAbandoned(error)
          if (latest?.journal && (lapsed || !latest.journal.registrationAttempted && latest.journal.message.expire_at <= Math.floor(Date.now() / 1000))) {
            await save({ ...latest, state: 'aborted' }); release(wallet, latest.quote)
            publish('needed', lapsed ? (error as Error).message : 'The unsubmitted wallet renewal expired; review a new quote'); return
          }
          throw error
        }
        release(wallet, record.quote)
      }
      publish('idle')
    } catch (error) { publish('recovery', error instanceof Error ? error.message : String(error)); throw error }
    finally { busy = false; if (active === controller) active = undefined }
  }
  return { prepare, confirm, refresh, recover, dispose() { disposed = true; active?.abort(); plans.clear() } }
}
