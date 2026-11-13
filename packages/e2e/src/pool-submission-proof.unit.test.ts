import { Transaction, type Wallet } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { verifyPoolSubmission, type PoolGameDescriptor } from 'arkade-coinflip/dist/pool-game-vault'
import type { PoolSubmitRequest } from 'arkade-coinflip/dist/pool-protocol'

const script = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(7)])
const encode = (tx: Transaction) => base64.encode(tx.toPSBT())
function fixture() {
  const originals = [11, 12].map(n => ({ txid: n.toString(16).padStart(64, '0'), vout: 0, value: 1000, script: hex.encode(script) }))
  const checkpoints = originals.map(coin => {
    const tx = new Transaction()
    tx.addInput({ txid: coin.txid, index: coin.vout, witnessUtxo: { script, amount: BigInt(coin.value) } })
    tx.addOutput({ script, amount: BigInt(coin.value) })
    return tx
  })
  const arkTx = new Transaction()
  for (const checkpoint of checkpoints) arkTx.addInput({ txid: checkpoint.id, index: 0 })
  arkTx.addOutput({ script, amount: 2000n })
  const request: PoolSubmitRequest = { operationId: 'proof-test', expectedHead: originals[0], arkTxid: arkTx.id,
    arkTx: encode(arkTx), checkpointTxs: checkpoints.map(encode), memberPubkey: '11'.repeat(32),
    command: { kind: 'subscribe', depositSats: '100', minShares: '100' } }
  const coins = originals.map((coin, i) => ({ ...coin, isSpent: true, spentBy: checkpoints[i].id, arkTxId: arkTx.id }))
  const getVtxos = jest.fn(async () => ({ vtxos: coins })), getVirtualTxs = jest.fn(async () => ({ txs: [encode(arkTx)] }))
  const wallet = { indexerProvider: { getVtxos, getVirtualTxs }, getArkadeInfo: jest.fn() } as unknown as Wallet
  return { originals, checkpoints, arkTx, request, coins, getVtxos, getVirtualTxs, wallet }
}
const descriptor = {} as PoolGameDescriptor

it('keeps an approved transaction pending when either original input lacks exact indexed consumption', async () => {
  for (const attack of ['unspent', 'checkpoint', 'arkTx', 'value', 'script'] as const) {
    const f = fixture()
    if (attack === 'unspent') { f.coins[1].isSpent = false; f.coins[1].spentBy = ''; f.coins[1].arkTxId = '' }
    if (attack === 'checkpoint') f.coins[1].spentBy = 'ff'.repeat(32)
    if (attack === 'arkTx') f.coins[1].arkTxId = 'ff'.repeat(32)
    if (attack === 'value') f.coins[1].value++
    if (attack === 'script') f.coins[1].script = '5120' + 'ff'.repeat(32)
    await expect(verifyPoolSubmission(f.wallet, descriptor, f.request)).resolves.toEqual({ status: 'pending' })
    expect(f.wallet.getArkadeInfo).not.toHaveBeenCalled()
  }
})

it('keeps a claimed conflicting spend pending when its checkpoint consumes another outpoint', async () => {
  const f = fixture(), checkpoint = f.checkpoints[0].clone()
  checkpoint.updateInput(0, { txid: 'ff'.repeat(32) })
  const conflicting = new Transaction()
  conflicting.addInput({ txid: checkpoint.id, index: 0 })
  conflicting.addOutput({ script, amount: 1000n })
  f.coins[0].spentBy = checkpoint.id; f.coins[0].arkTxId = conflicting.id
  f.getVirtualTxs.mockResolvedValue({ txs: [encode(conflicting), encode(checkpoint)] })
  await expect(verifyPoolSubmission(f.wallet, descriptor, f.request)).resolves.toEqual({ status: 'pending' })
})

it('accepts conflict only after the actual checkpoint and spender both bind the exact expected head', async () => {
  const f = fixture(), conflicting = new Transaction()
  conflicting.addInput({ txid: f.checkpoints[0].id, index: 0 })
  conflicting.addOutput({ script, amount: 999n })
  f.coins[0].arkTxId = conflicting.id
  f.getVirtualTxs.mockResolvedValue({ txs: [encode(conflicting), encode(f.checkpoints[0])] })
  await expect(verifyPoolSubmission(f.wallet, descriptor, f.request)).resolves.toEqual({ status: 'conflict' })
})

it('does not terminalize a missing original input despite a returned transaction PSBT', async () => {
  const f = fixture()
  f.getVtxos.mockResolvedValue({ vtxos: [f.coins[0]] })
  await expect(verifyPoolSubmission(f.wallet, descriptor, f.request)).resolves.toEqual({ status: 'pending' })
  expect(f.getVirtualTxs).not.toHaveBeenCalled()
})
