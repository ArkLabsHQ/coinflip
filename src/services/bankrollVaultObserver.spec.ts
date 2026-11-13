import { beforeEach, describe, expect, it, vi } from 'vitest'
import { arkade, asset, CSVMultisigTapscript, networks, P2A, Transaction, type ContractEvent, type Wallet } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import {
  createBankrollVaultObserver, parseBankrollDescriptor,
  type BankrollPoolDescriptor, type BankrollPoolDisplay,
} from './bankrollVaultObserver'

const chain = vi.hoisted(() => ({ bootstrap: vi.fn(), position: vi.fn() }))
vi.mock('arkade-coinflip/dist/bankroll-vault.js', async () => {
  const sdk = await import('@arkade-os/sdk')
  const artifact = await import('../../packages/lib/src/artifact/bankroll_vault.json')
  return { bankrollVaultProgram: sdk.arkade.programFromArtifact(artifact.default),
    verifyBankrollBootstrap: chain.bootstrap, readBankrollVaultPosition: chain.position }
})

function checkpoint(marker: number): string {
  const tx = new Transaction({ version: 3 })
  tx.addInput({ txid: new Uint8Array(32).fill(marker), index: 0 })
  tx.addOutput({ script: P2A.script, amount: 330n })
  return base64.encode(tx.toPSBT())
}

function descriptor(): BankrollPoolDescriptor {
  return { version: 1, name: 'Shared bankroll', network: 'regtest', operatorUrl: 'http://localhost:37770',
    controlAssetId: asset.AssetId.create('11'.repeat(32), 0).toString(),
    shareAssetId: asset.AssetId.create('11'.repeat(32), 1).toString(),
    bootstrapTxid: '22'.repeat(32), checkpointPsbts: [checkpoint(1), checkpoint(2)] }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const desc = descriptor()
  const key = hex.decode('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
  const callbacks = new Set<(event: ContractEvent) => void>()
  let watchedScript = ''
  const manager = {
    getSyncState: vi.fn(() => ({ mode: 'online', lastSyncedAt: Date.now() })),
    watchScript: vi.fn(async (script: string) => { watchedScript = script }),
    unwatchScript: vi.fn(async () => {}),
    getWatchedScripts: vi.fn(async (): Promise<Array<{ script: string }>> => []),
    onContractEvent: vi.fn((callback: (event: ContractEvent) => void) => {
      callbacks.add(callback)
      return () => { callbacks.delete(callback) }
    }),
    createContract: vi.fn(), dispose: vi.fn(),
  }
  const owned = (amount: bigint, marker = '33') => ({ txid: marker.repeat(32), vout: 0, value: 1000,
    script: '', createdAt: new Date(), isSpent: false, isSwept: false, isUnrolled: false,
    assets: [{ assetId: desc.shareAssetId, amount }] })
  const wallet = {
    network: networks.regtest, indexerProvider: {},
    getArkadeInfo: vi.fn(async () => ({ network: 'regtest', signerPubkey: hex.encode(key), unilateralExitDelay: 512n,
      checkpointTapscript: hex.encode(CSVMultisigTapscript.encode({ pubkeys: [key], timelock: { type: 'seconds', value: 512n } }).script) })),
    getContractManager: vi.fn(async () => manager),
    getVtxos: vi.fn(async () => [owned(100n)]),
    getSpendableVtxos: vi.fn(async () => [owned(60n)]),
    getBalance: vi.fn(async () => ({ available: 50_000, total: 50_000 })),
  }
  Object.defineProperty(wallet, 'identity', { get() { throw new Error('Observer accessed signing identity') } })
  const states: BankrollPoolDisplay[] = []
  let current = true
  const options = { wallet: wallet as unknown as Wallet, descriptor: desc, network: 'regtest', operatorUrl: desc.operatorUrl,
    isCurrent: () => current, onState: (state: BankrollPoolDisplay) => states.push(state) }
  return { options, wallet, manager, states, owned, callbacks, setCurrent: (value: boolean) => { current = value },
    emit: (event: ContractEvent) => callbacks.forEach(callback => callback(event)), getScript: () => watchedScript }
}

beforeEach(() => {
  vi.restoreAllMocks()
  chain.bootstrap.mockReset().mockResolvedValue({ navSats: 100_000n, supply: 1000n })
  chain.position.mockReset().mockResolvedValue({ navSats: 100_000n, supply: 1000n })
})

describe('public bankroll descriptor boundary', () => {
  it('normalizes the endpoint and checks context before any provider access', async () => {
    const f = fixture()
    expect(parseBankrollDescriptor(JSON.stringify({ ...f.options.descriptor, operatorUrl: `${f.options.operatorUrl}/` })).operatorUrl).toBe(f.options.operatorUrl)
    await expect(createBankrollVaultObserver({ ...f.options, network: 'bitcoin' })).rejects.toThrow(/does not match/)
    expect(f.wallet.getArkadeInfo).not.toHaveBeenCalled()
    expect(chain.bootstrap).not.toHaveBeenCalled()
  })

  it.each([
    { version: 2 }, { name: '' }, { network: 'regtest\n' }, { controlAssetId: 'invalid' },
    { operatorUrl: 'https://user:secret@example.com' }, { extra: true },
    { checkpointPsbts: ['invalid', 'invalid'] }, { bootstrapTxid: '0'.repeat(64) },
  ])('rejects malformed descriptors: %j', patch => {
    expect(() => parseBankrollDescriptor(JSON.stringify({ ...descriptor(), ...patch }))).toThrow()
  })

  it('rejects oversized documents and duplicate checkpoint proofs', () => {
    expect(() => parseBankrollDescriptor(' '.repeat(131_073))).toThrow(/size/)
    const desc = descriptor()
    desc.checkpointPsbts[1] = desc.checkpointPsbts[0]
    expect(() => parseBankrollDescriptor(JSON.stringify(desc))).toThrow(/distinct/)
  })
})

describe('read-only vault observer', () => {
  it('watches without claiming the pool balance or obtaining signing capabilities', async () => {
    const f = fixture()
    const connect = vi.spyOn(arkade.Arkade, 'connect')
    const observer = await createBankrollVaultObserver(f.options)
    expect(connect.mock.calls[0][0]).not.toHaveProperty('identity')
    expect(connect.mock.calls[0][0]).not.toHaveProperty('emulator')
    expect(Object.keys(connect.mock.calls[0][0].arkade!)).toEqual(['getInfo'])
    expect(f.manager.createContract).not.toHaveBeenCalled()
    expect(f.wallet.getBalance).not.toHaveBeenCalled()
    expect(f.manager.watchScript).toHaveBeenCalledOnce()
    expect(f.wallet.getSpendableVtxos).toHaveBeenCalledWith(expect.objectContaining({ requireSynced: true }))
    expect(f.states.at(-1)).toMatchObject({ status: 'ready', navSats: '100000', supply: '1000',
      memberShares: '100', availableShares: '60', estimatedClaimSats: '10000', canDeposit: false, canRedeem: false })
    await observer.dispose()
    expect(f.manager.unwatchScript).toHaveBeenCalledWith(f.getScript())
    expect(f.callbacks.size).toBe(0)
    expect(f.manager.dispose).not.toHaveBeenCalled()
  })

  it('does not install a watch when bootstrap verification fails', async () => {
    const f = fixture()
    chain.bootstrap.mockRejectedValueOnce(new Error('Genesis control mismatch'))
    await expect(createBankrollVaultObserver(f.options)).rejects.toThrow('Genesis control mismatch')
    expect(f.manager.watchScript).not.toHaveBeenCalled()
    expect(f.wallet.getVtxos).not.toHaveBeenCalled()
    expect(f.manager.dispose).not.toHaveBeenCalled()
  })

  it('does not remove a watch installed by another consumer', async () => {
    const first = fixture()
    const firstObserver = await createBankrollVaultObserver(first.options)
    const script = first.getScript()
    await firstObserver.dispose()
    const second = fixture()
    second.manager.getWatchedScripts.mockResolvedValue([{ script }])
    const observer = await createBankrollVaultObserver(second.options)
    await observer.dispose()
    expect(second.manager.watchScript).not.toHaveBeenCalled()
    expect(second.manager.unwatchScript).not.toHaveBeenCalled()
    expect(second.callbacks.size).toBe(0)
  })

  it('cleans an owned watch that finishes after its context has changed', async () => {
    const f = fixture()
    const pending = deferred<void>()
    f.manager.watchScript.mockImplementationOnce(() => pending.promise)
    const starting = createBankrollVaultObserver(f.options)
    const rejected = expect(starting).rejects.toThrow(/context changed/)
    await vi.waitFor(() => expect(f.manager.watchScript).toHaveBeenCalled())
    f.setCurrent(false)
    pending.resolve()
    await rejected
    expect(f.manager.unwatchScript).toHaveBeenCalledOnce()
    expect(f.callbacks.size).toBe(0)
  })

  it('keeps a shared watch while a replacement observer finishes registering', async () => {
    const f = fixture()
    const pending = deferred<void>()
    f.manager.watchScript.mockImplementationOnce(() => pending.promise)
    let firstCurrent = true
    const first = createBankrollVaultObserver({ ...f.options, isCurrent: () => firstCurrent })
    const rejected = expect(first).rejects.toThrow(/context changed/)
    await vi.waitFor(() => expect(f.manager.watchScript).toHaveBeenCalledOnce())
    const second = createBankrollVaultObserver(f.options)
    await vi.waitFor(() => expect(chain.bootstrap).toHaveBeenCalledTimes(2))
    firstCurrent = false
    pending.resolve()
    await rejected
    const observer = await second
    expect(f.manager.watchScript).toHaveBeenCalledOnce()
    expect(f.manager.unwatchScript).not.toHaveBeenCalled()
    await observer.dispose()
    expect(f.manager.unwatchScript).toHaveBeenCalledOnce()
  })

  it('discards a pending bootstrap after its wallet context changes', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    chain.bootstrap.mockReturnValueOnce(pending.promise)
    const starting = createBankrollVaultObserver(f.options)
    await vi.waitFor(() => expect(chain.bootstrap).toHaveBeenCalled())
    f.setCurrent(false)
    pending.resolve({})
    await expect(starting).rejects.toThrow(/context changed/)
    expect(f.manager.watchScript).not.toHaveBeenCalled()
    expect(f.states.some(state => state.status === 'ready')).toBe(false)
  })

  it('uses event-triggered rereads and suppresses an obsolete read error', async () => {
    const f = fixture()
    const observer = await createBankrollVaultObserver(f.options)
    const pending = deferred<unknown>()
    chain.position.mockReturnValueOnce(pending.promise).mockResolvedValue({ navSats: 200_000n, supply: 1000n })
    const refreshing = observer.refresh()
    f.emit({ type: 'connection_reset', timestamp: Date.now() })
    pending.reject(new Error('Obsolete network error'))
    await refreshing
    expect(f.states.at(-1)).toMatchObject({ status: 'ready', navSats: '200000' })
    expect(f.states.some(state => state.error === 'Obsolete network error')).toBe(false)
    await observer.dispose()
  })

  it('reports an absent output separately from unavailable recovery or failed holdings', async () => {
    const f = fixture()
    chain.position.mockResolvedValueOnce(undefined)
    const observer = await createBankrollVaultObserver(f.options)
    expect(f.states.at(-1)).toMatchObject({ status: 'absent', navSats: null, supply: null, estimatedClaimSats: null })
    chain.position.mockRejectedValueOnce(new Error('Control coin requires recovery'))
    await observer.refresh()
    expect(f.states.at(-1)).toMatchObject({ status: 'unavailable', navSats: null, memberShares: null, error: 'Control coin requires recovery' })
    f.wallet.getSpendableVtxos.mockRejectedValueOnce(new Error('Sync unavailable'))
    await observer.refresh()
    expect(f.states.at(-1)).toMatchObject({ status: 'unavailable', availableShares: null, error: 'Sync unavailable' })
    await observer.dispose()
  })

  it('keeps holdings unknown when sync evidence or asset quantities are inconsistent', async () => {
    const f = fixture()
    f.manager.getSyncState.mockReturnValue({ mode: 'online', lastSyncedAt: undefined as unknown as number })
    const observer = await createBankrollVaultObserver(f.options)
    expect(f.states.at(-1)).toMatchObject({ status: 'unavailable', memberShares: null })
    f.manager.getSyncState.mockReturnValue({ mode: 'online', lastSyncedAt: Date.now() })
    f.wallet.getVtxos.mockResolvedValueOnce([f.owned(100n), f.owned(100n)])
    await observer.refresh()
    expect(f.states.at(-1)).toMatchObject({ status: 'unavailable', memberShares: null, error: 'Duplicate wallet share output' })
    await observer.dispose()
  })

  it('never publishes late results after disposal', async () => {
    const f = fixture()
    const observer = await createBankrollVaultObserver(f.options)
    const pending = deferred<unknown>()
    chain.position.mockReturnValueOnce(pending.promise)
    const refreshing = observer.refresh()
    await observer.dispose()
    const count = f.states.length
    pending.reject(new Error('Disposed request failed'))
    await refreshing
    expect(f.states).toHaveLength(count)
    expect(f.manager.unwatchScript).toHaveBeenCalledOnce()
  })
})
