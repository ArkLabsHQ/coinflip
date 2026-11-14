import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { Transaction } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import type { PoolRenewalJournal, PoolRenewalReceipt } from 'arkade-coinflip/dist/pool-game-vault.js'
import type { PoolInputRenewalJournal, PoolInputRenewalPlan, PoolInputRenewalReceipt } from 'arkade-coinflip/dist/pool-input-renewal.js'
import type { PoolGameDescriptor, PoolGameSnapshot, PoolPrepareRequest, PoolSubmitRequest, PoolOperatorActionRequest } from 'arkade-coinflip'
import { PoolService, SQLitePoolRepository, POOL_SCHEMA, createPoolRoutes, createPoolAdminRoutes, type AppDeps, type PoolAdapter } from 'arkade-coinflip-server'

const initialHead = { txid: 'aa'.repeat(32), vout: 0 }
const descriptor: PoolGameDescriptor = { version: 1, name: 'Software proof pool', network: 'regtest',
  operatorUrl: 'http://operator.invalid', controlAssetId: `${'11'.repeat(32)}:0`, shareAssetId: `${'22'.repeat(32)}:0`,
  operatorPubkey: '33'.repeat(32), operatorPayoutPkScript: `5120${'44'.repeat(32)}`, operatorFeeBps: 2000,
  minHouseEdgeBps: 100, maxStakeBps: 1000, bootstrapTxid: '55'.repeat(32), checkpointPsbts: ['cp-a', 'cp-b'] }
const snapshot = (): PoolGameSnapshot => ({ outpoint: initialHead, phase: 'idle', valueSats: '100330',
  navSats: '100000', supply: '100000000000', carriedLossSats: '0', accruedFeesSats: '0',
  requiredLifetimeSeconds: 6000, recoveryMarginSeconds: 2400,
  expiresAt: Date.now() + 86_400_000, expiresAtHeight: null, readyForOperations: true, admissionClosesAt: Date.now() + 86_400_000 - 6_060_000,
  rescueOpensAt: Date.now() + 86_400_000 - 6_000_000 })
const submission = (operationId = 'capital-a'): PoolSubmitRequest => ({ operationId, expectedHead: initialHead,
  command: { kind: 'subscribe', depositSats: '1000', minShares: '1' }, arkTxid: 'bb'.repeat(32),
  arkTx: 'fixture-psbt', checkpointTxs: ['fixture-checkpoint'], memberPubkey: '66'.repeat(32) })
const quoteRequest = (): PoolPrepareRequest => ({ requestId: 'quote-a', expectedHead: initialHead,
  playerPubkey: '66'.repeat(32), playerHash: '77'.repeat(32), playerPayoutAddress: 'player-payout-fixture',
  playerStakeSats: '10000', oddsN: 2, oddsLo: 0, oddsTarget: 1 })
function renewalFixture(): { journal: PoolRenewalJournal; receipt: PoolRenewalReceipt } {
  const proof = new Transaction()
  proof.addInput({ txid: initialHead.txid, index: 0, witnessUtxo: { amount: 100330n, script: hex.decode(descriptor.operatorPayoutPkScript) } })
  proof.addOutput({ amount: 100330n, script: hex.decode(descriptor.operatorPayoutPkScript) })
  const nextHead = { txid: 'ef'.repeat(32), vout: 0 }, now = Math.floor(Date.now() / 1000)
  return { journal: { version: 1, contractScript: descriptor.operatorPayoutPkScript, expectedHead: initialHead,
    proof: base64.encode(proof.toPSBT()), feeSats: '0', status: 'prepared', message: { type: 'register',
      onchain_output_indexes: [], valid_at: now - 1, expire_at: now + 120, cosigners_public_keys: [`02${descriptor.operatorPubkey}`] } },
  receipt: { intentId: null, proofTxid: proof.id, commitmentTxid: 'ed'.repeat(32), nextHead,
    snapshot: { ...snapshot(), outpoint: nextHead }, feeSats: '0' } }
}
type OperatorStage = NonNullable<Awaited<ReturnType<PoolAdapter['operatorAction']>>['stage']>
const operatorStageFixture = (): OperatorStage => ({ version: 1, authorization: { validUntil: Math.floor(Date.now() / 1000) + 120, minTTL: 6000 },
  funding: { arkTxid: 'ad'.repeat(32), arkTx: 'signed-founder-stage', checkpointTxs: ['signed-stage-checkpoint'],
    inputOutpoints: [{ txid: 'dd'.repeat(32), vout: 1 }], submitted: false } })

function inputRenewalFixture(): { plan: PoolInputRenewalPlan; journal: PoolInputRenewalJournal; receipt: PoolInputRenewalReceipt } {
  const source = { txid: 'dd'.repeat(32), vout: 1, value: 330, script: descriptor.operatorPayoutPkScript,
    assets: [{ assetId: descriptor.shareAssetId, amount: '100000000000' }] }
  const proof = new Transaction()
  proof.addInput({ txid: source.txid, index: source.vout, witnessUtxo: { amount: 330n, script: hex.decode(source.script) } })
  proof.addOutput({ amount: 330n, script: hex.decode(source.script) })
  const journal: PoolInputRenewalJournal = { version: 1, sources: [source], address: 'same-wallet-address', outputSats: '330', maximumFeeSats: '5000',
    proof: base64.encode(proof.toPSBT()), message: renewalFixture().journal.message, registrationAttempted: true, intentId: 'native-input-intent', status: 'pending' }
  const output = { txid: 'fc'.repeat(32), vout: 0 }
  return { journal, plan: { inputs: [{ ...source, assets: source.assets.map(value => ({ ...value, amount: BigInt(value.amount) })) }] as PoolInputRenewalPlan['inputs'],
    address: journal.address, outputSats: 330n, maximumFeeSats: 5000n }, receipt: { proofTxid: proof.id, intentId: journal.intentId!,
    commitmentTxid: 'fe'.repeat(32), output, outputSats: '330', assets: source.assets,
    outputs: [{ outpoint: output, valueSats: '330', assets: source.assets }] } }
}

describe('pool coordinator durable boundaries', () => {
  let db: Database.Database
  let repo: SQLitePoolRepository
  let adapter: jest.Mocked<PoolAdapter>
  let service: PoolService
  let config: Map<string, string>
  let deps: AppDeps

  beforeEach(async () => {
    db = new Database(':memory:')
    db.exec(POOL_SCHEMA)
    const sql = {
      run: async (query: string, values: unknown[] = []) => { db.prepare(query).run(...values) },
      get: async <T>(query: string, values: unknown[] = []) => db.prepare(query).get(...values) as T | undefined,
      all: async <T>(query: string, values: unknown[] = []) => db.prepare(query).all(...values) as T[],
    }
    repo = new SQLitePoolRepository(sql)
    await repo.beginBootstrap({ initialNavSats: '100000' })
    await repo.finishBootstrap(descriptor)
    config = new Map([['pool_fairness_assumption', 'honest-operator'], ['variable_odds_edge_bps', '300']])
    deps = { arkInfo: { unilateralExitDelay: 1536n }, repos: { config: { get: async (key: string) => config.get(key),
      set: async (key: string, value: string) => { config.set(key, value) } } } } as unknown as AppDeps
    adapter = { available: jest.fn().mockResolvedValue(true), restoreBootstrapHolds: jest.fn(),
      restoreRenewalHolds: jest.fn(), reserveRenewalSponsor: jest.fn().mockResolvedValue({ reservation: { outpoints: [], release: jest.fn() } }), renew: jest.fn(),
      prepareInputRenewal: jest.fn().mockResolvedValue(undefined), restoreInputRenewalHolds: jest.fn(), renewInputs: jest.fn(),
      restoreOperatorStageHolds: jest.fn().mockReturnValue({ outpoints: [initialHead], release: jest.fn() }), submitOperatorStage: jest.fn().mockResolvedValue('funded'),
      restoreOperationHolds: jest.fn().mockReturnValue({ outpoints: [initialHead], release: jest.fn() }),
      operatorCoins: jest.fn().mockResolvedValue([{ outpoint: { txid: 'dd'.repeat(32), vout: 1 }, valueSats: '330',
        shares: '100000000000', equitySats: '100000', fullRedemptionPayoutSats: '100330' }]),
      operatorAction: jest.fn().mockImplementation(async (_descriptor, action: PoolOperatorActionRequest) => {
        const approved: PoolSubmitRequest = { ...submission(action.operationId), expectedHead: action.expectedHead,
          command: action.command, memberPubkey: descriptor.operatorPubkey }
        return { request: approved, relay: { arkTxid: approved.arkTxid, body: { arkTx: approved.arkTx, checkpointTxs: approved.checkpointTxs } },
          reservation: { outpoints: [initialHead], release: jest.fn() } }
      }), read: jest.fn().mockResolvedValue(snapshot()),
      bootstrap: jest.fn().mockResolvedValue({ descriptor, snapshot: snapshot() }),
      authorize: jest.fn().mockImplementation(async (_descriptor, request: PoolSubmitRequest) => ({
        arkTxid: request.arkTxid, body: { arkTx: 'operator-authorized-packet', checkpointTxs: ['signed-cp'] } })),
      verify: jest.fn().mockResolvedValue({ status: 'pending' }), resolution: jest.fn(), post: jest.fn().mockResolvedValue(undefined) }
    service = new PoolService(deps, repo, adapter)
  })
  afterEach(() => { jest.restoreAllMocks(); db.close() })

  it('atomically gives only one different operation ownership of a canonical head', async () => {
    const first = submission('one'), second = { ...submission('two'), arkTxid: 'cc'.repeat(32) }
    expect(await Promise.all([repo.claimOperation(first, 'first'), repo.claimOperation(second, 'second')])).toEqual([true, false])
    expect(await repo.activeOperations()).toHaveLength(1)
  })

  it('persists the claimed transaction before operator authorization and the exact relay before posting', async () => {
    const request = submission()
    adapter.authorize.mockImplementationOnce(async () => {
      expect(await repo.operation(request.operationId)).toMatchObject({ status: 'submitting', ark_txid: request.arkTxid, relay_json: null })
      return { arkTxid: request.arkTxid, body: { arkTx: 'exact-authorized-body', checkpointTxs: ['cp'] } }
    })
    adapter.post.mockImplementationOnce(async relay => {
      expect(JSON.parse((await repo.operation(request.operationId))!.relay_json!)).toEqual(relay)
    })
    expect((await service.submit(request)).status).toBe('pending')
    expect(adapter.post).toHaveBeenCalledTimes(1)
  })

  it('never broadcasts when another worker terminalizes the row during authorization', async () => {
    const request = submission()
    adapter.authorize.mockImplementationOnce(async () => {
      await repo.updateOperation(request.operationId, 'conflict')
      return { arkTxid: request.arkTxid, body: { arkTx: 'must-not-broadcast', checkpointTxs: ['cp'] } }
    })
    await expect(service.submit(request)).rejects.toThrow(/eligible for broadcast/)
    expect(adapter.post).not.toHaveBeenCalled()
    expect((await repo.operation(request.operationId))?.status).toBe('conflict')
  })

  it('retains a head after an ambiguous network result and retries only its persisted packet', async () => {
    const request = submission()
    adapter.post.mockRejectedValueOnce(new Error('network response lost'))
    expect((await service.submit(request)).status).toBe('unknown')
    await expect(service.submit({ ...submission('competitor'), arkTxid: 'cc'.repeat(32) })).rejects.toThrow(/owns this pool head/)
    expect((await service.submit(request)).status).toBe('pending')
    expect(adapter.authorize).toHaveBeenCalledTimes(1)
    expect(adapter.post.mock.calls[1][0]).toEqual(adapter.post.mock.calls[0][0])
  })

  it('restores the same authorized payload after restarting the service', async () => {
    const request = submission()
    adapter.post.mockRejectedValueOnce(new Error('timeout'))
    await service.submit(request)
    const restarted = new PoolService(deps, new SQLitePoolRepository({
      run: async (query: string, values: unknown[] = []) => { db.prepare(query).run(...values) },
      get: async <T>(query: string, values: unknown[] = []) => db.prepare(query).get(...values) as T | undefined,
      all: async <T>(query: string, values: unknown[] = []) => db.prepare(query).all(...values) as T[],
    }), adapter)
    expect((await restarted.submit(request)).status).toBe('pending')
    expect(adapter.authorize).toHaveBeenCalledTimes(1)
    expect(adapter.post.mock.calls[1][0]).toEqual(adapter.post.mock.calls[0][0])
  })

  it('rejects an idempotency id replay with a changed transaction or command', async () => {
    await service.submit(submission())
    await expect(service.submit({ ...submission(), arkTxid: 'cc'.repeat(32) })).rejects.toThrow(/bound to another transaction/)
    await expect(service.submit({ ...submission(), command: { kind: 'subscribe', depositSats: '2000', minShares: '1' } }))
      .rejects.toThrow(/bound to another transaction/)
    expect(adapter.post).toHaveBeenCalledTimes(1)
  })

  it('does not confirm merely because the covenant service accepted the request', async () => {
    expect((await service.submit(submission())).status).toBe('pending')
    expect((await service.operation('capital-a')).receipt).toBeUndefined()
    expect(await repo.activeOperations()).toHaveLength(1)
  })

  it('rejects chain receipts referring to a different approved transaction', async () => {
    await service.submit(submission())
    adapter.verify.mockResolvedValueOnce({ status: 'confirmed', receipt: { arkTxid: 'cc'.repeat(32),
      consumedHead: initialHead, nextHead: { txid: 'dd'.repeat(32), vout: 0 }, observedAt: Date.now() } })
    await expect(service.operation('capital-a')).rejects.toThrow(/does not match/)
    expect((await repo.operation('capital-a'))?.status).toBe('pending')
  })

  it('releases a claim only after its matching chain receipt and rejects later use of that spent head', async () => {
    const request = submission(), nextHead = { txid: request.arkTxid, vout: 0 }
    await service.submit(request)
    adapter.verify.mockResolvedValueOnce({ status: 'confirmed', receipt: { arkTxid: request.arkTxid,
      consumedHead: initialHead, nextHead, observedAt: Date.now() } })
    expect((await service.operation(request.operationId)).status).toBe('confirmed')
    expect(await repo.activeOperations()).toHaveLength(0)
    adapter.read.mockResolvedValue({ ...snapshot(), outpoint: nextHead })
    await expect(service.submit(submission('stale-head'))).rejects.toThrow(/snapshot changed/)
  })

  it('refuses capital while a game owns the canonical coin and refuses unsafe expiry', async () => {
    adapter.read.mockResolvedValueOnce({ ...snapshot(), phase: 'funded' })
    await expect(service.submit(submission())).rejects.toThrow(/snapshot changed/)
    adapter.read.mockResolvedValueOnce({ ...snapshot(), readyForOperations: false, recoveryReason: 'Pool expiry requires recovery' })
    await expect(service.submit(submission())).rejects.toThrow(/expiry requires recovery/)
    expect(adapter.authorize).not.toHaveBeenCalled()
    expect(await repo.activeOperations()).toHaveLength(0)
  })

  it('keeps fee collection available near expiry while enforcing the compiled capital lifetime guard', async () => {
    adapter.read.mockResolvedValue({ ...snapshot(), expiresAt: Date.now() + 5 * 60_000, readyForOperations: false,
      recoveryReason: 'Pool renewal is required for new operations', accruedFeesSats: '2000' })
    expect((await service.publicState()).capabilities).toMatchObject({ subscribe: false, play: false, redeem: false })
    expect((await service.operatorPosition()).capabilities).toEqual({ redeem: false, sweepFees: true })
    await expect(service.prepare(quoteRequest())).rejects.toThrow(/renewal/)
    await expect(service.submit({ ...submission('near-expiry-exit'), command: { kind: 'redeem', burnShares: '1000', minSats: '1' } })).rejects.toThrow(/renewal/)
  })

  it('requires the full final deadline, actual CSV exit delay and buffer before game admission', async () => {
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now)
    const minimum = (6000 + 300) * 1000
    adapter.read.mockResolvedValue({ ...snapshot(), expiresAt: now + minimum })
    await expect(service.prepare(quoteRequest())).rejects.toThrow(/deadline and exit margin/)
    expect((await service.publicState()).capabilities).toMatchObject({ subscribe: false, play: false, redeem: true })
    adapter.read.mockResolvedValue({ ...snapshot(), expiresAt: now + minimum + 1 })
    expect((await service.prepare(quoteRequest())).finalAt).toBe(Math.floor(now / 1000) + 3600)
  })

  it('keeps public funding disabled until the fairness assumption is explicitly selected', async () => {
    config.delete('pool_fairness_assumption')
    const state = await service.publicState()
    expect(state.fairnessAssumption).toBe('unresolved')
    expect(state.capabilities).toMatchObject({ subscribe: false, redeem: true, play: false })
    await expect(service.submit(submission())).rejects.toThrow(/fairness assumptions/)
    await expect(service.prepare(quoteRequest())).rejects.toThrow(/fairness assumptions/)
    expect(adapter.authorize).not.toHaveBeenCalled()
    expect((await service.submit({ ...submission('exit-allowed'), command: { kind: 'redeem', burnShares: '1000', minSats: '1' } })).status).toBe('pending')
  })

  it('requires an explicit admin policy choice and preserves redemption after revocation', async () => {
    config.delete('pool_fairness_assumption')
    const publicApp = express().use(express.json()).use(createPoolRoutes(service))
    const adminApp = express().use(express.json()).use(createPoolAdminRoutes(service))
    expect((await request(publicApp).put('/api/admin/pool/policy').send({ fairnessAssumption: 'honest-operator' })).status).toBe(404)
    expect((await request(publicApp).get('/api/pool')).body.capabilities).toMatchObject({ subscribe: false, redeem: true, play: false })
    const enabled = await request(adminApp).put('/api/admin/pool/policy').send({ fairnessAssumption: 'honest-operator' })
    expect(enabled.status).toBe(200)
    expect(enabled.body).toMatchObject({ fairnessAssumption: 'honest-operator', capabilities: { subscribe: true, redeem: true, play: true } })
    const disabled = await request(adminApp).put('/api/admin/pool/policy').send({ fairnessAssumption: 'unresolved' })
    expect(disabled.status).toBe(200)
    expect(disabled.body).toMatchObject({ fairnessAssumption: 'unresolved', capabilities: { subscribe: false, redeem: true, play: false } })
    expect(config.get('pool_fairness_assumption')).toBe('unresolved')
    await expect(service.submit(submission())).rejects.toThrow(/fairness assumptions/)
    expect((await service.submit({ ...submission('revoked-policy-exit'), command: { kind: 'redeem', burnShares: '1000', minSats: '1' } })).status).toBe('pending')
  })

  it('pauses new wagers and contributions after a large daily pool loss while redemptions stay open', async () => {
    db.prepare(`INSERT INTO pool_games (game_id, request_id, request_hash, request_json, prepared_json, head_txid, head_vout,
      house_secret_hex, status, winner, created_at, expires_at) VALUES (?, ?, 'h', '{}', ?, ?, 0, '00', 'settled', 'player', ?, ?)`)
      .run('lost-big', 'lost-big', JSON.stringify({ houseStakeSats: '25000', playerStakeSats: '1000' }), 'dd'.repeat(32), Date.now(), Date.now())
    const state = await service.publicState()
    expect(state.capabilities).toMatchObject({ subscribe: false, play: false, redeem: true })
    expect(state.capabilities.reason).toMatch(/Paused after the pool lost 25000 sats in 24 hours/)
    await expect(service.prepare(quoteRequest())).rejects.toThrow(/Paused/)
    await expect(service.submit(submission('paused-capital'))).rejects.toThrow(/Paused/)
    expect((await service.submit({ ...submission('paused-exit'), command: { kind: 'redeem', burnShares: '1000', minSats: '1' } })).status).toBe('pending')
  })

  it.each([{}, { fairnessAssumption: 'independent' }, { fairnessAssumption: true },
    { fairnessAssumption: 'honest-operator', enableAll: true }])('rejects unsupported policy bodies without changing configuration: %p', async body => {
    const app = express().use(express.json()).use(createPoolAdminRoutes(service))
    expect((await request(app).put('/api/admin/pool/policy').send(body)).status).toBe(400)
    expect(config.get('pool_fairness_assumption')).toBe('honest-operator')
  })

  it('restores unresolved bootstrap inputs before allowing startup to complete and fails closed on invalid saved holds', async () => {
    const journal = { version: 1 as const, optionsHash: '99'.repeat(32), genesis: { arkTxid: 'ee'.repeat(32),
      arkTx: 'saved-genesis', checkpointTxs: ['saved-checkpoint'], inputOutpoints: [initialHead], submitted: true } }
    db.prepare("UPDATE pool_bootstrap SET status='unknown',journal_json=? WHERE id=1").run(JSON.stringify(journal))
    await service.restoreStartupHolds()
    expect(adapter.restoreBootstrapHolds).toHaveBeenCalledWith(journal)
    adapter.restoreBootstrapHolds.mockImplementationOnce(() => { throw new Error('Saved bootstrap inputs are invalid') })
    await expect(service.restoreStartupHolds()).rejects.toThrow(/inputs are invalid/)
  })

  it('never replaces saved issuance identities or input reservations while advancing bootstrap', async () => {
    db.prepare("UPDATE pool_bootstrap SET status='creating' WHERE id=1").run()
    const journal = { version: 1 as const, optionsHash: '99'.repeat(32), genesis: { arkTxid: 'ee'.repeat(32),
      arkTx: 'saved-genesis', checkpointTxs: ['saved-checkpoint'], inputOutpoints: [initialHead], submitted: true } }
    await repo.saveBootstrapJournal(journal)
    await expect(repo.saveBootstrapJournal({ ...journal, optionsHash: '88'.repeat(32) })).rejects.toThrow(/identity/)
    await expect(repo.saveBootstrapJournal({ ...journal, genesis: { ...journal.genesis, arkTxid: 'ff'.repeat(32) } })).rejects.toThrow(/financial intent/)
    await expect(repo.saveBootstrapJournal({ ...journal, genesis: { ...journal.genesis, inputOutpoints: [{ txid: 'ff'.repeat(32), vout: 1 }] } })).rejects.toThrow(/financial intent/)
    await expect(repo.saveBootstrapJournal({ ...journal, genesis: { ...journal.genesis, submitted: false } })).rejects.toThrow(/financial intent/)
    const confirmed = { ...journal, genesis: { ...journal.genesis, confirmed: true } }
    await repo.saveBootstrapJournal(confirmed)
    await expect(repo.saveBootstrapJournal(journal)).rejects.toThrow(/financial intent/)
    expect(JSON.parse((await repo.bootstrap())!.journal_json!)).toEqual(confirmed)
  })

  it('rejects a concurrent bootstrap journal writer that lost the exact saved-plan compare-and-swap', async () => {
    db.prepare("UPDATE pool_bootstrap SET status='creating' WHERE id=1").run()
    const results = await Promise.allSettled([repo.saveBootstrapJournal({ version: 1, optionsHash: '11'.repeat(32) }),
      repo.saveBootstrapJournal({ version: 1, optionsHash: '22'.repeat(32) })])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(JSON.parse((await repo.bootstrap())!.journal_json!).optionsHash).toBe('11'.repeat(32))
  })

  it('quotes actual founder share coins and keeps operator exits independent of the fairness policy', async () => {
    config.delete('pool_fairness_assumption')
    adapter.read.mockResolvedValue({ ...snapshot(), accruedFeesSats: '2000', valueSats: '102330' })
    const position = await service.operatorPosition()
    expect(position).toMatchObject({ totalShares: '100000000000', totalEquitySats: '100000', feeSweepSats: '2000',
      coins: [{ shares: '100000000000', fullRedemptionPayoutSats: '100330' }], capabilities: { redeem: true, sweepFees: true } })
    expect((await service.operatorAction({ operationId: 'operator-fees', expectedHead: initialHead, command: { kind: 'sweepFees' } })).status).toBe('pending')
  })

  it('persists an operator draft before POST, retains uncertain reservations and retries the exact saved packet', async () => {
    const action: PoolOperatorActionRequest = { operationId: 'founder-redeem', expectedHead: initialHead,
      memberOutpoint: { txid: 'dd'.repeat(32), vout: 1 }, command: { kind: 'redeem', burnShares: '1000', minSats: '1' } }
    adapter.post.mockImplementationOnce(async relay => {
      const saved = (await repo.operation(action.operationId))!
      expect(JSON.parse(saved.operator_request_json!)).toEqual(action)
      expect(JSON.parse(saved.relay_json!)).toEqual(relay)
      throw new Error('Operator response lost')
    })
    expect((await service.operatorAction(action)).status).toBe('unknown')
    const draft = await adapter.operatorAction.mock.results[0].value
    expect(draft.reservation.release).not.toHaveBeenCalled()
    expect((await service.operatorAction(action)).status).toBe('pending')
    expect(adapter.operatorAction).toHaveBeenCalledTimes(1)
    expect(adapter.post.mock.calls[1][0]).toEqual(adapter.post.mock.calls[0][0])
    await expect(service.operatorAction({ ...action, command: { ...action.command, minSats: '2' } })).rejects.toThrow(/another operator action/)
    expect(draft.reservation.release).not.toHaveBeenCalled()
  })

  it('rebuilds pending founder reservations on restart and releases them only after exact chain proof', async () => {
    const action: PoolOperatorActionRequest = { operationId: 'founder-restart', expectedHead: initialHead,
      memberOutpoint: { txid: 'dd'.repeat(32), vout: 1 }, command: { kind: 'redeem', burnShares: '1000', minSats: '1' } }
    await service.operatorAction(action)
    const saved = (await repo.operation(action.operationId))!
    const restarted = new PoolService(deps, repo, adapter)
    await restarted.restoreStartupHolds()
    expect(adapter.restoreOperationHolds).toHaveBeenCalledWith(JSON.parse(saved.request_json))
    const restored = adapter.restoreOperationHolds.mock.results[0].value
    expect((await restarted.operation(action.operationId)).status).toBe('pending')
    expect(restored.release).not.toHaveBeenCalled()
    adapter.verify.mockResolvedValue({ status: 'confirmed', receipt: { arkTxid: saved.ark_txid,
      consumedHead: initialHead, nextHead: { txid: saved.ark_txid, vout: 0 }, observedAt: Date.now() } })
    expect((await restarted.operation(action.operationId)).status).toBe('confirmed')
    await restarted.operation(action.operationId)
    expect(restored.release).toHaveBeenCalledTimes(1)
  })

  it('releases a locally signed losing draft without replacing the operation that won the canonical head', async () => {
    const action: PoolOperatorActionRequest = { operationId: 'losing-founder', expectedHead: initialHead,
      memberOutpoint: { txid: 'dd'.repeat(32), vout: 1 }, command: { kind: 'redeem', burnShares: '1000', minSats: '1' } }
    const defaultBuild = adapter.operatorAction.getMockImplementation()!
    adapter.operatorAction.mockImplementationOnce(async (...args) => {
      await repo.claimOperation(submission('winning-member'), 'winning-request')
      return defaultBuild(...args)
    })
    await expect(service.operatorAction(action)).rejects.toThrow(/owns this pool head/)
    const draft = await adapter.operatorAction.mock.results[0].value
    expect(draft.reservation.release).toHaveBeenCalledTimes(1)
    expect(await repo.operation(action.operationId)).toBeUndefined()
    expect((await repo.operation('winning-member'))?.status).toBe('submitting')
    expect(adapter.post).not.toHaveBeenCalled()
  })

  it('never posts a terminalized operator draft and releases its resolved reservation', async () => {
    const action: PoolOperatorActionRequest = { operationId: 'terminal-founder', expectedHead: initialHead,
      memberOutpoint: { txid: 'dd'.repeat(32), vout: 1 }, command: { kind: 'redeem', burnShares: '1000', minSats: '1' } }
    jest.spyOn(repo, 'saveRelay').mockImplementationOnce(async operationId => {
      await repo.updateOperation(operationId, 'conflict')
      return false
    })
    await expect(service.operatorAction(action)).rejects.toThrow(/durable broadcast permission/)
    const draft = await adapter.operatorAction.mock.results[0].value
    expect(draft.reservation.release).toHaveBeenCalledTimes(1)
    expect(adapter.post).not.toHaveBeenCalled()
  })

  it('keeps operator signing and fee withdrawal off the public router', async () => {
    config.delete('pool_fairness_assumption')
    adapter.read.mockResolvedValue({ ...snapshot(), accruedFeesSats: '2000', valueSats: '102330' })
    const publicApp = express().use(express.json()).use(createPoolRoutes(service))
    const adminApp = express().use(express.json()).use(createPoolAdminRoutes(service))
    expect((await request(publicApp).get('/api/admin/pool/position')).status).toBe(404)
    expect((await request(publicApp).post('/api/admin/pool/fees').send({ operationId: 'no-public-fees', expectedHead: initialHead })).status).toBe(404)
    expect((await request(publicApp).post('/api/admin/pool/redeem').send({})).status).toBe(404)
    expect((await request(adminApp).get('/api/admin/pool/position')).body.capabilities).toEqual({ redeem: true, sweepFees: true })
    const result = await request(adminApp).post('/api/admin/pool/fees').send({ operationId: 'admin-fees', expectedHead: initialHead })
    expect(result.status).toBe(202)
    expect(result.body.status).toBe('pending')
    expect(adapter.operatorAction.mock.calls[0][1]).toEqual({ operationId: 'admin-fees', expectedHead: initialHead, command: { kind: 'sweepFees' } })
    expect((await request(adminApp).get('/api/admin/pool/operations/admin-fees')).body).toMatchObject({ operationId: 'admin-fees', status: 'pending' })
    expect((await request(publicApp).get('/api/admin/pool/operations/admin-fees')).status).toBe(404)
  })

  it('rejects stale heads, busy pools and sub-dust fees before building an operator transaction', async () => {
    await expect(service.operatorAction({ operationId: 'dust-fees', expectedHead: initialHead, command: { kind: 'sweepFees' } })).rejects.toThrow(/unavailable/)
    adapter.read.mockResolvedValue({ ...snapshot(), phase: 'funded', accruedFeesSats: '2000' })
    await expect(service.operatorAction({ operationId: 'busy-fees', expectedHead: initialHead, command: { kind: 'sweepFees' } })).rejects.toThrow(/active game/)
    adapter.read.mockResolvedValue({ ...snapshot(), accruedFeesSats: '2000', outpoint: { txid: 'ff'.repeat(32), vout: 0 } })
    await expect(service.operatorAction({ operationId: 'stale-fees', expectedHead: initialHead, command: { kind: 'sweepFees' } })).rejects.toThrow(/head changed/)
    expect(adapter.operatorAction).not.toHaveBeenCalled()
  })

  it('reserves a renewal sponsor and persists the exact proof before any external batch action', async () => {
    const fixture = renewalFixture()
    adapter.read.mockResolvedValue({ ...snapshot(), expiresAt: Date.now() + 6500_000 })
    let sponsorHeld = false
    const reservation = { outpoints: [{ txid: 'ad'.repeat(32), vout: 0 }], release: jest.fn(() => { sponsorHeld = false }) }
    adapter.reserveRenewalSponsor.mockImplementationOnce(async () => { sponsorHeld = true; return { reservation } })
    adapter.renew.mockImplementationOnce(async (_descriptor, persistence) => {
      expect(sponsorHeld).toBe(true)
      const claim = (await repo.activeRenewal())!
      expect(claim.renewal_journal_json).toBeNull()
      expect(await repo.claimOperation(submission('racing-member'), 'racing')).toBe(false)
      await persistence.save(fixture.journal)
      expect(JSON.parse((await repo.operation(claim.operation_id))!.renewal_journal_json!)).toEqual(fixture.journal)
      return fixture.receipt
    })
    await service.maintain()
    expect(reservation.release).toHaveBeenCalledTimes(1)
    expect(await repo.activeRenewal()).toBeUndefined()
    const saved = db.prepare("SELECT * FROM pool_operations WHERE operation_kind='renewal'").get() as { status: string; renewal_receipt_json: string }
    expect(saved.status).toBe('confirmed')
    expect(JSON.parse(saved.renewal_receipt_json).intentId).toBeNull()
  })

  it('does not renew a healthy head or compete with a submitted member operation', async () => {
    await service.maintain()
    expect(adapter.renew).not.toHaveBeenCalled()
    adapter.read.mockResolvedValue({ ...snapshot(), expiresAt: Date.now() + 6500_000 })
    await repo.claimOperation(submission('existing-member'), 'existing')
    await service.maintain()
    expect(adapter.reserveRenewalSponsor).not.toHaveBeenCalled()
    expect(adapter.renew).not.toHaveBeenCalled()
  })

  it('retains unknown renewal claims across restart and never replaces their saved proof', async () => {
    const fixture = renewalFixture()
    adapter.read.mockResolvedValue({ ...snapshot(), expiresAt: Date.now() + 6500_000 })
    adapter.renew.mockImplementationOnce(async (_descriptor, persistence) => {
      await persistence.save(fixture.journal)
      throw new Error('Registration response lost')
    })
    await expect(service.maintain()).rejects.toThrow(/response lost/)
    const claim = (await repo.activeRenewal())!
    expect((await service.publicState()).renewal).toMatchObject({ status: 'recovery', operationId: claim.operation_id })
    const restarted = new PoolService(deps, repo, adapter)
    await restarted.restoreStartupHolds()
    expect(adapter.restoreRenewalHolds).toHaveBeenCalledWith(fixture.journal)
    adapter.renew.mockImplementationOnce(async (_descriptor, persistence) => {
      expect(await persistence.load()).toEqual(fixture.journal)
      throw new Error('Saved signing session needs recovery')
    })
    await expect(restarted.maintain()).rejects.toThrow(/signing session/)
    expect(adapter.reserveRenewalSponsor).toHaveBeenCalledTimes(1)
    expect((await repo.activeRenewal())?.operation_id).toBe(claim.operation_id)
    expect(JSON.parse((await repo.activeRenewal())!.renewal_journal_json!)).toEqual(fixture.journal)
    await expect(restarted.submit(submission('blocked-by-renewal'))).rejects.toThrow(/owns this pool head/)
  })

  it('safely fences an interrupted renewal with no durable external intent', async () => {
    await repo.claimRenewal('unsigned-renewal', initialHead)
    await service.restoreStartupHolds()
    expect((await repo.operation('unsigned-renewal'))?.status).toBe('rejected')
    const fixture = renewalFixture()
    await expect(repo.saveRenewalJournal('unsigned-renewal', fixture.journal, fixture.receipt.proofTxid)).rejects.toThrow(/permission/)
    expect(await repo.claimOperation(submission('after-fence'), 'after-fence')).toBe(true)
    expect(adapter.renew).not.toHaveBeenCalled()
  })

  it('uses revision compare-and-swap before a renewal session exposes nonces or partial signatures', async () => {
    await repo.claimRenewal('session-renewal', initialHead)
    expect(await repo.saveRenewalSession('session-renewal', { version: 1, revision: 0, binding: 'first' }, null)).toBe(true)
    expect(await repo.saveRenewalSession('session-renewal', { version: 1, revision: 0, binding: 'second' }, null)).toBe(false)
    const results = await Promise.all([repo.saveRenewalSession('session-renewal', { version: 1, revision: 1, binding: 'first' }, 0),
      repo.saveRenewalSession('session-renewal', { version: 1, revision: 1, binding: 'conflicting' }, 0)])
    expect(results).toEqual([true, false])
    expect(JSON.parse((await repo.operation('session-renewal'))!.renewal_session_json!)).toEqual({ version: 1, revision: 1, binding: 'first' })
  })

  it('preserves the registered intent and immutable event prefix in the renewal replay journal', async () => {
    const fixture = renewalFixture()
    await repo.claimRenewal('replay-renewal', initialHead)
    await repo.saveRenewalJournal('replay-renewal', { ...fixture.journal, intentId: 'registered-id', status: 'registered' }, fixture.receipt.proofTxid)
    const start = { version: 1, revision: 0, intentId: 'registered-id', events: [] as string[] }
    expect(await repo.saveRenewalReplay('replay-renewal', start, null)).toBe(true)
    expect(await repo.saveRenewalReplay('replay-renewal', { ...start, revision: 1, events: ['first-event'] }, 0)).toBe(true)
    await expect(repo.saveRenewalReplay('replay-renewal', { ...start, revision: 2, intentId: 'another-id', events: ['first-event', 'second'] }, 1)).rejects.toThrow(/registered intent/)
    await expect(repo.saveRenewalReplay('replay-renewal', { ...start, revision: 2, events: ['changed-first-event'] }, 1)).rejects.toThrow(/saved history/)
    expect(await repo.saveRenewalReplay('replay-renewal', { ...start, revision: 2, events: ['first-event', 'second'] }, 1)).toBe(true)
  })

  it('uses the authenticated network recovery margin for capital and game readiness', async () => {
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now)
    adapter.read.mockResolvedValue({ ...snapshot(), requiredLifetimeSeconds: 90300, recoveryMarginSeconds: 86700,
      expiresAt: now + 90_000_000, accruedFeesSats: '2000' })
    expect((await service.publicState()).capabilities).toMatchObject({ subscribe: false, redeem: false, play: false })
    expect((await service.operatorPosition()).capabilities).toEqual({ redeem: false, sweepFees: true })
    await expect(service.prepare(quoteRequest())).rejects.toThrow(/deadline and exit margin/)
    adapter.read.mockResolvedValue({ ...snapshot(), requiredLifetimeSeconds: 90300, recoveryMarginSeconds: 86700,
      expiresAt: now + 90_600_001 })
    expect((await service.publicState()).capabilities).toMatchObject({ subscribe: true, redeem: true, play: true })
    expect((await service.prepare(quoteRequest())).finalAt).toBe(Math.floor(now / 1000) + 3600)
  })

  it('never marks an unrelated batch proof as a completed renewal', async () => {
    const fixture = renewalFixture()
    adapter.read.mockResolvedValue({ ...snapshot(), expiresAt: Date.now() + 6500_000 })
    adapter.renew.mockImplementationOnce(async (_descriptor, persistence) => {
      await persistence.save(fixture.journal)
      return { ...fixture.receipt, proofTxid: 'ea'.repeat(32) }
    })
    await expect(service.maintain()).rejects.toThrow(/does not match/)
    expect((await repo.activeRenewal())?.status).toBe('unknown')
    const selected = await adapter.reserveRenewalSponsor.mock.results[0].value
    expect(selected.reservation.release).not.toHaveBeenCalled()
  })

  it('atomically fences every founder source while leaving the canonical head available', async () => {
    const source = operatorStageFixture().funding.inputOutpoints[0]
    const plan = { inputOutpoints: [source], address: 'same-wallet', outputSats: '330', maximumFeeSats: '5000' }
    expect(await repo.claimInputRenewal('native-founder', plan)).toBe(true)
    const stage = operatorStageFixture()
    expect(await repo.claimOperation(submission('racing-founder'), 'founder', undefined, undefined, stage)).toBe(false)
    expect(await repo.operation('racing-founder')).toBeUndefined()
    expect(await repo.claimInputRenewal('overlapping-batch', { ...plan,
      inputOutpoints: [{ txid: '12'.repeat(32), vout: 0 }, source] })).toBe(false)
    expect(await repo.claimedWalletInputs()).toEqual([source])
    expect(await repo.claimOperation(submission('independent-member'), 'member')).toBe(true)
    await repo.updateOperation('native-founder', 'rejected')
    expect(await repo.claimedWalletInputs()).toEqual([])
    expect(await repo.claimInputRenewal('after-terminal', plan)).toBe(true)
  })

  it('persists founder source claims and exact proof before native batch registration', async () => {
    const fixture = inputRenewalFixture(), release = jest.fn()
    const reservation = { outpoints: fixture.journal.sources.map(({ txid, vout }) => ({ txid, vout })), release }
    adapter.prepareInputRenewal.mockResolvedValueOnce({ plan: fixture.plan, reservation })
    adapter.renewInputs.mockImplementationOnce(async (persistence, plan, _signal, held) => {
      expect(plan).toEqual(fixture.plan)
      expect(held).toBe(reservation)
      expect(release).not.toHaveBeenCalled()
      expect(await repo.claimedWalletInputs()).toEqual(reservation.outpoints)
      await persistence.save(fixture.journal)
      expect(await persistence.load()).toEqual(fixture.journal)
      expect(await persistence.saveSession({ version: 1, revision: 0 } as never, null)).toBe(true)
      expect(await persistence.saveSession({ version: 1, revision: 0 } as never, null)).toBe(false)
      expect(await persistence.saveReplay({ version: 1, revision: 0, intentId: fixture.journal.intentId!, events: [] }, null)).toBe(true)
      return fixture.receipt
    })
    await service.maintain()
    expect(release).toHaveBeenCalledTimes(1)
    expect(await repo.activeInputRenewals()).toEqual([])
    expect(await repo.claimedWalletInputs()).toEqual([])
    expect((await service.operatorPosition()).inputRenewal).toMatchObject({ status: 'idle', pending: 0 })
  })

  it('retains an ambiguous founder batch across restart without replacing sources or blocking members', async () => {
    const fixture = inputRenewalFixture(), release = jest.fn()
    adapter.prepareInputRenewal.mockResolvedValueOnce({ plan: fixture.plan,
      reservation: { outpoints: fixture.journal.sources, release } })
    adapter.renewInputs.mockImplementationOnce(async persistence => { await persistence.save(fixture.journal); throw new Error('Native registration response lost') })
    await expect(service.maintain()).rejects.toThrow(/response lost/)
    const claim = (await repo.activeInputRenewals())[0]
    expect((await service.operatorPosition()).inputRenewal).toMatchObject({ status: 'recovery', pending: 1 })
    expect(release).not.toHaveBeenCalled()
    const restarted = new PoolService(deps, repo, adapter)
    await restarted.restoreStartupHolds()
    expect(adapter.restoreInputRenewalHolds).toHaveBeenCalledWith(fixture.journal)
    adapter.renewInputs.mockImplementationOnce(async (persistence, plan) => {
      expect(plan).toBeUndefined()
      expect(await persistence.load()).toEqual(fixture.journal)
      throw new Error('Awaiting the saved batch signing events')
    })
    await expect(restarted.maintain()).rejects.toThrow(/saved batch/)
    expect(adapter.prepareInputRenewal).toHaveBeenCalledTimes(1)
    expect((await repo.activeInputRenewals())[0].operation_id).toBe(claim.operation_id)
    expect((await restarted.submit(submission('member-during-founder-renewal'))).status).toBe('pending')
    await expect(restarted.operation(claim.operation_id)).rejects.toThrow(/maintenance status/)
    await expect(repo.saveInputRenewalJournal(claim.operation_id, { ...fixture.journal, registrationAttempted: false }, fixture.receipt.proofTxid)).rejects.toThrow(/registered intent/)
  })

  it('fences pre-registration founder crashes so a stale worker cannot send its late proof', async () => {
    const fixture = inputRenewalFixture(), request = { inputOutpoints: fixture.journal.sources.map(({ txid, vout }) => ({ txid, vout })),
      address: fixture.journal.address, outputSats: fixture.journal.outputSats, maximumFeeSats: fixture.journal.maximumFeeSats }
    await repo.claimInputRenewal('not-registered', request)
    await repo.saveInputRenewalJournal('not-registered', { ...fixture.journal, registrationAttempted: false, intentId: undefined }, fixture.receipt.proofTxid)
    await service.restoreStartupHolds()
    expect((await repo.operation('not-registered'))?.status).toBe('rejected')
    expect(adapter.restoreInputRenewalHolds).not.toHaveBeenCalled()
    expect(await repo.claimedWalletInputs()).toEqual([])
    await expect(repo.saveInputRenewalJournal('not-registered', fixture.journal, fixture.receipt.proofTxid)).rejects.toThrow(/permission/)
    expect(await repo.claimInputRenewal('replacement-only-after-fence', request)).toBe(true)
  })

  it('keeps founder input claims when an unrelated completion receipt is returned', async () => {
    const fixture = inputRenewalFixture(), release = jest.fn()
    adapter.prepareInputRenewal.mockResolvedValueOnce({ plan: fixture.plan, reservation: { outpoints: fixture.journal.sources, release } })
    adapter.renewInputs.mockImplementationOnce(async persistence => {
      await persistence.save(fixture.journal)
      return { ...fixture.receipt, proofTxid: 'ab'.repeat(32) }
    })
    await expect(service.maintain()).rejects.toThrow(/receipt does not match/)
    expect((await repo.activeInputRenewals())[0].status).toBe('unknown')
    expect(await repo.claimedWalletInputs()).toHaveLength(1)
    expect(release).not.toHaveBeenCalled()
  })

  it('abandons a lapsed renewal intent, then renews an expired head on the next tick', async () => {
    const fixture = renewalFixture(), lapsed = () => Object.assign(new Error('Saved pool renewal intent lapsed'), { code: 'POOL_RENEWAL_ABANDONED' })
    adapter.read.mockResolvedValue({ ...snapshot(), expiresAt: Date.now() - 60_000, readyForOperations: false, admissionClosesAt: null })
    adapter.renew.mockImplementationOnce(async (_descriptor, persistence) => { await persistence.save(fixture.journal); throw lapsed() })
    await expect(service.maintain()).rejects.toThrow(/lapsed/)
    expect(await repo.activeRenewal()).toBeUndefined()
    expect(db.prepare("SELECT status, error FROM pool_operations WHERE operation_kind='renewal'").get()).toEqual({ status: 'rejected', error: 'Saved pool renewal intent lapsed' })
    adapter.renew.mockImplementationOnce(async (_descriptor, persistence) => { await persistence.save(fixture.journal); return fixture.receipt })
    await service.maintain()
    expect(db.prepare("SELECT status FROM pool_operations WHERE operation_kind='renewal' ORDER BY created_at DESC, rowid DESC").get()).toEqual({ status: 'confirmed' })
  })

  it('abandons a lapsed founder renewal, releases its sources and clears recovery status', async () => {
    const fixture = inputRenewalFixture(), release = jest.fn()
    adapter.prepareInputRenewal.mockResolvedValueOnce({ plan: fixture.plan, reservation: { outpoints: fixture.journal.sources, release } })
    adapter.renewInputs.mockImplementationOnce(async persistence => { await persistence.save(fixture.journal); throw new Error('Native registration response lost') })
    await expect(service.maintain()).rejects.toThrow(/response lost/)
    adapter.renewInputs.mockImplementationOnce(async () => { throw Object.assign(new Error('Saved wallet input renewal lapsed'), { code: 'POOL_RENEWAL_ABANDONED' }) })
    await expect(service.maintain()).rejects.toThrow(/lapsed/)
    expect(release).toHaveBeenCalledTimes(1)
    expect(await repo.activeInputRenewals()).toEqual([])
    expect(await repo.claimedWalletInputs()).toEqual([])
    expect((await service.operatorPosition()).inputRenewal).toMatchObject({ status: 'idle', pending: 0 })
  })

  it('atomically saves founder staging and the final pool packet before submitting either', async () => {
    const action: PoolOperatorActionRequest = { operationId: 'staged-founder', expectedHead: initialHead,
      memberOutpoint: { txid: 'dd'.repeat(32), vout: 1 }, command: { kind: 'redeem', burnShares: '1000', minSats: '1' } }
    const stage = operatorStageFixture(), build = adapter.operatorAction.getMockImplementation()!
    adapter.operatorAction.mockImplementationOnce(async (...args) => ({ ...await build(...args), stage }))
    adapter.submitOperatorStage.mockImplementationOnce(async (_descriptor, saved, save) => {
      const row = (await repo.operation(action.operationId))!
      expect(JSON.parse(row.operator_stage_json!)).toEqual(stage)
      expect(JSON.parse(row.request_json).arkTxid).toBe(submission().arkTxid)
      expect(row.relay_json).not.toBeNull()
      expect(adapter.post).not.toHaveBeenCalled()
      await save({ ...saved, funding: { ...saved.funding, submitted: true, confirmed: true } })
      return 'funded'
    })
    expect((await service.operatorAction(action)).status).toBe('pending')
    expect(adapter.post).toHaveBeenCalledTimes(1)
  })

  it('restores both original and staged founder holds after an uncertain staging response', async () => {
    const action: PoolOperatorActionRequest = { operationId: 'staged-founder-restart', expectedHead: initialHead,
      memberOutpoint: { txid: 'dd'.repeat(32), vout: 1 }, command: { kind: 'redeem', burnShares: '1000', minSats: '1' } }
    const stage = operatorStageFixture(), build = adapter.operatorAction.getMockImplementation()!
    adapter.operatorAction.mockImplementationOnce(async (...args) => ({ ...await build(...args), stage }))
    adapter.submitOperatorStage.mockImplementationOnce(async (_descriptor, saved, save) => {
      await save({ ...saved, funding: { ...saved.funding, submitted: true } })
      throw new Error('Staging response lost')
    })
    await expect(service.operatorAction(action)).rejects.toThrow(/response lost/)
    expect((await repo.operation(action.operationId))?.status).toBe('unknown')
    const first = await adapter.operatorAction.mock.results[0].value
    expect(first.reservation.release).not.toHaveBeenCalled()
    const restarted = new PoolService(deps, repo, adapter)
    await restarted.restoreStartupHolds()
    expect(adapter.restoreOperatorStageHolds).toHaveBeenCalledWith({ ...stage, funding: { ...stage.funding, submitted: true } })
    adapter.submitOperatorStage.mockImplementationOnce(async (_descriptor, saved, save) => {
      await save({ ...saved, funding: { ...saved.funding, confirmed: true } })
      return 'funded'
    })
    await restarted.reconcile()
    expect(adapter.operatorAction).toHaveBeenCalledTimes(1)
    expect(adapter.post).toHaveBeenCalledTimes(1)
    expect((await repo.operation(action.operationId))?.status).toBe('pending')
  })

  it('returns staged founder shares before releasing a head claim consumed by a different transaction', async () => {
    const action: PoolOperatorActionRequest = { operationId: 'staged-conflict', expectedHead: initialHead,
      memberOutpoint: { txid: 'dd'.repeat(32), vout: 1 }, command: { kind: 'redeem', burnShares: '1000', minSats: '1' } }
    const stage = operatorStageFixture(), build = adapter.operatorAction.getMockImplementation()!
    adapter.operatorAction.mockImplementationOnce(async (...args) => ({ ...await build(...args), stage }))
    adapter.submitOperatorStage.mockImplementationOnce(async (_descriptor, saved, save) => {
      await save({ ...saved, funding: { ...saved.funding, submitted: true } })
      throw new Error('Unknown stage acceptance')
    })
    await expect(service.operatorAction(action)).rejects.toThrow(/Unknown stage/)
    const draft = await adapter.operatorAction.mock.results[0].value
    adapter.verify.mockResolvedValue({ status: 'conflict' })
    adapter.submitOperatorStage.mockRejectedValueOnce(new Error('Refund service offline'))
    await expect(service.operation(action.operationId)).rejects.toThrow(/offline/)
    expect(draft.reservation.release).not.toHaveBeenCalled()
    expect((await repo.operation(action.operationId))?.status).toBe('unknown')
    adapter.submitOperatorStage.mockImplementationOnce(async (_descriptor, saved, save, refundOnly) => {
      expect(refundOnly).toBe(true)
      await save({ ...saved, funding: { ...saved.funding, confirmed: true }, refund: { arkTxid: 'ae'.repeat(32),
        body: { arkTx: 'approved-owner-refund', checkpointTxs: ['refund-checkpoint'] } }, refunded: true })
      return 'refunded'
    })
    expect((await service.operation(action.operationId)).status).toBe('conflict')
    expect(draft.reservation.release).toHaveBeenCalledTimes(1)
    expect(adapter.post).not.toHaveBeenCalled()
  })

  it('fences an expired unsubmitted founder stage without funding it and rejects late submissions', async () => {
    const action: PoolOperatorActionRequest = { operationId: 'expired-stage', expectedHead: initialHead,
      memberOutpoint: { txid: 'dd'.repeat(32), vout: 1 }, command: { kind: 'redeem', burnShares: '1000', minSats: '1' } }
    const stage = operatorStageFixture(), build = adapter.operatorAction.getMockImplementation()!
    stage.authorization.validUntil = Math.floor(Date.now() / 1000) - 1
    adapter.operatorAction.mockImplementationOnce(async (...args) => ({ ...await build(...args), stage }))
    adapter.submitOperatorStage.mockResolvedValueOnce('unsubmitted')
    expect((await service.operatorAction(action)).status).toBe('rejected')
    const draft = await adapter.operatorAction.mock.results[0].value
    expect(draft.reservation.release).toHaveBeenCalledTimes(1)
    expect(adapter.post).not.toHaveBeenCalled()
    await expect(repo.saveOperatorStage(action.operationId, { ...stage, funding: { ...stage.funding, submitted: true } })).rejects.toThrow(/permission/)
  })

  it('quotes the actual effective edge, binds request replay and never publishes its private house reveal', async () => {
    const prepared = await service.prepare(quoteRequest())
    expect(prepared.economics.effectiveHouseEdgeBps).toEqual({ numerator: '150', denominator: '1' })
    expect(prepared.houseStakeSats).toBe('9700')
    expect(await service.prepare(quoteRequest())).toEqual(prepared)
    expect(JSON.stringify(prepared)).not.toContain((await repo.game(prepared.gameId))!.house_secret_hex)
    await expect(service.prepare({ ...quoteRequest(), playerStakeSats: '9000' })).rejects.toThrow(/different game terms/)
  })

  it('allows competing unsigned quotes but authorizes only one game for the same head', async () => {
    const [first, second] = await Promise.all([service.prepare(quoteRequest()), service.prepare({ ...quoteRequest(), requestId: 'quote-b' })])
    expect(first.gameId).not.toBe(second.gameId)
    const one = { ...submission('opening-a'), command: { kind: 'openGame' as const, gameId: first.gameId } }
    const two = { ...submission('opening-b'), arkTxid: 'cc'.repeat(32), command: { kind: 'openGame' as const, gameId: second.gameId } }
    const results = await Promise.allSettled([service.submit(one), service.submit(two)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(adapter.authorize).toHaveBeenCalledTimes(1)
    expect(await repo.activeOperations()).toHaveLength(1)
  })

  it('expires only unsigned quotes and cannot authorize them after expiry', async () => {
    const prepared = await service.prepare(quoteRequest())
    await repo.expireQuotes(prepared.expiresAt)
    const request = { ...submission(), command: { kind: 'openGame' as const, gameId: prepared.gameId } }
    await expect(service.submit(request)).rejects.toThrow(/expired before authorization/)
    expect(adapter.authorize).not.toHaveBeenCalled()
    expect(adapter.post).not.toHaveBeenCalled()
  })

  it('enforces the configured minimum effective edge instead of assuming the stake discount is that edge', async () => {
    await expect(service.prepare({ ...quoteRequest(), oddsN: 100, oddsTarget: 95 })).rejects.toThrow(/minimum effective house edge/)
    expect(await repo.activeGames()).toHaveLength(0)
  })

  it('rejects contract dust and accounting bounds before publishing game commitments', async () => {
    await expect(service.prepare({ ...quoteRequest(), playerStakeSats: '329' })).rejects.toThrow(/Player stake/)
    await expect(service.prepare({ ...quoteRequest(), playerStakeSats: '330' })).rejects.toThrow(/house stake below/)
    adapter.read.mockResolvedValue({ ...snapshot(), carriedLossSats: '999999' })
    await expect(service.prepare(quoteRequest())).rejects.toThrow(/accounting limits/)
    adapter.read.mockResolvedValue({ ...snapshot(), accruedFeesSats: '999999' })
    await expect(service.prepare(quoteRequest())).rejects.toThrow(/accounting limits/)
    expect(await repo.activeGames()).toHaveLength(0)
  })

  it('resumes uncertain bootstrap only with its saved exact plan and never publishes an unverified descriptor', async () => {
    db.prepare('DELETE FROM pool_bootstrap').run()
    const journal = { version: 1 as const, optionsHash: 'same-options', genesis: { arkTxid: 'ee'.repeat(32),
      arkTx: 'persisted-genesis', checkpointTxs: ['persisted-checkpoint'], inputOutpoints: [initialHead], submitted: true } }
    adapter.bootstrap.mockImplementationOnce(async (_request, persistence) => {
      await persistence.save(journal)
      throw new Error('asset issue response lost')
    })
    const request = { name: 'Community pool', initialNavSats: '100000' }
    await expect(service.bootstrap(request)).rejects.toThrow(/needs reconciliation/)
    expect(adapter.bootstrap).toHaveBeenCalledTimes(1)
    expect(await repo.bootstrap()).toMatchObject({ status: 'unknown', descriptor_json: null })
    expect((await service.publicState()).status).toBe('unavailable')
    adapter.bootstrap.mockImplementationOnce(async (_request, persistence) => {
      expect(await persistence.load()).toEqual(journal)
      return { descriptor, snapshot: snapshot() }
    })
    expect((await service.bootstrap(request)).status).toBe('ready')
    expect(adapter.bootstrap).toHaveBeenCalledTimes(2)
  })

  it('does not fence setup when funding fails before any external transaction plan exists', async () => {
    db.prepare('DELETE FROM pool_bootstrap').run()
    adapter.bootstrap.mockRejectedValueOnce(new Error('Insufficient operator funds'))
    await expect(service.bootstrap({ name: 'Unfunded pool', initialNavSats: '100000' })).rejects.toThrow(/was not submitted/)
    expect(await repo.bootstrap()).toBeUndefined()
  })

  it('retains a bootstrap journal when its save committed but the acknowledgement failed', async () => {
    db.prepare('DELETE FROM pool_bootstrap').run()
    const save = repo.saveBootstrapJournal.bind(repo), externalPost = jest.fn()
    jest.spyOn(repo, 'saveBootstrapJournal').mockImplementationOnce(async journal => {
      await save(journal); throw new Error('journal acknowledgement lost')
    })
    adapter.bootstrap.mockImplementationOnce(async (_request, persistence) => {
      await persistence.save({ version: 1, optionsHash: 'bound-options' })
      externalPost()
      return { descriptor, snapshot: snapshot() }
    })
    await expect(service.bootstrap({ name: 'Community pool', initialNavSats: '100000' })).rejects.toThrow(/needs reconciliation/)
    expect(externalPost).not.toHaveBeenCalled()
    expect(await repo.bootstrap()).toMatchObject({ status: 'unknown', descriptor_json: null })
    expect(JSON.parse((await repo.bootstrap())!.journal_json!)).toMatchObject({ optionsHash: 'bound-options' })
  })

  it.each([false, true])('recovers an internal resolution after crashing before POST, saved relay: %s', async savedRelay => {
    const quote = await service.prepare(quoteRequest())
    const request: PoolSubmitRequest = { ...submission(`settle:${quote.gameId}`), expectedHead: { txid: 'cc'.repeat(32), vout: 0 },
      command: { kind: 'settleGame', gameId: quote.gameId, playerSecretHex: `00${'22'.repeat(16)}`, houseSecretHex: `01${'33'.repeat(16)}` } }
    await repo.claimOperation(request, 'persisted-private-request-hash', quote.gameId)
    const relay = { arkTxid: request.arkTxid, body: { arkTx: 'persisted-resolution', checkpointTxs: ['exact-cp'] } }
    if (savedRelay) await repo.saveRelay(request.operationId, relay)
    adapter.post.mockRejectedValueOnce(new Error('first response lost'))
    await service.reconcile()
    expect((await repo.operation(request.operationId))?.status).toBe('unknown')
    const persisted = JSON.parse((await repo.operation(request.operationId))!.relay_json!)
    expect((await repo.game(quote.gameId))?.resolution_operation_id).toBe(request.operationId)
    await service.reconcile()
    expect((await repo.operation(request.operationId))?.status).toBe('pending')
    expect(adapter.post.mock.calls[0][0]).toEqual(persisted)
    expect(adapter.post.mock.calls[1][0]).toEqual(persisted)
    expect(adapter.authorize).toHaveBeenCalledTimes(savedRelay ? 0 : 1)
  })

  it('records the contract winner when a recovered player digit is out of range', async () => {
    const quote = await service.prepare(quoteRequest())
    const game = (await repo.game(quote.gameId))!
    // n = 2, so digit 2 + house digit loses on-chain while (player + house) % n alone would win.
    const playerSecretHex = `${(2 + parseInt(game.house_secret_hex.slice(0, 2), 16)).toString(16).padStart(2, '0')}${'22'.repeat(16)}`
    const request: PoolSubmitRequest = { ...submission(`settle:${quote.gameId}`), expectedHead: { txid: 'cc'.repeat(32), vout: 0 },
      command: { kind: 'settleGame', gameId: quote.gameId, playerSecretHex, houseSecretHex: game.house_secret_hex } }
    await repo.claimOperation(request, 'private-request-hash', quote.gameId)
    await repo.updateGame(quote.gameId, 'funded', { resolutionId: request.operationId })
    adapter.verify.mockResolvedValue({ status: 'confirmed', receipt: {
      arkTxid: request.arkTxid, consumedHead: request.expectedHead, nextHead: { txid: request.arkTxid, vout: 0 }, observedAt: Date.now() } })
    await service.reconcile()
    expect((await repo.game(quote.gameId))).toMatchObject({ status: 'settled', winner: 'pool' })
  })

  it.each([false, true])('discards an expired unsigned opening after restart, quote CAS previously won: %s', async authorized => {
    const quote = await service.prepare(quoteRequest())
    const request: PoolSubmitRequest = { ...submission('opening-crash'), command: { kind: 'openGame', gameId: quote.gameId } }
    await repo.claimOperation(request, 'private-persisted-request', quote.gameId)
    if (authorized) await repo.authorizeGame(quote.gameId, request.operationId, Date.now())
    jest.spyOn(Date, 'now').mockReturnValue(quote.expiresAt + 1)
    await service.reconcile()
    expect((await repo.operation(request.operationId))?.status).toBe('rejected')
    expect(await repo.activeOperations()).toHaveLength(0)
    expect((await repo.game(quote.gameId))?.status).toBe('expired')
    expect(adapter.authorize).not.toHaveBeenCalled()
    expect(adapter.post).not.toHaveBeenCalled()
  })

  it('returns the final settlement identity on reveal and does not settle or charge twice on replay', async () => {
    const playerSecret = `00${'22'.repeat(16)}`
    const quote = await service.prepare({ ...quoteRequest(), playerHash: createHash('sha256').update(Buffer.from(playerSecret, 'hex')).digest('hex') })
    const opening = { ...submission('game-opening'), command: { kind: 'openGame' as const, gameId: quote.gameId } }
    adapter.verify.mockImplementation(async (_descriptor, approved) => ({ status: 'confirmed', receipt: {
      arkTxid: approved.arkTxid, consumedHead: approved.expectedHead, nextHead: { txid: approved.arkTxid, vout: 0 }, observedAt: Date.now() } }))
    await service.submit(opening)
    const busyHead = { txid: opening.arkTxid, vout: 0 }
    adapter.resolution.mockImplementationOnce(async (_descriptor, game, houseSecretHex, playerSecretHex) => {
      const resolution: PoolSubmitRequest = { ...submission(`settle:${game.gameId}`), expectedHead: busyHead, arkTxid: 'cc'.repeat(32),
        command: { kind: 'settleGame', gameId: game.gameId, houseSecretHex, playerSecretHex: playerSecretHex! } }
      return { arkTxid: resolution.arkTxid, expectedHead: busyHead, request: resolution,
        body: { arkTx: 'final-settlement-packet', checkpointTxs: ['settlement-cp'] } }
    })
    const first = await service.reveal(opening.operationId, playerSecret)
    expect(first.operation.arkTxid).toBe('cc'.repeat(32))
    expect(first.operation.arkTxid).not.toBe(opening.arkTxid)
    expect(first.operation.status).toBe('confirmed')
    const repeated = await service.reveal(opening.operationId, playerSecret)
    expect(repeated.operation).toEqual(first.operation)
    expect(adapter.resolution).toHaveBeenCalledTimes(1)
    expect(adapter.post).toHaveBeenCalledTimes(2)
    expect((await repo.game(quote.gameId))?.status).toBe('settled')
    expect((await service.operation(opening.operationId)).resolution).toMatchObject({ arkTxid: first.operation.arkTxid, status: 'confirmed' })
    expect((await service.publicState()).history[0]).toMatchObject({ openingTxid: opening.arkTxid, settlementTxid: first.operation.arkTxid })
  })

  it('exposes bootstrap only through the admin router while both ports can read verified state', async () => {
    const publicApp = express().use(express.json()).use(createPoolRoutes(service))
    const adminApp = express().use(express.json()).use(createPoolAdminRoutes(service))
    expect((await request(publicApp).get('/api/pool')).status).toBe(200)
    expect((await request(adminApp).get('/api/admin/pool')).body.descriptor.name).toBe(descriptor.name)
    expect((await request(publicApp).post('/api/admin/pool/bootstrap').send({ name: 'No public bootstrap', initialNavSats: '100000' })).status).toBe(404)
    expect((await request(adminApp).post('/api/admin/pool/bootstrap').send({ name: 'Bad policy', initialNavSats: '100000', maxStakeBps: 2001 })).status).toBe(400)
    expect(adapter.bootstrap).not.toHaveBeenCalled()
  })

  it.each([{ operatorFeeBps: 3001 }, { minHouseEdgeBps: 1001 }, { maxStakeBps: 2001 }, { minHouseEdgeBps: 0 }])(
    'rejects invalid constructor bounds before claiming bootstrap: %p', async invalid => {
      db.prepare('DELETE FROM pool_bootstrap').run()
      await expect(service.bootstrap({ name: 'Invalid policy', initialNavSats: '100000', ...invalid })).rejects.toThrow(/basis points/)
      expect(await repo.bootstrap()).toBeUndefined()
      expect(adapter.bootstrap).not.toHaveBeenCalled()
    },
  )
})
