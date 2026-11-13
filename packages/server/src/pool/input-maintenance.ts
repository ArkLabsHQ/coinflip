import { randomUUID } from 'node:crypto'
import { Transaction } from '@arkade-os/sdk'
import { base64 } from '@scure/base'
import type { PoolGameDescriptor, PoolInputMaintenanceState } from 'arkade-coinflip'
import type { PoolInputRenewalJournal } from 'arkade-coinflip/dist/pool-input-renewal.js'
import { isPoolRenewalAbandoned } from 'arkade-coinflip/dist/pool-renewal-session.js'
import type { PoolAdapter, PoolInputReservation } from './adapter.js'
import type { PoolOperationRow, SQLitePoolRepository } from './repository.js'

export class PoolInputMaintenance {
  private running = false
  private error: string | undefined
  private readonly holds = new Map<string, PoolInputReservation>()
  constructor(private readonly repo: SQLitePoolRepository, private readonly adapter: PoolAdapter) {}

  async state(): Promise<PoolInputMaintenanceState> {
    const pending = await this.repo.activeInputRenewals()
    const error = pending.find(row => row.error)?.error || this.error
    return { status: pending.some(row => row.status === 'unknown') || error ? 'recovery' : pending.length ? 'renewing' : 'idle',
      pending: pending.length, ...(pending.length ? { sourceOutpoints: pending.map(row => ({ txid: row.head_txid, vout: row.head_vout })) } : {}),
      ...(error ? { error } : {}) }
  }

  async restore(): Promise<void> {
    for (const row of await this.repo.activeInputRenewals()) {
      const journal = row.renewal_journal_json ? JSON.parse(row.renewal_journal_json) as PoolInputRenewalJournal : undefined
      if (!journal?.registrationAttempted) {
        await this.repo.rejectUnregisteredInputRenewal(row.operation_id, row.renewal_journal_json)
      } else this.adapter.restoreInputRenewalHolds(journal)
    }
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    let row: PoolOperationRow | undefined
    try {
      const bootstrap = await this.repo.bootstrap()
      if (bootstrap?.status !== 'ready' || !bootstrap.descriptor_json) return
      const descriptor = JSON.parse(bootstrap.descriptor_json) as PoolGameDescriptor
      row = (await this.repo.activeInputRenewals())[0]
      const prepared = !row ? await this.adapter.prepareInputRenewal(descriptor, await this.repo.claimedWalletInputs()) : undefined
      if (!row) {
        if (!prepared) { this.error = undefined; return }
        const id = `input-renew:${randomUUID()}`
        let claimed = false
        try {
          claimed = await this.repo.claimInputRenewal(id, { inputOutpoints: prepared.plan.inputs.map(({ txid, vout }) => ({ txid, vout })),
            address: prepared.plan.address, outputSats: String(prepared.plan.outputSats), maximumFeeSats: String(prepared.plan.maximumFeeSats) })
          if (!claimed) return
          this.holds.set(id, prepared.reservation)
          row = (await this.repo.operation(id))!
        } finally { if (!claimed) prepared.reservation.release() }
      }
      const operationId = row.operation_id
      const receipt = await this.adapter.renewInputs({
        load: async () => {
          const value = (await this.repo.operation(operationId))?.renewal_journal_json
          return value ? JSON.parse(value) as PoolInputRenewalJournal : undefined
        },
        save: async journal => {
          const proof = Transaction.fromPSBT(base64.decode(journal.proof))
          await this.repo.saveInputRenewalJournal(operationId, journal, proof.id)
          await this.repo.updateOperation(operationId, 'pending')
        },
        loadSession: async () => {
          const value = (await this.repo.operation(operationId))?.renewal_session_json
          return value ? JSON.parse(value) : undefined
        },
        saveSession: (next, revision) => this.repo.saveRenewalSession(operationId, next, revision),
        loadReplay: async () => {
          const value = (await this.repo.operation(operationId))?.renewal_replay_json
          return value ? JSON.parse(value) : undefined
        },
        saveReplay: (next, revision) => this.repo.saveRenewalReplay(operationId, next, revision),
      }, prepared?.plan, AbortSignal.timeout(120_000), prepared?.reservation)
      const saved = (await this.repo.operation(operationId))!
      if (receipt.proofTxid !== saved.ark_txid || !await this.repo.finishInputRenewal(operationId, receipt)) {
        throw new Error('Founder input renewal receipt does not match its saved proof')
      }
      this.holds.get(operationId)?.release(); this.holds.delete(operationId)
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Founder input renewal needs recovery'
      if (row) {
        const current = await this.repo.operation(row.operation_id)
        const abandoned = isPoolRenewalAbandoned(error) && await this.repo.abandonMaintenance(row.operation_id, 'input-renewal', this.error)
        if (abandoned) this.error = undefined
        if (abandoned || (current && ['confirmed', 'rejected', 'conflict'].includes(current.status)) ||
            await this.repo.rejectUnregisteredInputRenewal(row.operation_id, current?.renewal_journal_json ?? null)) {
          this.holds.get(row.operation_id)?.release(); this.holds.delete(row.operation_id)
        } else await this.repo.updateOperation(row.operation_id, 'unknown', { error: this.error })
      }
      throw error
    } finally { this.running = false }
  }
}
