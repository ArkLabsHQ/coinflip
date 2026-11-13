import { randomUUID } from 'node:crypto'
import { Transaction } from '@arkade-os/sdk'
import { base64 } from '@scure/base'
import type { PoolGameDescriptor, PoolGameSnapshot, PoolPublicResponse } from 'arkade-coinflip'
import type { PoolRenewalJournal } from 'arkade-coinflip/dist/pool-game-vault.js'
import { isPoolRenewalAbandoned } from 'arkade-coinflip/dist/pool-renewal-session.js'
import type { AppDeps } from '../deps.js'
import type { PoolAdapter, PoolInputReservation } from './adapter.js'
import type { PoolOperationRow, SQLitePoolRepository } from './repository.js'

export const POOL_MIN_TTL_SECONDS = 6000
export const POOL_GAME_FINAL_SECONDS = 3600
function requiredCapitalLifetimeSeconds(snapshot: PoolGameSnapshot): number {
  const minimum = snapshot.requiredLifetimeSeconds, margin = snapshot.recoveryMarginSeconds
  return Number.isSafeInteger(minimum) && Number.isSafeInteger(margin) && margin >= 2400 &&
    minimum >= Math.max(POOL_MIN_TTL_SECONDS, POOL_GAME_FINAL_SECONDS + margin) ? minimum : Infinity
}
export function requiredGameLifetimeSeconds(snapshot: PoolGameSnapshot): number {
  return requiredCapitalLifetimeSeconds(snapshot) + 300
}
export function capitalReady(snapshot: PoolGameSnapshot, feeOnly = false): boolean {
  return snapshot.expiresAtHeight === null && snapshot.expiresAt !== null &&
    snapshot.expiresAt > Date.now() + (feeOnly ? 60 : requiredCapitalLifetimeSeconds(snapshot) + 60) * 1000
}

export class PoolRenewalSupervisor {
  private running = false
  private readonly sponsorHolds = new Map<string, PoolInputReservation>()
  constructor(private readonly deps: AppDeps, private readonly repo: SQLitePoolRepository, private readonly adapter: PoolAdapter) {}

  async state(): Promise<NonNullable<PoolPublicResponse['renewal']>> {
    const row = await this.repo.activeRenewal()
    if (!row) return { status: 'idle' }
    const journal = row.renewal_journal_json ? JSON.parse(row.renewal_journal_json) as PoolRenewalJournal : undefined
    return { status: row.status === 'unknown' ? 'recovery' : 'renewing', operationId: row.operation_id,
      expectedHead: { txid: row.head_txid, vout: row.head_vout }, ...(journal ? { stage: journal.status } : {}),
      ...(row.error ? { error: row.error } : {}) }
  }

  async restore(): Promise<void> {
    const row = await this.repo.activeRenewal()
    if (!row) return
    if (!row.renewal_journal_json) { await this.repo.rejectUnpreparedRenewal(row.operation_id); return }
    this.adapter.restoreRenewalHolds(JSON.parse(row.renewal_journal_json) as PoolRenewalJournal)
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    let claimed: PoolOperationRow | undefined
    try {
      const bootstrap = await this.repo.bootstrap()
      if (bootstrap?.status !== 'ready' || !bootstrap.descriptor_json) return
      const descriptor = JSON.parse(bootstrap.descriptor_json) as PoolGameDescriptor
      claimed = await this.repo.activeRenewal()
      if (!claimed) {
        if (!await this.adapter.available()) return
        const head = await this.adapter.read(descriptor)
        const required = head ? requiredGameLifetimeSeconds(head) + 300 : Infinity
        const configured = Number(await this.deps.repos.config.get('pool_renewal_lead_seconds') ?? required)
        const lead = Number.isSafeInteger(configured) && configured >= required ? configured : required
        if (!head || head.expiresAtHeight !== null || head.expiresAt === null || !Number.isFinite(lead) ||
            head.expiresAt > Date.now() + lead * 1000) return
        const operationId = `renew:${randomUUID()}`
        if (!await this.repo.claimRenewal(operationId, head.outpoint)) return
        claimed = (await this.repo.operation(operationId))!
      }
      const operationId = claimed.operation_id
      const selected = !claimed.renewal_journal_json ? await this.adapter.reserveRenewalSponsor() : undefined
      if (selected) this.sponsorHolds.set(operationId, selected.reservation)
      const receipt = await this.adapter.renew(descriptor, {
        load: async () => {
          const saved = (await this.repo.operation(operationId))?.renewal_journal_json
          return saved ? JSON.parse(saved) as PoolRenewalJournal : undefined
        },
        save: async journal => {
          const proof = Transaction.fromPSBT(base64.decode(journal.proof))
          await this.repo.saveRenewalJournal(operationId, journal, proof.id)
          await this.repo.updateOperation(operationId, 'pending')
        },
        loadSession: async () => {
          const saved = (await this.repo.operation(operationId))?.renewal_session_json
          return saved ? JSON.parse(saved) : undefined
        },
        saveSession: (session, expectedRevision) => this.repo.saveRenewalSession(operationId, session, expectedRevision),
        loadReplay: async () => {
          const saved = (await this.repo.operation(operationId))?.renewal_replay_json
          return saved ? JSON.parse(saved) : undefined
        },
        saveReplay: (replay, expectedRevision) => this.repo.saveRenewalReplay(operationId, replay, expectedRevision),
      }, selected?.sponsor, AbortSignal.timeout(120_000), selected?.reservation)
      const stored = (await this.repo.operation(operationId))!
      if (!stored.renewal_journal_json || receipt.proofTxid !== stored.ark_txid ||
          !receipt.nextHead || receipt.nextHead.txid === stored.head_txid && receipt.nextHead.vout === stored.head_vout) {
        throw new Error('Pool renewal receipt does not match the saved batch proof')
      }
      if (!await this.repo.finishRenewal(operationId, receipt)) throw new Error('Pool renewal lost its completion permission')
      this.sponsorHolds.get(operationId)?.release(); this.sponsorHolds.delete(operationId)
    } catch (error) {
      if (claimed && isPoolRenewalAbandoned(error) && await this.repo.abandonMaintenance(claimed.operation_id, 'renewal', (error as Error).message)) {
        this.sponsorHolds.get(claimed.operation_id)?.release(); this.sponsorHolds.delete(claimed.operation_id)
      } else if (claimed) {
        const current = await this.repo.operation(claimed.operation_id)
        if (current && ['confirmed', 'rejected', 'conflict'].includes(current.status)) {
          this.sponsorHolds.get(claimed.operation_id)?.release(); this.sponsorHolds.delete(claimed.operation_id)
        } else if (current?.renewal_journal_json) await this.repo.updateOperation(claimed.operation_id, 'unknown', {
          error: error instanceof Error ? error.message : 'Pool renewal needs recovery' })
        else if (await this.repo.rejectUnpreparedRenewal(claimed.operation_id)) {
          this.sponsorHolds.get(claimed.operation_id)?.release(); this.sponsorHolds.delete(claimed.operation_id)
        }
      }
      throw error
    } finally { this.running = false }
  }
}
