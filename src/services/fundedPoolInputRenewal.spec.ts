import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArkAddress, asset, Batch, DefaultVtxo, Extension, SettlementEventType, SingleKey, Transaction,
  type NormalizedExtendedVirtualCoin, type SettlementEvent, type Wallet } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { createFundedPoolInputRenewal, restorePoolInputRenewalHolds } from './fundedPoolInputRenewal'
import type { FundedPoolContext } from './fundedPoolJournal'
import type { FundedPoolInputRenewalDisplay } from './fundedPoolTypes'

vi.mock('arkade-coinflip/dist/pool-input-renewal.js', () => import('../../packages/lib/src/pool-input-renewal'))
let serial = 0
afterEach(() => vi.restoreAllMocks())
async function fixture(values: Array<{ value: number; shares?: bigint; otherAsset?: boolean; lifetime?: number }> = [{ value: 10000 }]) {
  const owner = SingleKey.fromHex('01'.repeat(32)), server = SingleKey.fromHex('02'.repeat(32))
  const script = new DefaultVtxo.Script({ pubKey: await owner.xOnlyPublicKey(), serverPubKey: await server.xOnlyPublicKey(), csvTimelock: { type: 'seconds', value: 1536n } })
  const address = script.address('tark', await server.xOnlyPublicKey()).encode(), shareAssetId = asset.AssetId.create('11'.repeat(32), 1).toString()
  const coins = values.map((value, index) => {
    const source = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true })
    source.addInput({ txid: (index + 20).toString(16).padStart(64, '0'), index: 0 }); source.addOutput({ script: script.pkScript, amount: BigInt(value.value) })
    return { txid: source.id, vout: 0, value: value.value, prevTx: source.toBytes(),
      script: hex.encode(script.pkScript), tapTree: script.encode(), forfeitTapLeafScript: script.forfeit(), intentTapLeafScript: script.forfeit(),
      assets: value.shares ? [{ assetId: value.otherAsset ? asset.AssetId.create('33'.repeat(32), 0).toString() : shareAssetId, amount: value.shares }] : [],
      createdAt: new Date(), expiresAt: new Date(Date.now() + (value.lifetime ?? 5000) * 1000), isSpent: false, isUnrolled: false, isSwept: false,
      isPreconfirmed: false, spentBy: '', commitmentTxIds: [], status: { confirmed: false } } as NormalizedExtendedVirtualCoin
  })
  const context: FundedPoolContext = { publicKey: String(++serial).padStart(64, '0'), network: 'regtest', operatorUrl: 'http://operator.invalid' }
  let config = { offchainInput: '10.0', offchainOutput: '5.0' }, current = true
  const releases: ReturnType<typeof vi.fn>[] = [], states: FundedPoolInputRenewalDisplay[] = [], held = new Set<string>()
  const reserveVtxos = vi.fn((points: Array<{ txid: string; vout: number }>) => {
    if (points.some(point => held.has(`${point.txid}:${point.vout}`))) throw new Error('Already reserved')
    points.forEach(point => held.add(`${point.txid}:${point.vout}`))
    const release = vi.fn(() => points.forEach(point => held.delete(`${point.txid}:${point.vout}`)))
    releases.push(release); return { outpoints: points, release }
  })
  const registerIntent = vi.fn(async (request: { proof: string; message: unknown }) => { void request; return 'intent-public-uuid' }), sign = vi.fn((tx: Transaction) => owner.sign(tx))
  const join = vi.spyOn(Batch, 'join').mockRejectedValue(new Error('batch stream interrupted'))
  const createBatchHandler = vi.fn((id: string, inputs: unknown, recipients: unknown, session: { getPublicKey(): Promise<Uint8Array> }) => {
    void [id, inputs, recipients, session]
    return { onBatchStarted: vi.fn(), onTreeSigningStarted: vi.fn(), onTreeNonces: vi.fn(), onBatchFinalization: vi.fn() }
  })
  const wallet = { identity: owner, getAddress: vi.fn(async () => address), getArkadeInfo: vi.fn(async () => ({ fees: { intentFee: config } })),
    getSpendableVtxos: vi.fn(async () => coins.filter(coin => !coin.isSpent)), getVtxos: vi.fn(async () => coins), reserveVtxos, signInputsByWitnessScript: sign, createBatchHandler,
    arkProvider: { registerIntent, getEventStream: vi.fn(async function* (): AsyncGenerator<SettlementEvent> { yield { type: SettlementEventType.StreamStarted, id: '' } as SettlementEvent }) },
    indexerProvider: { getVtxos: vi.fn(async () => ({ vtxos: coins })), getCommitmentTx: vi.fn(async () => ({})), getVirtualTxs: vi.fn(async () => ({ txs: [] })) } } as unknown as Wallet
  const options = { wallet, context, shareAssetId, minimumLifetimeSeconds: 6000, isCurrent: () => current, onState: (state: FundedPoolInputRenewalDisplay) => { states.push(state) } }
  const service = createFundedPoolInputRenewal(options)
  return { service, options, wallet, coins, address, context, sign, join, registerIntent, createBatchHandler, reserveVtxos, releases, states,
    fee: (input: string) => { config = { ...config, offchainInput: `${input}.0` } }, stale: () => { current = false } }
}

describe('reviewed wallet input renewal', () => {
  it('persists only the three context strings when the runtime context also owns a callback-bearing wallet', async () => {
    const f = await fixture(), runtimeContext = { ...f.context, wallet: f.wallet, eventCallback: (txs: Transaction[]) => txs }
    expect(() => structuredClone(runtimeContext)).toThrow()
    const stored: FundedPoolContext[] = [], original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'renewals') stored.push(value.context)
      return original.call(this, value, key)
    })
    const service = createFundedPoolInputRenewal({ ...f.options, context: runtimeContext })
    const quote = await service.prepare()
    await expect(service.confirm(quote)).rejects.toThrow('batch stream interrupted')
    expect(f.registerIntent).toHaveBeenCalledOnce()
    expect(stored.length).toBeGreaterThan(0)
    for (const context of stored) {
      expect(context).toEqual(f.context)
      expect(Object.keys(context).sort()).toEqual(['network', 'operatorUrl', 'publicKey'])
      expect(() => structuredClone(context)).not.toThrow()
    }
  })
  it('prepares without signing and persists a signed fee-capped self output', async () => {
    const f = await fixture(), quote = await f.service.prepare({ kind: 'plain', amount: 5000n })
    expect(quote).toMatchObject({ estimatedFeeSats: '15', estimatedOutputSats: '9985', feeEstimateOnly: false })
    expect(f.sign).not.toHaveBeenCalled(); expect(f.reserveVtxos).not.toHaveBeenCalled()
    expect(Object.isFrozen(quote.inputs[0].outpoint)).toBe(true)
    await expect(f.service.confirm(quote)).rejects.toThrow('batch stream interrupted')
    const sent = f.registerIntent.mock.calls[0][0], proof = Transaction.fromPSBT(base64.decode(sent.proof))
    expect(proof.getOutput(0)).toMatchObject({ amount: 9985n, script: ArkAddress.decode(f.address).pkScript })
    expect(proof.getInput(1).tapScriptSig?.length).toBeGreaterThan(0)
    expect(f.states.at(-1)?.status).toBe('recovery'); expect(f.releases[0]).not.toHaveBeenCalled()
  })
  it('preserves the sole share asset on 330 sats and returns the fee sponsor as plain bitcoin', async () => {
    const f = await fixture([{ value: 330, shares: 500n }, { value: 1000 }, { value: 100000, shares: 99n, otherAsset: true }])
    const quote = await f.service.prepare({ kind: 'shares', amount: 500n })
    expect(quote.inputs.map(input => input.valueSats)).toEqual(['330', '1000'])
    expect(quote).toMatchObject({ estimatedFeeSats: '30', estimatedOutputSats: '1300' })
    await expect(f.service.confirm(quote)).rejects.toThrow('batch stream interrupted')
    const proof = Transaction.fromPSBT(base64.decode(f.registerIntent.mock.calls[0][0].proof)), groups = Extension.fromTx(proof).getAssetPacket()!.groups
    expect(groups).toHaveLength(1); expect(groups[0].inputs).toEqual([asset.AssetInput.create(1, 500n)])
    expect(groups[0].outputs).toEqual([asset.AssetOutput.create(0, 500n)])
    expect([proof.getOutput(0).amount, proof.getOutput(1).amount]).toEqual([330n, 970n])
    expect(f.createBatchHandler.mock.calls[0][2]).toEqual([{ address: f.address, amount: 330, assets: f.coins[0].assets }, { address: f.address, amount: 970, assets: [] }])
    expect(f.coins[2].isSpent).toBe(false)
  })
  it('rejects a higher fee or changed source before requesting a signature', async () => {
    const f = await fixture(), quote = await f.service.prepare(); f.fee('100')
    await expect(f.service.confirm(quote)).rejects.toThrow(/fee increased/)
    expect(f.sign).not.toHaveBeenCalled(); expect(f.registerIntent).not.toHaveBeenCalled()
    f.fee('10'); f.coins[0].value++
    await expect(f.service.confirm(quote)).rejects.toThrow(/inputs changed/); expect(f.sign).not.toHaveBeenCalled()
  })
  it('never posts when the mandatory registration-attempt journal cannot be saved', async () => {
    const f = await fixture(), quote = await f.service.prepare(), original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (value.journal?.registrationAttempted === true) throw new DOMException('disk full', 'QuotaExceededError')
      return original.call(this, value, key)
    })
    await expect(f.service.confirm(quote)).rejects.toThrow('disk full')
    expect(f.registerIntent).not.toHaveBeenCalled(); expect(f.releases[0]).toHaveBeenCalledOnce()
  })
  it('never posts when the exact signed proof cannot be durably saved', async () => {
    const f = await fixture(), quote = await f.service.prepare(), original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (value.journal?.proof) throw new DOMException('proof storage failed', 'QuotaExceededError')
      return original.call(this, value, key)
    })
    await expect(f.service.confirm(quote)).rejects.toThrow('proof storage failed')
    expect(f.sign).toHaveBeenCalledOnce(); expect(f.registerIntent).not.toHaveBeenCalled(); expect(f.releases[0]).toHaveBeenCalledOnce()
  })
  it('retains a lost registration response through restart and never signs from refresh', async () => {
    const f = await fixture(), quote = await f.service.prepare(); f.registerIntent.mockRejectedValueOnce(new Error('response lost'))
    await expect(f.service.confirm(quote)).rejects.toThrow('response lost'); f.service.dispose()
    expect(f.releases[0]).not.toHaveBeenCalled()
    const restored = { reserveVtxos: vi.fn(points => ({ outpoints: points, release: vi.fn() })) } as unknown as Wallet
    await restorePoolInputRenewalHolds(restored, f.context); expect(restored.reserveVtxos).toHaveBeenCalledWith([quote.inputs[0].outpoint])
    const resumed = createFundedPoolInputRenewal(f.options)
    await resumed.refresh(); expect(f.sign).toHaveBeenCalledOnce(); expect(f.registerIntent).toHaveBeenCalledOnce()
    await expect(resumed.recover()).rejects.toThrow(/registration is unknown/)
    expect(f.registerIntent).toHaveBeenCalledOnce(); expect(f.sign).toHaveBeenCalledOnce()
  })
  it('resumes only by explicit recovery using the saved session and accepted intent', async () => {
    const f = await fixture(), quote = await f.service.prepare()
    await expect(f.service.confirm(quote)).rejects.toThrow('batch stream interrupted')
    await f.service.refresh(); expect(f.join).toHaveBeenCalledOnce()
    await expect(f.service.recover()).rejects.toThrow('batch stream interrupted')
    expect(f.join).toHaveBeenCalledTimes(2); expect(f.registerIntent).toHaveBeenCalledOnce(); expect(f.sign).toHaveBeenCalledOnce()
    const first = f.createBatchHandler.mock.calls[0], second = f.createBatchHandler.mock.calls[1]
    expect(first[0]).toBe(second[0]); expect(await first[3].getPublicKey()).toEqual(await second[3].getPublicKey())
    f.coins[0].isSpent = true; f.coins[0].settledBy = 'bb'.repeat(32)
    await f.service.refresh(); expect(f.releases[0]).not.toHaveBeenCalled()
  })
  it('uses the actual network lifetime plus 120 seconds and refuses unrelated assets or stale context', async () => {
    const f = await fixture([{ value: 10000, lifetime: 6200 }])
    await expect(f.service.prepare()).rejects.toThrow(/No eligible/)
    const production = createFundedPoolInputRenewal({ ...f.options, minimumLifetimeSeconds: 90428 })
    expect((await production.prepare()).inputs).toHaveLength(1)
    const other = await fixture([{ value: 10000, shares: 500n, otherAsset: true }])
    await expect(other.service.prepare()).rejects.toThrow(/No eligible/)
    const stale = await fixture(), quote = await stale.service.prepare(); stale.stale()
    await expect(stale.service.confirm(quote)).rejects.toThrow(/context changed/); expect(stale.registerIntent).not.toHaveBeenCalled()
  })
})
