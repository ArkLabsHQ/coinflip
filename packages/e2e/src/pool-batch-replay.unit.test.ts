import { ArkAddress, Batch, P2A, SettlementEventType as Type, Transaction, TxTree, networks, validateBatchRecipients,
  type SettlementEvent, type SignerSession, type TreeNonces, type TxTreeNode } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { Script } from '@scure/btc-signer/script.js'
import { sha256 } from '@scure/btc-signer/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { createDurablePoolBatchReplay, createPoolTreeNonceReplayGuard, decodePoolBatchReplayEvent, encodePoolBatchReplayEvent, hasSavedPoolTreeNonces,
  type PoolBatchReplayJournal, type PoolBatchReplayPersistence } from 'arkade-coinflip/dist/pool-batch-replay'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
type PublicEvent = Exclude<SettlementEvent, { type: Type.StreamStarted }>
const intentId = 'renewal-intent-one', batchId = 'batch-one'
const intentHash = hex.encode(sha256(new TextEncoder().encode(intentId)))
const owner = schnorr.getPublicKey(new Uint8Array(32).fill(1)), compressed = new Uint8Array([2, ...owner])
const nonce = new Uint8Array([...compressed, ...compressed])
const script = Script.encode(['OP_1', owner])
const encode = (tx: Transaction) => base64.encode(tx.toPSBT())
async function* source(events: readonly SettlementEvent[]): AsyncGenerator<SettlementEvent> { yield* events }
async function collect(events: AsyncIterable<SettlementEvent>): Promise<SettlementEvent[]> {
  const result: SettlementEvent[] = []
  for await (const event of events) result.push(event)
  return result
}
function storage(initial?: PoolBatchReplayJournal) {
  let saved = initial && clone(initial)
  let failure: 'before' | 'after' | undefined
  const persistence: PoolBatchReplayPersistence = { load: jest.fn(async () => saved && clone(saved)),
    save: jest.fn(async (next, expected) => {
      if ((saved?.revision ?? null) !== expected) return false
      if (failure === 'before') throw new Error('storage failed before commit')
      saved = clone(next)
      if (failure === 'after') throw new Error('storage acknowledgment lost')
      return true
    }) }
  return { persistence, read: () => clone(saved!), fail: (next?: typeof failure) => { failure = next } }
}
function fixture(filtered = false) {
  const commitment = new Transaction({ version: 3 })
  commitment.addInput({ txid: new Uint8Array(32).fill(9), index: 0, witnessUtxo: { script, amount: 10000n } })
  commitment.addOutput({ script, amount: filtered ? 15000n : 10000n }); commitment.addOutput({ script: P2A.script, amount: 0n })
  const root = new Transaction({ version: 3 })
  root.addInput({ txid: commitment.id, index: 0, witnessUtxo: { script, amount: filtered ? 15000n : 10000n } })
  root.addOutput({ script, amount: 9000n })
  if (filtered) root.addOutput({ script, amount: 6000n })
  root.addOutput({ script: P2A.script, amount: 0n })
  const child = new Transaction({ version: 3 })
  child.addInput({ txid: root.id, index: 0, witnessUtxo: { script, amount: 9000n } })
  child.addOutput({ script, amount: 9000n }); child.addOutput({ script: P2A.script, amount: 0n })
  const sibling = new Transaction({ version: 3 })
  sibling.addInput({ txid: root.id, index: 1, witnessUtxo: { script, amount: 6000n } })
  sibling.addOutput({ script: Script.encode(['OP_1', schnorr.getPublicKey(new Uint8Array(32).fill(2))]), amount: 6000n })
  sibling.addOutput({ script: P2A.script, amount: 0n })
  const connector = new Transaction({ version: 3 })
  connector.addInput({ txid: new Uint8Array(32).fill(7), index: 0, witnessUtxo: { script, amount: 330n } })
  connector.addOutput({ script, amount: 330n }); connector.addOutput({ script: P2A.script, amount: 0n })
  const chunk = (tx: Transaction, children: Record<number, string> = {}): TxTreeNode => ({ txid: tx.id, tx: encode(tx), children })
  const nonces = (txid: string): PublicEvent => ({ type: Type.TreeNonces, id: batchId, topic: [], txid,
    nonces: new Map([[hex.encode(owner), { pubNonce: nonce }]]) })
  const events: PublicEvent[] = [
    { type: Type.BatchStarted, id: batchId, intentIdHashes: [intentHash], batchExpiry: 86400n },
    { type: Type.TreeTx, id: batchId, topic: [], batchIndex: 0, chunk: chunk(child) },
    { type: Type.TreeTx, id: batchId, topic: [], batchIndex: 0, chunk: chunk(root, filtered ? { 0: child.id, 1: sibling.id } : { 0: child.id }) },
    { type: Type.TreeSigningStarted, id: batchId, cosignersPublicKeys: [hex.encode(compressed)], unsignedCommitmentTx: encode(commitment) },
    nonces(child.id), nonces(root.id),
    { type: Type.TreeSignature, id: batchId, topic: [], batchIndex: 0, txid: child.id, signature: '44'.repeat(64) },
    { type: Type.TreeSignature, id: batchId, topic: [], batchIndex: 0, txid: root.id, signature: '55'.repeat(64) },
    { type: Type.TreeTx, id: batchId, topic: [], batchIndex: 1, chunk: chunk(connector) },
    { type: Type.BatchFinalization, id: batchId, commitmentTx: encode(commitment) },
    { type: Type.BatchFinalized, id: batchId, commitmentTxid: commitment.id },
  ]
  return { events, commitment, root, child, sibling, connector, expected: new Map([[child.id, { pubNonce: nonce }], [root.id, { pubNonce: nonce }]]) as TreeNonces }
}
describe('durable public batch event replay', () => {
  it('round-trips every public event with bigint, Map nonce bytes and exact tree PSBTs', () => {
    const { events } = fixture()
    for (const event of events) {
      const restored = decodePoolBatchReplayEvent(JSON.parse(JSON.stringify(encodePoolBatchReplayEvent(event))))
      expect(restored).toEqual(event)
      if (restored.type === Type.TreeNonces) {
        expect(restored.nonces).toBeInstanceOf(Map)
        expect(restored.nonces.get(hex.encode(owner))!.pubNonce).toBeInstanceOf(Uint8Array)
      }
    }
  })
  it.each(['present', 'missing', 'undefined', 'empty'] as const)('restores public SDK Batch.join phase and tree assembly after restart with %s wire IDs', async mode => {
    const f = fixture(), store = storage(), first = await createDurablePoolBatchReplay(store.persistence, { intentId })
    for (const event of f.events) if (event.type === Type.TreeTx && mode !== 'present') {
      if (mode === 'missing') {
        const { txid, ...chunk } = event.chunk
        void txid; event.chunk = chunk as TxTreeNode
      } else event.chunk.txid = (mode === 'empty' ? '' : undefined) as unknown as string
    }
    await collect(first.stream(source(f.events.slice(0, 5))))
    const resumed = await createDurablePoolBatchReplay(store.persistence, { intentId })
    const calls: string[] = [], processed = new Set<string>()
    let selected: string | undefined, validatedCommitment: string | undefined
    const handler: Batch.Handler = {
      onBatchStarted: async event => { selected = event.id; calls.push('start'); return { skip: false } },
      onTreeSigningStarted: async (event, tree) => {
        expect(selected).toBe(batchId); tree.validate(); expect(tree.nbOfNodes()).toBe(2)
        validatedCommitment = Transaction.fromPSBT(base64.decode(event.unsignedCommitmentTx)).id
        calls.push('signing'); return { skip: false }
      },
      onTreeNonces: async event => { processed.add(event.txid); calls.push('nonce'); return { fullySigned: processed.size === 2 } },
      onBatchFinalization: async (event, tree, connectors) => {
        expect(selected).toBe(batchId); expect(validatedCommitment).toBe(f.commitment.id)
        expect(Transaction.fromPSBT(base64.decode(event.commitmentTx)).id).toBe(validatedCommitment)
        expect(tree!.root.getInput(0).tapKeySig).toEqual(new Uint8Array(64).fill(0x55))
        expect(tree!.find(f.child.id)!.root.getInput(0).tapKeySig).toEqual(new Uint8Array(64).fill(0x44))
        expect(connectors!.root.id).toBe(f.connector.id); calls.push('finalization')
      },
    }
    const result = await Batch.join(resumed.stream(source(f.events.slice(5))), handler)
    expect(result).toBe(f.commitment.id)
    expect(calls).toEqual(['start', 'signing', 'nonce', 'nonce', 'finalization'])
    expect(store.read().events).toHaveLength(f.events.length)
    const mutated = resumed.savedEvents(); (mutated[0] as { id: string }).id = 'changed'
    expect(resumed.savedEvents()[0].id).toBe(batchId)
  })
  it('rejects a supplied tree ID that differs from the PSBT and derives absent duplicate chunk IDs only once', async () => {
    const f = fixture(), treeEvent = f.events[1]
    if (treeEvent.type !== Type.TreeTx) throw new Error('Invalid fixture')
    expect(() => encodePoolBatchReplayEvent({ ...treeEvent, chunk: { ...treeEvent.chunk, txid: 'ab'.repeat(32) } })).toThrow('ID changed')
    expect(() => encodePoolBatchReplayEvent({ ...treeEvent, chunk: { ...treeEvent.chunk, txid: null as unknown as string } })).toThrow('hash')
    const { txid, ...chunk } = treeEvent.chunk
    const missing = { ...treeEvent, chunk: chunk as TxTreeNode }
    const store = storage(), replay = await createDurablePoolBatchReplay(store.persistence, { intentId })
    const published = await collect(replay.stream(source([f.events[0], missing, missing])))
    expect(published).toHaveLength(2)
    expect((published[1] as typeof treeEvent).chunk.txid).toBe(txid)
    expect(store.read().events).toHaveLength(2)
  })
  it('replays a signer-filtered branch with an unstreamed sibling and validates the expected recipient through the public SDK', async () => {
    const f = fixture(true), store = storage(), first = await createDurablePoolBatchReplay(store.persistence, { intentId })
    await collect(first.stream(source(f.events.slice(0, 3))))
    const replay = await createDurablePoolBatchReplay(store.persistence, { intentId }), processed = new Set<string>()
    const address = new ArkAddress(owner, owner, 'tark').encode()
    const handler: Batch.Handler = {
      onBatchStarted: async () => ({ skip: false }),
      onTreeSigningStarted: async (_event, tree) => {
        tree.validate(); expect(tree.nbOfNodes()).toBe(2); expect(tree.children.size).toBe(1)
        expect(tree.find(f.sibling.id)).toBeNull()
        expect(tree.root.outputsLength).toBe(3)
        validateBatchRecipients(f.commitment, tree.leaves(), [{ address, amount: 9000 }], networks.regtest)
        expect(() => validateBatchRecipients(f.commitment, tree.leaves(), [{ address, amount: 9001 }], networks.regtest)).toThrow()
        return { skip: false }
      },
      onTreeNonces: async event => { processed.add(event.txid); return { fullySigned: processed.size === 2 } },
      onBatchFinalization: async (_event, tree) => { expect(tree!.find(f.sibling.id)).toBeNull(); tree!.validate() },
    }
    expect(await Batch.join(replay.stream(source(f.events.slice(3))), handler)).toBe(f.commitment.id)
    expect(store.read().events).toHaveLength(f.events.length)
  })
  it.each(['wrong-input', 'wrong-value', 'disconnected', 'shared'] as const)('still rejects %s provided nodes in a filtered tree', async mode => {
    const f = fixture(true), rootEvent = f.events[2], childEvent = f.events[1]
    if (rootEvent.type !== Type.TreeTx || childEvent.type !== Type.TreeTx) throw new Error('Invalid fixture')
    if (mode === 'wrong-input' || mode === 'wrong-value') {
      const bad = f.child.clone()
      if (mode === 'wrong-input') bad.updateInput(0, { index: 1 })
      else bad.updateOutput(0, { amount: 9001n })
      childEvent.chunk = { txid: bad.id, tx: encode(bad), children: {} }
      rootEvent.chunk.children[0] = bad.id
    } else if (mode === 'disconnected') f.events.splice(3, 0, { ...rootEvent,
      chunk: { txid: f.connector.id, tx: encode(f.connector), children: {} } })
    else rootEvent.chunk.children[1] = f.child.id
    const messages = { 'wrong-input': /input of child/, 'wrong-value': /sum of child's outputs/,
      disconnected: /tree roots/, shared: /Duplicate batch replay child/ }
    const replay = await createDurablePoolBatchReplay(storage().persistence, { intentId })
    await expect(collect(replay.stream(source(f.events)))).rejects.toThrow(messages[mode])
  })
  it('does not publish an observed event before its append commits', async () => {
    const store = storage(), replay = await createDurablePoolBatchReplay(store.persistence, { intentId })
    let commit!: () => void, enter!: () => void, observed = false
    const entered = new Promise<void>(resolve => { enter = resolve })
    const original = store.persistence.save
    store.persistence.save = async (next, expected) => { await new Promise<void>(resolve => { commit = resolve; enter() }); return original(next, expected) }
    const stream = replay.stream(source([fixture().events[0]]))
    const pending = stream.next().then(result => { observed = true; return result })
    await entered
    expect(observed).toBe(false); expect(store.read().events).toHaveLength(0)
    commit(); expect((await pending).value!.type).toBe(Type.BatchStarted)
    expect(store.read().events).toHaveLength(1); await stream.return(undefined)
  })
  it.each(['before', 'after'] as const)('poisons an ambiguous %s-save stream and reloads only the committed prefix', async failure => {
    const store = storage(), replay = await createDurablePoolBatchReplay(store.persistence, { intentId })
    store.fail(failure)
    await expect(collect(replay.stream(source([fixture().events[0]])))).rejects.toThrow('storage')
    await expect(collect(replay.stream(source([])))).rejects.toThrow('fresh exclusive')
    store.fail()
    const restored = await createDurablePoolBatchReplay(store.persistence, { intentId })
    expect(await collect(restored.stream(source([])))).toHaveLength(failure === 'after' ? 1 : 0)
  })
  it('allows only one concurrent revision writer to publish', async () => {
    const store = storage(), first = await createDurablePoolBatchReplay(store.persistence, { intentId })
    const second = await createDurablePoolBatchReplay(store.persistence, { intentId })
    const results = await Promise.allSettled([collect(first.stream(source([fixture().events[0]]))), collect(second.stream(source([fixture().events[0]])))])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(store.read().revision).toBe(1)
  })
  it('filters unrelated batches and deduplicates exact repeats while rejecting changed same-key content', async () => {
    const f = fixture(), store = storage(), replay = await createDurablePoolBatchReplay(store.persistence, { intentId })
    const unrelated = { ...f.events[0], id: 'unrelated', intentIdHashes: ['99'.repeat(32)] } as SettlementEvent
    const reordered: PublicEvent = { batchExpiry: 86400n, intentIdHashes: [intentHash], id: batchId, type: Type.BatchStarted }
    expect(await collect(replay.stream(source([{ type: Type.StreamStarted, id: 'stream' }, unrelated, f.events[0], reordered])))).toEqual([f.events[0]])
    await expect(collect(replay.stream(source([{ ...f.events[0], batchExpiry: 86401n } as SettlementEvent])))).rejects.toThrow('changed')
    expect(store.read().events).toHaveLength(1)
  })
  it('requires all saved own nonce acceptances and rejects any mismatching own contribution', () => {
    const f = fixture()
    expect(hasSavedPoolTreeNonces(f.events.slice(0, 5), compressed, f.expected)).toBe(false)
    expect(hasSavedPoolTreeNonces(f.events, compressed, f.expected)).toBe(true)
    const changed = decodePoolBatchReplayEvent(encodePoolBatchReplayEvent(f.events[4]))
    if (changed.type !== Type.TreeNonces) throw new Error('Invalid fixture')
    changed.nonces.set(hex.encode(owner), { pubNonce: new Uint8Array(66) })
    expect(hasSavedPoolTreeNonces([...f.events, changed], owner, f.expected)).toBe(false)
  })
  it.each([
    { type: Type.BatchStarted, id: batchId, intentIdHashes: [intentHash], batchExpiry: '-1' },
    { type: Type.BatchStarted, id: batchId, intentIdHashes: [intentHash], batchExpiry: '18446744073709551616' },
    { type: Type.BatchStarted, id: batchId, intentIdHashes: [intentHash], batchExpiry: '1', extra: 1 },
    { type: Type.TreeNonces, id: batchId, topic: [], txid: '11'.repeat(32), nonces: [[hex.encode(owner), '00']] },
    { type: Type.TreeSignature, id: batchId, topic: [], batchIndex: -1, txid: '11'.repeat(32), signature: '11'.repeat(64) },
  ])('rejects malformed stored event %#', value => expect(() => decodePoolBatchReplayEvent(value)).toThrow())
  it('rejects missing, cyclic, mixed-batch or changed-commitment event histories before persisting them', async () => {
    const f = fixture()
    const histories = [
      [f.events[0], f.events[3]],
      [f.events[0], { ...f.events[1], chunk: { ...(f.events[1] as { chunk: TxTreeNode }).chunk,
        children: { 0: f.child.id } } } as SettlementEvent, f.events[3]],
      [...f.events.slice(0, 6), { ...f.events[9], commitmentTx: encode(f.connector) } as SettlementEvent],
    ]
    for (const events of histories) {
      const store = storage(), replay = await createDurablePoolBatchReplay(store.persistence, { intentId })
      await expect(collect(replay.stream(source(events)))).rejects.toThrow()
      expect(store.read().events.length).toBeLessThan(events.length)
    }
    const events = f.events.slice(0, 2).map(encodePoolBatchReplayEvent)
    events[1].id = 'another-batch'
    await expect(createDurablePoolBatchReplay(storage({ version: 1, revision: 2, intentId, events }).persistence, { intentId })).rejects.toThrow('Mixed')
    await expect(createDurablePoolBatchReplay(storage({ version: 1, revision: 0, intentId: 'another-intent', events: [] }).persistence, { intentId })).rejects.toThrow()
    await expect(createDurablePoolBatchReplay(storage({ version: 1, revision: 8193, intentId,
      events: Array(8193).fill(encodePoolBatchReplayEvent(f.events[0])) }).persistence, { intentId })).rejects.toThrow()
  })
})

describe('validated tree nonce replay boundary', () => {
  const setup = (saved = fixture().events) => {
    const f = fixture(), session: jest.Mocked<SignerSession> = {
      getPublicKey: jest.fn().mockResolvedValue(compressed), init: jest.fn().mockResolvedValue(undefined),
      getNonces: jest.fn().mockResolvedValue(f.expected), aggregatedNonces: jest.fn().mockResolvedValue({ hasAllNonces: false }),
      sign: jest.fn().mockResolvedValue(new Map()),
    }
    const guard = createPoolTreeNonceReplayGuard(session, saved)
    const event = f.events[3] as Extract<SettlementEvent, { type: Type.TreeSigningStarted }>
    const tree = TxTree.create(f.events.filter((value): value is Extract<SettlementEvent, { type: Type.TreeTx }> => value.type === Type.TreeTx && value.batchIndex === 0).map(value => value.chunk))
    const base = (onTreeSigningStarted: Batch.Handler['onTreeSigningStarted']): Batch.Handler => ({
      onBatchStarted: async () => ({ skip: false }), onTreeSigningStarted, onTreeNonces: async () => ({ fullySigned: false }),
      onBatchFinalization: async () => {}, onBatchFinalized: async () => {}, onBatchFailed: async () => {},
    })
    const validated = async () => {
      tree.validate()
      await guard.session.init(tree, new Uint8Array(32), 10000n)
      await guard.session.getPublicKey()
      await guard.session.getNonces()
    }
    return { f, session, guard, event, tree, base, validated }
  }

  it('resumes an opaque nonce RPC error only after the current validated nonce boundary', async () => {
    const { session, guard, event, tree, base, validated } = setup()
    const handler = guard.handler(base(async () => { await validated(); throw new Error('INTERNAL_ERROR') }))
    await expect(handler.onTreeSigningStarted(event, tree)).resolves.toEqual({ skip: false })
    expect(session.init).toHaveBeenCalledTimes(1)
    expect(session.getNonces).toHaveBeenCalledTimes(1)
    await guard.session.aggregatedNonces('txid', new Map())
    await guard.session.sign()
    expect(session.aggregatedNonces).toHaveBeenCalledWith('txid', new Map())
    expect(session.sign).toHaveBeenCalledTimes(1)
  })

  it('preserves a validation failure before initialization even with accepted saved nonces', async () => {
    const { session, guard, event, tree, base } = setup(), failure = new Error('Invalid recipient')
    await guard.session.getNonces()
    const handler = guard.handler(base(async () => { await guard.session.getPublicKey(); throw failure }))
    await expect(handler.onTreeSigningStarted(event, tree)).rejects.toBe(failure)
    expect(session.init).not.toHaveBeenCalled()
    expect(session.getNonces).toHaveBeenCalledTimes(1)
  })

  it.each(['init', 'getNonces'] as const)('never suppresses a session %s failure', async method => {
    const { session, guard, event, tree, base, validated } = setup(), failure = new Error('Changed cryptographic context')
    session[method].mockRejectedValueOnce(failure)
    const handler = guard.handler(base(async () => { await validated(); throw new Error('INTERNAL_ERROR') }))
    await expect(handler.onTreeSigningStarted(event, tree)).rejects.toBe(failure)
  })

  it.each(['incomplete', 'mismatch', 'batch', 'commitment', 'missing-start'] as const)('refuses opaque RPC recovery with %s saved evidence', async mode => {
    const f = fixture()
    let saved = f.events.map(value => decodePoolBatchReplayEvent(encodePoolBatchReplayEvent(value)))
    if (mode === 'incomplete') saved = saved.filter(value => value.type !== Type.TreeNonces || value.txid !== f.root.id)
    if (mode === 'mismatch') {
      const event = saved.find((value): value is Extract<SettlementEvent, { type: Type.TreeNonces }> => value.type === Type.TreeNonces)!
      event.nonces.set(hex.encode(owner), { pubNonce: new Uint8Array(66) })
    }
    if (mode === 'batch') saved = saved.map(value => ({ ...value, id: 'another-batch' }))
    if (mode === 'commitment') {
      const event = saved.find((value): value is Extract<SettlementEvent, { type: Type.TreeSigningStarted }> => value.type === Type.TreeSigningStarted)!
      event.unsignedCommitmentTx = encode(f.connector)
    }
    if (mode === 'missing-start') saved = saved.filter(value => value.type !== Type.BatchStarted)
    const { guard, event, tree, base, validated } = setup(saved), failure = new Error('INTERNAL_ERROR')
    const handler = guard.handler(base(async () => { await validated(); throw failure }))
    await expect(handler.onTreeSigningStarted(event, tree)).rejects.toBe(failure)
  })
})
