import { base64, hex } from '@scure/base'
import { Transaction, arkade, type Identity, type NormalizedExtendedVirtualCoin } from '@arkade-os/sdk'
import { prepareSettleForEmulator } from 'arkade-coinflip'
import {
  authorizePoolFreshSpend, buildPoolFreshStage, createPoolFreshInput, readPoolFreshInput,
  type PoolFreshAuthorization, type PoolFreshBuilt, type PoolFreshInput, type PoolGameDescriptor,
} from 'arkade-coinflip/dist/pool-game-vault'
import { signCheckpointsByOutpoint } from './checkpoint-signers'

export async function stagePoolTestInput(client: arkade.Arkade, descriptor: PoolGameDescriptor,
  member: NormalizedExtendedVirtualCoin,
  authorization: PoolFreshAuthorization = { validUntil: Math.floor(Date.now() / 1000) + 120, minTTL: 6000 },
): Promise<{ coin: PoolFreshInput; authorization: PoolFreshAuthorization }> {
  const { identity, arkProvider } = client
  if (!identity || !client.indexer || !arkProvider.submitTx || !arkProvider.finalizeTx) throw new Error('Pool staging requires a signed operator connection')
  const script = member.script ? hex.decode(member.script) : undefined
  if (!script) throw new Error('Pool staging source has no wallet script')
  const built = buildPoolFreshStage(client, descriptor, member, await identity.xOnlyPublicKey(), script, authorization)
  const signed = await identity.sign(built.arkTx)
  const submitted = await arkProvider.submitTx(base64.encode(signed.toPSBT()), built.checkpoints.map(tx => base64.encode(tx.toPSBT())))
  const checkpoints = await signCheckpointsByOutpoint(submitted.signedCheckpointTxs, built.checkpoints.map(checkpoint => ({ checkpoint, identity })))
  await arkProvider.finalizeTx(submitted.arkTxid, checkpoints)
  const gate = createPoolFreshInput(client, descriptor), deadline = Date.now() + 30_000
  for (;;) {
    try { return { coin: await readPoolFreshInput(gate, descriptor, { txid: submitted.arkTxid, vout: 0 }, client.indexer), authorization } }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
}

export async function submitPoolTestSpend(client: arkade.Arkade, built: PoolFreshBuilt, authorization: PoolFreshAuthorization,
  owner: Identity = client.identity!, poolSigner?: Identity, mode: 'authorize' | 'refund' = 'authorize'): Promise<{ txid: string }> {
  if (!owner || !client.indexer || !client.emulator) throw new Error('Pool owner, indexer and emulator are required')
  const authorized = await authorizePoolFreshSpend(owner, built, authorization, mode)
  if (poolSigner) {
    authorized.arkTx = await poolSigner.sign(authorized.arkTx, [0])
    authorized.checkpoints[0] = await poolSigner.sign(authorized.checkpoints[0], [0])
  }
  const encoded = await prepareSettleForEmulator(authorized, client.indexer)
  const result = await client.emulator.submitTx(encoded.arkTx, encoded.checkpointTxs)
  return { txid: Transaction.fromPSBT(base64.decode(result.signedArkTx)).id }
}
