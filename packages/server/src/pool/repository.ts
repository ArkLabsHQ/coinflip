import type { PoolGameDescriptor, PoolPreparedGame, PoolPrepareRequest, PoolSubmitRequest, PoolOperationResponse, PoolOperationReceipt, PoolOperatorActionRequest } from 'arkade-coinflip'
import type { SQLExecutor } from '../repositories/types.js'
import type { PoolBootstrapJournal } from 'arkade-coinflip/dist/pool-game-vault.js'
import type { PoolRenewalJournal, PoolRenewalReceipt } from 'arkade-coinflip/dist/pool-game-vault.js'
import type { PoolOperatorStage } from './adapter.js'

export const POOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS pool_bootstrap (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'unknown')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  descriptor_json TEXT,
  journal_json TEXT CHECK (journal_json IS NULL OR json_valid(journal_json)),
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pool_games (
  game_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  prepared_json TEXT NOT NULL CHECK (json_valid(prepared_json)),
  head_txid TEXT NOT NULL,
  head_vout INTEGER NOT NULL,
  house_secret_hex TEXT NOT NULL,
  player_secret_hex TEXT,
  status TEXT NOT NULL DEFAULT 'quoted',
  opening_operation_id TEXT,
  resolution_operation_id TEXT,
  winner TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
DROP INDEX IF EXISTS pool_active_quote;
CREATE UNIQUE INDEX IF NOT EXISTS pool_active_game_head ON pool_games(head_txid, head_vout)
  WHERE status IN ('authorized', 'funded', 'revealed');
CREATE TABLE IF NOT EXISTS pool_operations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  head_txid TEXT NOT NULL,
  head_vout INTEGER NOT NULL,
  ark_txid TEXT NOT NULL,
  status TEXT NOT NULL,
  game_id TEXT,
  operator_request_json TEXT,
  operator_stage_json TEXT,
  operation_kind TEXT NOT NULL DEFAULT 'transaction',
  renewal_journal_json TEXT,
  renewal_session_json TEXT,
  renewal_replay_json TEXT,
  renewal_receipt_json TEXT,
  relay_json TEXT,
  receipt_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pool_active_submission ON pool_operations(head_txid, head_vout)
  WHERE status IN ('submitting', 'pending', 'unknown');
CREATE TABLE IF NOT EXISTS pool_wallet_input_claims (
  source_txid TEXT NOT NULL, source_vout INTEGER NOT NULL, operation_id TEXT NOT NULL,
  PRIMARY KEY(source_txid,source_vout),
  FOREIGN KEY(operation_id) REFERENCES pool_operations(operation_id) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS pool_wallet_input_claims_insert AFTER INSERT ON pool_operations
WHEN NEW.operator_stage_json IS NOT NULL OR NEW.operation_kind='input-renewal'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(CASE WHEN NEW.operator_stage_json IS NOT NULL
      THEN json_extract(NEW.operator_stage_json,'$.funding.inputOutpoints') ELSE json_extract(NEW.request_json,'$.inputOutpoints') END) source
    JOIN pool_wallet_input_claims claimed ON claimed.source_txid=json_extract(source.value,'$.txid')
      AND claimed.source_vout=json_extract(source.value,'$.vout')
  ) THEN RAISE(ABORT,'pool wallet input already claimed') END;
  INSERT INTO pool_wallet_input_claims(source_txid,source_vout,operation_id)
    SELECT json_extract(source.value,'$.txid'),json_extract(source.value,'$.vout'),NEW.operation_id
    FROM json_each(CASE WHEN NEW.operator_stage_json IS NOT NULL THEN json_extract(NEW.operator_stage_json,'$.funding.inputOutpoints')
      ELSE json_extract(NEW.request_json,'$.inputOutpoints') END) source;
END;
CREATE TRIGGER IF NOT EXISTS pool_wallet_input_claims_release AFTER UPDATE OF status ON pool_operations
WHEN NEW.status IN ('confirmed','rejected','conflict')
BEGIN DELETE FROM pool_wallet_input_claims WHERE operation_id=NEW.operation_id; END;
`

export interface PoolBootstrapRow {
  status: 'creating' | 'ready' | 'unknown'
  request_json: string
  descriptor_json: string | null
  journal_json: string | null
  error: string | null
}
export interface PoolGameRow {
  game_id: string
  request_id: string
  request_hash: string
  request_json: string
  prepared_json: string
  head_txid: string
  head_vout: number
  house_secret_hex: string
  player_secret_hex: string | null
  status: 'quoted' | 'authorized' | 'funded' | 'revealed' | 'settled' | 'refunded' | 'expired' | 'conflict'
  opening_operation_id: string | null
  resolution_operation_id: string | null
  winner: 'player' | 'pool' | null
  created_at: number
  expires_at: number
}
export interface PoolOperationRow {
  operation_id: string
  request_hash: string
  request_json: string
  head_txid: string
  head_vout: number
  ark_txid: string
  status: PoolOperationResponse['status']
  game_id: string | null
  operator_request_json: string | null
  operator_stage_json: string | null
  operation_kind: 'transaction' | 'renewal' | 'input-renewal'
  renewal_journal_json: string | null
  renewal_session_json: string | null
  renewal_replay_json: string | null
  renewal_receipt_json: string | null
  relay_json: string | null
  receipt_json: string | null
  error: string | null
  created_at: number
  updated_at: number
}
export interface PoolRelay {
  arkTxid: string
  body: { arkTx: string; checkpointTxs: string[] }
}

// Matches by message: the native driver's error class can come from another realm, so `instanceof Error` is unreliable.
const claimConflict = (error: unknown) => (error as { message?: unknown } | null)?.message === 'pool wallet input already claimed'

export class SQLitePoolRepository {
  constructor(private readonly db: SQLExecutor) {}

  bootstrap(): Promise<PoolBootstrapRow | undefined> {
    return this.db.get<PoolBootstrapRow>('SELECT * FROM pool_bootstrap WHERE id = 1')
  }
  async beginBootstrap(request: unknown): Promise<boolean> {
    return !!await this.db.get(`INSERT OR IGNORE INTO pool_bootstrap(id,status,request_json,created_at)
      VALUES (1,'creating',?,?) RETURNING id`, [JSON.stringify(request), Date.now()])
  }
  async finishBootstrap(descriptor: PoolGameDescriptor): Promise<void> {
    await this.db.run("UPDATE pool_bootstrap SET status='ready',descriptor_json=?,error=NULL WHERE id=1 AND status='creating'", [JSON.stringify(descriptor)])
  }
  async failBootstrap(error: string): Promise<void> {
    await this.db.run("UPDATE pool_bootstrap SET status='unknown',error=? WHERE id=1 AND status='creating'", [error])
  }
  async resumeBootstrap(): Promise<boolean> {
    return !!await this.db.get("UPDATE pool_bootstrap SET status='creating',error=NULL WHERE id=1 AND status IN ('creating','unknown') AND journal_json IS NOT NULL RETURNING id")
  }
  async saveBootstrapJournal(journal: PoolBootstrapJournal): Promise<void> {
    const saved = (await this.bootstrap())?.journal_json ?? null
    if (saved) {
      const previous = JSON.parse(saved) as PoolBootstrapJournal
      if (previous.version !== journal.version || previous.optionsHash !== journal.optionsHash || previous.complete && !journal.complete) {
        throw new Error('Pool bootstrap journal changed its saved identity')
      }
      for (const name of ['genesis', 'activation'] as const) {
        const before = previous[name], after = journal[name]
        if (before && (!after || before.arkTxid !== after.arkTxid || before.arkTx !== after.arkTx ||
            JSON.stringify(before.checkpointTxs) !== JSON.stringify(after.checkpointTxs) ||
            JSON.stringify(before.inputOutpoints) !== JSON.stringify(after.inputOutpoints) ||
            before.submitted && !after.submitted || before.confirmed && !after.confirmed ||
            before.finalizeCheckpointTxs && JSON.stringify(before.finalizeCheckpointTxs) !== JSON.stringify(after.finalizeCheckpointTxs))) {
          throw new Error('Pool bootstrap journal changed a saved financial intent')
        }
      }
    }
    const result = await this.db.get("UPDATE pool_bootstrap SET journal_json=? WHERE id=1 AND status IN ('creating','unknown') AND journal_json IS ? RETURNING id", [JSON.stringify(journal), saved])
    if (!result) throw new Error('Pool bootstrap lost its durable journal permission')
  }
  async cancelUnpreparedBootstrap(): Promise<void> {
    await this.db.run("DELETE FROM pool_bootstrap WHERE id=1 AND status='creating' AND journal_json IS NULL")
  }
  game(id: string): Promise<PoolGameRow | undefined> {
    return this.db.get<PoolGameRow>('SELECT * FROM pool_games WHERE game_id=?', [id])
  }
  gameByRequest(id: string): Promise<PoolGameRow | undefined> {
    return this.db.get<PoolGameRow>('SELECT * FROM pool_games WHERE request_id=?', [id])
  }
  games(limit = 30): Promise<PoolGameRow[]> {
    return this.db.all<PoolGameRow>('SELECT * FROM pool_games ORDER BY created_at DESC LIMIT ?', [limit])
  }
  /** Pool loss (positive) from games started since `since`: house stakes paid out minus player stakes won. */
  async realizedLossSince(since: number): Promise<bigint> {
    const rows = await this.db.all<{ winner: string; prepared_json: string }>(
      "SELECT winner, prepared_json FROM pool_games WHERE status='settled' AND created_at>=?", [since])
    return rows.reduce((loss, row) => {
      const game = JSON.parse(row.prepared_json) as { houseStakeSats: string; playerStakeSats: string }
      return loss + (row.winner === 'player' ? BigInt(game.houseStakeSats) : -BigInt(game.playerStakeSats))
    }, 0n)
  }
  activeGames(): Promise<PoolGameRow[]> {
    return this.db.all<PoolGameRow>("SELECT * FROM pool_games WHERE status IN ('quoted','authorized','funded','revealed') ORDER BY created_at")
  }
  async expireQuotes(now: number): Promise<void> {
    await this.db.run("UPDATE pool_games SET status='expired' WHERE status='quoted' AND expires_at<=?", [now])
  }
  async saveGame(request: PoolPrepareRequest, prepared: PoolPreparedGame, requestHash: string, secret: string): Promise<boolean> {
    return !!await this.db.get(`INSERT OR IGNORE INTO pool_games
      (game_id,request_id,request_hash,request_json,prepared_json,head_txid,head_vout,house_secret_hex,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING game_id`, [prepared.gameId, request.requestId, requestHash,
      JSON.stringify(request), JSON.stringify(prepared), prepared.expectedHead.txid, prepared.expectedHead.vout,
      secret, Date.now(), prepared.expiresAt])
  }
  async authorizeGame(id: string, operationId: string, now: number): Promise<boolean> {
    return !!await this.db.get(`UPDATE pool_games SET status='authorized',opening_operation_id=?
      WHERE game_id=? AND status='quoted' AND expires_at>?
        AND NOT EXISTS (SELECT 1 FROM pool_games other WHERE other.game_id<>pool_games.game_id
          AND other.head_txid=pool_games.head_txid AND other.head_vout=pool_games.head_vout
          AND other.status IN ('authorized','funded','revealed'))
      RETURNING game_id`, [operationId, id, now])
  }
  async updateGame(id: string, status: PoolGameRow['status'], values: { playerSecret?: string; resolutionId?: string; winner?: 'player' | 'pool' } = {}): Promise<void> {
    await this.db.run(`UPDATE pool_games SET status=?, player_secret_hex=COALESCE(?,player_secret_hex),
      resolution_operation_id=COALESCE(?,resolution_operation_id),winner=COALESCE(?,winner) WHERE game_id=?`,
    [status, values.playerSecret ?? null, values.resolutionId ?? null, values.winner ?? null, id])
  }
  async clearResolution(gameId: string, operationId: string): Promise<void> {
    await this.db.run('UPDATE pool_games SET resolution_operation_id=NULL WHERE game_id=? AND resolution_operation_id=?', [gameId, operationId])
  }
  operation(id: string): Promise<PoolOperationRow | undefined> {
    return this.db.get<PoolOperationRow>('SELECT * FROM pool_operations WHERE operation_id=?', [id])
  }
  activeOperations(): Promise<PoolOperationRow[]> {
    return this.db.all<PoolOperationRow>("SELECT * FROM pool_operations WHERE operation_kind='transaction' AND status IN ('submitting','pending','unknown') ORDER BY created_at")
  }
  activeClaims(): Promise<PoolOperationRow[]> {
    return this.db.all<PoolOperationRow>("SELECT * FROM pool_operations WHERE status IN ('submitting','pending','unknown') ORDER BY created_at")
  }
  activeRenewal(): Promise<PoolOperationRow | undefined> {
    return this.db.get<PoolOperationRow>("SELECT * FROM pool_operations WHERE operation_kind='renewal' AND status IN ('submitting','pending','unknown') ORDER BY created_at LIMIT 1")
  }
  async claimRenewal(operationId: string, expectedHead: { txid: string; vout: number }): Promise<boolean> {
    const request = { kind: 'renewal', expectedHead }
    return !!await this.db.get(`INSERT OR IGNORE INTO pool_operations
      (operation_id,request_hash,request_json,head_txid,head_vout,ark_txid,status,operation_kind,created_at,updated_at)
      VALUES (?,?,?,?,?,'','submitting','renewal',?,?) RETURNING operation_id`, [operationId, JSON.stringify(request),
      JSON.stringify(request), expectedHead.txid, expectedHead.vout, Date.now(), Date.now()])
  }
  async saveRenewalJournal(operationId: string, journal: PoolRenewalJournal, proofTxid: string): Promise<void> {
    const row = await this.operation(operationId)
    if (!row || row.operation_kind !== 'renewal' || row.head_txid !== journal.expectedHead.txid || row.head_vout !== journal.expectedHead.vout ||
        row.ark_txid && row.ark_txid !== proofTxid) throw new Error('Pool renewal changed its claimed head or exact proof')
    if (row.renewal_journal_json) {
      const previous = JSON.parse(row.renewal_journal_json) as PoolRenewalJournal
      if (JSON.stringify(previous.message) !== JSON.stringify(journal.message) || previous.contractScript !== journal.contractScript ||
          previous.intentId && previous.intentId !== journal.intentId || previous.registrationAttempted && !journal.registrationAttempted) throw new Error('Pool renewal changed its saved intent')
    }
    const result = await this.db.get(`UPDATE pool_operations SET renewal_journal_json=?,ark_txid=?,updated_at=?
      WHERE operation_id=? AND operation_kind='renewal' AND status IN ('submitting','pending','unknown')
      AND renewal_journal_json IS ? RETURNING operation_id`, [JSON.stringify(journal), proofTxid, Date.now(), operationId, row.renewal_journal_json])
    if (!result) throw new Error('Pool renewal lost its durable journal permission')
  }
  async saveRenewalSession(operationId: string, session: unknown, expectedRevision: number | null): Promise<boolean> {
    const next = session as { version?: unknown; revision?: unknown }
    if (!next || next.version !== 1 || next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw new Error('Invalid pool renewal session revision')
    const encoded = JSON.stringify(session)
    return !!await this.db.get(`UPDATE pool_operations SET renewal_session_json=?,updated_at=? WHERE operation_id=?
      AND operation_kind IN ('renewal','input-renewal') AND status IN ('submitting','pending','unknown')
      AND ((? IS NULL AND renewal_session_json IS NULL) OR (? IS NOT NULL AND json_extract(renewal_session_json,'$.revision')=?))
      AND (renewal_session_json IS NULL OR (json_extract(renewal_session_json,'$.secretKey') IS json_extract(?,'$.secretKey')
        AND json_extract(renewal_session_json,'$.publicKey') IS json_extract(?,'$.publicKey')
        AND (json_extract(renewal_session_json,'$.context.digest') IS NULL OR json_extract(renewal_session_json,'$.context.digest') IS json_extract(?,'$.context.digest'))))
      RETURNING operation_id`, [encoded, Date.now(), operationId, expectedRevision, expectedRevision, expectedRevision, encoded, encoded, encoded])
  }
  async finishRenewal(operationId: string, receipt: PoolRenewalReceipt): Promise<boolean> {
    return !!await this.db.get(`UPDATE pool_operations SET status='confirmed',renewal_receipt_json=?,error=NULL,updated_at=?
      WHERE operation_id=? AND operation_kind='renewal' AND ark_txid=? AND status IN ('submitting','pending','unknown') RETURNING operation_id`,
    [JSON.stringify(receipt), Date.now(), operationId, receipt.proofTxid])
  }
  async saveRenewalReplay(operationId: string, replay: unknown, expectedRevision: number | null): Promise<boolean> {
    const next = replay as { version?: unknown; revision?: unknown; intentId?: unknown; events?: unknown[] }
    if (!next || next.version !== 1 || next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1) || !Array.isArray(next.events)) throw new Error('Invalid pool batch replay revision')
    const row = await this.operation(operationId), saved = row?.renewal_replay_json ?? null
    if (!row?.renewal_journal_json || JSON.parse(row.renewal_journal_json).intentId !== next.intentId) throw new Error('Pool batch replay changed its registered intent')
    if (saved) {
      const previous = JSON.parse(saved) as { events: unknown[] }
      if (previous.events.some((event, index) => JSON.stringify(event) !== JSON.stringify(next.events![index]))) throw new Error('Pool batch replay discarded its saved history')
    }
    return !!await this.db.get(`UPDATE pool_operations SET renewal_replay_json=?,updated_at=? WHERE operation_id=?
      AND operation_kind IN ('renewal','input-renewal') AND status IN ('submitting','pending','unknown') AND renewal_replay_json IS ?
      AND ((? IS NULL AND renewal_replay_json IS NULL) OR (? IS NOT NULL AND json_extract(renewal_replay_json,'$.revision')=?))
      RETURNING operation_id`, [JSON.stringify(replay), Date.now(), operationId, saved, expectedRevision, expectedRevision, expectedRevision])
  }
  async rejectUnpreparedRenewal(operationId: string): Promise<boolean> {
    return !!await this.db.get(`UPDATE pool_operations SET status='rejected',error='Interrupted before a renewal intent was saved',updated_at=?
      WHERE operation_id=? AND operation_kind='renewal' AND renewal_journal_json IS NULL AND status IN ('submitting','pending','unknown') RETURNING operation_id`, [Date.now(), operationId])
  }
  async abandonMaintenance(operationId: string, kind: 'renewal' | 'input-renewal', reason: string): Promise<boolean> {
    return !!await this.db.get(`UPDATE pool_operations SET status='rejected',error=?,updated_at=?
      WHERE operation_id=? AND operation_kind=? AND status IN ('submitting','pending','unknown') RETURNING operation_id`, [reason, Date.now(), operationId, kind])
  }
  async claimOperation(request: PoolSubmitRequest, requestHash: string, gameId?: string, operatorRequest?: PoolOperatorActionRequest, stage?: PoolOperatorStage): Promise<boolean> {
    try { return !!await this.db.get(`INSERT OR IGNORE INTO pool_operations
      (operation_id,request_hash,request_json,head_txid,head_vout,ark_txid,status,game_id,operator_request_json,operator_stage_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'submitting',?,?,?,?,?) RETURNING operation_id`, [request.operationId, requestHash,
      JSON.stringify(request), request.expectedHead.txid, request.expectedHead.vout, request.arkTxid, gameId ?? null,
      operatorRequest ? JSON.stringify(operatorRequest) : null, stage ? JSON.stringify(stage) : null, Date.now(), Date.now()]) }
    catch (error) { if (claimConflict(error)) return false; throw error }
  }
  activeInputRenewals(): Promise<PoolOperationRow[]> {
    return this.db.all<PoolOperationRow>("SELECT * FROM pool_operations WHERE operation_kind='input-renewal' AND status IN ('submitting','pending','unknown') ORDER BY created_at")
  }
  claimedWalletInputs(): Promise<Array<{ txid: string; vout: number }>> {
    return this.db.all("SELECT source_txid AS txid,source_vout AS vout FROM pool_wallet_input_claims")
  }
  async claimInputRenewal(operationId: string, request: { inputOutpoints: Array<{ txid: string; vout: number }>; address: string; outputSats: string; maximumFeeSats: string }): Promise<boolean> {
    if (!request.inputOutpoints.length) throw new Error('Wallet input renewal needs an explicit source')
    const source = request.inputOutpoints[0]
    try { return !!await this.db.get(`INSERT OR IGNORE INTO pool_operations
      (operation_id,request_hash,request_json,head_txid,head_vout,ark_txid,status,operation_kind,created_at,updated_at)
      VALUES (?,?,?,?,?,'','submitting','input-renewal',?,?) RETURNING operation_id`, [operationId, JSON.stringify(request), JSON.stringify(request),
      source.txid, source.vout, Date.now(), Date.now()]) }
    catch (error) { if (claimConflict(error)) return false; throw error }
  }
  async saveInputRenewalJournal(operationId: string, journal: { proof: string; message: unknown; sources: Array<{ txid: string; vout: number }>; address: string; outputSats: string; maximumFeeSats: string; registrationAttempted: boolean; intentId?: string }, proofTxid: string): Promise<void> {
    const row = await this.operation(operationId)
    if (!row || row.operation_kind !== 'input-renewal' || row.ark_txid && row.ark_txid !== proofTxid) throw new Error('Wallet input renewal changed its exact proof')
    const request = JSON.parse(row.request_json)
    if (JSON.stringify(request.inputOutpoints) !== JSON.stringify(journal.sources.map(({ txid, vout }) => ({ txid, vout }))) ||
        request.address !== journal.address || request.outputSats !== journal.outputSats || request.maximumFeeSats !== journal.maximumFeeSats) throw new Error('Wallet input renewal changed its selected sources or payout')
    if (row.renewal_journal_json) {
      const before = JSON.parse(row.renewal_journal_json)
      if (JSON.stringify(before.message) !== JSON.stringify(journal.message) || before.registrationAttempted && !journal.registrationAttempted ||
          before.intentId && before.intentId !== journal.intentId) throw new Error('Wallet input renewal changed its registered intent')
    }
    const saved = await this.db.get(`UPDATE pool_operations SET renewal_journal_json=?,ark_txid=?,updated_at=? WHERE operation_id=?
      AND operation_kind='input-renewal' AND status IN ('submitting','pending','unknown') AND renewal_journal_json IS ? RETURNING operation_id`,
    [JSON.stringify(journal), proofTxid, Date.now(), operationId, row.renewal_journal_json])
    if (!saved) throw new Error('Wallet input renewal lost its durable proof permission')
  }
  async finishInputRenewal(operationId: string, receipt: { proofTxid: string }): Promise<boolean> {
    return !!await this.db.get(`UPDATE pool_operations SET status='confirmed',renewal_receipt_json=?,error=NULL,updated_at=?
      WHERE operation_id=? AND operation_kind='input-renewal' AND ark_txid=? AND status IN ('submitting','pending','unknown') RETURNING operation_id`,
    [JSON.stringify(receipt), Date.now(), operationId, receipt.proofTxid])
  }
  async rejectUnregisteredInputRenewal(operationId: string, expectedJournal: string | null): Promise<boolean> {
    return !!await this.db.get(`UPDATE pool_operations SET status='rejected',error='Wallet renewal stopped before durable registration',updated_at=?
      WHERE operation_id=? AND operation_kind='input-renewal' AND status IN ('submitting','pending','unknown') AND renewal_journal_json IS ?
      AND (renewal_journal_json IS NULL OR COALESCE(json_extract(renewal_journal_json,'$.registrationAttempted'),0)=0) RETURNING operation_id`,
    [Date.now(), operationId, expectedJournal])
  }
  async saveOperatorStage(operationId: string, stage: PoolOperatorStage): Promise<void> {
    const row = await this.operation(operationId)
    if (!row?.operator_stage_json) throw new Error('Operator staging has no durable original plan')
    const before = JSON.parse(row.operator_stage_json) as PoolOperatorStage
    if (JSON.stringify(before.authorization) !== JSON.stringify(stage.authorization) || before.funding.arkTxid !== stage.funding.arkTxid ||
        before.funding.arkTx !== stage.funding.arkTx || JSON.stringify(before.funding.checkpointTxs) !== JSON.stringify(stage.funding.checkpointTxs) ||
        JSON.stringify(before.funding.inputOutpoints) !== JSON.stringify(stage.funding.inputOutpoints) || before.funding.submitted && !stage.funding.submitted ||
        before.funding.confirmed && !stage.funding.confirmed || before.refunded && !stage.refunded) throw new Error('Operator staging changed its saved funding plan')
    if (before.refund && before.refund.arkTxid !== stage.refund?.arkTxid &&
        !stage.refundHistory?.some(value => JSON.stringify(value) === JSON.stringify(before.refund))) throw new Error('Operator staging discarded an uncertain refund')
    if ((before.refundHistory ?? []).some((value, index) => JSON.stringify(value) !== JSON.stringify(stage.refundHistory?.[index]))) throw new Error('Operator staging discarded its refund history')
    const result = await this.db.get(`UPDATE pool_operations SET operator_stage_json=?,updated_at=? WHERE operation_id=?
      AND status IN ('submitting','pending','unknown') AND operator_stage_json IS ? RETURNING operation_id`,
    [JSON.stringify(stage), Date.now(), operationId, row.operator_stage_json])
    if (!result) throw new Error('Operator staging lost its durable submission permission')
  }
  async rejectUnsubmittedStage(operationId: string, expectedStage: string): Promise<boolean> {
    return !!await this.db.get(`UPDATE pool_operations SET status='rejected',error='Staging authorization expired before submission',updated_at=?
      WHERE operation_id=? AND status IN ('submitting','pending','unknown') AND operator_stage_json IS ?
      AND json_extract(operator_stage_json,'$.funding.submitted')=0 AND COALESCE(json_extract(operator_stage_json,'$.funding.confirmed'),0)=0
      RETURNING operation_id`, [Date.now(), operationId, expectedStage])
  }
  async saveRelay(id: string, relay: PoolRelay): Promise<boolean> {
    return !!await this.db.get(`UPDATE pool_operations SET relay_json=COALESCE(relay_json,?),updated_at=?
      WHERE operation_id=? AND status IN ('submitting','pending','unknown') RETURNING operation_id`, [JSON.stringify(relay), Date.now(), id])
  }
  async rejectUnprepared(id: string, error: string): Promise<boolean> {
    return !!await this.db.get(`UPDATE pool_operations SET status='rejected',error=?,updated_at=?
      WHERE operation_id=? AND status='submitting' AND relay_json IS NULL RETURNING operation_id`, [error, Date.now(), id])
  }
  async updateOperation(id: string, status: PoolOperationResponse['status'], values: { receipt?: PoolOperationReceipt; error?: string } = {}): Promise<void> {
    await this.db.run(`UPDATE pool_operations SET status=?,receipt_json=COALESCE(?,receipt_json),error=?,updated_at=?
      WHERE operation_id=? AND status IN ('submitting','pending','unknown')`,
    [status, values.receipt ? JSON.stringify(values.receipt) : null, values.error ?? null, Date.now(), id])
  }
}
