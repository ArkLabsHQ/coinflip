import { CosignerPublicKey, TxTree, getArkPsbtFields,
  type IndexerProvider, type SignerSession, type TreeNonces, type TreePartialSigs } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import * as musig2 from '@scure/btc-signer/musig2.js'
import { Script } from '@scure/btc-signer/script.js'
import { SigHash } from '@scure/btc-signer/transaction.js'
import { randomPrivateKeyBytes, sha256 } from '@scure/btc-signer/utils.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'

export interface PoolRenewalSigningContext {
  rootTxid: string
  nodes: Array<{ txid: string; tx: string; children: Record<number, string> }>
  scriptRoot: string
  rootInputAmount: string
  digest: string
}
export interface PoolRenewalSessionNonce {
  publicNonce: string
  secretNonce?: string
  message: string
  aggregate?: { participants: Record<string, string>; publicNonce: string; binding: string }
  partialSignature?: string
}
export interface PoolRenewalSessionJournal {
  version: 1
  revision: number
  secretKey: string
  publicKey: string
  context?: PoolRenewalSigningContext
  nonces: Record<string, PoolRenewalSessionNonce>
}
export interface PoolRenewalSessionPersistence {
  load(): Promise<PoolRenewalSessionJournal | undefined>
  // The store must durably compare revisions and never roll back a committed nonce binding.
  save(journal: PoolRenewalSessionJournal, expectedRevision: number | null): Promise<boolean>
}

// arkd keeps queued intents past expire_at, but a batch cannot finalize without this session's cosigner.
// Resumes refuse after expire_at and live joins are time-bounded; the margin covers a batch already fully signed.
export const RENEWAL_ABANDON_MARGIN_SECONDS = 600
export class PoolRenewalAbandonedError extends Error { readonly code = 'POOL_RENEWAL_ABANDONED' }
export const isPoolRenewalAbandoned = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'POOL_RENEWAL_ABANDONED'
export const renewalAbandonable = (message: { expire_at: number }): boolean =>
  message.expire_at > 0 && Math.floor(Date.now() / 1000) >= message.expire_at + RENEWAL_ABANDON_MARGIN_SECONDS

/** Batch inputs carry the indexer's swept/spent state: a stale wallet copy makes the SDK expect forfeits arkd will not take. */
export async function withIndexedState<T extends { txid: string; vout: number }>(indexer: Pick<IndexerProvider, 'getVtxos'>, coins: T[]): Promise<T[]> {
  if (!coins.length) return coins
  const live = (await indexer.getVtxos({ outpoints: coins.map(({ txid, vout }) => ({ txid, vout })), spendableOnly: false })).vtxos
  return coins.map(coin => {
    const fresh = live.find(value => value.txid === coin.txid && value.vout === coin.vout)
    if (!fresh) throw new Error('Renewal input is not indexed')
    return { ...coin, isSwept: fresh.isSwept, isSpent: fresh.isSpent, isUnrolled: fresh.isUnrolled, spentBy: fresh.spentBy, settledBy: fresh.settledBy }
  })
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
const digest = (value: unknown) => hex.encode(sha256(new TextEncoder().encode(canonical(value))))
const isHex = (value: unknown, bytes: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value)
const xonly = (value: Uint8Array) => hex.encode(value.subarray(1))
function fail(reason: string): never { throw new Error(`Pool renewal signing session: ${reason}`) }
function partialSignature(encoded: string) {
  const s = hex.decode(encoded)
  return { s, R: new Uint8Array(33), encode: () => Uint8Array.from(s) }
}

function contextFor(tree: TxTree, scriptRoot: Uint8Array, amount: bigint): PoolRenewalSigningContext {
  if (scriptRoot.length !== 32 || amount <= 0n || amount > 2_100_000_000_000_000n) fail('invalid root context')
  tree.validate()
  const nodes = [...tree.iterator()].map(node => ({ txid: node.txid, tx: base64.encode(node.root.toPSBT()),
    children: Object.fromEntries([...node.children].sort(([a], [b]) => a - b).map(([index, child]) => [index, child.txid])) }))
    .sort((a, b) => a.txid.localeCompare(b.txid))
  if (new Set(nodes.map(node => node.txid)).size !== nodes.length) fail('duplicate tree transaction')
  const body = { rootTxid: tree.txid, nodes, scriptRoot: hex.encode(scriptRoot), rootInputAmount: String(amount) }
  return { ...body, digest: digest(body) }
}

function graphFor(context: PoolRenewalSigningContext): TxTree {
  const graph = TxTree.create(copy(context.nodes))
  const rebuilt = contextFor(graph, hex.decode(context.scriptRoot), BigInt(context.rootInputAmount))
  if (canonical(rebuilt) !== canonical(context)) fail('saved tree context is not canonical')
  return graph
}

function signingContext(graph: TxTree, context: PoolRenewalSigningContext, txid: string, publicKey: string) {
  const node = graph.find(txid)
  if (!node || node.root.inputsLength !== 1) fail('unknown signing transaction')
  const keys = musig2.sortKeys(getArkPsbtFields(node.root, 0, CosignerPublicKey).map(entry => Uint8Array.from(entry.key)))
  if (!keys.length || keys.some(key => key.length !== 33) || new Set(keys.map(xonly)).size !== keys.length ||
      !keys.some(key => hex.encode(key) === publicKey)) fail('invalid participant set')
  const untweaked = musig2.keyAggregate(keys).aggPublicKey.toBytes(true)
  const tweak = schnorr.utils.taggedHash('TapTweak', untweaked.subarray(1), hex.decode(context.scriptRoot))
  const final = musig2.keyAggregate(keys, [tweak], [true]).aggPublicKey.toBytes(true)
  let amount = BigInt(context.rootInputAmount)
  if (txid !== graph.txid) {
    const input = node.root.getInput(0)
    const parent = input.txid && graph.find(hex.encode(input.txid))
    if (!parent || input.index === undefined) fail('missing signing parent')
    const output = parent.root.getOutput(input.index)
    if (!output.amount || output.amount <= 0n) fail('invalid signing parent amount')
    amount = output.amount
  }
  const script = Script.encode(['OP_1', final.subarray(1)])
  const message = node.root.preimageWitnessV1(0, [script], SigHash.DEFAULT, [amount])
  return { keys, tweak, message, untweaked }
}

function aggregateBinding(context: PoolRenewalSigningContext, txid: string, nonce: PoolRenewalSessionNonce,
  participants: Record<string, string>, publicNonce: string): string {
  return digest({ context: context.digest, txid, message: nonce.message, participants, publicNonce })
}

function validate(record: PoolRenewalSessionJournal): PoolRenewalSessionJournal {
  if (!record || record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      !isHex(record.secretKey, 32) || !isHex(record.publicKey, 33) || !record.nonces || typeof record.nonces !== 'object' || Array.isArray(record.nonces)) fail('invalid saved journal')
  if (hex.encode(musig2.IndividualPubkey(hex.decode(record.secretKey))) !== record.publicKey) fail('saved signing key mismatch')
  if (!record.context) {
    if (Object.keys(record.nonces).length) fail('nonces have no committed tree')
    return copy(record)
  }
  const context = record.context, graph = graphFor(context), txids = [...graph.iterator()].map(node => node.txid)
  const nonceKeys = Object.keys(record.nonces)
  if (nonceKeys.length && (nonceKeys.length !== txids.length || nonceKeys.some(txid => !txids.includes(txid)))) fail('incomplete nonce set')
  for (const [txid, nonce] of Object.entries(record.nonces)) {
    const signing = signingContext(graph, context, txid, record.publicKey)
    if (!isHex(nonce.publicNonce, 66) || nonce.message !== hex.encode(signing.message)) fail('nonce changed its signing message')
    musig2.nonceAggregate([hex.decode(nonce.publicNonce)])
    if (nonce.partialSignature !== undefined) {
      if (!isHex(nonce.partialSignature, 32) || nonce.secretNonce !== undefined || !nonce.aggregate) fail('invalid consumed nonce')
    } else {
      if (!isHex(nonce.secretNonce, 97) || nonce.secretNonce.slice(128) !== record.publicKey) fail('invalid secret nonce')
      const secret = hex.decode(nonce.secretNonce)
      try {
        if (hex.encode(secp256k1.getPublicKey(secret.subarray(0, 32))) + hex.encode(secp256k1.getPublicKey(secret.subarray(32, 64))) !== nonce.publicNonce) fail('secret nonce does not match its public commitment')
      } finally { secret.fill(0) }
    }
    if (nonce.aggregate) {
      const aggregate = nonce.aggregate, participants = aggregate.participants
      const expected = signing.keys.map(xonly)
      if (!participants || Object.keys(participants).length !== expected.length || Object.keys(participants).some(key => !expected.includes(key)) ||
          participants[record.publicKey.slice(2)] !== nonce.publicNonce || Object.values(participants).some(value => !isHex(value, 66))) fail('aggregate changed its participants')
      const combined = hex.encode(musig2.nonceAggregate(signing.keys.map(key => hex.decode(participants[xonly(key)]))))
      if (aggregate.publicNonce !== combined || aggregate.binding !== aggregateBinding(context, txid, nonce, participants, combined)) fail('aggregate binding mismatch')
      if (nonce.partialSignature && !new musig2.Session(hex.decode(combined), signing.keys, signing.message, [signing.tweak], [true])
        .partialSigVerify(hex.decode(nonce.partialSignature), signing.keys.map(key => hex.decode(participants[xonly(key)])), expected.indexOf(record.publicKey.slice(2)))) fail('invalid cached partial signature')
    }
  }
  return copy(record)
}

function preserves(previous: PoolRenewalSessionJournal, next: PoolRenewalSessionJournal): void {
  if (next.revision < previous.revision || next.publicKey !== previous.publicKey || next.secretKey !== previous.secretKey ||
      previous.context && canonical(next.context) !== canonical(previous.context)) fail('saved session moved backwards or changed context')
  if (next.revision === previous.revision && canonical(next) !== canonical(previous)) fail('journal changed without a revision')
  for (const [txid, nonce] of Object.entries(previous.nonces)) {
    const current = next.nonces[txid]
    if (!current || current.publicNonce !== nonce.publicNonce || current.message !== nonce.message ||
        nonce.aggregate && canonical(current.aggregate) !== canonical(nonce.aggregate) ||
        nonce.partialSignature && current.partialSignature !== nonce.partialSignature ||
        nonce.secretNonce === undefined && current.secretNonce !== undefined ||
        nonce.secretNonce && current.secretNonce && current.secretNonce !== nonce.secretNonce) fail('saved nonce binding changed')
  }
}

export async function createDurablePoolRenewalSession(persistence: PoolRenewalSessionPersistence): Promise<SignerSession> {
  const load = async () => {
    try { return await persistence.load() }
    catch { fail('journal read failed; reload the saved session before retrying') }
  }
  let journal = await load()
  if (!journal) {
    const secretKey = randomPrivateKeyBytes()
    const fresh: PoolRenewalSessionJournal = { version: 1, revision: 0, secretKey: hex.encode(secretKey),
      publicKey: hex.encode(musig2.IndividualPubkey(secretKey)), nonces: {} }
    secretKey.fill(0)
    try {
      if (!await persistence.save(copy(fresh), null)) fail('initial key claim was lost')
      const saved = await load()
      if (!saved || canonical(saved) !== canonical(fresh)) fail('initial key was not durably saved')
      journal = saved
    } catch { fail('key persistence failed; reload the saved session before retrying') }
  }
  journal = validate(journal)
  let poisoned = false, serial = Promise.resolve()
  const refresh = async () => {
    const saved = await load()
    if (!saved) fail('saved session disappeared')
    const next = validate(saved)
    preserves(journal!, next)
    journal = next
  }
  const commit = async (next: PoolRenewalSessionJournal) => {
    next.revision = journal!.revision + 1
    preserves(journal!, next)
    try {
      if (!await persistence.save(copy(next), journal!.revision)) fail('journal compare-and-swap was lost')
      const saved = await load()
      if (!saved) fail('committed session disappeared')
      const actual = validate(saved)
      preserves(next, actual)
      journal = actual
    } catch { poisoned = true; fail('journal update failed; reload the saved session before retrying') }
  }
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const result = serial.then(async () => {
      if (poisoned) fail('session requires reload after a failed persistence operation')
      try { await refresh(); return await action() }
      catch (error) { poisoned = true; throw error }
    })
    serial = result.then(() => {}, () => {})
    return result
  }
  const requireContext = () => {
    if (!journal!.context) fail('initialize the signing tree first')
    return { context: journal!.context, graph: graphFor(journal!.context) }
  }
  const ensureNonces = async () => {
    const { context, graph } = requireContext()
    if (Object.keys(journal!.nonces).length) return
    const nonces: PoolRenewalSessionJournal['nonces'] = {}
    for (const node of graph.iterator()) {
      const signing = signingContext(graph, context, node.txid, journal!.publicKey)
      const generated = musig2.nonceGen(hex.decode(journal!.publicKey), hex.decode(journal!.secretKey),
        signing.untweaked.subarray(1), signing.message, hex.decode(digest({ context: context.digest, txid: node.txid })))
      nonces[node.txid] = { publicNonce: hex.encode(generated.public), secretNonce: hex.encode(generated.secret), message: hex.encode(signing.message) }
      generated.secret.fill(0)
    }
    await commit({ ...journal!, nonces })
  }
  return {
    getPublicKey: () => run(async () => hex.decode(journal!.publicKey)),
    init: async (tree, scriptRoot, rootInputAmount) => {
      const candidate = contextFor(tree, Uint8Array.from(scriptRoot), rootInputAmount)
      return run(async () => {
        if (journal!.context) {
          if (canonical(journal!.context) !== canonical(candidate)) fail('signing tree, script root or amount changed')
        } else {
          const graph = graphFor(candidate)
          for (const node of graph.iterator()) signingContext(graph, candidate, node.txid, journal!.publicKey)
          await commit({ ...journal!, context: candidate })
        }
      })
    },
    getNonces: () => run(async (): Promise<TreeNonces> => {
      await ensureNonces()
      return new Map(Object.entries(journal!.nonces).map(([txid, nonce]) => [txid, { pubNonce: hex.decode(nonce.publicNonce) }]))
    }),
    aggregatedNonces: async (txid, noncesByPubkey) => {
      const supplied = new Map([...noncesByPubkey].map(([key, value]) => [key, Uint8Array.from(value.pubNonce)]))
      return run(async () => {
        await ensureNonces()
        const { context, graph } = requireContext(), nonce = journal!.nonces[txid]
        if (!nonce) fail('aggregate names an unknown transaction')
        const signing = signingContext(graph, context, txid, journal!.publicKey), participants: Record<string, string> = {}
        for (const key of signing.keys) {
          const name = xonly(key), mine = hex.encode(key) === journal!.publicKey
          const proposed = supplied.get(name)
          if (mine && proposed && hex.encode(proposed) !== nonce.publicNonce) fail('aggregate replaced the local public nonce')
          const value = mine ? hex.decode(nonce.publicNonce) : proposed
          if (!value || value.length !== 66) fail('missing participant nonce')
          participants[name] = hex.encode(value)
        }
        const publicNonce = hex.encode(musig2.nonceAggregate(signing.keys.map(key => hex.decode(participants[xonly(key)]))))
        const aggregate = { participants, publicNonce, binding: aggregateBinding(context, txid, nonce, participants, publicNonce) }
        if (nonce.aggregate) {
          if (canonical(nonce.aggregate) !== canonical(aggregate)) fail('aggregate nonce changed after binding')
        } else await commit({ ...journal!, nonces: { ...journal!.nonces, [txid]: { ...nonce, aggregate } } })
        return { hasAllNonces: Object.values(journal!.nonces).every(value => !!value.aggregate) }
      })
    },
    sign: () => run(async (): Promise<TreePartialSigs> => {
      await ensureNonces()
      const { context, graph } = requireContext()
      if (Object.values(journal!.nonces).some(value => !value.aggregate)) fail('aggregate nonces are incomplete')
      const nonces = copy(journal!.nonces)
      let changed = false
      for (const [txid, nonce] of Object.entries(nonces)) {
        if (nonce.partialSignature) continue
        const signing = signingContext(graph, context, txid, journal!.publicKey)
        if (nonce.message !== hex.encode(signing.message) || !nonce.secretNonce) fail('nonce is not bound to its original message')
        const session = new musig2.Session(hex.decode(nonce.aggregate!.publicNonce), signing.keys, signing.message, [signing.tweak], [true])
        const secret = hex.decode(nonce.secretNonce), key = hex.decode(journal!.secretKey)
        let partial: Uint8Array
        // Every retry is confined to the aggregate and message already committed before signing.
        try { partial = session.sign(secret, key) }
        finally { secret.fill(0); key.fill(0) }
        nonce.partialSignature = hex.encode(partial)
        delete nonce.secretNonce
        changed = true
      }
      if (changed) await commit({ ...journal!, nonces })
      return new Map(Object.entries(journal!.nonces).map(([txid, nonce]) => [txid, partialSignature(nonce.partialSignature!)]))
    }),
  }
}
