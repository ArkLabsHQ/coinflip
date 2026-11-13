import { CosignerPublicKey, P2A, Transaction, TreeSignerSession, TxTree, setArkPsbtField, type SignerSession, type TreeNonces } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import * as musig2 from '@scure/btc-signer/musig2.js'
import { Script } from '@scure/btc-signer/script.js'
import { SigHash } from '@scure/btc-signer/transaction.js'
import { sha256 } from '@scure/btc-signer/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { createDurablePoolRenewalSession, isPoolRenewalAbandoned, PoolRenewalAbandonedError, RENEWAL_ABANDON_MARGIN_SECONDS, renewalAbandonable,
  type PoolRenewalSessionJournal, type PoolRenewalSessionPersistence } from 'arkade-coinflip/dist/pool-renewal-session'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const point = (value: Uint8Array) => hex.encode(value.subarray(1))
const scriptRoot = sha256(new TextEncoder().encode('pool renewal unit test script root'))
const amount = 12000n
const childAmount = 11000n
function storage() {
  let saved: PoolRenewalSessionJournal | undefined
  let before: ((next: PoolRenewalSessionJournal) => boolean) | undefined
  let after: ((next: PoolRenewalSessionJournal) => boolean) | undefined
  const attempts: PoolRenewalSessionJournal[] = []
  const persistence: PoolRenewalSessionPersistence = { load: jest.fn(async () => saved && clone(saved)),
    save: jest.fn(async (next, expected) => {
      attempts.push(clone(next))
      if ((saved?.revision ?? null) !== expected) return false
      if (before?.(next)) throw new Error('storage write failed')
      saved = clone(next)
      if (after?.(next)) throw new Error('storage acknowledgment lost')
      return true
    }) }
  return { persistence, attempts, read: () => clone(saved!), failBefore: (predicate?: typeof before) => { before = predicate },
    failAfter: (predicate?: typeof after) => { after = predicate } }
}
function buildTree(keys: Uint8Array[]): TxTree {
  const sorted = musig2.sortKeys(keys), aggregated = musig2.keyAggregate(sorted).aggPublicKey.toBytes(true)
  const tweak = schnorr.utils.taggedHash('TapTweak', aggregated.subarray(1), scriptRoot)
  const final = musig2.keyAggregate(sorted, [tweak], [true]).aggPublicKey.toBytes(true)
  const shared = Script.encode(['OP_1', final.subarray(1)])
  const root = new Transaction({ version: 3, lockTime: 0 })
  root.addInput({ txid: new Uint8Array(32).fill(8), index: 0, witnessUtxo: { script: shared, amount } })
  root.addOutput({ script: shared, amount: childAmount }); root.addOutput({ script: P2A.script, amount: 0n })
  const child = new Transaction({ version: 3, lockTime: 0 })
  child.addInput({ txid: root.id, index: 0, witnessUtxo: { script: shared, amount: childAmount } })
  child.addOutput({ script: Script.encode(['OP_1', keys[0].subarray(1)]), amount: childAmount }); child.addOutput({ script: P2A.script, amount: 0n })
  for (const tx of [root, child]) keys.forEach((key, index) => setArkPsbtField(tx, 0, CosignerPublicKey, { key, index }))
  return new TxTree(root, new Map([[0, new TxTree(child)]]))
}
async function fixture() {
  const store = storage(), local = await createDurablePoolRenewalSession(store.persistence), peer = TreeSignerSession.random()
  const localKey = await local.getPublicKey(), peerKey = await peer.getPublicKey(), tree = buildTree([peerKey, localKey])
  await local.init(tree, scriptRoot, amount); await peer.init(tree, scriptRoot, amount)
  const ours = await local.getNonces(), theirs = await peer.getNonces()
  const contributions = (txid: string, peerNonce = theirs.get(txid)!.pubNonce): TreeNonces => new Map([
    [point(localKey), { pubNonce: ours.get(txid)!.pubNonce }], [point(peerKey), { pubNonce: peerNonce }],
  ])
  const bind = async (session: SignerSession = local) => {
    for (const node of tree.iterator()) {
      await session.aggregatedNonces(node.txid, contributions(node.txid))
      await peer.aggregatedNonces(node.txid, contributions(node.txid))
    }
  }
  const reload = async () => {
    const resumed = await createDurablePoolRenewalSession(store.persistence)
    await resumed.init(tree, scriptRoot, amount)
    return resumed
  }
  const verify = async (session: SignerSession) => {
    const localSigs = await session.sign(), peerSigs = await peer.sign()
    const keys = musig2.sortKeys([peerKey, localKey]), before = musig2.keyAggregate(keys).aggPublicKey.toBytes(true)
    const tweak = schnorr.utils.taggedHash('TapTweak', before.subarray(1), scriptRoot)
    const final = musig2.keyAggregate(keys, [tweak], [true]).aggPublicKey.toBytes(true)
    const shared = Script.encode(['OP_1', final.subarray(1)])
    for (const node of tree.iterator()) {
      const combined = musig2.nonceAggregate(keys.map(key => contributions(node.txid).get(point(key))!.pubNonce))
      const message = node.root.preimageWitnessV1(0, [shared], SigHash.DEFAULT, [node.txid === tree.txid ? amount : childAmount])
      const context = new musig2.Session(combined, keys, message, [tweak], [true])
      const nonces = keys.map(key => contributions(node.txid).get(point(key))!.pubNonce)
      const signatures = keys.map(key => hex.encode(key) === hex.encode(localKey) ? localSigs.get(node.txid)!.encode() : peerSigs.get(node.txid)!.encode())
      signatures.forEach((signature, index) => expect(context.partialSigVerify(signature, nonces, index)).toBe(true))
      expect(schnorr.verify(context.partialSigAgg(signatures), message, final.subarray(1))).toBe(true)
    }
    return localSigs
  }
  return { store, local, peer, localKey, peerKey, tree, ours, theirs, contributions, bind, reload, verify }
}
const partials = (journal: PoolRenewalSessionJournal) => Object.values(journal.nonces).some(nonce => !!nonce.partialSignature)
const encodedSignatures = (value: Awaited<ReturnType<SignerSession['sign']>>) => [...value].map(([txid, signature]) => [txid, hex.encode(signature.encode())]).sort()

describe('lapsed renewal intents', () => {
  it('become abandonable only after expire_at plus the safety margin', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(renewalAbandonable({ expire_at: now - RENEWAL_ABANDON_MARGIN_SECONDS + 5 })).toBe(false)
    expect(renewalAbandonable({ expire_at: now - RENEWAL_ABANDON_MARGIN_SECONDS - 1 })).toBe(true)
    expect(renewalAbandonable({ expire_at: 0 })).toBe(false)
    expect(isPoolRenewalAbandoned(new PoolRenewalAbandonedError('lapsed'))).toBe(true)
    expect(isPoolRenewalAbandoned(new Error('lapsed'))).toBe(false)
  })
})

describe('durable pool renewal MuSig2 session', () => {
  it('restarts with exact public nonces and produces valid aggregate signatures with the public SDK session', async () => {
    const f = await fixture(), resumed = await f.reload()
    expect(hex.encode(await resumed.getPublicKey())).toBe(hex.encode(f.localKey))
    expect([...await resumed.getNonces()].map(([id, value]) => [id, hex.encode(value.pubNonce)])).toEqual([...f.ours].map(([id, value]) => [id, hex.encode(value.pubNonce)]))
    await f.bind(resumed)
    const signatures = await f.verify(resumed)
    const saved = f.store.read()
    expect(Object.values(saved.nonces).every(nonce => !!nonce.partialSignature && nonce.secretNonce === undefined)).toBe(true)
    expect(encodedSignatures(await resumed.sign())).toEqual(encodedSignatures(signatures))
    expect(encodedSignatures(await (await f.reload()).sign())).toEqual(encodedSignatures(signatures))
  })

  it('saves the ephemeral key before publishing it and returns detached public values', async () => {
    const store = storage(), session = await createDurablePoolRenewalSession(store.persistence)
    expect(store.read().revision).toBe(0)
    const publicKey = await session.getPublicKey(), original = hex.encode(publicKey)
    expect(store.read().publicKey).toBe(original)
    publicKey.fill(0)
    expect(hex.encode(await session.getPublicKey())).toBe(original)
    const peer = TreeSignerSession.random(), tree = buildTree([await peer.getPublicKey(), await session.getPublicKey()])
    await session.init(tree, scriptRoot, amount)
    const nonces = await session.getNonces(), first = [...nonces][0]
    const persisted = store.read().nonces[first[0]].publicNonce
    first[1].pubNonce.fill(0)
    expect(hex.encode((await session.getNonces()).get(first[0])!.pubNonce)).toBe(persisted)
  })

  it.each(['tree', 'script root', 'amount'])('rejects a changed %s after nonces have been saved', async kind => {
    const f = await fixture(), resumed = await f.reload()
    const tree = TxTree.create(clone(f.store.read().context!.nodes))
    if (kind === 'tree') tree.children.get(0)!.root.updateOutput(0, { script: Script.encode(['OP_1', f.localKey.subarray(1)]) })
    const root = Uint8Array.from(scriptRoot)
    if (kind === 'script root') root[0] ^= 1
    await expect(resumed.init(tree, root, kind === 'amount' ? amount + 1n : amount)).rejects.toThrow(/changed/)
    await expect(resumed.getNonces()).rejects.toThrow(/requires reload/)
  })

  it('rejects substituted participant nonces after their aggregate has been pinned, including after restart', async () => {
    const f = await fixture(), node = [...f.tree.iterator()][0]
    await f.local.aggregatedNonces(node.txid, f.contributions(node.txid))
    const replacement = musig2.nonceGen(f.peerKey).public, resumed = await f.reload()
    await expect(resumed.aggregatedNonces(node.txid, f.contributions(node.txid, replacement))).rejects.toThrow(/aggregate nonce changed/)
    const ownReplacement = new Map(f.contributions(node.txid))
    ownReplacement.set(point(f.localKey), { pubNonce: replacement })
    await expect((await f.reload()).aggregatedNonces(node.txid, ownReplacement)).rejects.toThrow(/local public nonce/)
  })

  it.each(['before', 'after'])('does not publish nonces after a failed %s-write acknowledgment', async timing => {
    const store = storage(), session = await createDurablePoolRenewalSession(store.persistence), peer = TreeSignerSession.random()
    const tree = buildTree([await peer.getPublicKey(), await session.getPublicKey()])
    await session.init(tree, scriptRoot, amount)
    const reject = (journal: PoolRenewalSessionJournal) => Object.keys(journal.nonces).length > 0
    if (timing === 'before') store.failBefore(reject); else store.failAfter(reject)
    await expect(session.getNonces()).rejects.toThrow(/journal update failed/)
    await expect(session.getPublicKey()).rejects.toThrow(/requires reload/)
    const attempted = store.attempts.at(-1)!
    store.failBefore(); store.failAfter()
    const recovered = await createDurablePoolRenewalSession(store.persistence), published = await recovered.getNonces()
    if (timing === 'after') expect([...published].map(([id, value]) => [id, hex.encode(value.pubNonce)])).toEqual(Object.entries(attempted.nonces).map(([id, nonce]) => [id, nonce.publicNonce]))
    expect(published.size).toBe(2)
  })

  it.each(['before', 'after'])('retains the aggregate binding when partial persistence fails %s commit', async timing => {
    const f = await fixture()
    await f.bind()
    if (timing === 'before') f.store.failBefore(partials); else f.store.failAfter(partials)
    await expect(f.local.sign()).rejects.toThrow(/journal update failed/)
    const attempted = f.store.attempts.at(-1)!
    f.store.failBefore(); f.store.failAfter()
    const node = [...f.tree.iterator()][0]
    await expect((await f.reload()).aggregatedNonces(node.txid, f.contributions(node.txid, musig2.nonceGen(f.peerKey).public))).rejects.toThrow(/aggregate nonce changed/)
    const resumed = await f.reload(), signatures = await f.verify(resumed)
    expect(encodedSignatures(signatures)).toEqual(Object.entries(attempted.nonces).map(([id, nonce]) => [id, nonce.partialSignature]).sort())
    expect(Object.values(f.store.read().nonces).every(nonce => nonce.secretNonce === undefined)).toBe(true)
  })

  it('allows only one competing aggregate context to win the durable revision CAS', async () => {
    const f = await fixture(), other = await f.reload(), node = [...f.tree.iterator()][0]
    const attempts = await Promise.allSettled([
      f.local.aggregatedNonces(node.txid, f.contributions(node.txid)),
      other.aggregatedNonces(node.txid, f.contributions(node.txid, musig2.nonceGen(f.peerKey).public)),
    ])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(f.store.read().nonces[node.txid].aggregate).toBeDefined()
  })

  it('exposes no public key if initial persistence fails', async () => {
    const store = storage()
    store.failAfter(() => true)
    await expect(createDurablePoolRenewalSession(store.persistence)).rejects.toThrow(/key persistence failed/)
    const savedKey = store.read().publicKey
    store.failAfter()
    expect(hex.encode(await (await createDurablePoolRenewalSession(store.persistence)).getPublicKey())).toBe(savedKey)
  })
})
