import { base64, hex } from '@scure/base'
import { ArkAddress, CSVMultisigTapscript, DefaultVtxo, Extension, SingleKey, Transaction, asset, networks,
  verifyTapscriptSignatures, type NormalizedExtendedVirtualCoin, type Wallet } from '@arkade-os/sdk'
import { bootstrapPool, restorePoolBootstrapHolds, submitPoolWalletStage, verifyPoolWalletStage,
  type PoolBootstrapJournal, type PoolBootstrapPersistence } from 'arkade-coinflip/dist/pool-game-vault'

const decode = (value: string) => Transaction.fromPSBT(base64.decode(value))
const encode = (value: Transaction) => base64.encode(value.toPSBT())
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const options = { name: 'Durable pool', initialNavSats: '10000', network: 'regtest', operatorUrl: 'http://operator.invalid', operatorFeeBps: 2000, minHouseEdgeBps: 100, maxStakeBps: 2000 }

async function fixture() {
  const owner = SingleKey.fromHex('01'.repeat(32)), server = SingleKey.fromHex('02'.repeat(32))
  const ownerKey = await owner.xOnlyPublicKey(), serverKey = await server.xOnlyPublicKey()
  const script = new DefaultVtxo.Script({ pubKey: ownerKey, serverPubKey: serverKey, csvTimelock: { type: 'seconds', value: 512n } })
  const checkpoint = CSVMultisigTapscript.encode({ pubkeys: [serverKey], timelock: { type: 'seconds', value: 512n } })
  const info = { network: 'regtest', signerPubkey: hex.encode(serverKey), unilateralExitDelay: 512n, checkpointTapscript: hex.encode(checkpoint.script) }
  const coins = new Map<string, NormalizedExtendedVirtualCoin>(), transactions = new Map<string, Transaction>()
  const key = (point: { txid: string; vout: number }) => `${point.txid}:${point.vout}`
  const add = (value: Transaction) => {
    transactions.set(value.id, value)
    const groups = Array.from({ length: value.outputsLength }, (_, i) => value.getOutput(i)).some(output => output.script && Extension.isExtension(output.script))
      ? Extension.fromTx(value).getAssetPacket()?.groups ?? [] : []
    for (let vout = 0; vout < value.outputsLength; vout++) {
      const output = value.getOutput(vout)
      if (!output.amount) continue
      const assets = groups.flatMap((group, index) => group.outputs.filter(item => item.vout === vout).map(item => ({
        assetId: (group.assetId ?? asset.AssetId.create(value.id, index)).toString(), amount: item.amount })))
      coins.set(`${value.id}:${vout}`, { txid: value.id, vout, value: Number(output.amount), script: hex.encode(output.script!), assets,
        isSpent: false, isSwept: false, isUnrolled: false, isPreconfirmed: true, status: { confirmed: false }, createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000),
        tapTree: script.encode(), forfeitTapLeafScript: script.forfeit(), intentTapLeafScript: script.forfeit(), commitmentTxIds: [], spentBy: '' } as NormalizedExtendedVirtualCoin)
    }
  }
  const funding = new Transaction({ version: 3 })
  funding.addInput({ txid: new Uint8Array(32).fill(7), index: 0 })
  funding.addOutput({ script: script.pkScript, amount: 20000n })
  add(funding)
  let saved: PoolBootstrapJournal | undefined, lose = '', twoPhase = false, failFinalize = false
  let failSave: ((journal: PoolBootstrapJournal) => boolean) | undefined
  const persistence: PoolBootstrapPersistence = { load: jest.fn(async () => saved && copy(saved)), save: jest.fn(async value => {
    saved = copy(value)
    if (failSave?.(value)) throw new Error('storage acknowledgment lost')
  }) }
  const calls: Array<{ arkTx: string; checkpointTxs: string[] }> = []
  const pending = new Map<string, { arkTx: Transaction; checkpoints: Transaction[] }>()
  const accept = (arkTx: Transaction, checkpoints: Transaction[]) => {
    for (const [vin, cp] of checkpoints.entries()) {
      const input = cp.getInput(0), point = { txid: hex.encode(input.txid!), vout: input.index! }
      const coin = coins.get(key(point))!
      if (coin.isSpent && coin.arkTxId !== arkTx.id) throw new Error('input already spent')
      verifyTapscriptSignatures(arkTx, vin, [hex.encode(ownerKey)])
      verifyTapscriptSignatures(cp, 0, [hex.encode(ownerKey)])
      coin.isSpent = true; coin.spentBy = cp.id; coin.arkTxId = arkTx.id
      transactions.set(cp.id, cp)
    }
    add(arkTx)
  }
  const submitTx = jest.fn(async (arkTx: string, checkpointTxs: string[]) => {
    const actual = decode(arkTx), checkpoints = checkpointTxs.map(decode)
    const stage = actual.id === saved?.genesis?.arkTxid ? saved.genesis : saved?.activation
    expect(stage).toMatchObject({ arkTxid: actual.id, arkTx, checkpointTxs, submitted: true })
    calls.push({ arkTx, checkpointTxs })
    if (lose === 'before-acceptance') { lose = ''; throw new Error('connection lost before acceptance') }
    if (!twoPhase) accept(actual, checkpoints)
    else pending.set(actual.id, { arkTx: actual, checkpoints })
    if (lose === 'genesis' && actual.id === saved?.genesis?.arkTxid || lose === 'activation' && actual.id === saved?.activation?.arkTxid) {
      lose = ''; throw new Error('submit response lost')
    }
    const returned = await Promise.all(checkpoints.map(async cp => {
      if (!twoPhase) return encode(await server.sign(cp))
      const bare = Transaction.fromRaw(cp.toBytes())
      const { tapScriptSig, ...input } = cp.getInput(0)
      void tapScriptSig
      bare.updateInput(0, input)
      for (let i = 0; i < cp.outputsLength; i++) bare.updateOutput(i, cp.getOutput(i))
      return encode(await server.sign(bare))
    }))
    return { arkTxid: actual.id, signedCheckpointTxs: returned, finalArkTx: encode(actual) }
  })
  const finalizeTx = jest.fn(async (id: string, checkpoints: string[]) => {
    const stage = saved?.genesis?.arkTxid === id ? saved.genesis : saved?.activation
    expect(stage?.finalizeCheckpointTxs).toEqual(checkpoints)
    if (failFinalize) { failFinalize = false; throw new Error('finalize response lost') }
    accept(pending.get(id)!.arkTx, checkpoints.map(decode))
  })
  const wallet = () => {
    const held = new Set<string>(), releases: Array<jest.Mock> = []
    const reserveVtxos = jest.fn((points: Array<{ txid: string; vout: number }>) => {
      if (points.some(point => held.has(key(point)))) throw new Error('duplicate reservation')
      points.forEach(point => held.add(key(point)))
      const release = jest.fn(() => points.forEach(point => held.delete(key(point))))
      releases.push(release)
      return { outpoints: points, release }
    })
    const value = { identity: owner, network: networks.regtest, getAddress: async () => new ArkAddress(serverKey, script.tweakedPublicKey, 'tark').encode(),
      getArkadeInfo: async () => info, getSpendableVtxos: async () => [...coins.values()].filter(coin => !coin.isSpent && coin.script === hex.encode(script.pkScript) && !held.has(key(coin))),
      getVtxos: async () => [...coins.values()].filter(coin => !coin.isSpent && coin.script === hex.encode(script.pkScript)), reserveVtxos,
      arkProvider: { submitTx, finalizeTx }, indexerProvider: {
        getVtxos: async (query: { outpoints?: Array<{ txid: string; vout: number }>; scripts?: string[] }) => ({ vtxos: [...coins.values()].filter(coin => query.outpoints
          ? query.outpoints.some(point => key(point) === key(coin)) : query.scripts?.includes(coin.script)) }),
        getVirtualTxs: async (ids: string[]) => ({ txs: ids.flatMap(id => transactions.has(id) ? [encode(transactions.get(id)!)] : []) }),
      } } as unknown as Wallet
    return { value, held, releases, reserveVtxos }
  }
  return { wallet, persistence, submitTx, finalizeTx, calls, journal: () => saved!,
    lose: (stage: string) => { lose = stage }, twoPhase: () => { twoPhase = true }, failFinalize: () => { failFinalize = true },
    failSave: (predicate: typeof failSave) => { failSave = predicate } }
}

describe('pool bootstrap durable exact transactions', () => {
  it.each(['too-short', 'unknown'])('refuses %s funding lifetime before issuing any pool assets', async lifetime => {
    const f = await fixture(), first = f.wallet()
    const coins = await first.value.getSpendableVtxos()
    coins[0].expiresAt = lifetime === 'unknown' ? undefined : new Date(Date.now() + 6_000_000)
    await expect(bootstrapPool(first.value, options, f.persistence)).rejects.toThrow('Renew plain wallet capital')
    expect(f.journal()).toBeUndefined()
    expect(f.submitTx).not.toHaveBeenCalled()
    expect(f.finalizeTx).not.toHaveBeenCalled()
    expect(first.held.size).toBe(0)
  })

  it.each(['genesis', 'activation'])('recovers a lost %s response after restart without issuing another series', async stage => {
    const f = await fixture(), first = f.wallet()
    f.lose(stage)
    await expect(bootstrapPool(first.value, options, f.persistence)).rejects.toThrow('submit response lost')
    const committed = copy(f.journal()), interrupted = committed[stage as 'genesis' | 'activation']!
    expect(first.held).toEqual(new Set([...interrupted.inputOutpoints.map(point => `${point.txid}:${point.vout}`),
      `${committed.genesis!.arkTxid}:0`, `${committed.genesis!.arkTxid}:1`]))
    const second = f.wallet()
    restorePoolBootstrapHolds(second.value, committed)
    const result = await bootstrapPool(second.value, options, f.persistence)
    expect(result.descriptor.controlAssetId).toBe(asset.AssetId.create(f.journal().genesis!.arkTxid, 0).toString())
    expect(f.journal().genesis!.arkTx).toBe(committed.genesis!.arkTx)
    expect(f.journal().complete).toBe(true)
    expect(f.calls).toHaveLength(2)
    expect(second.held.size).toBe(0)
    expect(result.snapshot.navSats).toBe('10000')
  })

  it('retains a committed plan when the storage acknowledgment fails before any external write', async () => {
    const f = await fixture(), first = f.wallet()
    f.failSave(value => !!value.genesis && !value.genesis.submitted)
    await expect(bootstrapPool(first.value, options, f.persistence)).rejects.toThrow('storage acknowledgment lost')
    const original = copy(f.journal().genesis!)
    expect(f.submitTx).not.toHaveBeenCalled()
    expect(first.held.size).toBe(original.inputOutpoints.length + 2)
    f.failSave(undefined)
    const second = f.wallet()
    await bootstrapPool(second.value, options, f.persistence)
    expect(f.calls[0]).toEqual({ arkTx: original.arkTx, checkpointTxs: original.checkpointTxs })
    expect(second.held.size).toBe(0)
  })

  it('retries the identical signed issuance when the first ambiguous attempt was not accepted', async () => {
    const f = await fixture(), first = f.wallet()
    f.lose('before-acceptance')
    await expect(bootstrapPool(first.value, options, f.persistence)).rejects.toThrow('connection lost before acceptance')
    await bootstrapPool(f.wallet().value, options, f.persistence)
    expect(f.calls).toHaveLength(3)
    expect(f.calls[1]).toEqual(f.calls[0])
    expect(f.journal().complete).toBe(true)
  })

  it('persists and resumes exact finalization bytes without submitting a replacement', async () => {
    const f = await fixture(), first = f.wallet()
    f.twoPhase(); f.failFinalize()
    await expect(bootstrapPool(first.value, options, f.persistence)).rejects.toThrow('finalize response lost')
    const final = [...f.journal().genesis!.finalizeCheckpointTxs!]
    expect(final.length).toBeGreaterThan(0)
    const second = f.wallet()
    await bootstrapPool(second.value, options, f.persistence)
    expect(f.finalizeTx.mock.calls[1][1]).toEqual(final)
    expect(f.calls).toHaveLength(2)
  })

  it('refuses changed policy and invalid constructor arguments before any submission', async () => {
    const f = await fixture(), first = f.wallet()
    await expect(bootstrapPool(first.value, { ...options, maxStakeBps: 2001 }, f.persistence)).rejects.toThrow('Invalid pool policy')
    expect(f.journal()).toBeUndefined()
    expect(f.submitTx).not.toHaveBeenCalled()
    f.lose('genesis')
    await expect(bootstrapPool(first.value, options, f.persistence)).rejects.toThrow('submit response lost')
    await expect(bootstrapPool(f.wallet().value, { ...options, operatorFeeBps: 1999 }, f.persistence)).rejects.toThrow('different options')
    expect(f.submitTx).toHaveBeenCalledTimes(1)
  })

  it('binds a resumed descriptor to the policy whose hash was saved', async () => {
    const f = await fixture(), first = f.wallet()
    f.lose('genesis')
    await expect(bootstrapPool(first.value, options, f.persistence)).rejects.toThrow('submit response lost')
    f.journal().descriptor!.operatorFeeBps = 0
    await expect(bootstrapPool(f.wallet().value, options, f.persistence)).rejects.toThrow('changed its constructor policy')
    expect(f.submitTx).toHaveBeenCalledTimes(1)
  })

  it('replays a saved wallet funding stage without constructing or signing a replacement', async () => {
    const f = await fixture()
    f.lose('before-acceptance')
    await expect(bootstrapPool(f.wallet().value, options, f.persistence)).rejects.toThrow(/before acceptance/)
    const original = copy(f.journal().genesis!), wallet = f.wallet().value
    await submitPoolWalletStage(wallet, original, next => f.persistence.save({ ...f.journal(), genesis: next }))
    expect(await verifyPoolWalletStage(wallet, f.journal().genesis!)).toBe(true)
    expect(f.calls[1]).toEqual(f.calls[0])
    expect(f.journal().genesis!.arkTx).toBe(original.arkTx)
  })

  it('persists exact wallet-stage finalization and resumes it after a lost response', async () => {
    const f = await fixture()
    f.lose('before-acceptance')
    await expect(bootstrapPool(f.wallet().value, options, f.persistence)).rejects.toThrow(/before acceptance/)
    f.twoPhase(); f.failFinalize()
    const save = (next: NonNullable<PoolBootstrapJournal['genesis']>) => f.persistence.save({ ...f.journal(), genesis: next })
    await expect(submitPoolWalletStage(f.wallet().value, f.journal().genesis!, save)).rejects.toThrow(/finalize response lost/)
    const final = [...f.journal().genesis!.finalizeCheckpointTxs!]
    await submitPoolWalletStage(f.wallet().value, f.journal().genesis!, save)
    expect(f.finalizeTx.mock.calls[1][1]).toEqual(final)
    expect(f.submitTx).toHaveBeenCalledTimes(2)
    expect(f.journal().genesis!.confirmed).toBe(true)
  })

  it('refuses a changed checkpoint response before wallet-stage finalization', async () => {
    const f = await fixture()
    f.lose('before-acceptance')
    await expect(bootstrapPool(f.wallet().value, options, f.persistence)).rejects.toThrow(/before acceptance/)
    const original = copy(f.journal().genesis!)
    const approved = decode(original.checkpointTxs[0]), wrong = Transaction.fromRaw(approved.toBytes())
    const { tapScriptSig, ...input } = approved.getInput(0)
    void tapScriptSig
    wrong.updateInput(0, input)
    wrong.updateOutput(0, { ...wrong.getOutput(0), amount: wrong.getOutput(0).amount! - 1n })
    f.submitTx.mockResolvedValueOnce({ arkTxid: original.arkTxid, finalArkTx: original.arkTx, signedCheckpointTxs: [encode(wrong)] })
    await expect(submitPoolWalletStage(f.wallet().value, original, next => f.persistence.save({ ...f.journal(), genesis: next }))).rejects.toThrow()
    expect(f.finalizeTx).not.toHaveBeenCalled()
    expect(f.journal().genesis!.finalizeCheckpointTxs).toBeUndefined()
  })
})
