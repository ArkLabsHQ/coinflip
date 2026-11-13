import { Transaction, type Identity } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'

function outpoint(transaction: Transaction): string {
  if (transaction.inputsLength !== 1) throw new Error('Checkpoint must spend exactly one outpoint')
  const input = transaction.getInput(0)
  if (!input.txid || input.index === undefined) throw new Error('Checkpoint outpoint is missing')
  return `${hex.encode(input.txid)}:${input.index}`
}

/** Response ordering is unspecified. Match each checkpoint to its committed input and signer. */
export async function signCheckpointsByOutpoint(
  responses: string[],
  expected: { checkpoint: Transaction; identity: Pick<Identity, 'sign'> }[],
): Promise<string[]> {
  if (responses.length !== expected.length) throw new Error('Checkpoint count does not match the submitted inputs')
  const owners = new Set(expected.map((entry) => outpoint(entry.checkpoint)))
  if (owners.size !== expected.length) throw new Error('Submitted checkpoint outpoints are duplicated')
  const received = new Map<string, Transaction>()
  for (const response of responses) {
    const checkpoint = Transaction.fromPSBT(base64.decode(response))
    const key = outpoint(checkpoint)
    if (!owners.has(key)) throw new Error(`Unexpected checkpoint outpoint: ${key}`)
    if (received.has(key)) throw new Error(`Duplicate checkpoint outpoint: ${key}`)
    received.set(key, checkpoint)
  }
  return Promise.all(expected.map(async ({ checkpoint, identity }) => {
    const signed = await identity.sign(received.get(outpoint(checkpoint))!, [0])
    return base64.encode(signed.toPSBT())
  }))
}
