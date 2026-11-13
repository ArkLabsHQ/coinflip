import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { computeHouseStake, quotePoolEconomics, randomUniformInt } from 'arkade-coinflip'
import type { PoolBootstrapRequest, PoolGameDescriptor, PoolGameSummary, PoolOperationResponse, PoolPrepareRequest,
  PoolPreparedGame, PoolPublicResponse, PoolRevealResponse, PoolSubmitRequest, PoolOperatorActionRequest, PoolOperatorPosition, PoolGameSnapshot } from 'arkade-coinflip'
import type { AppDeps } from '../deps.js'
import { KeyedMutex } from '../vtxo-pool.js'
import type { PoolAdapter, PoolInputReservation, PoolOperatorStage } from './adapter.js'
import type { PoolBootstrapJournal } from 'arkade-coinflip/dist/pool-game-vault.js'
import { SQLitePoolRepository, type PoolGameRow, type PoolOperationRow, type PoolRelay } from './repository.js'
import { capitalReady, POOL_GAME_FINAL_SECONDS, PoolRenewalSupervisor, requiredGameLifetimeSeconds } from './renewal.js'
import { PoolInputMaintenance } from './input-maintenance.js'

export class PoolError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}
function fail(message: string, status = 400): never { throw new PoolError(message, status) }
function text(error: unknown): string { return error instanceof Error ? error.message : 'Pool operation failed' }
function id(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(value)) fail(`Invalid ${name}`)
}
function hex(value: unknown, bytes: number, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[a-fA-F0-9]+$/.test(value)) fail(`Invalid ${name}`)
}
function amount(value: unknown, minimum: bigint, maximum: bigint, name: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(value)) fail(`Invalid ${name}`)
  const result = BigInt(value)
  if (result < minimum || result > maximum) fail(`${name} is outside its bounds`)
  return result
}
function sameHead(a: { txid: string; vout: number }, b: { txid: string; vout: number }): boolean {
  return a.txid === b.txid && a.vout === b.vout
}
function head(value: { txid: string; vout: number } | undefined): void {
  if (!value) fail('Missing expected pool head')
  hex(value.txid, 32, 'pool head txid')
  if (!Number.isSafeInteger(value.vout) || value.vout < 0 || value.vout > 1024) fail('Invalid pool head output')
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function secretHash(secret: string): string { return createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex') }

export class PoolService {
  private readonly locks = new KeyedMutex()
  private readonly operationHolds = new Map<string, PoolInputReservation>()
  private readonly renewal: PoolRenewalSupervisor
  private readonly inputMaintenance: PoolInputMaintenance
  private reconcileRunning = false

  constructor(private readonly deps: AppDeps, private readonly repo: SQLitePoolRepository, private readonly adapter: PoolAdapter) {
    this.renewal = new PoolRenewalSupervisor(deps, repo, adapter)
    this.inputMaintenance = new PoolInputMaintenance(repo, adapter)
  }

  private gameReady(snapshot: PoolGameSnapshot): boolean {
    return snapshot.readyForOperations === true &&
      snapshot.expiresAtHeight === null && snapshot.expiresAt !== null &&
      snapshot.expiresAt > Date.now() + requiredGameLifetimeSeconds(snapshot) * 1000
  }

  async restoreStartupHolds(): Promise<void> {
    await this.renewal.restore()
    await this.inputMaintenance.restore()
    const saved = (await this.repo.bootstrap())?.journal_json
    if (saved) this.adapter.restoreBootstrapHolds(JSON.parse(saved) as PoolBootstrapJournal)
    for (const operation of await this.repo.activeOperations()) {
      if (operation.operator_request_json && !this.operationHolds.has(operation.operation_id)) {
        const final = this.adapter.restoreOperationHolds(JSON.parse(operation.request_json) as PoolSubmitRequest)
        const source = operation.operator_stage_json ? this.adapter.restoreOperatorStageHolds(JSON.parse(operation.operator_stage_json) as PoolOperatorStage) : undefined
        this.operationHolds.set(operation.operation_id, { outpoints: [...final.outpoints, ...(source?.outpoints ?? [])],
          release: () => { final.release(); source?.release() } })
      }
    }
  }

  async maintain(): Promise<void> {
    const results = await Promise.allSettled([this.renewal.tick(), this.inputMaintenance.tick()])
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${index ? 'inputs' : 'head'}: ${text(result.reason)}`] : [])
    if (failed.length) throw new Error(failed.join('; '))
  }

  async operatorPosition(): Promise<PoolOperatorPosition> {
    const state = await this.publicState()
    const empty: PoolOperatorPosition = { head: state.head, coins: [], totalShares: '0', totalEquitySats: '0',
      feeSweepSats: state.head?.accruedFeesSats ?? '0', inputRenewal: await this.inputMaintenance.state(), capabilities: { redeem: false, sweepFees: false,
        reason: state.error || state.capabilities.reason } }
    if (!state.descriptor || !state.head) return empty
    const coins = await this.adapter.operatorCoins(state.descriptor, state.head)
    const available = await this.adapter.available()
    const active = (await this.repo.activeClaims()).some(operation => sameHead(state.head!.outpoint, { txid: operation.head_txid, vout: operation.head_vout }))
    const usable = available && state.head.phase === 'idle' && !active
    const redeem = usable && capitalReady(state.head) && BigInt(state.head.navSats) > 0n && coins.length > 0
    const sweepFees = usable && capitalReady(state.head, true) && BigInt(state.head.accruedFeesSats) >= 330n
    return { ...empty, coins, totalShares: String(coins.reduce((sum, coin) => sum + BigInt(coin.shares), 0n)),
      totalEquitySats: String(coins.reduce((sum, coin) => sum + BigInt(coin.equitySats), 0n)),
      capabilities: { redeem, sweepFees, ...(!usable ? { reason: !available ? 'The covenant service is unavailable'
        : active ? 'A pool transaction is awaiting verified chain evidence'
        : state.head.phase !== 'idle' ? 'Finish or recover the active game first'
        : state.head.recoveryReason || 'The canonical coin requires recovery checks' } : {}) } }
  }

  async operatorAction(request: PoolOperatorActionRequest): Promise<PoolOperationResponse> {
    if (!request) fail('Missing operator action')
    id(request.operationId, 'operation id'); head(request.expectedHead)
    if (request.command?.kind === 'redeem') {
      if (!('memberOutpoint' in request)) fail('Missing founder share outpoint')
      head(request.memberOutpoint)
      amount(request.command.burnShares, 1n, 1_000_000_000_000n, 'Share burn')
      amount(request.command.minSats, 1n, 1_000_000n, 'Minimum sats')
    } else if (request.command?.kind !== 'sweepFees') fail('Unsupported operator action')
    return this.locks.runExclusive(request.operationId, async () => {
      const descriptor = await this.descriptor()
      const existing = await this.repo.operation(request.operationId)
      if (existing) {
        if (!existing.operator_request_json || hash(JSON.parse(existing.operator_request_json)) !== hash(request)) fail('Operation id is already bound to another operator action', 409)
        return this.resumeOperation(existing, descriptor)
      }
      const position = await this.operatorPosition()
      if (!position.head || !sameHead(position.head.outpoint, request.expectedHead)) fail('The pool head changed; review a fresh operator quote', 409)
      if (!position.capabilities[request.command.kind === 'redeem' ? 'redeem' : 'sweepFees']) fail(position.capabilities.reason || 'This operator action is unavailable', 409)
      const built = await this.adapter.operatorAction(descriptor, request)
      let claimed = false
      try {
        if (built.request.operationId !== request.operationId || !sameHead(built.request.expectedHead, request.expectedHead) ||
            hash(built.request.command) !== hash(request.command) || built.request.memberPubkey !== descriptor.operatorPubkey ||
            built.request.arkTxid !== built.relay.arkTxid) fail('The operator draft differs from its approved action', 503)
        claimed = await this.repo.claimOperation(built.request, hash(built.request), undefined, request, built.stage)
        if (!claimed) fail('Another operation owns this pool head', 409)
        this.operationHolds.set(request.operationId, built.reservation)
        if (!await this.repo.saveRelay(request.operationId, built.relay)) fail('Operator action lost its durable broadcast permission', 409)
        const saved = (await this.repo.operation(request.operationId))!
        if (saved.operator_stage_json) return this.resumeOperation(saved, descriptor)
        await this.broadcast(request.operationId, JSON.parse(saved.relay_json!) as PoolRelay)
        return this.reconcileOperation((await this.repo.operation(request.operationId))!, descriptor)
      } finally {
        if (!claimed) built.reservation.release()
        else {
          const current = await this.repo.operation(request.operationId)
          if (current && ['confirmed', 'conflict', 'rejected'].includes(current.status)) this.releaseOperationHolds(request.operationId)
        }
      }
    })
  }

  async setPolicy(request: unknown): Promise<PoolPublicResponse> {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).length !== 1 || !('fairnessAssumption' in request) ||
        request.fairnessAssumption !== 'unresolved' && request.fairnessAssumption !== 'honest-operator') {
      fail('Fairness assumption must be unresolved or honest-operator')
    }
    await this.deps.repos.config.set('pool_fairness_assumption', request.fairnessAssumption)
    return this.publicState()
  }

  private async descriptor(): Promise<PoolGameDescriptor> {
    const bootstrap = await this.repo.bootstrap()
    if (bootstrap?.status !== 'ready' || !bootstrap.descriptor_json) fail('The operator has not completed pool setup', 503)
    return JSON.parse(bootstrap.descriptor_json) as PoolGameDescriptor
  }

  async publicState(): Promise<PoolPublicResponse> {
    const bootstrap = await this.repo.bootstrap()
    const configuredHouseStakeDiscountBps = Number(await this.deps.repos.config.get('variable_odds_edge_bps') ?? 300)
    const base: PoolPublicResponse = { status: 'unconfigured', descriptor: null, head: null,
      capabilities: { subscribe: false, redeem: false, play: false, reason: 'The operator has not set up a live pool' },
      history: [], pricing: { configuredHouseStakeDiscountBps, minHouseEdgeBps: 0 }, fairnessAssumption: 'unresolved', renewal: await this.renewal.state() }
    const fairnessReady = await this.deps.repos.config.get('pool_fairness_assumption') === 'honest-operator'
    if (fairnessReady) base.fairnessAssumption = 'honest-operator'
    if (!bootstrap) return base
    if (bootstrap.status !== 'ready' || !bootstrap.descriptor_json) return { ...base, status: 'unavailable',
      error: 'Pool setup needs reconciliation; no new control asset will be issued automatically' }
    const descriptor = JSON.parse(bootstrap.descriptor_json) as PoolGameDescriptor
    base.descriptor = descriptor
    base.pricing.minHouseEdgeBps = descriptor.minHouseEdgeBps
    base.history = await this.history()
    try {
      const snapshot = await this.adapter.read(descriptor)
      if (!snapshot) return { ...base, status: 'unavailable', error: 'The current control coin is not indexed; this does not establish retirement' }
      const active = await this.repo.activeClaims()
      const pending = active.some(operation => sameHead(snapshot.outpoint, { txid: operation.head_txid, vout: operation.head_vout }))
      const available = await this.adapter.available()
      const idle = snapshot.phase === 'idle'
      const exitsReady = available && capitalReady(snapshot) && idle && !pending && BigInt(snapshot.navSats) > 0n
      const enabled = fairnessReady && exitsReady && this.gameReady(snapshot)
      const reason = !fairnessReady ? `New contributions and wagers are disabled while fairness assumptions are unresolved; ${exitsReady
        ? 'verified idle shares can still be redeemed' : 'redemption also requires an idle, usable vault and the Arkade and covenant services'}`
        : !available ? 'The covenant service is unavailable'
        : !this.gameReady(snapshot) ? snapshot.recoveryReason || 'Pool batch lifetime does not cover the game deadline and exit margin; renewal is required before new contributions or wagers'
        : pending ? 'A pool transaction is awaiting verified chain evidence'
        : !idle ? 'Finish or recover the active pool game before changing capital' : BigInt(snapshot.navSats) === 0n ? 'The pool has no redeemable equity' : undefined
      return { ...base, head: snapshot, status: idle && !pending ? 'ready' : 'busy',
        capabilities: { subscribe: enabled, redeem: exitsReady, play: enabled, ...(reason ? { reason } : {}) } }
    } catch (error) { return { ...base, status: 'error', error: text(error) } }
  }

  async bootstrap(request: PoolBootstrapRequest): Promise<PoolPublicResponse> {
    if (!request || typeof request.name !== 'string' || !request.name.trim() || request.name.length > 80) fail('Pool name must contain 1 to 80 characters')
    amount(request.initialNavSats, 330n, 1_000_000n, 'Initial pool equity')
    const operatorFeeBps = request.operatorFeeBps ?? 2000
    const minHouseEdgeBps = request.minHouseEdgeBps ?? 100
    const maxStakeBps = request.maxStakeBps ?? 1000
    for (const [name, value, minimum, maximum] of [['Operator fee', operatorFeeBps, 0, 3000], ['Minimum house edge', minHouseEdgeBps, 1, 1000], ['Maximum stake', maxStakeBps, 1, 2000]] as const) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${name} must be whole basis points in [${minimum}, ${maximum}]`)
    }
    const normalized = { ...request, name: request.name.trim(), operatorFeeBps, minHouseEdgeBps, maxStakeBps }
    const existing = await this.repo.bootstrap()
    if (existing?.status === 'ready') return this.publicState()
    if (existing) {
      if (hash(JSON.parse(existing.request_json)) !== hash(normalized) || !existing.journal_json || !await this.repo.resumeBootstrap()) {
        fail('Pool setup is already in progress or needs reconciliation with the same saved plan', 409)
      }
    } else if (!await this.repo.beginBootstrap(normalized)) fail('Pool setup is already in progress', 409)
    try {
      const result = await this.adapter.bootstrap(normalized, {
        load: async () => {
          const saved = (await this.repo.bootstrap())?.journal_json
          return saved ? JSON.parse(saved) as PoolBootstrapJournal : undefined
        },
        save: journal => this.repo.saveBootstrapJournal(journal),
      })
      const verified = await this.adapter.read(result.descriptor)
      if (!verified || !sameHead(verified.outpoint, result.snapshot.outpoint)) throw new Error('Pool setup receipt has not been verified')
      await this.repo.finishBootstrap(result.descriptor)
      return this.publicState()
    } catch (error) {
      if ((await this.repo.bootstrap())?.journal_json) {
        await this.repo.failBootstrap(text(error))
        throw new PoolError(`Pool setup needs reconciliation: ${text(error)}`, 503)
      }
      await this.repo.cancelUnpreparedBootstrap()
      throw new PoolError(`Pool setup was not submitted: ${text(error)}`, 503)
    }
  }

  async prepare(request: PoolPrepareRequest): Promise<PoolPreparedGame> {
    if (!request) fail('Missing pool game request')
    id(request.requestId, 'request id'); head(request.expectedHead)
    hex(request.playerPubkey, 32, 'player pubkey'); hex(request.playerHash, 32, 'player commitment')
    if (typeof request.playerPayoutAddress !== 'string' || request.playerPayoutAddress.length > 256) fail('Invalid player payout address')
    const player = amount(request.playerStakeSats, 330n, 1_000_000n, 'Player stake')
    const prior = await this.repo.gameByRequest(request.requestId)
    const requestHash = hash(request)
    if (prior) {
      if (prior.request_hash !== requestHash) fail('Request id is already bound to different game terms', 409)
      return JSON.parse(prior.prepared_json) as PoolPreparedGame
    }
    const descriptor = await this.descriptor()
    if (await this.deps.repos.config.get('pool_fairness_assumption') !== 'honest-operator') fail('Pool fairness assumptions have not been enabled', 503)
    if (!await this.adapter.available()) fail('The pool covenant service is unavailable', 503)
    const snapshot = await this.adapter.read(descriptor)
    if (!snapshot || snapshot.phase !== 'idle' || !sameHead(snapshot.outpoint, request.expectedHead)) fail('Pool snapshot changed; request a fresh quote', 409)
    if (!this.gameReady(snapshot)) fail(snapshot.recoveryReason || 'The pool head does not cover the game deadline and exit margin; renew before a new game', 503)
    const configuredHouseStakeDiscountBps = Number(await this.deps.repos.config.get('variable_odds_edge_bps') ?? 300)
    const houseStake = computeHouseStake(Number(player), request.oddsN, request.oddsTarget, request.oddsLo, configuredHouseStakeDiscountBps)
    const economics = quotePoolEconomics({ playerStake: Number(player), houseStake, oddsN: request.oddsN,
      oddsTarget: request.oddsTarget, oddsLo: request.oddsLo, configuredHouseStakeDiscountBps })
    const edge = economics.effectiveHouseEdgeBps
    if (BigInt(edge.numerator) < BigInt(descriptor.minHouseEdgeBps) * BigInt(edge.denominator)) fail('The requested odds do not meet this pool\'s minimum effective house edge')
    const nav = BigInt(snapshot.navSats)
    if (houseStake < 330) fail('The requested odds produce a house stake below the contract minimum')
    if (BigInt(houseStake) * 10000n > nav * BigInt(descriptor.maxStakeBps)) fail('The requested house stake exceeds the pool exposure limit')
    if (BigInt(houseStake) > 1_000_000n - BigInt(snapshot.carriedLossSats) ||
        player * BigInt(descriptor.operatorFeeBps) / 10000n > 1_000_000n - BigInt(snapshot.accruedFeesSats)) fail('The requested game exceeds the pool accounting limits')
    if (nav + player > 1_000_000n) fail('The player stake exceeds the pool game value limit')
    const now = Date.now(), seconds = Math.floor(now / 1000)
    const houseSecret = Buffer.concat([Buffer.from([randomUniformInt(request.oddsN)]), randomBytes(16)]).toString('hex')
    const prepared: PoolPreparedGame = { gameId: randomUUID(), expectedHead: request.expectedHead,
      playerHash: request.playerHash, playerPubkey: request.playerPubkey, playerPayoutAddress: request.playerPayoutAddress,
      houseHash: secretHash(houseSecret), playerStakeSats: String(player), houseStakeSats: String(houseStake),
      oddsN: request.oddsN, oddsLo: request.oddsLo, oddsTarget: request.oddsTarget,
      cancelAt: seconds + 1800, finalAt: seconds + POOL_GAME_FINAL_SECONDS, expiresAt: now + 60_000, economics }
    await this.repo.expireQuotes(now)
    if (!await this.repo.saveGame(request, prepared, requestHash, houseSecret)) {
      const raced = await this.repo.gameByRequest(request.requestId)
      if (raced?.request_hash === requestHash) return JSON.parse(raced.prepared_json) as PoolPreparedGame
      fail('Request id is already bound to different game terms', 409)
    }
    return prepared
  }

  private checkSubmission(request: PoolSubmitRequest): void {
    if (!request) fail('Missing pool transaction')
    id(request.operationId, 'operation id'); head(request.expectedHead)
    hex(request.arkTxid, 32, 'transaction id'); hex(request.memberPubkey, 32, 'member pubkey')
    if (typeof request.arkTx !== 'string' || request.arkTx.length < 8 || request.arkTx.length > 262_144 ||
        !Array.isArray(request.checkpointTxs) || request.checkpointTxs.length > 16 ||
        request.checkpointTxs.some(value => typeof value !== 'string' || value.length < 8 || value.length > 262_144)) fail('Invalid pool transaction packet')
    if (request.command?.kind === 'subscribe') {
      amount(request.command.depositSats, 1n, 1_000_000n, 'Deposit'); amount(request.command.minShares, 1n, 1_000_000_000_000n, 'Minimum shares')
    } else if (request.command?.kind === 'redeem') {
      amount(request.command.burnShares, 1n, 1_000_000_000_000n, 'Share burn'); amount(request.command.minSats, 1n, 1_000_000n, 'Minimum sats')
    } else if (request.command?.kind === 'openGame') id(request.command.gameId, 'game id')
    else fail('Unsupported public pool operation')
  }

  async submit(request: PoolSubmitRequest): Promise<PoolOperationResponse> {
    this.checkSubmission(request)
    return this.locks.runExclusive(request.operationId, () => this.submitLocked(request))
  }

  private async submitLocked(request: PoolSubmitRequest): Promise<PoolOperationResponse> {
    const descriptor = await this.descriptor(), requestHash = hash(request)
    let stored = await this.repo.operation(request.operationId)
    if (stored && stored.request_hash !== requestHash) fail('Operation id is already bound to another transaction', 409)
    if (stored && ['confirmed', 'conflict', 'rejected'].includes(stored.status)) return this.response(stored)
    if (stored?.operator_stage_json) return this.resumeOperation(stored, descriptor)
    let game: PoolGameRow | undefined
    if (request.command.kind === 'openGame') {
      game = await this.repo.game(request.command.gameId)
      if (!game) fail('Pool game not found', 404)
      const prepared = JSON.parse(game.prepared_json) as PoolPreparedGame
      if (!sameHead(prepared.expectedHead, request.expectedHead) || prepared.playerPubkey !== request.memberPubkey) fail('Pool transaction does not match the quoted member and head')
      if (game.opening_operation_id && game.opening_operation_id !== request.operationId) fail('Pool game already has an opening operation', 409)
    }
    if (!stored) {
      if (request.command.kind !== 'redeem' && await this.deps.repos.config.get('pool_fairness_assumption') !== 'honest-operator') fail('Pool fairness assumptions have not been enabled', 503)
      const snapshot = await this.adapter.read(descriptor)
      if (!snapshot || snapshot.phase !== 'idle' || !sameHead(snapshot.outpoint, request.expectedHead)) fail('Pool snapshot changed before submission', 409)
      if (!(request.command.kind === 'redeem' ? capitalReady(snapshot) : this.gameReady(snapshot))) fail(snapshot.recoveryReason || 'The pool head is not safe for this operation; renew or recover it', 503)
      if (!await this.repo.claimOperation(request, requestHash, game?.game_id)) {
        stored = await this.repo.operation(request.operationId)
        if (!stored || stored.request_hash !== requestHash) fail('Another operation owns this pool head', 409)
      } else stored = (await this.repo.operation(request.operationId))!
    }
    if (game) {
      if (game.status === 'quoted') await this.repo.authorizeGame(game.game_id, request.operationId, Date.now())
      game = (await this.repo.game(game.game_id))!
      if (game.opening_operation_id !== request.operationId || !['authorized', 'funded', 'revealed', 'settled'].includes(game.status)) {
        await this.repo.rejectUnprepared(request.operationId, 'Game quote expired before authorization')
        fail('Game quote expired before authorization; request a fresh quote', 409)
      }
    }
    let relay: PoolRelay
    try {
      relay = stored.relay_json ? JSON.parse(stored.relay_json) as PoolRelay
        : await this.adapter.authorize(descriptor, request, game ? JSON.parse(game.prepared_json) as PoolPreparedGame : undefined)
      if (relay.arkTxid !== request.arkTxid) fail('Authorization changed the approved pool transaction')
      if (!await this.repo.saveRelay(request.operationId, relay)) fail('Pool operation is no longer eligible for broadcast', 409)
      relay = JSON.parse((await this.repo.operation(request.operationId))!.relay_json!) as PoolRelay
    } catch (error) {
      const rejected = await this.repo.rejectUnprepared(request.operationId, text(error))
      if (game && rejected) await this.repo.updateGame(game.game_id, 'conflict')
      throw error
    }
    await this.broadcast(request.operationId, relay)
    return this.reconcileOperation((await this.repo.operation(request.operationId))!, descriptor)
  }

  private async broadcast(operationId: string, relay: PoolRelay): Promise<void> {
    try { await this.adapter.post(relay); await this.repo.updateOperation(operationId, 'pending') }
    catch (error) { await this.repo.updateOperation(operationId, 'unknown', { error: text(error) }) }
  }

  private async response(row: PoolOperationRow): Promise<PoolOperationResponse> {
    const result: PoolOperationResponse = { operationId: row.operation_id, arkTxid: row.ark_txid, status: row.status,
      ...(row.game_id ? { gameId: row.game_id } : {}), ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) } : {}),
      ...(row.error ? { error: row.error } : {}) }
    if (row.game_id) {
      const game = await this.repo.game(row.game_id)
      const resolution = game?.resolution_operation_id ? await this.repo.operation(game.resolution_operation_id) : undefined
      if (resolution && resolution.operation_id !== row.operation_id) result.resolution = {
        operationId: resolution.operation_id, arkTxid: resolution.ark_txid, status: resolution.status,
        ...(game?.player_secret_hex ? { houseSecretHex: game.house_secret_hex } : {}),
        ...(game?.winner ? { winner: game.winner } : {}),
      }
    }
    return result
  }

  private async reconcileOperation(row: PoolOperationRow, descriptor: PoolGameDescriptor): Promise<PoolOperationResponse> {
    if (!['confirmed', 'conflict', 'rejected'].includes(row.status)) {
      const request = JSON.parse(row.request_json) as PoolSubmitRequest
      const result = await this.adapter.verify(descriptor, request)
      if (result.status === 'confirmed') {
        if (!result.receipt || result.receipt.arkTxid !== row.ark_txid ||
            !sameHead(result.receipt.consumedHead, request.expectedHead)) fail('Pool receipt does not match its approved transaction', 503)
        await this.repo.updateOperation(row.operation_id, 'confirmed', { receipt: result.receipt })
        if (row.game_id) {
          const game = await this.repo.game(row.game_id)
          if (game?.opening_operation_id === row.operation_id) await this.repo.updateGame(row.game_id, 'funded')
          else if (game?.resolution_operation_id === row.operation_id) {
            const prepared = JSON.parse(game.prepared_json) as PoolPreparedGame
            const player = request.command.kind === 'settleGame' ? request.command.playerSecretHex : undefined
            const roll = player ? (parseInt(player.slice(0, 2), 16) + parseInt(game.house_secret_hex.slice(0, 2), 16)) % prepared.oddsN : undefined
            await this.repo.updateGame(row.game_id, player ? 'settled' : 'refunded',
              roll === undefined ? {} : { winner: roll >= prepared.oddsLo && roll < prepared.oddsTarget ? 'player' : 'pool' })
          }
        }
      } else if (result.status === 'conflict') {
        if (row.operator_stage_json) {
          try {
            const stage = await this.adapter.submitOperatorStage(descriptor, JSON.parse(row.operator_stage_json) as PoolOperatorStage,
              next => this.repo.saveOperatorStage(row.operation_id, next), true)
            if (stage === 'unsubmitted') {
              if (!await this.repo.rejectUnsubmittedStage(row.operation_id, row.operator_stage_json)) fail('Operator staging changed while fencing its unused plan', 409)
            } else if (stage !== 'refunded') fail('Conflicting operator action has not returned its staged shares', 503)
          } catch (error) {
            await this.repo.updateOperation(row.operation_id, 'unknown', { error: `Staged shares need recovery: ${text(error)}` })
            throw error
          }
        }
        await this.repo.updateOperation(row.operation_id, 'conflict', { error: 'The canonical input was spent by another verified transaction' })
        if (row.game_id) {
          const game = await this.repo.game(row.game_id)
          if (game?.opening_operation_id === row.operation_id) await this.repo.updateGame(row.game_id, 'conflict')
          else if (game?.resolution_operation_id === row.operation_id) await this.repo.clearResolution(row.game_id, row.operation_id)
        }
      }
      row = (await this.repo.operation(row.operation_id))!
    }
    if (['confirmed', 'conflict', 'rejected'].includes(row.status)) {
      this.releaseOperationHolds(row.operation_id)
    }
    return this.response(row)
  }

  private releaseOperationHolds(operationId: string): void {
    this.operationHolds.get(operationId)?.release()
    this.operationHolds.delete(operationId)
  }

  async operation(operationId: string): Promise<PoolOperationResponse> {
    id(operationId, 'operation id')
    const row = await this.repo.operation(operationId)
    if (!row) fail('Pool operation not found', 404)
    if (row.operation_kind !== 'transaction') fail('Inspect pool maintenance status through pool discovery and operator position', 409)
    return this.reconcileOperation(row, await this.descriptor())
  }

  async reveal(operationId: string, playerSecret: string): Promise<PoolRevealResponse> {
    return this.locks.runExclusive(operationId, async () => {
      const opening = await this.repo.operation(operationId)
      if (!opening?.game_id) fail('Pool game opening operation not found', 404)
      const game = (await this.repo.game(opening.game_id))!
      const prepared = JSON.parse(game.prepared_json) as PoolPreparedGame
      if (typeof playerSecret !== 'string' || !/^[a-fA-F0-9]{34}$/.test(playerSecret) ||
          secretHash(playerSecret) !== prepared.playerHash || parseInt(playerSecret.slice(0, 2), 16) >= prepared.oddsN) fail('Player reveal does not match the pool game commitment')
      await this.reconcileOperation(opening, await this.descriptor())
      if ((await this.repo.operation(operationId))?.status !== 'confirmed') fail('Pool game funding has not been verified', 409)
      if (game.resolution_operation_id && ['settled', 'refunded'].includes(game.status)) return {
        gameId: game.game_id, operation: await this.operation(game.resolution_operation_id),
        ...(game.player_secret_hex ? { houseSecretHex: game.house_secret_hex } : {}), ...(game.winner ? { winner: game.winner } : {}) }
      await this.repo.updateGame(game.game_id, game.status === 'revealed' ? 'revealed' : 'funded', { playerSecret })
      const operation = await this.resolveGame((await this.repo.game(game.game_id))!, 'settle')
      const roll = (parseInt(playerSecret.slice(0, 2), 16) + parseInt(game.house_secret_hex.slice(0, 2), 16)) % prepared.oddsN
      return { gameId: game.game_id, operation, houseSecretHex: game.house_secret_hex,
        winner: roll >= prepared.oddsLo && roll < prepared.oddsTarget ? 'player' : 'pool' }
    })
  }

  private async resolveGame(game: PoolGameRow, mode: 'settle' | 'refund'): Promise<PoolOperationResponse> {
    const descriptor = await this.descriptor()
    if (game.resolution_operation_id) return this.resumeOperation((await this.repo.operation(game.resolution_operation_id))!, descriptor)
    const prepared = JSON.parse(game.prepared_json) as PoolPreparedGame
    const relay = await this.adapter.resolution(descriptor, prepared, game.house_secret_hex, game.player_secret_hex ?? undefined, mode)
    const request = relay.request
    if (!sameHead(relay.expectedHead, request.expectedHead) || relay.arkTxid !== request.arkTxid) fail('Pool resolution draft has inconsistent transaction identity', 503)
    if (!await this.repo.claimOperation(request, hash(request), game.game_id)) {
      const existing = await this.repo.operation(request.operationId)
      if (!existing || existing.request_hash !== hash(request)) fail('Another operation owns the resolution head', 409)
      await this.repo.updateGame(game.game_id, game.status, { resolutionId: request.operationId })
      return this.resumeOperation(existing, descriptor)
    }
    if (!await this.repo.saveRelay(request.operationId, relay)) fail('Pool resolution is no longer eligible for broadcast', 409)
    await this.repo.updateGame(game.game_id, game.status, { resolutionId: request.operationId })
    await this.broadcast(request.operationId, relay)
    return this.reconcileOperation((await this.repo.operation(request.operationId))!, descriptor)
  }

  private async resumeOperation(row: PoolOperationRow, descriptor: PoolGameDescriptor): Promise<PoolOperationResponse> {
    const checked = await this.reconcileOperation(row, descriptor)
    if (['confirmed', 'conflict', 'rejected'].includes(checked.status)) return checked
    const request = JSON.parse(row.request_json) as PoolSubmitRequest
    if (row.operator_stage_json) {
      let staged: 'funded' | 'refunded' | 'unsubmitted'
      try { staged = await this.adapter.submitOperatorStage(descriptor, JSON.parse(row.operator_stage_json) as PoolOperatorStage,
        next => this.repo.saveOperatorStage(row.operation_id, next)) }
      catch (error) {
        await this.repo.updateOperation(row.operation_id, 'unknown', { error: `Operator staging needs recovery: ${text(error)}` })
        throw error
      }
      if (staged === 'unsubmitted') {
        if (!await this.repo.rejectUnsubmittedStage(row.operation_id, row.operator_stage_json)) fail('Staging changed while fencing an expired authorization', 409)
        this.releaseOperationHolds(row.operation_id)
        return this.response((await this.repo.operation(row.operation_id))!)
      }
      if (staged === 'refunded') {
        await this.repo.updateOperation(row.operation_id, 'rejected', { error: 'Staged founder shares were returned to the operator; review a fresh redemption' })
        this.releaseOperationHolds(row.operation_id)
        return this.response((await this.repo.operation(row.operation_id))!)
      }
    }
    let game = row.game_id ? await this.repo.game(row.game_id) : undefined
    if (request.command.kind === 'openGame' && !row.relay_json) {
      if (game?.status === 'quoted') await this.repo.authorizeGame(game.game_id, row.operation_id, Date.now())
      game = row.game_id ? await this.repo.game(row.game_id) : undefined
      if (!game || game.status !== 'authorized' || game.opening_operation_id !== row.operation_id || game.expires_at <= Date.now()) {
        if (await this.repo.rejectUnprepared(row.operation_id, 'Unsigned pool game quote expired before recovery')) {
          if (game) await this.repo.updateGame(game.game_id, 'expired')
        }
        return this.response((await this.repo.operation(row.operation_id))!)
      }
    }
    const relay = row.relay_json ? JSON.parse(row.relay_json) as PoolRelay : await this.adapter.authorize(descriptor, request,
      game ? JSON.parse(game.prepared_json) as PoolPreparedGame : undefined)
    if (relay.arkTxid !== row.ark_txid || !await this.repo.saveRelay(row.operation_id, relay)) fail('Pool recovery lost its exact broadcast permission', 409)
    if (game && request.command.kind !== 'openGame' && !game.resolution_operation_id) {
      await this.repo.updateGame(game.game_id, game.status, { resolutionId: row.operation_id })
    }
    const persisted = JSON.parse((await this.repo.operation(row.operation_id))!.relay_json!) as PoolRelay
    await this.broadcast(row.operation_id, persisted)
    return this.reconcileOperation((await this.repo.operation(row.operation_id))!, descriptor)
  }

  async reconcile(): Promise<void> {
    if (this.reconcileRunning) return
    this.reconcileRunning = true
    try {
      const bootstrap = await this.repo.bootstrap()
      if (bootstrap?.status !== 'ready') return
      const descriptor = await this.descriptor()
      await this.repo.expireQuotes(Date.now())
      for (const operation of await this.repo.activeOperations()) {
        try { await this.resumeOperation(operation, descriptor) } catch { /* Retain the exact intent until chain evidence is available. */ }
      }
      const snapshot = await this.adapter.read(descriptor)
      if (!snapshot) return
      for (const game of await this.repo.activeGames()) {
        const prepared = JSON.parse(game.prepared_json) as PoolPreparedGame
        if (game.status === 'quoted' && !sameHead(snapshot.outpoint, prepared.expectedHead)) {
          await this.repo.updateGame(game.game_id, 'conflict'); continue
        }
        if (!snapshot.game || snapshot.game.houseHash !== prepared.houseHash || snapshot.game.playerHash !== prepared.playerHash) continue
        if (snapshot.phase === 'contest') await this.repo.updateGame(game.game_id, 'revealed',
          snapshot.playerSecretHex ? { playerSecret: snapshot.playerSecretHex } : {})
        const current = (await this.repo.game(game.game_id))!
        try {
          if (current.player_secret_hex) await this.resolveGame(current, 'settle')
          else if (Math.floor(Date.now() / 1000) >= prepared.cancelAt) await this.resolveGame(current, 'refund')
        } catch { /* An unresolved game remains visible and recoverable. */ }
      }
    } finally { this.reconcileRunning = false }
  }

  private async history(): Promise<PoolGameSummary[]> {
    return Promise.all((await this.repo.games()).map(async game => {
      const quote = JSON.parse(game.prepared_json) as PoolPreparedGame
      const opening = game.opening_operation_id ? await this.repo.operation(game.opening_operation_id) : undefined
      const resolution = game.resolution_operation_id ? await this.repo.operation(game.resolution_operation_id) : undefined
      return { gameId: game.game_id, status: game.status, createdAt: game.created_at,
        playerStakeSats: quote.playerStakeSats, houseStakeSats: quote.houseStakeSats,
        oddsN: quote.oddsN, oddsLo: quote.oddsLo, oddsTarget: quote.oddsTarget,
        ...(opening ? { openingTxid: opening.ark_txid } : {}), ...(resolution ? { settlementTxid: resolution.ark_txid } : {}),
        ...(game.winner ? { winner: game.winner } : {}),
        ...(game.player_secret_hex ? { houseSecretHex: game.house_secret_hex } : {}) }
    }))
  }
}
