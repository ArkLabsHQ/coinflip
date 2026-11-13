import { ArkAddress, asset, Batch, Estimator, Extension, isVtxoSpent, Proof, Transaction, VtxoScript, withPrevTxs,
  toOffchainInputFeeParams, type NormalizedExtendedVirtualCoin, type SignerSession, type Wallet } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { createDurablePoolRenewalSession, PoolRenewalAbandonedError, renewalAbandonable, withIndexedState, type PoolRenewalSessionPersistence } from './pool-renewal-session'
export { isPoolRenewalAbandoned, renewalAbandonable } from './pool-renewal-session'
import { createDurablePoolBatchReplay, createPoolTreeNonceReplayGuard, type PoolBatchReplayPersistence } from './pool-batch-replay'

export interface PoolInputRenewalPlan { inputs: NormalizedExtendedVirtualCoin[]; address: string; outputSats: bigint; maximumFeeSats: bigint }
export interface PoolInputRenewalSource { txid: string; vout: number; value: number; script: string; assets: Array<{ assetId: string; amount: string }> }
export interface PoolInputRenewalJournal {
  version: 1
  sources: PoolInputRenewalSource[]
  address: string
  outputSats: string
  maximumFeeSats: string
  proof: string
  message: Proof.RegisterMessage
  registrationAttempted: boolean
  intentId?: string
  commitmentTxid?: string
  status: 'pending' | 'confirmed'
}
export interface PoolInputRenewalPersistence {
  load(): Promise<PoolInputRenewalJournal | undefined>
  save(journal: PoolInputRenewalJournal): Promise<void>
  loadSession: PoolRenewalSessionPersistence['load']
  saveSession: PoolRenewalSessionPersistence['save']
  loadReplay: PoolBatchReplayPersistence['load']
  saveReplay: PoolBatchReplayPersistence['save']
}
export interface PoolInputRenewalReceipt { proofTxid: string; intentId: string | null; commitmentTxid: string; output: { txid: string; vout: number }; outputSats: string; assets: Array<{ assetId: string; amount: string }>; outputs: Array<{ outpoint: { txid: string; vout: number }; valueSats: string; assets: Array<{ assetId: string; amount: string }> }> }
const key = (coin: { txid: string; vout: number }) => `${coin.txid}:${coin.vout}`
const holdings = (values: Array<{ assetId: string; amount: bigint | string }> = []) => values.map(value => ({ assetId: value.assetId, amount: String(value.amount) })).sort((a, b) => a.assetId.localeCompare(b.assetId))
const sourcesFor = (coins: NormalizedExtendedVirtualCoin[]): PoolInputRenewalSource[] => coins.map(coin => ({ txid: coin.txid, vout: coin.vout, value: coin.value, script: coin.script, assets: holdings(coin.assets) }))
const equal = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second)
const holds = new WeakMap<Wallet, Map<string, ReturnType<Wallet['reserveVtxos']>>>()
const running = new WeakSet<Wallet>()
function reserve(wallet: Wallet, sources: Array<{ txid: string; vout: number }>, reservation?: ReturnType<Wallet['reserveVtxos']>): void {
  const id = sources.map(key).sort().join('|')
  if (reservation && reservation.outpoints.map(key).sort().join('|') !== id) throw new Error('Wallet input renewal reservation changed its selected sources')
  let owned = holds.get(wallet)
  if (!owned) { owned = new Map(); holds.set(wallet, owned) }
  if (!owned.has(id)) owned.set(id, reservation ?? wallet.reserveVtxos(sources.map(({ txid, vout }) => ({ txid, vout }))))
}
function release(wallet: Wallet, journal: PoolInputRenewalJournal): void {
  const id = journal.sources.map(key).sort().join('|')
  holds.get(wallet)?.get(id)?.release(); holds.get(wallet)?.delete(id)
}
function assetsFor(journal: PoolInputRenewalJournal): Array<{ assetId: string; amount: bigint }> {
  const all = new Map<string, bigint>()
  for (const source of journal.sources) for (const value of source.assets) all.set(value.assetId, (all.get(value.assetId) ?? 0n) + BigInt(value.amount))
  return [...all].map(([assetId, amount]) => ({ assetId, amount })).sort((a, b) => a.assetId.localeCompare(b.assetId))
}
function recipientsFor(journal: PoolInputRenewalJournal) {
  const total = BigInt(journal.outputSats), assets = assetsFor(journal)
  return assets.length && total >= 660n ? [{ amount: 330n, assets }, { amount: total - 330n, assets: [] }] : [{ amount: total, assets }]
}
function validate(journal: PoolInputRenewalJournal): Transaction {
  const proof = Transaction.fromPSBT(base64.decode(journal.proof)), script = ArkAddress.decode(journal.address).pkScript
  const paid = journal.sources.reduce((sum, source) => sum + BigInt(source.value), 0n) - BigInt(journal.outputSats)
  if (journal.version !== 1 || !journal.sources.length || new Set(journal.sources.map(key)).size !== journal.sources.length || proof.inputsLength !== journal.sources.length + 1 ||
    journal.message.type !== 'register' || journal.message.onchain_output_indexes.length || journal.message.cosigners_public_keys.length !== 1 ||
    recipientsFor(journal).some((value, i) => proof.getOutput(i).amount !== value.amount || hex.encode(proof.getOutput(i).script!) !== hex.encode(script)) ||
    BigInt(journal.outputSats) < 330n || paid < 0n || BigInt(journal.maximumFeeSats) < 0n || BigInt(journal.maximumFeeSats) > 100_000n || paid > BigInt(journal.maximumFeeSats)) throw new Error('Invalid saved wallet input renewal')
  journal.sources.forEach((source, i) => {
    const input = proof.getInput(i + 1)
    if (hex.encode(input.txid!) !== source.txid || input.index !== source.vout || input.witnessUtxo?.amount !== BigInt(source.value) || hex.encode(input.witnessUtxo.script) !== source.script) throw new Error('Wallet input renewal changed an approved source')
  })
  const expected = assetsFor(journal)
  const groups = expected.map(value => asset.AssetGroup.create(asset.AssetId.fromString(value.assetId), null,
    journal.sources.flatMap((source, index) => source.assets.filter(entry => entry.assetId === value.assetId).map(entry => asset.AssetInput.create(index + 1, BigInt(entry.amount)))),
    [asset.AssetOutput.create(0, value.amount)], []))
  if (proof.outputsLength !== recipientsFor(journal).length + (groups.length ? 1 : 0) || groups.length && !equal([...Extension.fromTx(proof).getAssetPacket()!.serialize()], [...asset.Packet.create(groups).serialize()])) throw new Error('Wallet input renewal changed its asset conservation')
  return proof
}
export function restorePoolInputRenewalHolds(wallet: Wallet, journal: PoolInputRenewalJournal, reservation?: ReturnType<Wallet['reserveVtxos']>): void {
  validate(journal)
  if (journal.status === 'confirmed') release(wallet, journal)
  else reserve(wallet, journal.sources, reservation)
}
export async function readPoolInputRenewalReceipt(wallet: Wallet, journal: PoolInputRenewalJournal): Promise<PoolInputRenewalReceipt | undefined> {
  const proof = validate(journal), indexed = (await wallet.indexerProvider.getVtxos({ outpoints: journal.sources.map(({ txid, vout }) => ({ txid, vout })), spendableOnly: false })).vtxos
  const exact = journal.sources.map(source => indexed.filter(coin => key(coin) === key(source)))
  if (exact.some((matches, i) => matches.length !== 1 || !equal({ txid: matches[0].txid, vout: matches[0].vout, value: matches[0].value, script: matches[0].script, assets: holdings(matches[0].assets) }, journal.sources[i]))) return undefined
  const commitment = journal.commitmentTxid ?? exact[0][0].settledBy
  if (!commitment || !exact.every(matches => isVtxoSpent(matches[0]) && matches[0].settledBy === commitment)) return undefined
  const script = hex.encode(ArkAddress.decode(journal.address).pkScript), expected = holdings(assetsFor(journal)), found: PoolInputRenewalReceipt['outputs'] = []
  const outputs = (await wallet.indexerProvider.getVtxos({ scripts: [script], spendableOnly: false })).vtxos
  for (const wanted of recipientsFor(journal)) {
   for (const coin of outputs) {
    if (found.some(value => key(value.outpoint) === key(coin)) || coin.value !== Number(wanted.amount) || coin.script !== script || !coin.commitmentTxIds?.includes(commitment) || !equal(holdings(coin.assets), holdings(wanted.assets))) continue
    const raw = (await wallet.indexerProvider.getVirtualTxs([coin.txid])).txs.map(value => Transaction.fromPSBT(base64.decode(value)))
    const source = raw.find(value => value.id === coin.txid), output = source?.getOutput(coin.vout)
    if (!source || output?.amount !== wanted.amount || hex.encode(output.script!) !== script) continue
    const extension = Array.from({ length: source.outputsLength }, (_, i) => source.getOutput(i)).some(value => value.script && Extension.isExtension(value.script)) ? Extension.fromTx(source) : undefined
    const groups = extension?.getAssetPacket()?.groups ?? []
    const actual = groups.flatMap(group => group.outputs.filter(value => value.vout === coin.vout).map(value => ({ assetId: group.assetId?.toString() ?? '', amount: String(value.amount) })))
    if (!equal(holdings(actual), holdings(wanted.assets)) || wanted.assets.length && !groups.some(group => group.inputs.some(value => value.input.type === asset.AssetInputType.Proof && hex.encode(value.input.txid) === proof.id))) continue
    found.push({ outpoint: { txid: coin.txid, vout: coin.vout }, valueSats: String(wanted.amount), assets: holdings(wanted.assets) }); break
   }
  }
  if (found.length === recipientsFor(journal).length) {
    await wallet.indexerProvider.getCommitmentTx(commitment)
    return { proofTxid: proof.id, intentId: journal.intentId ?? null, commitmentTxid: commitment, output: found[0].outpoint, outputSats: journal.outputSats, assets: expected, outputs: found }
  }
  return undefined
}
async function prepare(wallet: Wallet, plan: PoolInputRenewalPlan, persistence: PoolInputRenewalPersistence, session: SignerSession, signal?: AbortSignal): Promise<PoolInputRenewalJournal> {
  if (!plan.inputs.length || plan.inputs.length > 100 || new Set(plan.inputs.map(key)).size !== plan.inputs.length || plan.outputSats < 330n || plan.maximumFeeSats < 0n || plan.maximumFeeSats > 100_000n) throw new Error('Invalid wallet input renewal plan')
  const address = await wallet.getAddress()
  if (address !== plan.address) throw new Error('Wallet input renewal must pay the current wallet address')
  const owned = await wallet.getVtxos({ withRecoverable: true })
  if (plan.inputs.some(input => !owned.some(coin => key(coin) === key(input) && !isVtxoSpent(coin) && !coin.isUnrolled && equal(sourcesFor([coin]), sourcesFor([input]))) || isVtxoSpent(input) || input.isUnrolled || hex.encode(VtxoScript.decode(input.tapTree).pkScript) !== input.script)) throw new Error('Wallet input renewal source is unavailable or changed')
  const indexed = (await wallet.indexerProvider.getVtxos({ outpoints: plan.inputs.map(({ txid, vout }) => ({ txid, vout })), spendableOnly: false })).vtxos
  if (plan.inputs.some(input => !indexed.some(coin => key(coin) === key(input) && !isVtxoSpent(coin) && !coin.isUnrolled))) throw new Error('Wallet input renewal source was already spent; refresh the wallet before renewing')
  const total = plan.inputs.reduce((sum, input) => sum + BigInt(input.value), 0n), paid = total - plan.outputSats
  const sources = sourcesFor(plan.inputs), partial = { sources, outputSats: String(plan.outputSats) } as PoolInputRenewalJournal
  const info = await wallet.getArkadeInfo({ requireLive: true }), script = ArkAddress.decode(address).pkScript
  const fee = BigInt(new Estimator(info.fees.intentFee).evaluate(plan.inputs.map(toOffchainInputFeeParams), [], recipientsFor(partial).map(value => ({ amount: value.amount, script: hex.encode(script) })), []).satoshis)
  if (fee < 0n || paid < fee || paid < 0n || paid > plan.maximumFeeSats) throw new Error('The batch fee increased; review a new maximum fee')
  const now = Math.floor(Date.now() / 1000), message: Proof.RegisterMessage = { type: 'register', onchain_output_indexes: [], valid_at: now - 1, expire_at: now + 120, cosigners_public_keys: [hex.encode(await session.getPublicKey())] }
  const assets = assetsFor(partial), outputs = recipientsFor(partial).map(value => ({ script, amount: value.amount }))
  if (assets.length) outputs.push(Extension.create([asset.Packet.create(assets.map(value => asset.AssetGroup.create(asset.AssetId.fromString(value.assetId), null,
    sources.flatMap((source, index) => source.assets.filter(entry => entry.assetId === value.assetId).map(entry => asset.AssetInput.create(index + 1, BigInt(entry.amount)))), [asset.AssetOutput.create(0, value.amount)], [])))]).txOut())
  const inputs = await withPrevTxs(plan.inputs, wallet.indexerProvider, wallet.onchainProvider), unsigned = Proof.create(message, inputs, outputs)
  signal?.throwIfAborted()
  const signed = await wallet.signInputsByWitnessScript(unsigned)
  if (signed.id !== unsigned.id) throw new Error('Wallet renewal signer changed the reviewed transaction')
  const journal: PoolInputRenewalJournal = { version: 1, sources, address, outputSats: String(plan.outputSats), maximumFeeSats: String(plan.maximumFeeSats), proof: base64.encode(signed.toPSBT()), message, registrationAttempted: false, status: 'pending' }
  validate(journal); await persistence.save(journal)
  return journal
}
export async function renewPoolInputs(wallet: Wallet, persistence: PoolInputRenewalPersistence, options: { plan?: PoolInputRenewalPlan; signal?: AbortSignal; reservation?: ReturnType<Wallet['reserveVtxos']> } = {}): Promise<PoolInputRenewalReceipt> {
  if (running.has(wallet)) throw new Error('Wallet input renewal is already running')
  running.add(wallet)
  let journal: PoolInputRenewalJournal | undefined
  try {
    journal = await persistence.load()
    if (journal) restorePoolInputRenewalHolds(wallet, journal, options.reservation)
    else if (options.plan) reserve(wallet, options.plan.inputs, options.reservation)
    else throw new Error('No saved wallet input renewal is available')
    const confirm = async () => {
      const receipt = await readPoolInputRenewalReceipt(wallet, journal!)
      if (receipt) { journal = { ...journal!, status: 'confirmed', commitmentTxid: receipt.commitmentTxid }; await persistence.save(journal); release(wallet, journal) }
      return receipt
    }
    if (journal) { const receipt = await confirm(); if (receipt) return receipt }
    if (journal && renewalAbandonable(journal.message)) {
      release(wallet, journal)
      throw new PoolRenewalAbandonedError('Saved wallet input renewal lapsed without a batch outcome; its inputs are released')
    }
    const savedSession = await persistence.loadSession()
    if (journal && !savedSession) throw new Error('Wallet renewal signing session is unavailable; its inputs remain reserved')
    const session = await createDurablePoolRenewalSession({ load: persistence.loadSession, save: persistence.saveSession })
    options.signal?.throwIfAborted()
    journal ??= await prepare(wallet, options.plan!, persistence, session, options.signal)
    if (journal.registrationAttempted && !journal.intentId) throw new Error('Wallet renewal registration is unknown; retain its exact intent and inputs for operator recovery')
    if (!journal.intentId && journal.message.expire_at <= Math.floor(Date.now() / 1000)) throw new Error('The saved wallet input renewal expired without a proven batch outcome')
    if (journal.message.cosigners_public_keys[0] !== hex.encode(await session.getPublicKey())) throw new Error('Wallet renewal signing session does not match its saved proof')
    const coins = await wallet.getVtxos({ withRecoverable: true })
    const stored = journal.sources.map(source => coins.find(coin => key(coin) === key(source) && equal(sourcesFor([coin])[0], source)))
    const inputs = stored.some(input => !input) ? [] : await withIndexedState(wallet.indexerProvider, stored as NormalizedExtendedVirtualCoin[])
    if (!inputs.length || inputs.some(input => isVtxoSpent(input) || input.isUnrolled)) throw new Error('Wallet renewal inputs are unavailable; reconcile the exact saved intent')
    const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
    const timeout = setTimeout(() => controller.abort(new Error('Wallet renewal is waiting for operator recovery')), 120_000)
    const topics = [...journal.message.cosigners_public_keys, ...journal.sources.map(key)], stream = wallet.arkProvider.getEventStream(controller.signal, topics), firstNext = stream.next()
    void firstNext.catch(() => {})
    const primed = (async function* () { const first = await firstNext; if (!first.done) yield first.value; yield* stream })()
    try {
      if (!journal.intentId) {
        journal = { ...journal, registrationAttempted: true }; await persistence.save(journal)
        controller.signal.throwIfAborted()
        const intentId = await wallet.arkProvider.registerIntent({ proof: journal.proof, message: journal.message })
        journal = { ...journal, intentId }; await persistence.save(journal)
      }
      const replay = await createDurablePoolBatchReplay({ load: persistence.loadReplay, save: persistence.saveReplay }, { intentId: journal.intentId! }), savedEvents = replay.savedEvents()
      const guard = createPoolTreeNonceReplayGuard(session, savedEvents)
      const base = wallet.createBatchHandler(journal.intentId!, inputs as NormalizedExtendedVirtualCoin[], recipientsFor(journal).map(value => ({ address: journal!.address, amount: Number(value.amount), assets: value.assets })), guard.session)
      const handler = guard.handler(base)
      const commitmentTxid = await Batch.join(replay.stream(primed, controller.signal), handler, { abortController: controller })
      journal = { ...journal, commitmentTxid }; await persistence.save(journal)
      for (let attempt = 0; attempt < 60; attempt++) {
        controller.signal.throwIfAborted()
        const receipt = await confirm(); if (receipt) return receipt
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      throw new Error('Wallet renewal awaits exact returned bitcoin and asset evidence')
    } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); controller.abort(); await stream.return?.() }
  } catch (error) {
    const stored = await persistence.load()
    if (!stored?.registrationAttempted && (stored || options.plan)) release(wallet, stored ?? { sources: sourcesFor(options.plan!.inputs) } as PoolInputRenewalJournal)
    throw error
  } finally { running.delete(wallet) }
}
