import { arkade, networks, RestEmulatorProvider, RestIndexerProvider, RestOperatorProvider, SingleKey, type Wallet } from '@arkade-os/sdk'
import {
  bootstrapPool, createPoolGameVault, poolGameSnapshot, readPoolGamePosition, readPoolRenewalPredecessor, renewPool,
  type PoolBootstrapJournal, type PoolRenewalJournal,
} from 'arkade-coinflip/dist/pool-game-vault.js'
import { createTestWallet, fundWallet, sleep } from './helpers'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const EMULATOR = process.env.EMULATOR_URL || 'http://localhost:7073'

it('lets a non-operator rescue the pool only after admission closes, preserving its state for the operator', async () => {
  const operator = new RestOperatorProvider(ARK), indexer = new RestIndexerProvider(ARK), emulator = new RestEmulatorProvider(EMULATOR)
  expect((await operator.getInfo()).network).toBe('regtest')
  const founder = SingleKey.fromRandomBytes(), member = SingleKey.fromRandomBytes()
  const wallets: Wallet[] = [], clients: arkade.Arkade[] = []
  const store = () => {
    let journal: PoolRenewalJournal | undefined
    return { load: async () => journal, save: async (value: PoolRenewalJournal) => { journal = structuredClone(value) } }
  }
  try {
    const houseWallet = await createTestWallet(founder), memberWallet = await createTestWallet(member)
    wallets.push(houseWallet, memberWallet)
    await fundWallet(houseWallet, 200_000); await fundWallet(memberWallet, 20_000)
    let bootstrapJournal: PoolBootstrapJournal | undefined
    const { descriptor } = await bootstrapPool(houseWallet, { name: 'Rescue proof pool', initialNavSats: '100000',
      operatorFeeBps: 2000, minHouseEdgeBps: 100, maxStakeBps: 1000, network: 'regtest', operatorUrl: ARK }, {
      load: async () => bootstrapJournal, save: async value => { bootstrapJournal = structuredClone(value) },
    })
    const observer = await arkade.Arkade.connect({ arkade: operator, indexer, emulator, network: networks.regtest })
    clients.push(observer)
    const contract = createPoolGameVault(observer, descriptor)
    const before = (await readPoolGamePosition(contract, descriptor, indexer))!
    const opened = poolGameSnapshot(before)

    await expect(renewPool(memberWallet, descriptor, emulator, store(), { rescue: true })).rejects.toThrow()
    expect((await readPoolGamePosition(contract, descriptor, indexer))!.coin.txid).toBe(before.coin.txid)

    const windowOpens = opened.expiresAt! - opened.requiredLifetimeSeconds * 1000 + 15_000
    console.info('[pool-rescue] waiting for the rescue window', { seconds: Math.max(0, Math.ceil((windowOpens - Date.now()) / 1000)) })
    while (Date.now() < windowOpens) await sleep(Math.min(30_000, windowOpens - Date.now()))

    const rescued = await renewPool(memberWallet, descriptor, emulator, store(), { rescue: true })
    const after = (await readPoolGamePosition(contract, descriptor, indexer))!
    expect({ txid: after.coin.txid, vout: after.coin.vout }).toEqual(rescued.nextHead)
    expect(after.coin.value).toBe(before.coin.value)
    expect(poolGameSnapshot(after)).toMatchObject({ navSats: opened.navSats, supply: opened.supply, phase: opened.phase,
      carriedLossSats: opened.carriedLossSats, accruedFeesSats: opened.accruedFeesSats, readyForOperations: true })
    expect(after.coin.expiresAt!.getTime()).toBeGreaterThan(opened.expiresAt!)
    const loadProof = async (txid: string) => {
      const response = await fetch(`${ARK}/v1/intent?txid=${txid}`)
      return ((await response.json()) as { intent: { proof: string } }).intent.proof
    }
    expect((await readPoolRenewalPredecessor(contract, descriptor, after, indexer, loadProof))?.coin.txid).toBe(before.coin.txid)

    const renewed = await renewPool(houseWallet, descriptor, emulator, store())
    expect(renewed.snapshot).toMatchObject({ navSats: opened.navSats, supply: opened.supply, readyForOperations: true })
    console.info('[pool-rescue]', { bootstrap: descriptor.bootstrapTxid, rescueCommitment: rescued.commitmentTxid, operatorCommitment: renewed.commitmentTxid })
  } finally {
    for (const client of clients) await client.dispose()
    for (const wallet of wallets) await wallet.dispose()
  }
}, 3_000_000)
