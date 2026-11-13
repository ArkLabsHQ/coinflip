import { createHash, randomBytes, randomUUID } from 'crypto'
import { base64, hex } from '@scure/base'
import {
  RestEmulatorProvider, RestIndexerProvider, RestOperatorProvider, SingleKey, Transaction, SettlementEventType, arkade, networks,
  type NormalizedExtendedVirtualCoin, type Wallet,
} from '@arkade-os/sdk'
import { packets, quoteCommittedEconomics } from 'arkade-coinflip'
import {
  bootstrapPool, buildPoolOpenGame, buildPoolPlayerReveal, buildPoolSettlement, buildPoolRenewalIntent,
  createPoolGameVault, poolGameSnapshot, readPoolGamePosition, readPoolRenewalPredecessor, renewPool,
  type PoolBootstrapJournal, type PoolGameDescriptor, type PoolGamePosition, type PoolRenewalJournal,
} from 'arkade-coinflip/dist/pool-game-vault'
import type { PoolPreparedGame } from 'arkade-coinflip/dist/pool-protocol'
import type { PoolRenewalSessionJournal } from 'arkade-coinflip/dist/pool-renewal-session'
import type { PoolBatchReplayJournal } from 'arkade-coinflip/dist/pool-batch-replay'
import { createTestWallet, fundWallet, sleep } from './helpers'
import { stagePoolTestInput, submitPoolTestSpend } from './test-helpers/pool-fresh'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const EMULATOR = process.env.EMULATOR_URL || 'http://localhost:7073'

it('renews the actual pool batch in idle, funded and contest phases without changing member claims or game commitments', async () => {
  const operator = new RestOperatorProvider(ARK), indexer = new RestIndexerProvider(ARK), emulator = new RestEmulatorProvider(EMULATOR)
  expect((await operator.getInfo()).network).toBe('regtest')
  const founder = SingleKey.fromRandomBytes(), player = SingleKey.fromRandomBytes()
  const wallets: Wallet[] = [], clients: arkade.Arkade[] = []
  try {
    let houseWallet = await createTestWallet(founder)
    const playerWallet = await createTestWallet(player)
    wallets.push(houseWallet, playerWallet)
    await fundWallet(houseWallet, 200_000); await fundWallet(playerWallet, 100_000)
    let bootstrapJournal: PoolBootstrapJournal | undefined
    const { descriptor } = await bootstrapPool(houseWallet, { name: 'Renewal proof pool', initialNavSats: '100000',
      operatorFeeBps: 2000, minHouseEdgeBps: 100, maxStakeBps: 1000, network: 'regtest', operatorUrl: ARK }, {
      load: async () => bootstrapJournal, save: async value => { bootstrapJournal = structuredClone(value) },
    })
    console.info('[pool-renewal-bootstrap]', descriptor.bootstrapTxid, descriptor.controlAssetId)
    const houseClient = await arkade.Arkade.connect({ arkade: operator, indexer, emulator, identity: founder, network: networks.regtest })
    const playerClient = await arkade.Arkade.connect({ arkade: operator, indexer, emulator, identity: player, network: networks.regtest })
    const observer = await arkade.Arkade.connect({ arkade: operator, indexer, emulator, network: networks.regtest })
    clients.push(houseClient, playerClient, observer)
    const contract = createPoolGameVault(houseClient, descriptor), watched = createPoolGameVault(observer, descriptor)
    let position = await waitHead(watched, descriptor, indexer)
    const unauthorized = await buildPoolRenewalIntent(houseWallet, contract, descriptor, position)
    const unsigned = new Transaction({ ...Transaction.ARK_TX_OPTS, version: unauthorized.proof.version, lockTime: unauthorized.proof.lockTime })
    for (let index = 0; index < unauthorized.proof.inputsLength; index++) {
      const input = unauthorized.proof.getInput(index)
      delete input.tapScriptSig
      delete input.tapKeySig
      delete input.partialSig
      unsigned.addInput(input)
    }
    for (let index = 0; index < unauthorized.proof.outputsLength; index++) unsigned.addOutput(unauthorized.proof.getOutput(index))
    expect(unsigned.id).toBe(unauthorized.proof.id)
    let unauthorizedApproval: string | undefined
    try { unauthorizedApproval = await emulator.submitIntent({ proof: base64.encode(unsigned.toPSBT()), message: unauthorized.message }) }
    catch (error) { expect(String(error)).toMatch(/signature|intent|emulator/i) }
    if (unauthorizedApproval) await expect(operator.registerIntent({ proof: unauthorizedApproval, message: unauthorized.message })).rejects.toThrow(/signature|proof|witness/i)
    expect((await waitHead(watched, descriptor, indexer)).coin.txid).toBe(position.coin.txid)
    const renewalProofs: Array<{ phase: string; before: string; after: string; commitment: string; expiresBefore: number; expiresAfter: number }> = []
    async function renew() {
      const previous = position, before = poolGameSnapshot(previous)
      expect(before.expiresAt).not.toBeNull()
      let journal: PoolRenewalJournal | undefined
      let session: PoolRenewalSessionJournal | undefined
      let replay: PoolBatchReplayJournal | undefined
      let failPreparedAcknowledgement = previous.state.phase === 'idle'
      let failAfterSavedNonces = previous.state.phase === 'funded'
      const persistence = { load: async () => journal, save: async (value: PoolRenewalJournal) => {
        journal = structuredClone(value)
        if (failPreparedAcknowledgement && value.status === 'prepared') {
          failPreparedAcknowledgement = false
          throw new Error('Simulated lost prepared-journal acknowledgement')
        }
      }, loadSession: async () => session, saveSession: async (value: PoolRenewalSessionJournal, expectedRevision: number | null) => {
        if ((session?.revision ?? null) !== expectedRevision) return false
        session = structuredClone(value)
        return true
      }, loadReplay: async () => replay, saveReplay: async (value: PoolBatchReplayJournal, expectedRevision: number | null) => {
        if ((replay?.revision ?? null) !== expectedRevision) return false
        replay = JSON.parse(JSON.stringify(value)) as PoolBatchReplayJournal
        const expected = Object.keys(session?.nonces ?? {})
        const observed = new Set(value.events.filter(event => event.type === SettlementEventType.TreeNonces).map(event => event.txid))
        if (failAfterSavedNonces && expected.length > 0 && expected.every(id => observed.has(id))) {
          failAfterSavedNonces = false
          throw new Error('Simulated restart after aggregate nonce persistence')
        }
        return true
      } }
      let restoredProofId: string | undefined
      if (previous.state.phase === 'idle') {
        await expect(renewPool(houseWallet, descriptor, emulator, persistence)).rejects.toThrow('lost prepared-journal acknowledgement')
        expect(journal?.registrationAttempted).toBeUndefined()
        restoredProofId = Transaction.fromPSBT(base64.decode(journal!.proof)).id
        wallets.splice(wallets.indexOf(houseWallet), 1)
        await houseWallet.dispose()
        houseWallet = await createTestWallet(founder)
        wallets.push(houseWallet)
      }
      if (previous.state.phase === 'funded') {
        let interruption: unknown
        try { await renewPool(houseWallet, descriptor, emulator, persistence, { signal: AbortSignal.timeout(120_000) }) }
        catch (error) { interruption = error }
        expect(interruption).toBeDefined()
        if (failAfterSavedNonces) throw interruption
        expect(failAfterSavedNonces).toBe(false)
        expect(Object.values(session!.nonces).every(nonce => !nonce.partialSignature)).toBe(true)
        restoredProofId = Transaction.fromPSBT(base64.decode(journal!.proof)).id
        wallets.splice(wallets.indexOf(houseWallet), 1)
        await houseWallet.dispose()
        houseWallet = await createTestWallet(founder)
        wallets.push(houseWallet)
      }
      const result = await renewPool(houseWallet, descriptor, emulator, persistence, { signal: AbortSignal.timeout(120_000) })
      if (restoredProofId) expect(result.proofTxid).toBe(restoredProofId)
      expect(Object.values(session!.nonces).length).toBeGreaterThan(0)
      expect(Object.values(session!.nonces).every(nonce => !!nonce.partialSignature && !nonce.secretNonce)).toBe(true)
      expect(journal?.status).toBe('confirmed')
      expect(result.feeSats).toBe('0')
      expect(result.nextHead).not.toEqual(before.outpoint)
      position = await waitHead(watched, descriptor, indexer, result.nextHead.txid)
      const after = poolGameSnapshot(position)
      expect(after.expiresAt).not.toBeNull()
      expect(after.expiresAt!).toBeGreaterThan(before.expiresAt!)
      expect(position.state).toEqual(previous.state)
      expect(position.coin.value).toBe(previous.coin.value)
      const old = (await indexer.getVtxos({ outpoints: [before.outpoint], spendableOnly: false })).vtxos[0]
      expect(old.settledBy).toBe(result.commitmentTxid)
      const predecessor = await readPoolRenewalPredecessor(watched, descriptor, position, indexer, async txid => {
        expect(txid).toBe(result.proofTxid); return journal!.proof
      })
      expect(predecessor?.coin.txid).toBe(previous.coin.txid)
      expect((await renewPool(houseWallet, descriptor, emulator, persistence)).nextHead).toEqual(result.nextHead)
      renewalProofs.push({ phase: previous.state.phase, before: before.outpoint.txid, after: after.outpoint.txid,
        commitment: result.commitmentTxid, expiresBefore: before.expiresAt!, expiresAfter: after.expiresAt! })
    }
    await renew()
    const playerSecret = packets.encodeReveal(0, new Uint8Array(randomBytes(16))), houseSecret = packets.encodeReveal(0, new Uint8Array(randomBytes(16)))
    const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
    const funding = await waitCoin(playerWallet)
    const now = Math.floor(Date.now() / 1000)
    const game: PoolPreparedGame = { gameId: randomUUID(), expectedHead: { txid: position.coin.txid, vout: position.coin.vout },
      playerHash: hash(playerSecret), houseHash: hash(houseSecret), playerPubkey: hex.encode(await player.xOnlyPublicKey()),
      playerPayoutAddress: await playerWallet.getAddress(), playerStakeSats: '1000', houseStakeSats: '970', oddsN: 100, oddsLo: 0, oddsTarget: 50,
      cancelAt: now + 600, finalAt: now + 1200, expiresAt: Date.now() + 60_000,
      economics: quoteCommittedEconomics({ playerStake: 1000, houseStake: 970, oddsN: 100, oddsLo: 0, oddsTarget: 50 }) }
    const staged = await stagePoolTestInput(playerClient, descriptor, funding)
    const built = await buildPoolOpenGame(contract, descriptor, position, staged.coin, game, staged.authorization).builder.build()
    const opened = await submitPoolTestSpend(playerClient, built, staged.authorization, player, founder)
    position = await waitHead(watched, descriptor, indexer, opened.txid)
    expect(position.state.phase).toBe('funded')
    await renew()
    const reveal = await buildPoolPlayerReveal(contract, descriptor, position, playerSecret).send()
    position = await waitHead(watched, descriptor, indexer, reveal.txid)
    expect(position.state.phase).toBe('contest')
    await renew()
    const settled = await buildPoolSettlement(contract, descriptor, position, playerSecret, houseSecret).builder.send()
    position = await waitHead(watched, descriptor, indexer, settled.txid)
    expect(position.state).toMatchObject({ phase: 'idle', navSats: 99_030n, supply: 100_000_000_000n, carriedLossSats: 970n, accruedFeesSats: 0n })
    console.info('[pool-renewal-proof]', JSON.stringify({ bootstrap: descriptor.bootstrapTxid, renewals: renewalProofs, settlement: settled.txid }))
  } finally { for (const client of clients) client.dispose(); await Promise.all(wallets.map(wallet => wallet.dispose())) }
}, 300_000)

async function waitHead(contract: arkade.ArkadeContract, descriptor: PoolGameDescriptor, indexer: RestIndexerProvider, txid?: string): Promise<PoolGamePosition> {
  const deadline = Date.now() + 45_000
  for (;;) {
    const value = await readPoolGamePosition(contract, descriptor, indexer)
    if (value && (!txid || value.coin.txid === txid)) return value
    if (Date.now() > deadline) throw new Error('Timed out waiting for canonical renewed pool state')
    await sleep(250)
  }
}
async function waitCoin(wallet: Wallet): Promise<NormalizedExtendedVirtualCoin> {
  const deadline = Date.now() + 45_000
  for (;;) {
    const value = (await wallet.getSpendableVtxos()).find(coin => !coin.assets?.length && coin.value >= 1330)
    if (value) return value
    if (Date.now() > deadline) throw new Error('Timed out waiting for player funding')
    await sleep(250)
  }
}
