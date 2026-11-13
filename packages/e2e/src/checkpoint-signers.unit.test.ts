import { Transaction } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { signCheckpointsByOutpoint } from './test-helpers/checkpoint-signers'

function checkpoint(byte: number, vout: number): Transaction {
  const transaction = new Transaction({ allowUnknownOutputs: true })
  transaction.addInput({ txid: new Uint8Array(32).fill(byte), index: vout })
  transaction.addOutput({ script: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(3)]), amount: 1000n })
  return transaction
}

it('matches shuffled checkpoint responses to their actual owners and restores input order', async () => {
  const player = checkpoint(1, 0)
  const house = checkpoint(2, 1)
  const signedBy: string[] = []
  const identity = (owner: string) => ({ sign: async (transaction: Transaction) => {
    signedBy.push(`${owner}:${hex.encode(transaction.getInput(0).txid!)}`)
    return transaction
  } })
  const results = await signCheckpointsByOutpoint([house, player].map((value) => base64.encode(value.toPSBT())), [
    { checkpoint: player, identity: identity('player') },
    { checkpoint: house, identity: identity('house') },
  ])
  expect(signedBy).toEqual([`player:${'01'.repeat(32)}`, `house:${'02'.repeat(32)}`])
  expect(results).toEqual([player, house].map((value) => base64.encode(value.toPSBT())))
})

it('refuses unknown or duplicate checkpoints before asking either identity to sign', async () => {
  const player = checkpoint(1, 0)
  const house = checkpoint(2, 1)
  const sign = jest.fn()
  const expected = [{ checkpoint: player, identity: { sign } }, { checkpoint: house, identity: { sign } }]
  await expect(signCheckpointsByOutpoint([player, checkpoint(3, 1)].map((value) => base64.encode(value.toPSBT())), expected))
    .rejects.toThrow('Unexpected checkpoint outpoint')
  await expect(signCheckpointsByOutpoint([player, player].map((value) => base64.encode(value.toPSBT())), expected))
    .rejects.toThrow('Duplicate checkpoint outpoint')
  expect(sign).not.toHaveBeenCalled()
})
