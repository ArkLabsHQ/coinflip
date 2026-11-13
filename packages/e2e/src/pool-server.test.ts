import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { base64, hex } from '@scure/base'
import {
  ArkAddress, CSVMultisigTapscript, RestEmulatorProvider, RestIndexerProvider, RestOperatorProvider,
  SingleKey, Transaction, arkade, decodeTapscript, networks,
  type NormalizedExtendedVirtualCoin, type Wallet,
} from '@arkade-os/sdk'
import {
  buildCofundFromPlay, packets, quoteCommittedEconomics,
  type PoolOperationResponse, type PoolOperatorPosition, type PoolPreparedGame, type PoolPublicResponse, type PoolSubmitRequest,
} from 'arkade-coinflip'
import {
  authorizePoolFreshSpend, buildPoolOpenGame, buildPoolRedemption, buildPoolSettlement, buildPoolSubscription,
  createPoolGameVault, readPoolGamePosition, type PoolFreshAuthorization, type PoolGameDescriptor, type PoolGamePosition,
} from 'arkade-coinflip/dist/pool-game-vault'
import type { AppDeps, V4PlayResult } from 'arkade-coinflip-server'
import { createTestWallet, fundWallet, sleep } from './helpers'
import { stagePoolTestInput, submitPoolTestSpend } from './test-helpers/pool-fresh'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMULATOR = process.env.EMULATOR_URL || 'http://localhost:7073'
type ServerModule = typeof import('arkade-coinflip-server')
type Built = Awaited<ReturnType<arkade.ArkadeTransactionBuilder['build']>>
const encode = (tx: Transaction): string => base64.encode(tx.toPSBT())
const digest = (secret: Uint8Array): string => createHash('sha256').update(secret).digest('hex')
const revealSecret = (): Uint8Array => packets.encodeReveal(0, new Uint8Array(randomBytes(16)))

it('serves real pool capital and wagers beside normal play, recovering the exact durable relay after restart', async () => {
  const envKeys = ['DATA_DIR', 'ARK_SERVER_URL', 'ARK_SERVER_PUBLIC_URL', 'ESPLORA_URL', 'EMULATOR_URL'] as const
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinflip-pool-http-'))
  let deps: AppDeps | undefined
  let memberWallet: Wallet | undefined
  let memberClient: arkade.Arkade | undefined
  let operatorClient: arkade.Arkade | undefined
  let closeDb: (() => void) | undefined
  try {
    process.env.DATA_DIR = dataDir
    process.env.ARK_SERVER_URL = ARK
    process.env.ARK_SERVER_PUBLIC_URL = ARK
    process.env.ESPLORA_URL = ESPLORA
    process.env.EMULATOR_URL = EMULATOR
    const info = await new RestOperatorProvider(ARK).getInfo()
    expect(info.network).toBe('regtest')
    expect((await fetch(`${EMULATOR}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok).toBe(true)
    const server: ServerModule = require('arkade-coinflip-server')
    closeDb = (require('arkade-coinflip-server/dist/db.js') as { closeDb(): void }).closeDb
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })
    await fundWallet(deps.wallet, 600_000)
    const member = SingleKey.fromRandomBytes()
    memberWallet = await createTestWallet(member)
    await fundWallet(memberWallet, 300_000)
    await memberWallet.send({ recipients: [{ address: await memberWallet.getAddress(), amount: 100_000 }] })
    memberClient = await arkade.Arkade.connect({
      arkade: new RestOperatorProvider(ARK), indexer: memberWallet.indexerProvider,
      emulator: new RestEmulatorProvider(EMULATOR), identity: member, network: networks.regtest,
      contractManager: await memberWallet.getContractManager(),
    })
    let apps = applications(server, deps)
    expect((await request(apps.public).get('/api/pool').expect(200)).body.status).toBe('unconfigured')
    const bootstrap = { name: 'Private HTTP software proof', initialNavSats: '100000',
      operatorFeeBps: 2000, minHouseEdgeBps: 100, maxStakeBps: 2000 }
    const boot = (await request(apps.admin).post('/api/admin/pool/bootstrap').send(bootstrap).expect(200)).body as PoolPublicResponse
    expect(boot.fairnessAssumption).toBe('unresolved')
    expect(boot.capabilities).toMatchObject({ subscribe: false, play: false, redeem: true })
    const descriptor = boot.descriptor!
    expect(descriptor.network).toBe('regtest')
    const vault = createPoolGameVault(memberClient, descriptor)
    const indexer = new RestIndexerProvider(ARK)
    let position = await waitHead(vault, descriptor, indexer)
    expect(position.state).toMatchObject({ navSats: 100_000n, supply: 100_000_000_000n })
    const memberKey = hex.encode(await member.xOnlyPublicKey())
    const depositCoin = await waitCoin(memberWallet, coin => !coin.assets?.length && coin.value === 100_000)
    const stagedDeposit = await stagePoolTestInput(memberClient, descriptor, depositCoin)
    const subscription = buildPoolSubscription(vault, descriptor, position, stagedDeposit.coin, 25_000n,
      25_000_000_000n, stagedDeposit.authorization)
    const subscribeRequest = await signedRequest(member, await subscription.builder.build(), position,
      { kind: 'subscribe', depositSats: '25000', minShares: subscription.mintedShares.toString() }, stagedDeposit.authorization)
    await request(apps.public).post('/api/pool/submit').send(subscribeRequest).expect(503)
    expect((await waitHead(vault, descriptor, indexer)).coin.txid).toBe(position.coin.txid)
    await request(apps.admin).put('/api/admin/pool/policy').send({ fairnessAssumption: 'honest-operator' }).expect(200)

    const actualFetch = globalThis.fetch
    let interruptedRelays = 0
    const relayFailure = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === `${EMULATOR}/v1/tx` && init?.method === 'POST') {
        interruptedRelays++
        throw new Error('HTTP lifecycle proof interrupted the persisted relay before broadcast')
      }
      return actualFetch(input, init)
    })
    try {
      const interrupted = await request(apps.public).post('/api/pool/submit').send(subscribeRequest)
      expect([202, 503]).toContain(interrupted.status)
    } finally { relayFailure.mockRestore() }
    expect(interruptedRelays).toBe(1)
    const sql = server.getSqlExecutor()
    const saved = await sql.get<{ status: string; relay_json: string }>(
      'SELECT status, relay_json FROM pool_operations WHERE operation_id = ?', [subscribeRequest.operationId])
    expect(saved?.status).toBe('unknown')
    expect(JSON.parse(saved!.relay_json).arkTxid).toBe(subscribeRequest.arkTxid)
    expect((await request(apps.public).get('/api/pool').expect(200)).body.capabilities.subscribe).toBe(false)
    const houseKey = hex.encode(await deps.identity.xOnlyPublicKey())
    await deps.wallet.dispose()
    deps = undefined
    closeDb()
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })
    apps = applications(server, deps)
    expect(hex.encode(await deps.identity.xOnlyPublicKey())).toBe(houseKey)
    const replayedBodies: unknown[] = []
    const observeReplay = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === `${EMULATOR}/v1/tx` && init?.method === 'POST') replayedBodies.push(JSON.parse(String(init.body)))
      return actualFetch(input, init)
    })
    try { await deps.pool!.reconcile() } finally { observeReplay.mockRestore() }
    expect(replayedBodies.length).toBeGreaterThan(0)
    for (const body of replayedBodies) expect(body).toEqual(JSON.parse(saved!.relay_json).body)
    const subscribed = await waitOperation(apps.public, subscribeRequest.operationId, deps)
    expect(subscribed.receipt).toMatchObject({ arkTxid: subscribeRequest.arkTxid,
      consumedHead: subscribeRequest.expectedHead, nextHead: { txid: subscribeRequest.arkTxid, vout: 0 } })
    position = await waitHead(vault, descriptor, indexer, subscribed.arkTxid)
    expect(position.state).toMatchObject({ navSats: 125_000n, supply: 125_000_000_000n })
    expect((await request(apps.public).post('/api/pool/submit').send(subscribeRequest).expect(202)).body.receipt).toEqual(subscribed.receipt)
    await request(apps.public).post('/api/pool/submit').send({ ...subscribeRequest,
      command: { ...subscribeRequest.command, depositSats: '25001' } }).expect(409)
    const memberShares = await waitCoin(memberWallet, coin => held(coin, descriptor.shareAssetId) === 25_000_000_000n)

    const playerSecret = revealSecret()
    const gameRequest = { requestId: randomUUID(), expectedHead: { txid: position.coin.txid, vout: position.coin.vout },
      playerPubkey: memberKey, playerHash: digest(playerSecret), playerPayoutAddress: await memberWallet.getAddress(),
      playerStakeSats: '10000', oddsN: 2, oddsLo: 0, oddsTarget: 1 }
    const prepared = (await request(apps.public).post('/api/pool/prepare').send(gameRequest).expect(200)).body as PoolPreparedGame
    expect((await request(apps.public).post('/api/pool/prepare').send(gameRequest).expect(200)).body).toEqual(prepared)
    const playerCoin = await waitCoin(memberWallet, coin => !coin.assets?.length && coin.value > 50_000)
    const stagedPlayer = await stagePoolTestInput(memberClient, descriptor, playerCoin)
    const opening = await signedRequest(member, await buildPoolOpenGame(vault, descriptor, position, stagedPlayer.coin,
      prepared, stagedPlayer.authorization).builder.build(), position,
      { kind: 'openGame', gameId: prepared.gameId }, stagedPlayer.authorization)
    await request(apps.public).post('/api/pool/submit').send(opening).expect(202)
    await waitOperation(apps.public, opening.operationId, deps)
    position = await waitHead(vault, descriptor, indexer, opening.arkTxid)
    expect(position.state).toMatchObject({ phase: 'funded', navSats: 125_000n })
    expect((await request(apps.public).get('/api/pool').expect(200)).body.capabilities).toMatchObject({ subscribe: false, redeem: false, play: false })
    const normal = await normalGame(apps.public, deps, memberWallet, member)
    expect((await waitHead(vault, descriptor, indexer)).coin.txid).toBe(opening.arkTxid)
    expect(held(await waitCoin(memberWallet, coin => coin.txid === memberShares.txid && coin.vout === memberShares.vout), descriptor.shareAssetId))
      .toBe(25_000_000_000n)

    await request(apps.public).post(`/api/pool/operations/${opening.operationId}/reveal`)
      .send({ playerSecretHex: hex.encode(revealSecret()) }).expect(400)
    const result = (await request(apps.public).post(`/api/pool/operations/${opening.operationId}/reveal`)
      .send({ playerSecretHex: hex.encode(playerSecret) }).expect(202)).body
    expect(digest(hex.decode(result.houseSecretHex))).toBe(prepared.houseHash)
    const roll = (playerSecret[0] + hex.decode(result.houseSecretHex)[0]) % prepared.oddsN
    const winner = roll >= prepared.oddsLo && roll < prepared.oddsTarget ? 'player' : 'pool'
    expect(result.winner).toBe(winner)
    const settled = await waitOperation(apps.public, result.operation.operationId, deps)
    position = await waitHead(vault, descriptor, indexer, settled.arkTxid)
    const houseStake = BigInt(prepared.houseStakeSats), playerStake = BigInt(prepared.playerStakeSats)
    const fee = winner === 'pool' ? playerStake * 2000n / 10_000n : 0n
    const nav = winner === 'pool' ? 125_000n + playerStake - fee : 125_000n - houseStake
    expect(position.state).toMatchObject({ phase: 'idle', navSats: nav, supply: 125_000_000_000n,
      accruedFeesSats: fee, carriedLossSats: winner === 'player' ? houseStake : 0n })
    if (winner === 'player') expect((await waitCoin(memberWallet, coin => coin.txid === settled.arkTxid && coin.vout === 1)).value)
      .toBe(Number(playerStake + houseStake))
    const history = (await request(apps.public).get('/api/pool').expect(200)).body as PoolPublicResponse
    expect(history.history).toContainEqual(expect.objectContaining({ gameId: prepared.gameId, status: 'settled',
      openingTxid: opening.arkTxid, settlementTxid: settled.arkTxid, winner }))
    const repeat = (await request(apps.public).post(`/api/pool/operations/${opening.operationId}/reveal`)
      .send({ playerSecretHex: hex.encode(playerSecret) }).expect(202)).body
    expect(repeat.operation.arkTxid).toBe(settled.arkTxid)

    await request(apps.admin).put('/api/admin/pool/policy').send({ fairnessAssumption: 'unresolved' }).expect(200)
    expect((await request(apps.public).get('/api/pool').expect(200)).body.capabilities)
      .toMatchObject({ subscribe: false, play: false, redeem: true })
    const stagedShares = await stagePoolTestInput(memberClient, descriptor, memberShares)
    const redemption = buildPoolRedemption(vault, descriptor, position, stagedShares.coin, 10_000_000_000n,
      undefined, stagedShares.authorization)
    const redeemRequest = await signedRequest(member, await redemption.builder.build(), position,
      { kind: 'redeem', burnShares: '10000000000', minSats: redemption.payoutSats.toString() }, stagedShares.authorization)
    await request(apps.public).post('/api/pool/submit').send(redeemRequest).expect(202)
    const redeemed = await waitOperation(apps.public, redeemRequest.operationId, deps)
    position = await waitHead(vault, descriptor, indexer, redeemed.arkTxid)
    expect(position.state).toMatchObject({ navSats: nav - redemption.payoutSats, supply: 115_000_000_000n, accruedFeesSats: fee })
    const remaining = await waitCoin(memberWallet, coin => coin.txid === redeemed.arkTxid && coin.vout === 1)
    expect(held(remaining, descriptor.shareAssetId)).toBe(15_000_000_000n)
    expect(remaining.value - memberShares.value).toBe(Number(redemption.payoutSats))

    operatorClient = await arkade.Arkade.connect({
      arkade: new RestOperatorProvider(ARK), indexer, emulator: new RestEmulatorProvider(EMULATOR),
      identity: deps.identity, network: networks.regtest, contractManager: await deps.wallet.getContractManager(),
    })
    const operatorVault = createPoolGameVault(operatorClient, descriptor)
    const fixtureBefore = position.state
    const fixture = await profitableFixture(operatorVault, descriptor, position, deps, memberWallet, member, indexer, memberClient)
    position = await waitHead(vault, descriptor, indexer, fixture.settlement)
    const fixtureProfit = 15_000n
    const recovered = fixtureProfit > fixtureBefore.carriedLossSats ? fixtureProfit - fixtureBefore.carriedLossSats : 0n
    const fixtureFee = recovered * BigInt(descriptor.operatorFeeBps) / 10_000n
    const earnedFees = fixtureBefore.accruedFeesSats + fixtureFee
    expect(earnedFees).toBeGreaterThanOrEqual(330n)
    expect(position.state).toMatchObject({ navSats: fixtureBefore.navSats + fixtureProfit - fixtureFee,
      supply: 115_000_000_000n, carriedLossSats: 0n, accruedFeesSats: earnedFees, phase: 'idle' })
    const beforeSweep = position.state
    const operatorPosition = (await request(apps.admin).get('/api/admin/pool/position').expect(200)).body as PoolOperatorPosition
    expect(operatorPosition).toMatchObject({ totalShares: '100000000000', feeSweepSats: earnedFees.toString(),
      capabilities: { redeem: true, sweepFees: true } })
    expect((await request(apps.public).get('/api/pool').expect(200)).body.fairnessAssumption).toBe('unresolved')
    const feeRequest = { operationId: randomUUID(), expectedHead: operatorPosition.head!.outpoint }
    await request(apps.admin).post('/api/admin/pool/fees').send(feeRequest).expect(202)
    const swept = await waitOperation(apps.public, feeRequest.operationId, deps)
    position = await waitHead(vault, descriptor, indexer, swept.arkTxid)
    expect(position.state).toMatchObject({ navSats: beforeSweep.navSats, supply: beforeSweep.supply,
      carriedLossSats: beforeSweep.carriedLossSats, accruedFeesSats: 0n })
    const feeCash = await waitCoin(deps.wallet, coin => coin.txid === swept.arkTxid && coin.vout === 1)
    expect(feeCash.value).toBe(Number(earnedFees))
    expect(feeCash.assets ?? []).toHaveLength(0)
    expect((await request(apps.admin).post('/api/admin/pool/fees').send(feeRequest).expect(202)).body.receipt).toEqual(swept.receipt)

    const founderPosition = (await request(apps.admin).get('/api/admin/pool/position').expect(200)).body as PoolOperatorPosition
    expect(founderPosition.capabilities).toMatchObject({ redeem: true, sweepFees: false })
    expect(founderPosition.coins).toHaveLength(1)
    const founder = founderPosition.coins[0]
    const founderShares = BigInt(founder.shares)
    const founderEquity = founderShares * position.state.navSats / position.state.supply
    expect(founderShares).toBe(100_000_000_000n)
    expect(founder.equitySats).toBe(founderEquity.toString())
    expect(BigInt(founder.fullRedemptionPayoutSats)).toBe(BigInt(founder.valueSats) + founderEquity)
    const founderRequest = { operationId: randomUUID(), expectedHead: founderPosition.head!.outpoint,
      memberOutpoint: founder.outpoint, burnShares: founder.shares, minSats: founder.equitySats }
    const beforeFounderExit = position.state
    await request(apps.admin).post('/api/admin/pool/redeem').send(founderRequest).expect(202)
    const founderExit = await waitOperation(apps.public, founderRequest.operationId, deps)
    position = await waitHead(vault, descriptor, indexer, founderExit.arkTxid)
    expect(position.state).toMatchObject({ navSats: beforeFounderExit.navSats - founderEquity,
      supply: 15_000_000_000n, accruedFeesSats: 0n, phase: 'idle' })
    const founderCash = await waitCoin(deps.wallet, coin => coin.txid === founderExit.arkTxid && coin.vout === 1)
    expect(founderCash.value).toBe(Number(BigInt(founder.fullRedemptionPayoutSats)))
    expect(founderCash.assets ?? []).toHaveLength(0)
    expect((await request(apps.admin).post('/api/admin/pool/redeem').send(founderRequest).expect(202)).body.receipt).toEqual(founderExit.receipt)
    expect((await waitHead(vault, descriptor, indexer)).coin.txid).toBe(founderExit.arkTxid)
    const preserved = await waitCoin(memberWallet, coin => coin.txid === remaining.txid && coin.vout === remaining.vout)
    expect(held(preserved, descriptor.shareAssetId)).toBe(15_000_000_000n)
    expect(preserved.value).toBe(remaining.value)
    const afterFounderExit = (await request(apps.admin).get('/api/admin/pool/position').expect(200)).body as PoolOperatorPosition
    expect(afterFounderExit).toMatchObject({ coins: [], totalShares: '0', totalEquitySats: '0', feeSweepSats: '0',
      capabilities: { redeem: false, sweepFees: false } })
    expect((await request(apps.admin).post('/api/admin/pool/bootstrap').send(bootstrap).expect(200)).body.descriptor).toEqual(descriptor)
    console.info('[pool-server]', { bootstrap: descriptor.bootstrapTxid, subscription: subscribed.arkTxid,
      recoveredOperation: subscribed.operationId, poolGame: prepared.gameId, opening: opening.arkTxid,
      normalGame: normal.gameId, normalSettlement: normal.settleTxid, settlement: settled.arkTxid,
      winner, httpGameFeeSats: fee.toString(), redemption: redeemed.arkTxid,
      controlledSdkFixtureOpening: fixture.opening, controlledSdkFixtureSettlement: fixture.settlement,
      sweptFeeSats: earnedFees.toString(), feeSweep: swept.arkTxid,
      founderExit: founderExit.arkTxid, founderSpendableSats: founderCash.value,
      finalNavSats: position.state.navSats.toString() })
  } finally {
    jest.restoreAllMocks()
    await operatorClient?.dispose()
    await memberClient?.dispose()
    await memberWallet?.dispose()
    await deps?.wallet.dispose()
    closeDb?.()
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    const resolved = path.resolve(dataDir)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('coinflip-pool-http-')) throw new Error('Unexpected test data directory')
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}, 600_000)

function applications(server: ServerModule, deps: AppDeps): { public: express.Express; admin: express.Express } {
  const publicApp = express(), admin = express()
  publicApp.use(express.json({ limit: '1mb' }))
  publicApp.use(server.createPublicRoutes(deps), server.createV4Routes(deps), server.createPoolRoutes(deps.pool!))
  admin.use(express.json(), server.createPoolAdminRoutes(deps.pool!))
  return { public: publicApp, admin }
}

async function signedRequest(identity: SingleKey, built: Built, position: PoolGamePosition,
  command: PoolSubmitRequest['command'], authorization: PoolFreshAuthorization): Promise<PoolSubmitRequest> {
  if (built.checkpoints.length !== 2) throw new Error('Expected pool and member checkpoints')
  const signed = await authorizePoolFreshSpend(identity, built, authorization)
  return { operationId: randomUUID(), expectedHead: { txid: position.coin.txid, vout: position.coin.vout },
    command, arkTxid: signed.arkTx.id, arkTx: encode(signed.arkTx), checkpointTxs: signed.checkpoints.map(encode),
    memberPubkey: hex.encode(await identity.xOnlyPublicKey()) }
}

async function waitOperation(app: express.Express, operationId: string, deps: AppDeps): Promise<PoolOperationResponse> {
  let result: PoolOperationResponse | undefined
  await waitUntil(async () => {
    await deps.pool!.reconcile()
    result = (await request(app).get(`/api/pool/operations/${operationId}`).expect(200)).body
    if (result!.status === 'conflict' || result!.status === 'rejected') throw new Error(JSON.stringify(result))
    return result!.status === 'confirmed'
  })
  return result!
}

async function waitHead(contract: arkade.ArkadeContract, descriptor: PoolGameDescriptor, indexer: RestIndexerProvider,
  txid?: string): Promise<PoolGamePosition> {
  let position: PoolGamePosition | undefined
  await waitUntil(async () => { position = await readPoolGamePosition(contract, descriptor, indexer); return !!position && (!txid || position.coin.txid === txid) })
  return position!
}

async function waitCoin(wallet: Wallet, predicate: (coin: NormalizedExtendedVirtualCoin) => boolean): Promise<NormalizedExtendedVirtualCoin> {
  let coin: NormalizedExtendedVirtualCoin | undefined
  await waitUntil(async () => { coin = (await wallet.getSpendableVtxos()).find(predicate); return !!coin })
  return coin!
}

function held(coin: NormalizedExtendedVirtualCoin, assetId: string): bigint {
  return (coin.assets ?? []).filter(asset => asset.assetId === assetId).reduce((sum, asset) => sum + asset.amount, 0n)
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 45_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for pool HTTP lifecycle state')
    await sleep(300)
  }
}

async function normalGame(app: express.Express, deps: AppDeps, wallet: Wallet, identity: SingleKey): Promise<{ gameId: string; settleTxid: string }> {
  const secret = revealSecret(), address = await wallet.getAddress()
  const play = (await request(app).post('/api/v4/play').send({ tier: 1000,
    playerPubkey: hex.encode(await identity.xOnlyPublicKey()), playerHash: digest(secret),
    playerPayoutAddress: address, playerChangeAddress: address }).expect(200)).body as V4PlayResult
  const houseInputs = (await deps.wallet.indexerProvider.getVtxos({ outpoints: play.houseInputs })).vtxos
  expect(houseInputs).toHaveLength(play.houseInputs.length)
  for (const input of houseInputs) expect(input.assets ?? []).toHaveLength(0)
  const coin = await waitCoin(wallet, value => !value.assets?.length && value.value >= 1330)
  const cofund = buildCofundFromPlay({ play, playerInputs: [{ txid: coin.txid, vout: coin.vout, value: coin.value,
    tapLeafScript: coin.forfeitTapLeafScript, tapTree: coin.tapTree }],
    playerChangePkScript: ArkAddress.decode(address).pkScript, betAmount: play.betAmount,
    serverUnroll: decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type })
  const first = (await request(app).post(`/api/v4/game/${play.gameId}/cofund`).send({
    arkTx: encode(await identity.sign(cofund.arkTx, [0])), checkpoints: cofund.checkpoints.map(encode) }).expect(200)).body
  const checkpoints = await Promise.all(first.playerCheckpoints.map(async (value: string) => encode(await identity.sign(Transaction.fromPSBT(base64.decode(value)), [0]))))
  await request(app).post(`/api/v4/game/${play.gameId}/cofund-finalize`).send({ playerCheckpoints: checkpoints }).expect(200)
  const result = (await request(app).post(`/api/v4/game/${play.gameId}/reveal`)
    .send({ playerSecretHex: hex.encode(secret) }).expect(200)).body
  const winnerWallet = result.winner === 'player' ? wallet : deps.wallet
  const payout = await waitCoin(winnerWallet, value => value.txid === result.settleTxid && value.value === play.pot)
  expect(payout.assets ?? []).toHaveLength(0)
  expect((await deps.repos.games.get(play.gameId))?.status).toBe('resolved')
  return { gameId: play.gameId, settleTxid: result.settleTxid }
}

async function profitableFixture(contract: arkade.ArkadeContract, descriptor: PoolGameDescriptor, position: PoolGamePosition,
  deps: AppDeps, wallet: Wallet, identity: SingleKey, indexer: RestIndexerProvider,
  memberClient: arkade.Arkade): Promise<{ opening: string; settlement: string }> {
  const playerSecret = packets.encodeReveal(70, new Uint8Array(randomBytes(16)))
  const houseSecret = revealSecret()
  const now = Math.floor(Date.now() / 1000)
  const terms: PoolPreparedGame = { gameId: randomUUID(), expectedHead: { txid: position.coin.txid, vout: position.coin.vout },
    playerHash: digest(playerSecret), houseHash: digest(houseSecret), playerPubkey: hex.encode(await identity.xOnlyPublicKey()),
    playerPayoutAddress: await wallet.getAddress(), playerStakeSats: '15000', houseStakeSats: '15000',
    oddsN: 100, oddsLo: 0, oddsTarget: 49, cancelAt: now + 300, finalAt: now + 600, expiresAt: Date.now() + 60_000,
    economics: quoteCommittedEconomics({ playerStake: 15000, houseStake: 15000, oddsN: 100, oddsLo: 0, oddsTarget: 49 }) }
  const coin = await waitCoin(wallet, value => !value.assets?.length && value.value >= 15_330)
  const staged = await stagePoolTestInput(memberClient, descriptor, coin)
  const opening = await buildPoolOpenGame(contract, descriptor, position, staged.coin, terms, staged.authorization).builder.build()
  const { txid: openingTxid } = await submitPoolTestSpend(memberClient, opening, staged.authorization, identity, deps.identity)
  position = await waitHead(contract, descriptor, indexer, openingTxid)
  const settlement = buildPoolSettlement(contract, descriptor, position, playerSecret, houseSecret)
  expect(settlement.winner).toBe('pool')
  const result = await settlement.builder.send()
  await waitHead(contract, descriptor, indexer, result.txid)
  return { opening: openingTxid, settlement: result.txid }
}
