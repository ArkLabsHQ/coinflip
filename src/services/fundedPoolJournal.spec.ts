import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import type { Wallet } from '@arkade-os/sdk'
import {
  confirmFundedPoolJournal, loadFundedPoolJournal, putFundedPoolJournal, releaseFundedPoolInput,
  restorePoolHolds, updateFundedPoolJournal, type FundedPoolContext, type FundedPoolJournalEntry,
} from './fundedPoolJournal'
import type { FundedPoolDescriptor, FundedPoolQuote, FundedPoolReceipt } from './fundedPoolTypes'

let serial = 0
function context(): FundedPoolContext { return { publicKey: String(++serial), network: 'regtest', operatorUrl: 'http://localhost:37770' } }
function entry(scope = context(), id = 'operation'): FundedPoolJournalEntry {
  return { version: 1, id, context: scope, createdAt: Date.now(), status: 'pending', stage: 'prepared', error: null,
    descriptor: { name: 'Test pool' } as FundedPoolDescriptor,
    intent: { arkTxid: 'aa'.repeat(32), expectedHead: { txid: 'bb'.repeat(32), vout: 0 },
      memberOutpoint: { txid: 'cc'.repeat(32), vout: 1 }, unsignedArkTx: 'private-unsigned', unsignedCheckpoints: ['private-checkpoint'],
      signedArkTx: 'private-signed', signedCheckpoints: ['private-signed-checkpoint'],
      command: { kind: 'openGame', gameId: 'game' }, quote: { id, kind: 'openGame' } as FundedPoolQuote,
      playerSecretHex: 'secret-never-public' } }
}
function receipt(record: FundedPoolJournalEntry): FundedPoolReceipt {
  return { operationId: record.id, kind: 'openGame', arkTxid: record.intent!.arkTxid,
    poolOutpoint: { txid: record.intent!.arkTxid, vout: 0 }, memberOutpoint: null,
    depositedSats: '0', mintedShares: '0', burnedShares: '0', payoutSats: '0', playerStakeSats: '1000',
    houseStakeSats: '1000', memberDeltaSats: '-1000', outcome: 'house', verifiedAt: Date.now() }
}

describe('durable funded pool journal', () => {
  it('commits concurrent operations separately and preserves their exact recovery material', async () => {
    const scope = context()
    const first = entry(scope, 'first'), second = entry(scope, 'second')
    await Promise.all([putFundedPoolJournal(first), putFundedPoolJournal(second)])
    const records = await loadFundedPoolJournal(scope)
    expect(records.map(record => record.id).sort()).toEqual(['first', 'second'])
    expect(records.find(record => record.id === 'first')?.intent).toEqual(first.intent)
  })

  it('isolates identical operation IDs by wallet, network, and operator', async () => {
    const original = context()
    const scopes = [original, { ...original, publicKey: 'other' }, { ...original, network: 'bitcoin' },
      { ...original, operatorUrl: 'https://other.example' }]
    await Promise.all(scopes.map(scope => putFundedPoolJournal(entry(scope))))
    for (const scope of scopes) expect(await loadFundedPoolJournal(scope)).toHaveLength(1)
  })

  it('aborts an invalid update without erasing pending secrets or signed intent', async () => {
    const record = entry()
    await putFundedPoolJournal(record)
    await expect(updateFundedPoolJournal(record.context, record.id, current => ({ ...current, id: 'different' })))
      .rejects.toThrow(/identity cannot change/)
    expect((await loadFundedPoolJournal(record.context))[0]).toEqual(record)
  })

  it('rejects an unrelated receipt and keeps the operation recoverable', async () => {
    const record = entry()
    await putFundedPoolJournal(record)
    await expect(confirmFundedPoolJournal(record.context, record.id, { ...receipt(record), arkTxid: 'dd'.repeat(32) }))
      .rejects.toThrow(/does not match/)
    expect((await loadFundedPoolJournal(record.context))[0].intent?.playerSecretHex).toBe('secret-never-public')
  })

  it('retains only the verified public receipt after explicit confirmation', async () => {
    const record = entry()
    await putFundedPoolJournal(record)
    const verified = receipt(record)
    await confirmFundedPoolJournal(record.context, record.id, verified)
    const confirmed = (await loadFundedPoolJournal(record.context))[0]
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.receipt).toEqual(verified)
    expect(confirmed.intent).toBeUndefined()
    expect(JSON.stringify(confirmed)).not.toMatch(/secret-never-public|private-unsigned|private-signed/)
  })

  it('reinstates SDK input holds idempotently before spending resumes', async () => {
    const record = entry()
    await putFundedPoolJournal(record)
    const active = new Set<string>()
    const release = vi.fn(() => { active.clear() })
    const reserveVtxos = vi.fn(outpoints => {
      for (const outpoint of outpoints) {
        const key = `${outpoint.txid}:${outpoint.vout}`
        if (active.has(key)) throw new Error('Input already held')
        active.add(key)
      }
      return { outpoints, release }
    })
    const wallet = { reserveVtxos } as unknown as Wallet
    await restorePoolHolds(wallet, record.context)
    await restorePoolHolds(wallet, record.context)
    expect(reserveVtxos).toHaveBeenCalledOnce()
    expect(active.has(`${record.intent!.memberOutpoint.txid}:1`)).toBe(true)
    await updateFundedPoolJournal(record.context, record.id, saved => ({ ...saved, stage: 'recovery', error: 'HTTP timeout' }))
    expect(release).not.toHaveBeenCalled()
    releaseFundedPoolInput(wallet, record.id)
    expect(active.size).toBe(0)
  })

  it('restores the predicted cash-release input before the capital output reaches the wallet', async () => {
    const record = entry()
    record.intent!.cashRelease = { arkTxid: 'dd'.repeat(32), sourceOutpoint: { txid: record.intent!.arkTxid, vout: 1 },
      unsignedArkTx: 'cash-plan', unsignedCheckpoints: ['cash-checkpoint'], inputs: [], outputs: [],
      serverUnrollScriptHex: 'script', serverPubkeyHex: 'ee'.repeat(32), cashSats: '1000' }
    await putFundedPoolJournal(record)
    const reserveVtxos = vi.fn(outpoints => ({ outpoints, release: vi.fn() }))
    const wallet = { reserveVtxos } as unknown as Wallet
    await restorePoolHolds(wallet, record.context)
    await restorePoolHolds(wallet, record.context)
    expect(reserveVtxos).toHaveBeenCalledTimes(2)
    expect(reserveVtxos.mock.calls.map(call => call[0])).toEqual([[record.intent!.memberOutpoint], [record.intent!.cashRelease.sourceOutpoint]])
  })
})
