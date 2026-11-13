import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  arkade, asset, CSVMultisigTapscript, DefaultVtxo, Extension, getNetwork,
  RestEmulatorProvider, RestOperatorProvider, resolveEmulatorPubkey, SingleKey, Transaction,
  verifyTapscriptSignatures, type NormalizedExtendedVirtualCoin, type Wallet,
} from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@scure/btc-signer/utils.js'
import { base64, hex } from '@scure/base'
import * as vault from 'arkade-coinflip/dist/pool-game-vault.js'
import { computeHouseStake, quotePoolEconomics } from 'arkade-coinflip'
import { createFundedPoolRuntime, memberCheckpoint, proveFundedPoolSpend } from './fundedPoolRuntime'
import { loadFundedPoolJournal, type FundedPoolContext, type FundedPoolIntent } from './fundedPoolJournal'
import * as journalStore from './fundedPoolJournal'
import type { FundedPoolDescriptor, FundedPoolDisplay, FundedPoolQuote } from './fundedPoolTypes'

const remote = vi.hoisted(() => ({ get: vi.fn(), submit: vi.fn(), prepare: vi.fn(), reveal: vi.fn(), network: vi.fn(), bootstrap: vi.fn() }))
vi.mock('./fundedPoolApi', () => ({ fundedPoolApi: remote }))
vi.mock('./api', () => ({ getNetwork: remote.network }))
vi.mock('arkade-coinflip/dist/pool-game-vault.js', async original => ({
  ...await original<typeof import('arkade-coinflip/dist/pool-game-vault.js')>(), verifyPoolBootstrap: remote.bootstrap,
}))
vi.mock('./fundedPoolInputRenewal', () => ({ createFundedPoolInputRenewal: () => ({
  refresh: async () => {}, dispose: async () => {}, recover: vi.fn(), prepare: vi.fn(), confirm: vi.fn(),
}) }))
const key = (n: number) => new Uint8Array(32).fill(n)
const userKey = schnorr.getPublicKey(key(1)), serverKey = schnorr.getPublicKey(key(2))
const locking = new DefaultVtxo.Script({ pubKey: userKey, serverPubKey: serverKey, csvTimelock: { type: 'seconds', value: 1536n } })
const checkpointScript = CSVMultisigTapscript.encode({ pubkeys: [serverKey], timelock: { type: 'seconds', value: 1536n } })
const poolScript = new Uint8Array([0x51, 0x20, ...key(7)])
const encode = (value: Transaction) => base64.encode(value.toPSBT())
const decode = (value: string) => Transaction.fromPSBT(base64.decode(value))
const point = (coin: { txid: string; vout: number }) => `${coin.txid}:${coin.vout}`
function fixture() {
  const member = { txid: hex.encode(key(11)), vout: 0, value: 5500, script: hex.encode(locking.pkScript),
    assets: [], tapTree: locking.encode(), forfeitTapLeafScript: locking.forfeit(), isSpent: false, isSwept: false, isUnrolled: false }
  const head = { txid: hex.encode(key(12)), vout: 0, value: 100330, script: hex.encode(poolScript), isSpent: false, isSwept: false, isUnrolled: false }
  const checkpoints = [head, member].map(coin => {
    const cp = new Transaction()
    cp.addInput({ txid: coin.txid, index: 0, witnessUtxo: { script: hex.decode(coin.script), amount: BigInt(coin.value) },
      ...(coin === member ? { tapLeafScript: [locking.forfeit()] } : {}) })
    cp.addOutput({ script: hex.decode(coin.script), amount: BigInt(coin.value) })
    return cp
  })
  const arkTx = new Transaction()
  checkpoints.forEach((cp, index) => arkTx.addInput({ txid: cp.id, index: 0,
    witnessUtxo: { script: cp.getOutput(0).script!, amount: cp.getOutput(0).amount! }, ...(index ? { tapLeafScript: [locking.forfeit()] } : {}) }))
  arkTx.addOutput({ script: poolScript, amount: 105330n }); arkTx.addOutput({ script: locking.pkScript, amount: 500n })
  const intent: FundedPoolIntent = { arkTxid: arkTx.id, expectedHead: head, memberOutpoint: member,
    unsignedArkTx: encode(arkTx), unsignedCheckpoints: checkpoints.map(encode),
    command: { kind: 'subscribe', depositSats: '5000', minShares: '5000000' }, quote: {} as FundedPoolQuote }
  const coins = [head, member].map((coin, index) => ({ ...coin, isSpent: true, spentBy: checkpoints[index].id, arkTxId: arkTx.id }))
  return { member, head, checkpoints, arkTx, intent, coins }
}
const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected unit-test network request') }))
  remote.bootstrap.mockResolvedValue(undefined)
  vi.spyOn(RestEmulatorProvider.prototype, 'submitTx').mockRejectedValue(new Error('Test emulator relay unavailable'))
})
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('funded pool transaction authorization', () => {
  it('finds the exact member checkpoint regardless of array order', () => {
    const f = fixture()
    expect(memberCheckpoint({ arkTx: f.arkTx, checkpoints: [...f.checkpoints].reverse() }, f.member, f.head).id).toBe(f.checkpoints[1].id)
    expect(() => memberCheckpoint({ arkTx: f.arkTx, checkpoints: [f.checkpoints[0], f.checkpoints[0]] }, f.member, f.head)).toThrow(/checkpoints/)
  })
  it('requires indexed consumption of both exact inputs by the locally approved transaction', async () => {
    const f = fixture()
    const wallet = { indexerProvider: { getVtxos: vi.fn(async () => ({ vtxos: f.coins })), getVirtualTxs: vi.fn(async () => ({ txs: [encode(f.arkTx)] })) } } as unknown as Wallet
    expect((await proveFundedPoolSpend(wallet, f.intent))?.id).toBe(f.arkTx.id)
    f.coins[1].arkTxId = 'ff'.repeat(32)
    expect(await proveFundedPoolSpend(wallet, f.intent)).toBeUndefined()
    f.coins[1].arkTxId = f.arkTx.id; f.coins[1].value++
    await expect(proveFundedPoolSpend(wallet, f.intent)).rejects.toThrow(/differs/)
  })
  it('keeps an absent or merely unspent input pending', async () => {
    const f = fixture()
    const getVtxos = vi.fn().mockResolvedValueOnce({ vtxos: [] }).mockResolvedValueOnce({ vtxos: [f.head, f.member] })
    const wallet = { indexerProvider: { getVtxos, getVirtualTxs: vi.fn() } } as unknown as Wallet
    expect(await proveFundedPoolSpend(wallet, f.intent)).toBeUndefined()
    expect(await proveFundedPoolSpend(wallet, f.intent)).toBeUndefined()
    expect(wallet.indexerProvider.getVirtualTxs).not.toHaveBeenCalled()
  })
})

let serial = 0
async function runtimeFixture(options: { value?: number; shares?: bigint[]; withWalletContext?: boolean } = {}) {
  const identity = SingleKey.fromHex(hex.encode(key(1))), operator = SingleKey.fromHex(hex.encode(key(2)))
  const context: FundedPoolContext = { publicKey: hex.encode(userKey), network: 'regtest', operatorUrl: `http://unit-${++serial}.test` }
  const coins = new Map<string, NormalizedExtendedVirtualCoin>(), transactions = new Map<string, Transaction>(), holds = new Set<string>()
  const descriptor: FundedPoolDescriptor = { version: 1, name: 'Funded test', network: context.network, operatorUrl: context.operatorUrl,
    controlAssetId: asset.AssetId.create(hex.encode(key(30)), 0).toString(), shareAssetId: asset.AssetId.create(hex.encode(key(30)), 1).toString(),
    operatorPubkey: hex.encode(serverKey), operatorPayoutPkScript: hex.encode(locking.pkScript), operatorFeeBps: 2000,
    minHouseEdgeBps: 50, maxStakeBps: 2000, bootstrapTxid: hex.encode(key(31)), checkpointPsbts: fixture().checkpoints.map(encode) as [string, string] }
  const indexer = {
    getVtxos: vi.fn(async (request?: { outpoints?: Array<{ txid: string; vout: number }>; scripts?: string[]; spendableOnly?: boolean }) => ({ vtxos:
      [...coins.values()].filter(coin => (!request?.outpoints || request.outpoints.some(value => point(value) === point(coin))) &&
        (!request?.scripts || request.scripts.includes(coin.script)) && (!request?.spendableOnly || !coin.isSpent)) })),
    getVirtualTxs: vi.fn(async (ids: string[]) => ({ txs: ids.flatMap(id => transactions.has(id) ? [encode(transactions.get(id)!)] : []) })),
  }
  const client = { network: getNetwork('regtest'), serverKey, emulatorKey: hex.decode(resolveEmulatorPubkey(getNetwork('regtest'))),
    serverExitDelay: 1536n, checkpoint: checkpointScript, identity, indexer, dispose: vi.fn(async () => {}) } as unknown as arkade.Arkade
  const contract = vault.createPoolGameVault(client, descriptor)
  const freshContract = vault.createPoolFreshInput(client, descriptor)
  function outputAssets(transaction: Transaction, vout: number) {
    let extension: Extension
    try { extension = Extension.fromTx(transaction) } catch { return [] }
    return extension.getAssetPacket()?.groups.flatMap((group, index) => group.outputs.filter(output => output.vout === vout)
      .map(output => ({ assetId: (group.assetId ?? asset.AssetId.create(transaction.id, index)).toString(), amount: output.amount }))) ?? []
  }
  function addOutputs(transaction: Transaction) {
    transactions.set(transaction.id, transaction)
    for (let vout = 0; vout < transaction.outputsLength; vout++) {
      const output = transaction.getOutput(vout)
      if (!output.script || output.amount === undefined || output.amount < 330n) continue
      const script = hex.encode(output.script)
      const existing = coins.get(`${transaction.id}:${vout}`)
      if (existing) { expect(existing.value).toBe(Number(output.amount)); expect(existing.script).toBe(script); continue }
      const tapTree = script === hex.encode(contract.pkScript) ? contract.tapTree : script === hex.encode(freshContract.pkScript) ? freshContract.tapTree : locking.encode()
      coins.set(`${transaction.id}:${vout}`, { txid: transaction.id, vout, value: Number(output.amount), script,
        assets: outputAssets(transaction, vout), tapTree, forfeitTapLeafScript: locking.forfeit(), intentTapLeafScript: locking.forfeit(), sourceTx: transaction.toBytes(),
        expiresAt: new Date(Date.now() + 12_000_000), isSpent: false, isSwept: false, isUnrolled: false, isPreconfirmed: true,
        createdAt: new Date(), status: { confirmed: false, isLeaf: false },
        spentBy: '', arkTxId: '', settledBy: '', commitmentTxIds: [] } as NormalizedExtendedVirtualCoin)
    }
  }
  function commit(transaction: Transaction, checkpoints: Transaction[]) {
    checkpoints.forEach(checkpoint => {
      const input = checkpoint.getInput(0), source = coins.get(`${hex.encode(input.txid!)}:${input.index}`)
      if (!source) throw new Error('Transport attempted to spend an unknown coin')
      if (source.isSpent && source.arkTxId !== transaction.id) throw new Error('Transport attempted a double spend')
      source.isSpent = true; source.spentBy = checkpoint.id; source.arkTxId = transaction.id
      transactions.set(checkpoint.id, checkpoint)
    })
    addOutputs(transaction)
  }
  function member(value: number, shares?: bigint) {
    const tx = new Transaction()
    tx.addInput({ txid: hex.encode(key(60 + coins.size)), index: 0 })
    tx.addOutput({ script: locking.pkScript, amount: BigInt(value) })
    if (shares) tx.addOutput(Extension.create([asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(descriptor.shareAssetId), null,
      [asset.AssetInput.create(0, shares)], [asset.AssetOutput.create(0, shares)], [])])]).txOut())
    addOutputs(tx)
    return coins.get(`${tx.id}:0`)!
  }
  const genesis = new Transaction()
  genesis.addInput({ txid: hex.encode(key(59)), index: 0 }); genesis.addOutput({ script: contract.pkScript, amount: 100330n })
  genesis.addOutput(Extension.create([asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(descriptor.controlAssetId), null,
    [asset.AssetInput.create(0, 1n)], [asset.AssetOutput.create(0, 1n)], [])]),
    ...vault.poolStatePackets({ supply: 100_000_000_000n, carriedLossSats: 0n, accruedFeesSats: 0n, phase: 'idle' })]).txOut())
  addOutputs(genesis)
  const head = coins.get(`${genesis.id}:0`)!
  const members = options.shares ? options.shares.map(amount => member(330, amount)) : [member(options.value ?? 5500)]
  const walletCoins = () => [...coins.values()].filter(coin => !coin.isSpent && coin.script === hex.encode(locking.pkScript))
  const reserve = vi.fn((points: Array<{ txid: string; vout: number }>) => {
    for (const value of points) { if (holds.has(point(value))) throw new Error('Input is already reserved'); holds.add(point(value)) }
    return { outpoints: points, release: vi.fn(() => { for (const value of points) holds.delete(point(value)) }) }
  })
  const sign = vi.spyOn(identity, 'sign'), realMessage = identity.signMessage.bind(identity)
  const signMessage = vi.spyOn(identity, 'signMessage').mockImplementation(async (...args) => {
    const saved = await loadFundedPoolJournal(context)
    expect(saved.length).toBeGreaterThan(0)
    expect(saved.every(entry => entry.intent || entry.receipt)).toBe(true)
    return realMessage(...args)
  })
  const manager = { getWatchedScripts: vi.fn(async () => []), watchScript: vi.fn(async () => {}), unwatchScript: vi.fn(async () => {}),
    onContractEvent: vi.fn(() => vi.fn()), getSyncState: () => ({ mode: 'online', lastSyncedAt: Date.now() }) }
  const wallet = { network: getNetwork('regtest'), identity, reserveVtxos: reserve,
    getArkadeInfo: vi.fn(async () => ({ network: 'regtest' })), getContractManager: vi.fn(async () => manager),
    getVtxos: vi.fn(async () => walletCoins()), getSpendableVtxos: vi.fn(async () => walletCoins().filter(coin => !holds.has(point(coin)))),
    getAddress: vi.fn(async () => locking.address(getNetwork('regtest').hrp, serverKey).encode()), indexerProvider: indexer } as unknown as Wallet
  remote.get.mockResolvedValue({ status: 'ready', descriptor, fairnessAssumption: 'honest-operator',
    head: vault.poolGameSnapshot((await vault.readPoolGamePosition(contract, descriptor, indexer))!),
    pricing: { configuredHouseStakeDiscountBps: 300, minHouseEdgeBps: descriptor.minHouseEdgeBps },
    capabilities: { subscribe: true, redeem: true, play: true }, history: [] })
  remote.network.mockResolvedValue({ network: context.network, operatorUrl: context.operatorUrl,
    emulator: { signerPubkey: resolveEmulatorPubkey(getNetwork('regtest')), url: 'http://unit-emulator.test', version: '0.0.9' } })
  remote.prepare.mockImplementation(async request => {
    const houseStake = computeHouseStake(Number(request.playerStakeSats), request.oddsN, request.oddsTarget, request.oddsLo, 300)
    return { ...request, gameId: crypto.randomUUID(), houseHash: hex.encode(sha256(new Uint8Array([0, ...key(3).slice(0, 16)]))),
      houseStakeSats: String(houseStake), cancelAt: Math.floor(Date.now() / 1000) + 900, finalAt: Math.floor(Date.now() / 1000) + 1800,
      expiresAt: Date.now() + 60_000, economics: quotePoolEconomics({ playerStake: Number(request.playerStakeSats), houseStake,
        oddsN: request.oddsN, oddsLo: request.oddsLo, oddsTarget: request.oddsTarget, configuredHouseStakeDiscountBps: 300 }) }
  })
  const nativeSubmit = vi.spyOn(RestOperatorProvider.prototype, 'submitTx').mockImplementation(async (ark, checkpoints) => {
    const journal = await loadFundedPoolJournal(context)
    expect(journal.filter(entry => entry.status === 'pending').every(entry => !entry.intent!.freshStage!.ownerAuthorizationPending)).toBe(true)
    const nativeId = decode(ark).id
    const role = journal.some(entry => entry.intent?.freshStage?.transfer.arkTxid === nativeId) ? 'staging' : 'cash release'
    const plan = journal.flatMap(entry => [entry.intent?.freshStage?.transfer, entry.intent?.cashRelease]).find(plan => plan?.arkTxid === nativeId)!
    if (!plan || plan.signedArkTx !== ark) throw new Error(`Native ${role} POST differs from durable signed body: sent ${nativeId}, saved ${plan?.signedArkTx ? decode(plan.signedArkTx).id : 'none'}`)
    expect(plan.signedCheckpoints).toHaveLength(1)
    const actual = await operator.sign(decode(ark), [0]), checkpoint = await operator.sign(decode(checkpoints[0]), [0])
    verifyTapscriptSignatures(actual, 0, [hex.encode(userKey), hex.encode(serverKey)])
    verifyTapscriptSignatures(checkpoint, 0, [hex.encode(userKey), hex.encode(serverKey)])
    commit(actual, [checkpoint])
    return { arkTxid: actual.id, finalArkTx: encode(actual), signedCheckpointTxs: [encode(checkpoint)] }
  })
  vi.spyOn(RestOperatorProvider.prototype, 'finalizeTx').mockImplementation(async () => { throw new Error('A fully signed native transfer needs no fallback') })
  const submitted: Array<{ operationId: string; arkTx: string; checkpointTxs: string[]; arkTxid: string }> = []
  const commitMain = (request: typeof submitted[number]) => {
    const transaction = decode(request.arkTx), checkpoints = request.checkpointTxs.map(decode)
    expect(vault.verifyPoolFreshSpend({ arkTx: transaction, checkpoints }).owner).toEqual(userKey)
    expect(transaction.id).toBe(request.arkTxid)
    submitted.push(request); commit(transaction, checkpoints)
    return { status: 'confirmed', arkTxid: transaction.id }
  }
  remote.submit.mockImplementation(commitMain)
  vi.spyOn(arkade.Arkade, 'connect').mockResolvedValue(client)
  const displays: FundedPoolDisplay[] = []
  let current = true
  const runtimeContext = options.withWalletContext ? { ...context, wallet } : context
  const start = () => {
    const runtime = createFundedPoolRuntime({ wallet, context: runtimeContext, isCurrent: () => current, onState: value => displays.push(value) })
    cleanups.push(runtime.dispose)
    return runtime
  }
  const runtime = start()
  await runtime.refresh()
  expect(displays.at(-1)?.status).toBe('ready')
  return { wallet, context, runtimeContext, descriptor, contract, client, runtime, displays, sign, signMessage, nativeSubmit, indexer, head, members,
    coins, transactions, holds, submitted, commit, commitMain, start, member, invalidate: () => { current = false } }
}

describe('funded pool display freshness', () => {
  it('rereads holdings when a wallet event lands during an in-flight read', async () => {
    const f = await runtimeFixture()
    const owned = () => [...f.coins.values()].filter(coin => !coin.isSpent && coin.script === hex.encode(locking.pkScript))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const reads = vi.mocked(f.wallet.getVtxos).mock.calls.length
    vi.mocked(f.wallet.getVtxos).mockImplementationOnce(async () => { const stale = owned(); await gate; return stale })
    const first = f.runtime.refresh()
    await vi.waitFor(() => expect(f.wallet.getVtxos).toHaveBeenCalledTimes(reads + 1))
    f.member(330, 7n)
    const second = f.runtime.refresh()
    release()
    await Promise.all([first, second])
    expect(f.displays.at(-1)).toMatchObject({ status: 'ready', memberShares: '7', availableShares: '7' })
  })

  it('rechecks an idle pool head at its admission boundary without signing', async () => {
    const f = await runtimeFixture()
    f.head.expiresAt = new Date(Date.now() + (vault.poolInputPolicy(f.client).minTTL + 60) * 1000 + 1000)
    await f.runtime.refresh()
    expect(f.displays.at(-1)!.capabilities.subscribe).toBe(true)
    await vi.waitFor(() => expect(f.displays.at(-1)).toMatchObject({ status: 'ready', capabilities: { subscribe: false, bet: false },
      error: expect.stringContaining('renewal is required') }), { timeout: 4000 })
    expect(f.sign).not.toHaveBeenCalled()
  })
})

describe('durable staged pool submission', () => {
  it('persists only a public context snapshot when the composable passes its live wallet', async () => {
    const f = await runtimeFixture({ withWalletContext: true })
    expect(() => structuredClone(f.runtimeContext)).toThrow()
    const quote = await f.runtime.prepareSubscribe(5000n)
    f.runtimeContext.network = 'changed-after-preview'
    await f.runtime.confirm(quote)
    const record = (await loadFundedPoolJournal(f.context))[0]
    expect(record.status).toBe('confirmed')
    expect(record.context).toEqual(f.context)
    expect(Object.keys(record.context).sort()).toEqual(['network', 'operatorUrl', 'publicKey'])
    expect(f.submitted).toHaveLength(1)
  })
  it('journals owner consent and native staging before relay, then proves the exact capital spend independently', async () => {
    const f = await runtimeFixture()
    const quote = await f.runtime.prepareSubscribe(5000n)
    expect(Object.isFrozen(quote)).toBe(true); expect(Object.isFrozen(quote.head)).toBe(true)
    expect(quote.transactionCount).toBe(2)
    await f.runtime.confirm(quote)
    const record = (await loadFundedPoolJournal(f.context))[0]
    expect(record.status).toBe('confirmed'); expect(record.intent).toBeUndefined()
    expect(record.receipt?.memberDeltaSats).toBe('-5000')
    expect(f.signMessage).toHaveBeenCalledOnce()
    expect(f.sign.mock.calls.map(call => call[1])).toEqual([[0], [0]])
    expect(f.nativeSubmit).toHaveBeenCalledOnce(); expect(f.holds.size).toBe(0)
    const position = await vault.readPoolGamePosition(f.contract, f.descriptor, f.wallet.indexerProvider)
    expect(position?.state).toMatchObject({ navSats: 105000n, supply: 105_000_000_000n })
    expect((await f.wallet.getVtxos())[0].assets).toEqual([{ assetId: f.descriptor.shareAssetId, amount: 5_000_000_000n }])
  })
  it('returns excess contribution cash as plain spendable change without losing shares', async () => {
    const f = await runtimeFixture({ value: 20000 })
    const quote = await f.runtime.prepareSubscribe(5000n)
    expect(quote.transactionCount).toBe(3); expect(quote.cashReleasedSats).toBe('14670')
    await f.runtime.confirm(quote)
    const owned = await f.wallet.getSpendableVtxos()
    expect(owned.find(coin => coin.assets?.length)?.value).toBe(330)
    expect(owned.find(coin => !coin.assets?.length)?.value).toBe(14670)
    expect(owned.find(coin => coin.assets?.length)?.assets?.[0].amount).toBe(5_000_000_000n)
    expect(f.nativeSubmit).toHaveBeenCalledTimes(2); expect(f.holds.size).toBe(0)
  })
  it('retains the exact authorized intent and staged input hold when submission times out, including after disposal', async () => {
    const f = await runtimeFixture()
    remote.submit.mockRejectedValue(new Error('HTTP timeout'))
    await expect(f.runtime.confirm(await f.runtime.prepareSubscribe(5000n))).rejects.toThrow('HTTP timeout')
    await f.runtime.dispose()
    const record = (await loadFundedPoolJournal(f.context))[0]
    expect(record.status).toBe('pending'); expect(record.error).toBe('HTTP timeout')
    expect(record.intent?.signedArkTx).toBeTruthy(); expect(record.intent?.freshStage?.transfer.signedArkTx).toBeTruthy()
    expect(f.holds.has(point(record.intent!.memberOutpoint))).toBe(true)
    expect(f.submitted).toHaveLength(0)
  })
  it('refuses token-bearing contribution coins before requesting authorization or submitting', async () => {
    const f = await runtimeFixture()
    f.members[0].assets = [{ assetId: f.descriptor.shareAssetId, amount: 1n }]
    await expect(f.runtime.prepareSubscribe(5000n)).rejects.toThrow(/plain bitcoin output/)
    expect(f.sign).not.toHaveBeenCalled(); expect(f.signMessage).not.toHaveBeenCalled(); expect(remote.submit).not.toHaveBeenCalled()
    expect(await loadFundedPoolJournal(f.context)).toEqual([])
  })
  it('does not sign on refresh after declined owner consent and explicitly recovers the saved plan', async () => {
    const f = await runtimeFixture()
    f.signMessage.mockRejectedValueOnce(new Error('Signature declined'))
    await expect(f.runtime.confirm(await f.runtime.prepareSubscribe(5000n))).rejects.toThrow('Signature declined')
    await f.runtime.refresh()
    expect(f.signMessage).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(remote.submit).not.toHaveBeenCalled()
    await f.runtime.recover()
    expect((await loadFundedPoolJournal(f.context))[0].status).toBe('confirmed')
    expect(f.signMessage).toHaveBeenCalledTimes(2); expect(f.nativeSubmit).toHaveBeenCalledOnce(); expect(f.holds.size).toBe(0)
  })
  it('stops after the owner signature await when wallet context changes without escaping native funds', async () => {
    const f = await runtimeFixture()
    const actual = f.signMessage.getMockImplementation()!
    f.signMessage.mockImplementationOnce(async (...args) => { const result = await actual(...args); f.invalidate(); return result })
    await expect(f.runtime.confirm(await f.runtime.prepareSubscribe(5000n))).rejects.toThrow(/Wallet context changed/)
    await f.runtime.dispose()
    expect(f.signMessage).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.nativeSubmit).not.toHaveBeenCalled()
    const record = (await loadFundedPoolJournal(f.context))[0]
    expect(record.status).toBe('pending'); expect(record.intent?.signedArkTx).toBeUndefined()
    expect(f.holds.size).toBe(2)
  })
  it('recovers a failed final authorization write without retaining an unreachable future cash hold', async () => {
    const f = await runtimeFixture({ value: 20000 })
    const actualUpdate = journalStore.updateFundedPoolJournal
    let rejected = false
    vi.spyOn(journalStore, 'updateFundedPoolJournal').mockImplementation((context, id, change) => actualUpdate(context, id, entry => {
      const next = change(entry)
      if (!rejected && entry.intent?.freshStage?.ownerAuthorizationPending && next.intent?.freshStage?.ownerAuthorizationPending === false) {
        rejected = true
        throw new Error('IndexedDB final authorization write failed')
      }
      return next
    }))
    await expect(f.runtime.confirm(await f.runtime.prepareSubscribe(5000n))).rejects.toThrow('IndexedDB final authorization write failed')
    expect(rejected).toBe(true)
    expect(f.signMessage).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled(); expect(f.nativeSubmit).not.toHaveBeenCalled()
    expect((await loadFundedPoolJournal(f.context))[0].intent?.freshStage?.ownerAuthorizationPending).toBe(true)
    expect(f.holds.size).toBe(2)
    await f.runtime.recover()
    expect((await loadFundedPoolJournal(f.context))[0].status).toBe('confirmed')
    expect(f.signMessage).toHaveBeenCalledTimes(2); expect(f.holds.size).toBe(0)
    const owned = await f.wallet.getSpendableVtxos()
    expect(owned.find(coin => coin.assets?.length)?.value).toBe(330)
    expect(owned.find(coin => !coin.assets?.length)?.value).toBe(14670)
  })
  it('makes concurrent recovery adopt one atomic owner authorization before any main relay', async () => {
    const f = await runtimeFixture({ value: 20000 })
    f.signMessage.mockRejectedValueOnce(new Error('Signature declined'))
    await expect(f.runtime.confirm(await f.runtime.prepareSubscribe(5000n))).rejects.toThrow('Signature declined')
    await f.runtime.dispose()
    const left = f.start(), right = f.start()
    await left.refresh(); await right.refresh()
    let signatures = 0, resume: () => void = () => {}
    const both = new Promise<void>(resolve => { resume = resolve })
    f.signMessage.mockImplementation(async (message, type) => {
      expect(type).toBe('schnorr')
      const sample = ++signatures
      if (sample === 2) resume()
      await both
      return schnorr.sign(message, key(1), key(70 + sample))
    })
    const actualAuthorize = vault.authorizePoolFreshSpend, proposals = new Set<string>()
    vi.spyOn(vault, 'authorizePoolFreshSpend').mockImplementation(async (...args) => {
      const result = await actualAuthorize(...args)
      proposals.add(result.arkTx.id)
      return result
    })
    let winnerBody = ''
    const relayed: string[] = []
    remote.submit.mockImplementation(async request => {
      const saved = (await loadFundedPoolJournal(f.context))[0]
      winnerBody = saved.intent?.signedArkTx ?? winnerBody
      expect(winnerBody).toBeTruthy()
      if (request.arkTx !== winnerBody) throw new Error(`Main relay ${request.arkTxid} differs from durable owner authorization ${decode(winnerBody).id}`)
      expect(request.arkTxid).toBe(saved.intent?.arkTxid ?? saved.receipt?.arkTxid)
      relayed.push(request.arkTx)
      return f.commitMain(request)
    })
    const results = await Promise.allSettled([left.recover(), right.recover()])
    expect(results.some(result => result.status === 'fulfilled')).toBe(true)
    for (const result of results) if (result.status === 'rejected') expect(String(result.reason)).toMatch(/already finished/)
    expect(signatures).toBe(2); expect(proposals.size).toBe(2)
    expect(relayed.length).toBeGreaterThan(0); expect(new Set(relayed).size).toBe(1)
    const completed = (await loadFundedPoolJournal(f.context))[0]
    expect(completed.status).toBe('confirmed'); expect(completed.intent).toBeUndefined()
    expect(completed.receipt?.arkTxid).toBe(decode(winnerBody).id)
    expect(f.holds.size).toBe(0)
    const owned = await f.wallet.getSpendableVtxos()
    expect(owned.find(coin => coin.assets?.length)?.assets?.[0].amount).toBe(5_000_000_000n)
    expect(owned.find(coin => !coin.assets?.length)?.value).toBe(14670)
    expect((await vault.readPoolGamePosition(f.contract, f.descriptor, f.wallet.indexerProvider))?.state.navSats).toBe(105000n)
  }, 15_000)
  it('restores a verified pool connection and redeems directly during coordinator outage', async () => {
    const f = await runtimeFixture({ shares: [5_000_000_000n] })
    await f.runtime.dispose()
    remote.get.mockRejectedValue(new Error('Coordinator unavailable')); remote.network.mockRejectedValue(new Error('Web API unavailable'))
    const relay = vi.mocked(RestEmulatorProvider.prototype.submitTx).mockImplementation(async (arkTx, checkpointTxs) => {
      f.commitMain({ operationId: 'direct', arkTx, checkpointTxs, arkTxid: decode(arkTx).id })
      return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs }
    })
    const restored = f.start()
    await restored.refresh()
    expect(f.displays.at(-1)?.capabilities).toMatchObject({ subscribe: false, redeem: true, bet: false })
    await restored.confirm(await restored.prepareRedeem(5_000_000_000n))
    expect(relay).toHaveBeenCalledOnce(); expect(remote.submit).not.toHaveBeenCalled()
    expect((await loadFundedPoolJournal(f.context))[0].receipt?.payoutSats).toBe('5000')
    expect((await f.wallet.getVtxos())[0]).toMatchObject({ value: 5330, assets: [] })
  })
  it('rejects a forged coordinator confirmation whose indexed input value differs from the authorized plan', async () => {
    const f = await runtimeFixture()
    remote.submit.mockImplementation(request => {
      const result = f.commitMain(request), savedHead = f.coins.get(point(f.head))!
      savedHead.value++
      return result
    })
    await expect(f.runtime.confirm(await f.runtime.prepareSubscribe(5000n))).rejects.toThrow(/differs/)
    const record = (await loadFundedPoolJournal(f.context))[0]
    expect(record.status).toBe('pending'); expect(record.intent?.signedArkTx).toBeTruthy(); expect(record.receipt).toBeUndefined()
    expect(f.holds.size).toBe(2)
  })
  it('keeps a staged conflict pending until explicit owner refund returns the complete input', async () => {
    const f = await runtimeFixture()
    remote.submit.mockRejectedValue(new Error('HTTP 409'))
    await expect(f.runtime.confirm(await f.runtime.prepareSubscribe(5000n))).rejects.toThrow('HTTP 409')
    const saved = (await loadFundedPoolJournal(f.context))[0], checkpoint = decode(saved.intent!.unsignedCheckpoints[0])
    const competitor = new Transaction()
    competitor.addInput({ txid: checkpoint.id, index: 0,
      witnessUtxo: { script: checkpoint.getOutput(0).script!, amount: checkpoint.getOutput(0).amount! } })
    competitor.addOutput({ script: f.contract.pkScript, amount: 100330n })
    competitor.addOutput(Extension.create([asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(f.descriptor.controlAssetId), null,
      [asset.AssetInput.create(0, 1n)], [asset.AssetOutput.create(0, 1n)], [])]),
      ...vault.poolStatePackets({ supply: 100_000_000_000n, carriedLossSats: 0n, accruedFeesSats: 0n, phase: 'idle' })]).txOut())
    f.commit(competitor, [checkpoint])
    await f.runtime.refresh()
    expect((await loadFundedPoolJournal(f.context))[0].status).toBe('pending')
    const before = f.signMessage.mock.calls.length
    vi.mocked(RestEmulatorProvider.prototype.submitTx).mockImplementation(async (arkTx, checkpointTxs) => {
      const built = { arkTx: decode(arkTx), checkpoints: checkpointTxs.map(decode) }
      expect(vault.verifyPoolFreshSpend(built, 'refund').owner).toEqual(userKey)
      f.commit(built.arkTx, built.checkpoints)
      return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs }
    })
    await f.runtime.recover()
    expect((await loadFundedPoolJournal(f.context))[0].status).toBe('abandoned')
    expect(f.signMessage).toHaveBeenCalledTimes(before + 1); expect(f.holds.size).toBe(0)
    expect((await f.wallet.getVtxos())[0]).toMatchObject({ value: 5500, assets: [] })
  })
  it('retains and proves an earlier accepted refund after indexing lag crosses a later authorization', async () => {
    const f = await runtimeFixture()
    remote.submit.mockRejectedValue(new Error('HTTP 409'))
    await expect(f.runtime.confirm(await f.runtime.prepareSubscribe(5000n))).rejects.toThrow('HTTP 409')
    const saved = (await loadFundedPoolJournal(f.context))[0], checkpoint = decode(saved.intent!.unsignedCheckpoints[0])
    const competitor = new Transaction()
    competitor.addInput({ txid: checkpoint.id, index: 0,
      witnessUtxo: { script: checkpoint.getOutput(0).script!, amount: checkpoint.getOutput(0).amount! } })
    competitor.addOutput({ script: f.contract.pkScript, amount: 100330n })
    competitor.addOutput(Extension.create([asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(f.descriptor.controlAssetId), null,
      [asset.AssetInput.create(0, 1n)], [asset.AssetOutput.create(0, 1n)], [])]),
      ...vault.poolStatePackets({ supply: 100_000_000_000n, carriedLossSats: 0n, accruedFeesSats: 0n, phase: 'idle' })]).txOut())
    f.commit(competitor, [checkpoint])
    const stagePoint = point(saved.intent!.memberOutpoint), actualIndex = f.indexer.getVtxos.getMockImplementation()!
    let lagging = true, attempts = 0, firstRefund = ''
    f.indexer.getVtxos.mockImplementation(async request => {
      const result = await actualIndex(request)
      return { vtxos: result.vtxos.map(coin => lagging && point(coin) === stagePoint ? { ...coin, isSpent: false, spentBy: '', arkTxId: '' } : coin) }
    })
    vi.mocked(RestEmulatorProvider.prototype.submitTx).mockImplementation(async (arkTx, checkpointTxs) => {
      const built = { arkTx: decode(arkTx), checkpoints: checkpointTxs.map(decode) }
      expect(vault.verifyPoolFreshSpend(built, 'refund').owner).toEqual(userKey)
      if (++attempts > 1) { lagging = false; throw new Error('The staged refund input is already spent') }
      firstRefund = built.arkTx.id
      f.commit(built.arkTx, built.checkpoints)
      return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs }
    })
    await expect(f.runtime.recover()).rejects.toThrow(/waiting for indexed confirmation/)
    const prior = (await loadFundedPoolJournal(f.context))[0].intent!.freshStage!.refund!
    expect(prior.arkTxid).toBe(firstRefund)
    vi.spyOn(Date, 'now').mockReturnValue((prior.authorization.validUntil + 1) * 1000)
    await expect(f.runtime.recover()).rejects.toThrow('The staged refund input is already spent')
    const retried = (await loadFundedPoolJournal(f.context))[0].intent!.freshStage!
    expect(retried.refund!.arkTxid).not.toBe(firstRefund)
    expect(retried.refundHistory?.map(refund => refund.arkTxid)).toContain(firstRefund)
    const signatures = f.signMessage.mock.calls.length
    await f.runtime.recover()
    expect((await loadFundedPoolJournal(f.context))[0].status).toBe('abandoned')
    expect(f.signMessage).toHaveBeenCalledTimes(signatures); expect(attempts).toBe(2); expect(f.holds.size).toBe(0)
    expect((await f.wallet.getVtxos())[0]).toMatchObject({ value: 5500, assets: [] })
  }, 15_000)
  it('journals all staged redemptions before authorization and preserves a confirmed prefix across a later timeout', async () => {
    const f = await runtimeFixture({ shares: [3_000_000_000n, 4_000_000_000n] })
    const accepted = f.commitMain
    remote.submit.mockImplementationOnce(accepted).mockRejectedValueOnce(new Error('Second redemption timeout'))
    vi.mocked(RestEmulatorProvider.prototype.submitTx).mockRejectedValue(new Error('Second redemption timeout'))
    const quote = await f.runtime.prepareRedeem(7_000_000_000n)
    expect(quote.transactionCount).toBe(4); expect(quote.payoutSats).toBe('7000')
    await expect(f.runtime.confirm(quote)).rejects.toThrow('Second redemption timeout')
    const journal = await loadFundedPoolJournal(f.context)
    expect(journal.map(entry => entry.status)).toEqual(['confirmed', 'pending'])
    expect(journal[0].receipt?.payoutSats).toBe('4000'); expect(journal[1].intent?.signedArkTx).toBeTruthy()
    expect(f.signMessage).toHaveBeenCalledTimes(2)
    const exact = journal[1].intent!.signedArkTx
    remote.submit.mockImplementation(request => { expect(request.arkTx).toBe(exact); return accepted(request) })
    await f.runtime.recover()
    const completed = await loadFundedPoolJournal(f.context)
    expect(completed.map(entry => entry.status)).toEqual(['confirmed', 'confirmed'])
    expect(completed.reduce((sum, entry) => sum + BigInt(entry.receipt!.payoutSats), 0n)).toBe(7000n)
    expect(f.signMessage).toHaveBeenCalledTimes(2); expect(f.holds.size).toBe(0)
    expect((await f.wallet.getVtxos()).every(coin => !coin.assets?.length)).toBe(true)
    expect((await vault.readPoolGamePosition(f.contract, f.descriptor, f.wallet.indexerProvider))?.state.navSats).toBe(93000n)
  })
})

describe('private pool reveal randomness', () => {
  it.each([0, 1])('does not derive the secret digit from repeated public choice %i', async choice => {
    const f = await runtimeFixture()
    const samples = [0, 1]
    const actualRandom = crypto.getRandomValues.bind(crypto)
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(value => {
      if (!(value instanceof Uint8Array) || value.length !== 17) return actualRandom(value)
      value.fill(7); value[0] = samples.shift()!
      return value
    })
    const bet = { playerStakeSats: 1000n, oddsN: 2, oddsLo: 0, oddsTarget: 1, choice }
    await f.runtime.prepareBet(bet); await f.runtime.prepareBet(bet)
    const expected = [0, 1].map(digit => hex.encode(sha256(new Uint8Array([digit, ...new Uint8Array(16).fill(7)]))))
    const commitments = remote.prepare.mock.calls.map(([request]) => request.playerHash)
    expect(new Set(commitments)).toEqual(new Set(expected))
    expect(new Set(commitments).size).toBe(2)
    expect(f.signMessage).not.toHaveBeenCalled(); expect(remote.submit).not.toHaveBeenCalled()
  })
  it('rejects the biased tail of a crypto sample before committing a valid digit', async () => {
    const f = await runtimeFixture()
    let calls = 0
    const actualRandom = crypto.getRandomValues.bind(crypto)
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(value => {
      if (!(value instanceof Uint8Array) || ![1, 17].includes(value.length)) return actualRandom(value)
      value.fill(9); value[0] = calls++ === 0 ? 255 : 2
      return value
    })
    await f.runtime.prepareBet({ playerStakeSats: 1000n, oddsN: 3, oddsLo: 0, oddsTarget: 1, choice: 0 })
    expect(calls).toBe(2)
    expect(remote.prepare.mock.calls[0][0].playerHash).toBe(hex.encode(sha256(new Uint8Array([2, ...new Uint8Array(16).fill(9)]))))
  })
})
