import { SettlementEventType as EventType, Transaction, TxTree, toXOnly,
  type Batch, type SettlementEvent, type SignerSession, type TreeNonces, type TxTreeNode } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { sha256 } from '@scure/btc-signer/utils.js'

type PublicEvent = Exclude<SettlementEvent, { type: EventType.StreamStarted }>
export type PoolBatchReplayEvent = Exclude<PublicEvent, { type: EventType.BatchStarted | EventType.TreeNonces }>
  | { type: EventType.BatchStarted; id: string; intentIdHashes: string[]; batchExpiry: string }
  | { type: EventType.TreeNonces; id: string; topic: string[]; txid: string; nonces: [string, string][] }
export interface PoolBatchReplayJournal {
  version: 1
  revision: number
  intentId: string
  events: PoolBatchReplayEvent[]
}
export interface PoolBatchReplayPersistence {
  load(): Promise<PoolBatchReplayJournal | undefined>
  save(journal: PoolBatchReplayJournal, expectedRevision: number | null): Promise<boolean>
}

const MAX_EVENTS = 8192, MAX_NODES = 2048, MAX_PSBT = 2_000_000, MAX_JOURNAL = 32_000_000
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const equal = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second)
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      !equal(Object.keys(value).sort(), keys.slice().sort())) throw new Error('Invalid batch replay fields')
  return value as Record<string, unknown>
}
function text(value: unknown, limit = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > limit) throw new Error('Invalid batch replay string')
  return value
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('Invalid batch replay integer')
  return value
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid batch replay hash')
  return value
}
function key(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{64}|0[23][0-9a-f]{64})$/.test(value)) throw new Error('Invalid batch replay public key')
  return value
}
function list(value: unknown, item: (entry: unknown) => string, maximum = 4096): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('Invalid batch replay list')
  const result = value.map(item)
  if (new Set(result).size !== result.length) throw new Error('Duplicate batch replay list entry')
  return result
}
function transaction(value: unknown): string {
  const encoded = text(value, MAX_PSBT), bytes = base64.decode(encoded)
  if (base64.encode(bytes) !== encoded) throw new Error('Invalid batch replay PSBT encoding')
  const tx = Transaction.fromPSBT(bytes)
  if (!tx.inputsLength || !tx.outputsLength || tx.inputsLength > 4096 || tx.outputsLength > 4096) throw new Error('Invalid batch replay transaction size')
  return encoded
}
function node(value: unknown): TxTreeNode {
  const hasId = value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'txid')
  const fields = record(value, hasId ? ['txid', 'tx', 'children'] : ['tx', 'children']), tx = transaction(fields.tx)
  const actualId = Transaction.fromPSBT(base64.decode(tx)).id
  const id = fields.txid === undefined || fields.txid === '' ? actualId : hash(fields.txid)
  if (actualId !== id) throw new Error('Batch replay tree transaction ID changed')
  const raw = fields.children
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > MAX_NODES) throw new Error('Invalid batch replay children')
  const children: Record<number, string> = {}
  for (const [index, child] of Object.entries(raw)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(index)) throw new Error('Invalid batch replay output index')
    children[integer(Number(index), 4095)] = hash(child)
  }
  if (new Set(Object.values(children)).size !== Object.keys(children).length) throw new Error('Duplicate batch replay child')
  return { txid: id, tx, children }
}
export function decodePoolBatchReplayEvent(value: unknown): PublicEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid batch replay event')
  const kind = (value as Record<string, unknown>).type
  const common = ['type', 'id'], withTopic = [...common, 'topic']
  const schemas: Record<string, string[]> = {
    [EventType.BatchStarted]: [...common, 'intentIdHashes', 'batchExpiry'],
    [EventType.TreeTx]: [...withTopic, 'batchIndex', 'chunk'],
    [EventType.TreeSigningStarted]: [...common, 'cosignersPublicKeys', 'unsignedCommitmentTx'],
    [EventType.TreeNonces]: [...withTopic, 'txid', 'nonces'],
    [EventType.TreeSignature]: [...withTopic, 'batchIndex', 'txid', 'signature'],
    [EventType.BatchFinalization]: [...common, 'commitmentTx'],
    [EventType.BatchFinalized]: [...common, 'commitmentTxid'],
    [EventType.BatchFailed]: [...common, 'reason'],
  }
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(schemas, kind)) throw new Error('Unknown batch replay event')
  const entry = record(value, schemas[kind]), id = text(entry.id, 128)
  const topic = () => list(entry.topic, value => text(value), 4096)
  switch (kind) {
    case EventType.BatchStarted: {
      if (typeof entry.batchExpiry !== 'string' || !/^[1-9][0-9]{0,19}$/.test(entry.batchExpiry) || BigInt(entry.batchExpiry) > 0xffffffffffffffffn) throw new Error('Invalid batch replay expiry')
      return { type: kind, id, intentIdHashes: list(entry.intentIdHashes, hash), batchExpiry: BigInt(entry.batchExpiry) }
    }
    case EventType.TreeTx: return { type: kind, id, topic: topic(), batchIndex: integer(entry.batchIndex, 1), chunk: node(entry.chunk) }
    case EventType.TreeSigningStarted: return { type: kind, id, cosignersPublicKeys: list(entry.cosignersPublicKeys, key), unsignedCommitmentTx: transaction(entry.unsignedCommitmentTx) }
    case EventType.TreeNonces: {
      if (!Array.isArray(entry.nonces) || !entry.nonces.length || entry.nonces.length > MAX_NODES) throw new Error('Invalid batch replay nonces')
      const nonces: TreeNonces = new Map(), seen = new Set<string>()
      for (const pair of entry.nonces) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Invalid batch replay nonce entry')
        const pubkey = key(pair[0]), normalized = hex.encode(toXOnly(hex.decode(pubkey)))
        if (seen.has(normalized) || typeof pair[1] !== 'string' || !/^[0-9a-f]{132}$/.test(pair[1])) throw new Error('Invalid or duplicate batch replay nonce')
        seen.add(normalized); nonces.set(pubkey, { pubNonce: hex.decode(pair[1]) })
      }
      return { type: kind, id, topic: topic(), txid: hash(entry.txid), nonces }
    }
    case EventType.TreeSignature: {
      if (typeof entry.signature !== 'string' || !/^[0-9a-f]{128}$/.test(entry.signature)) throw new Error('Invalid batch replay signature')
      return { type: kind, id, topic: topic(), batchIndex: integer(entry.batchIndex, 1), txid: hash(entry.txid), signature: entry.signature }
    }
    case EventType.BatchFinalization: return { type: kind, id, commitmentTx: transaction(entry.commitmentTx) }
    case EventType.BatchFinalized: return { type: kind, id, commitmentTxid: hash(entry.commitmentTxid) }
    case EventType.BatchFailed: return { type: kind, id, reason: text(entry.reason, 4096) }
    default: throw new Error('Unknown batch replay event')
  }
}
export function encodePoolBatchReplayEvent(event: PublicEvent): PoolBatchReplayEvent {
  let value: unknown = event
  if (event.type === EventType.BatchStarted) value = { ...event, batchExpiry: event.batchExpiry.toString() }
  else if (event.type === EventType.TreeNonces) {
    if (!(event.nonces instanceof Map)) throw new Error('Batch replay nonces must be a Map')
    value = { ...event, nonces: [...event.nonces].map(([pubkey, nonce]) => [pubkey, hex.encode(nonce.pubNonce)]).sort(([a], [b]) => a.localeCompare(b)) }
  }
  const decoded = decodePoolBatchReplayEvent(value)
  if (decoded.type === EventType.BatchStarted) return { ...decoded, batchExpiry: decoded.batchExpiry.toString() }
  if (decoded.type === EventType.TreeNonces) return { ...decoded,
    nonces: [...decoded.nonces].map(([pubkey, nonce]) => [pubkey, hex.encode(nonce.pubNonce)] as [string, string]).sort(([a], [b]) => a.localeCompare(b)) }
  return clone(decoded)
}
function eventKey(event: PublicEvent): string {
  if (event.type === EventType.TreeTx) return `${event.type}:${event.batchIndex}:${event.chunk.txid}`
  if (event.type === EventType.TreeSignature) return `${event.type}:${event.batchIndex}:${event.txid}`
  if (event.type === EventType.TreeNonces) return `${event.type}:${event.txid}`
  return event.type
}
function completeTree(nodes: TxTreeNode[]): void {
  if (!nodes.length || nodes.length > MAX_NODES) throw new Error('Incomplete batch replay tree')
  const all = new Set(nodes.map(value => value.txid)), parents = new Set<string>()
  for (const value of nodes) for (const child of Object.values(value.children)) {
    if (parents.has(child)) throw new Error('Shared batch replay child')
    parents.add(child)
  }
  const roots = nodes.filter(value => !parents.has(value.txid))
  if (roots.length !== 1) throw new Error('Invalid batch replay tree roots')
  const pending = [roots[0].txid], seen = new Set<string>(), byId = new Map(nodes.map(value => [value.txid, value]))
  while (pending.length) {
    const id = pending.pop()!
    if (seen.has(id)) throw new Error('Cyclic batch replay tree')
    seen.add(id); pending.push(...Object.values(byId.get(id)!.children).filter(child => all.has(child)))
  }
  if (seen.size !== nodes.length) throw new Error('Disconnected batch replay tree')
  TxTree.create(nodes).validate()
}
function validateJournal(value: unknown, intentId: string): PoolBatchReplayJournal {
  const entry = record(value, ['version', 'revision', 'intentId', 'events'])
  if (entry.version !== 1 || entry.intentId !== intentId || !Array.isArray(entry.events) || entry.events.length > MAX_EVENTS ||
      integer(entry.revision, MAX_EVENTS) !== entry.events.length || new TextEncoder().encode(JSON.stringify(entry)).length > MAX_JOURNAL) throw new Error('Invalid batch replay journal')
  const intentHash = hex.encode(sha256(new TextEncoder().encode(intentId))), keys = new Set<string>()
  const trees: TxTreeNode[][] = [[], []]
  let batch: string | undefined, phase = 0, commitment: string | undefined
  for (const raw of entry.events) {
    const event = decodePoolBatchReplayEvent(raw), identity = eventKey(event)
    if (keys.has(identity)) throw new Error('Duplicate saved batch replay event')
    keys.add(identity)
    if (phase === 5 || batch && event.id !== batch) throw new Error('Mixed or completed batch replay')
    if (event.type === EventType.BatchStarted) {
      if (phase || !event.intentIdHashes.includes(intentHash)) throw new Error('Batch replay is bound to another intent')
      batch = event.id; phase = 1
    } else if (!phase) throw new Error('Batch replay is missing its start event')
    else if (event.type === EventType.TreeTx) {
      if (event.batchIndex === 0 ? phase !== 1 : phase !== 1 && phase !== 3) throw new Error('Discontinuous batch replay tree')
      trees[event.batchIndex].push(event.chunk)
      if (trees[event.batchIndex].length > MAX_NODES) throw new Error('Batch replay tree exceeds its limit')
    } else if (event.type === EventType.TreeSigningStarted) {
      if (phase !== 1 || !event.cosignersPublicKeys.length) throw new Error('Discontinuous batch replay signing')
      completeTree(trees[0]); commitment = Transaction.fromPSBT(base64.decode(event.unsignedCommitmentTx)).id; phase = 2
    } else if (event.type === EventType.TreeNonces) {
      if (phase !== 2 && phase !== 3 || !trees[0].some(value => value.txid === event.txid)) throw new Error('Discontinuous batch replay nonces')
      phase = 3
    } else if (event.type === EventType.TreeSignature) {
      if (phase !== 3 || !trees[event.batchIndex].some(value => value.txid === event.txid)) throw new Error('Discontinuous batch replay signature')
    } else if (event.type === EventType.BatchFinalization) {
      if (phase !== 3 || Transaction.fromPSBT(base64.decode(event.commitmentTx)).id !== commitment) throw new Error('Discontinuous batch replay finalization')
      if (trees[1].length) completeTree(trees[1])
      phase = 4
    } else if (event.type === EventType.BatchFinalized) {
      if (phase !== 4 || event.commitmentTxid !== commitment) throw new Error('Discontinuous batch replay completion')
      phase = 5
    } else if (event.type === EventType.BatchFailed) phase = 5
  }
  return clone(value as PoolBatchReplayJournal)
}
export function hasSavedPoolTreeNonces(events: readonly SettlementEvent[], publicKey: Uint8Array, expected: TreeNonces): boolean {
  const ours = hex.encode(toXOnly(publicKey)), found = new Set<string>()
  if (!expected.size) return false
  for (const event of events) if (event.type === EventType.TreeNonces) for (const [pubkey, nonce] of event.nonces) {
    if (hex.encode(toXOnly(hex.decode(pubkey))) !== ours) continue
    const wanted = expected.get(event.txid)
    if (!wanted || !equal([...nonce.pubNonce], [...wanted.pubNonce])) return false
    found.add(event.txid)
  }
  return [...expected.keys()].every(txid => found.has(txid))
}
export function createPoolTreeNonceReplayGuard(session: SignerSession, savedEvents: readonly SettlementEvent[]): {
  session: SignerSession
  handler(base: Batch.Handler): Batch.Handler
} {
  const saved = savedEvents.filter((event): event is PublicEvent => event.type !== EventType.StreamStarted)
    .map(event => decodePoolBatchReplayEvent(encodePoolBatchReplayEvent(event)))
  type Attempt = { initialized: boolean; publicKey?: Uint8Array; nonces?: TreeNonces }
  let active: Attempt | undefined
  const facade: SignerSession = {
    getPublicKey: async () => {
      const attempt = active, key = await session.getPublicKey()
      if (attempt?.initialized && active === attempt) attempt.publicKey = key.slice()
      return key
    },
    init: async (...args) => {
      const attempt = active
      await session.init(...args)
      if (attempt && active === attempt) { attempt.initialized = true; attempt.publicKey = undefined; attempt.nonces = undefined }
    },
    getNonces: async () => {
      const attempt = active, nonces = await session.getNonces()
      if (attempt?.initialized && attempt.publicKey && active === attempt) {
        attempt.nonces = new Map([...nonces].map(([txid, nonce]) => [txid, { pubNonce: nonce.pubNonce.slice() }]))
      }
      return nonces
    },
    aggregatedNonces: (...args) => session.aggregatedNonces(...args),
    sign: () => session.sign(),
  }
  return { session: facade, handler: base => ({ ...base, onTreeSigningStarted: async (event, tree) => {
    if (active) throw new Error('Pool nonce replay handler requires exclusive access')
    const attempt: Attempt = { initialized: false }
    active = attempt
    try { return await base.onTreeSigningStarted(event, tree) }
    catch (error) {
      const acceptedSigning = saved.find(value => value.type === EventType.TreeSigningStarted)
      // SDK 0.5.4 validates and initializes the session before getNonces; only its nonce RPC follows.
      if (!attempt.nonces || !attempt.publicKey || saved.some(value => value.id !== event.id) ||
          !saved.some(value => value.type === EventType.BatchStarted) ||
          !acceptedSigning || !equal(encodePoolBatchReplayEvent(acceptedSigning), encodePoolBatchReplayEvent(event)) ||
          !hasSavedPoolTreeNonces(saved, attempt.publicKey, attempt.nonces)) throw error
      return { skip: false }
    } finally { active = undefined }
  } }) }
}
export async function createDurablePoolBatchReplay(persistence: PoolBatchReplayPersistence, options: { intentId: string }): Promise<{
  savedEvents(): SettlementEvent[]
  stream(source: AsyncIterable<SettlementEvent>, signal?: AbortSignal): AsyncGenerator<SettlementEvent>
}> {
  const intentId = text(options.intentId, 128)
  const loaded = await persistence.load()
  let journal = loaded ? validateJournal(loaded, intentId) : { version: 1 as const, revision: 0, intentId, events: [] }
  if (!loaded && !await persistence.save(clone(journal), null)) throw new Error('Batch replay initialization lost its revision permission')
  let active = false, poisoned = false
  return {
    savedEvents: () => journal.events.map(decodePoolBatchReplayEvent),
    async *stream(source, signal) {
      if (active || poisoned) throw new Error('Batch replay requires a fresh exclusive instance')
      active = true
      try {
        for (const event of journal.events) { signal?.throwIfAborted(); yield decodePoolBatchReplayEvent(event) }
        for await (const event of source) {
          signal?.throwIfAborted()
          if (event.type === EventType.StreamStarted) continue
          const first = journal.events[0]
          if (!first) {
            if (event.type !== EventType.BatchStarted || !event.intentIdHashes.includes(hex.encode(sha256(new TextEncoder().encode(intentId))))) continue
          } else if (event.id !== first.id) continue
          const encoded = encodePoolBatchReplayEvent(event), identity = eventKey(decodePoolBatchReplayEvent(encoded))
          const existing = journal.events.find(value => eventKey(decodePoolBatchReplayEvent(value)) === identity)
          if (existing) {
            if (!equal(existing, encoded)) throw new Error('A batch replay event changed its saved content')
            continue
          }
          const next = validateJournal({ ...journal, revision: journal.revision + 1, events: [...journal.events, encoded] }, intentId)
          if (!await persistence.save(clone(next), journal.revision)) throw new Error('Batch replay append lost its revision permission')
          journal = next
          signal?.throwIfAborted()
          yield decodePoolBatchReplayEvent(encoded)
        }
      } catch (error) { poisoned = true; throw error }
      finally { active = false }
    },
  }
}
