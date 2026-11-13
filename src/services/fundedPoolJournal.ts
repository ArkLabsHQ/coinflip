import type { PoolCommand, PoolPreparedGame } from 'arkade-coinflip/dist/pool-protocol.js'
import type { ArkTxInput, NormalizedExtendedVirtualCoin, Transaction, Wallet, VtxoReservation } from '@arkade-os/sdk'
import type { PoolFreshAuthorization, PoolFreshInput } from 'arkade-coinflip/dist/fresh-pool-input.js'
import type { FundedPoolDescriptor, FundedPoolPending, FundedPoolQuote, FundedPoolReceipt, PoolOutpoint } from './fundedPoolTypes'

export interface FundedPoolContext {
  publicKey: string
  network: string
  operatorUrl: string
}

export interface FundedPoolIntent {
  arkTxid: string
  expectedHead: PoolOutpoint
  memberOutpoint: PoolOutpoint
  unsignedArkTx: string
  unsignedCheckpoints: string[]
  signedArkTx?: string
  signedCheckpoints?: string[]
  command: PoolCommand
  quote: FundedPoolQuote
  playerSecretHex?: string
  game?: PoolPreparedGame
  playerPayoutPkScript?: string
  beforeState?: { supply: string; navSats: string; carriedLossSats: string; accruedFeesSats: string }
  cashRelease?: FundedPoolCashRelease
  freshStage?: FundedPoolFreshStage
}

export interface FundedPoolFreshStage {
  transfer: FundedPoolCashRelease
  sourceMember: NormalizedExtendedVirtualCoin
  stagedInput: PoolFreshInput
  authorization: PoolFreshAuthorization
  ownerAuthorizationPending: boolean
  ownerMessageHex?: string
  refund?: FundedPoolFreshRefund
  refundHistory?: FundedPoolFreshRefund[]
}

export interface FundedPoolFreshRefund {
  unsignedArkTx: string
  unsignedCheckpoints: string[]
  authorization: PoolFreshAuthorization
  arkTxid: string
  submitted: boolean
}

export interface FundedPoolCashRelease {
  arkTxid: string
  sourceOutpoint: PoolOutpoint
  unsignedArkTx: string
  unsignedCheckpoints: string[]
  signedArkTx?: string
  signedCheckpoints?: string[]
  inputs: ArkTxInput[]
  outputs: Array<ReturnType<Transaction['getOutput']>>
  serverUnrollScriptHex: string
  serverPubkeyHex: string
  cashSats: string
}

export interface FundedPoolJournalEntry {
  version: 1
  id: string
  context: FundedPoolContext
  descriptor: FundedPoolDescriptor
  createdAt: number
  status: 'pending' | 'confirmed' | 'abandoned'
  stage: FundedPoolPending['stage']
  intent?: FundedPoolIntent
  receipt?: FundedPoolReceipt
  batch?: { id: string; index: number; count: number }
  error: string | null
}

const DATABASE = 'coinflip-funded-pool'
const STORE = 'operations'
let connection: Promise<IDBDatabase> | undefined
const walletHolds = new WeakMap<Wallet, Map<string, VtxoReservation>>()

export function fundedPoolContextKey(context: FundedPoolContext): string {
  return JSON.stringify([context.publicKey, context.network, context.operatorUrl])
}

export function reserveFundedPoolInput(wallet: Wallet, id: string, outpoint: PoolOutpoint): VtxoReservation {
  let holds = walletHolds.get(wallet)
  if (!holds) { holds = new Map(); walletHolds.set(wallet, holds) }
  const existing = holds.get(id)
  if (existing) {
    if (existing.outpoints.length !== 1 || existing.outpoints[0].txid !== outpoint.txid || existing.outpoints[0].vout !== outpoint.vout) {
      throw new Error('Pool operation hold does not match its saved input')
    }
    return existing
  }
  const hold = wallet.reserveVtxos([outpoint])
  holds.set(id, hold)
  return hold
}

export function releaseFundedPoolInput(wallet: Wallet, id: string): void {
  const holds = walletHolds.get(wallet)
  holds?.get(id)?.release()
  holds?.delete(id)
}

export async function restorePoolHolds(wallet: Wallet, context: FundedPoolContext): Promise<void> {
  for (const entry of await loadFundedPoolJournal(context)) {
    if (entry.version !== 1 || fundedPoolContextKey(entry.context) !== fundedPoolContextKey(context)) {
      throw new Error('Invalid saved pool recovery context')
    }
    if (entry.status === 'pending') {
      if (!entry.intent) throw new Error('Pending pool operation has no saved transaction')
      reserveFundedPoolInput(wallet, entry.id, entry.intent.memberOutpoint)
      if (entry.intent.freshStage) reserveFundedPoolInput(wallet, `${entry.id}-source`, entry.intent.freshStage.transfer.sourceOutpoint)
      if (entry.intent.cashRelease) reserveFundedPoolInput(wallet, `${entry.id}-cash`, entry.intent.cashRelease.sourceOutpoint)
    }
  }
  const { restorePoolInputRenewalHolds } = await import('./fundedPoolInputRenewal')
  await restorePoolInputRenewalHolds(wallet, context)
}

const recordKey = (context: FundedPoolContext, id: string) => `${fundedPoolContextKey(context)}:${id}`

function database(): Promise<IDBDatabase> {
  if (!connection) connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('contextKey', 'contextKey')
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); connection = undefined }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('Pool recovery journal could not be opened'))
  }).catch(error => { connection = undefined; throw error })
  return connection
}

export async function loadFundedPoolJournal(context: FundedPoolContext): Promise<FundedPoolJournalEntry[]> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE)
    const request = tx.objectStore(STORE).index('contextKey').getAll(fundedPoolContextKey(context))
    let entries: FundedPoolJournalEntry[] = []
    request.onsuccess = () => { entries = request.result.map(({ key, contextKey, ...entry }) => {
      void key; void contextKey
      return entry as FundedPoolJournalEntry
    }) }
    tx.oncomplete = () => resolve(entries.sort((a, b) => a.createdAt - b.createdAt))
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Pool recovery journal could not be read'))
  })
}

export async function putFundedPoolJournal(entry: FundedPoolJournalEntry): Promise<void> {
  return putFundedPoolJournals([entry])
}

export async function putFundedPoolJournals(entries: readonly FundedPoolJournalEntry[]): Promise<void> {
  const db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    for (const entry of entries) tx.objectStore(STORE).put({ ...entry, key: recordKey(entry.context, entry.id), contextKey: fundedPoolContextKey(entry.context) })
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Pool recovery journal could not be saved'))
  })
}

export async function updateFundedPoolJournal(
  context: FundedPoolContext, id: string,
  change: (entry: FundedPoolJournalEntry) => FundedPoolJournalEntry,
): Promise<FundedPoolJournalEntry> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const request = store.get(recordKey(context, id))
    let updated: FundedPoolJournalEntry | undefined
    let failure: unknown
    request.onsuccess = () => {
      try {
        if (!request.result) throw new Error('Pool recovery operation is missing')
        const { key, contextKey, ...entry } = request.result
        void key; void contextKey
        updated = change(entry as FundedPoolJournalEntry)
        if (updated.id !== id || fundedPoolContextKey(updated.context) !== fundedPoolContextKey(context)) {
          throw new Error('Pool recovery operation identity cannot change')
        }
        store.put({ ...updated, key: recordKey(context, id), contextKey: fundedPoolContextKey(context) })
      } catch (error) { failure = error; tx.abort() }
    }
    tx.oncomplete = () => resolve(updated!)
    tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('Pool recovery journal update failed'))
  })
}

export async function confirmFundedPoolJournal(
  context: FundedPoolContext, id: string, receipt: FundedPoolReceipt,
): Promise<void> {
  await updateFundedPoolJournal(context, id, entry => {
    if (entry.status === 'confirmed' && entry.receipt?.arkTxid === receipt.arkTxid && entry.receipt.operationId === id) return entry
    if (entry.status !== 'pending' || !entry.intent || entry.intent.arkTxid !== receipt.arkTxid || receipt.operationId !== id) {
      throw new Error('Verified receipt does not match the saved pool operation')
    }
    return { version: 1, id, context: entry.context, descriptor: entry.descriptor, createdAt: entry.createdAt, batch: entry.batch,
      status: 'confirmed', stage: 'confirming', receipt, error: null }
  })
}
