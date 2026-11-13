import { expect, it, vi } from 'vitest'
import { arkade, asset, CSVMultisigTapscript, DefaultVtxo, Extension, getNetwork, resolveEmulatorPubkey, SingleKey, Transaction, toXOnly, type NormalizedExtendedVirtualCoin } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { base64, hex } from '@scure/base'
import {
  authorizePoolFreshSpend, buildPoolFreshStage, buildPoolRedemption, createPoolGameVault, poolInputPolicy, poolPositionAfterRedemption, poolStatePackets,
  type PoolGameDescriptor, type PoolGamePosition,
} from 'arkade-coinflip/dist/pool-game-vault.js'

const key = (value: number) => new Uint8Array(32).fill(value)
const network = getNetwork('regtest')
const locking = new DefaultVtxo.Script({ pubKey: schnorr.getPublicKey(key(1)), serverPubKey: schnorr.getPublicKey(key(2)),
  csvTimelock: { type: 'seconds', value: 86_528n } })
const { AssetGroup, AssetInput, AssetOutput, AssetId, Packet } = asset

it('prebuilds real-artifact sequential redemptions from a future locally approved head without fetching that unbroadcast transaction', async () => {
  const control = AssetId.create(hex.encode(key(20)), 0), shares = AssetId.create(hex.encode(key(20)), 1)
  const descriptor = { controlAssetId: control.toString(), shareAssetId: shares.toString(),
    operatorPubkey: hex.encode(schnorr.getPublicKey(key(2))), operatorPayoutPkScript: hex.encode(locking.pkScript),
    operatorFeeBps: 2000, minHouseEdgeBps: 0, maxStakeBps: 2000 } as PoolGameDescriptor
  const sources = new Map<string, Transaction>()
  const getVirtualTxs = vi.fn(async (ids: string[]) => ({ txs: ids.map(id => {
    const source = sources.get(id)
    if (!source) throw new Error('The test indexer cannot serve an unbroadcast transaction')
    return base64.encode(source.toPSBT())
  }) }))
  const client = { network, serverKey: schnorr.getPublicKey(key(2)), serverExitDelay: 86_528n,
    emulatorKey: toXOnly(hex.decode(resolveEmulatorPubkey(network))),
    checkpoint: CSVMultisigTapscript.encode({ pubkeys: [schnorr.getPublicKey(key(2))], timelock: { type: 'seconds', value: 86_528n } }),
    indexer: { getVirtualTxs } } as unknown as arkade.Arkade
  const contract = createPoolGameVault(client, descriptor)
  const source = new Transaction()
  source.addInput({ txid: key(21), index: 0, witnessUtxo: { script: contract.pkScript, amount: 100330n } })
  source.addOutput({ script: contract.pkScript, amount: 100330n })
  source.addOutput(Extension.create([Packet.create([AssetGroup.create(control, null, [AssetInput.create(0, 1n)], [AssetOutput.create(0, 1n)], [])]),
    ...poolStatePackets({ supply: 100000000n, carriedLossSats: 0n, accruedFeesSats: 0n, phase: 'idle' })]).txOut())
  const position: PoolGamePosition = { coin: { txid: source.id, vout: 0, value: 100330 }, sourceTx: source.toBytes(),
    state: { supply: 100000000n, navSats: 100000n, carriedLossSats: 0n, accruedFeesSats: 0n, phase: 'idle' } }
  const members = [22, 23].map(value => {
    const funding = new Transaction()
    funding.addInput({ txid: key(value), index: 0, witnessUtxo: { script: locking.pkScript, amount: 330n } })
    funding.addOutput({ script: locking.pkScript, amount: 330n })
    funding.addOutput(Extension.create([Packet.create([AssetGroup.create(shares, null, [AssetInput.create(0, 50000000n)], [AssetOutput.create(0, 50000000n)], [])])]).txOut())
    sources.set(funding.id, funding)
    return { txid: funding.id, vout: 0, value: 330, script: hex.encode(locking.pkScript), assets: [{ assetId: shares.toString(), amount: 50000000n }],
      isUnrolled: false, isSpent: false, isSwept: false, expiresAt: new Date(Date.now() + 604_800_000), createdAt: new Date(), status: { confirmed: false },
      tapTree: locking.encode(), forfeitTapLeafScript: locking.forfeit(), intentTapLeafScript: locking.forfeit() } as NormalizedExtendedVirtualCoin
  })
  const owner = SingleKey.fromHex(hex.encode(key(1))), authorization = { validUntil: Math.floor(Date.now() / 1000) + 60, minTTL: poolInputPolicy(client).minTTL }
  const stagedFirst = buildPoolFreshStage(client, descriptor, members[0], await owner.xOnlyPublicKey(), locking.pkScript, authorization)
  const first = buildPoolRedemption(contract, descriptor, position, stagedFirst.stagedInput, 50000000n, undefined, authorization)
  const firstDraft = await first.builder.build(), firstBuilt = await authorizePoolFreshSpend(owner, firstDraft, authorization)
  expect(firstBuilt.arkTx.id).not.toBe(firstDraft.arkTx.id)
  expect(firstBuilt.checkpoints.map(checkpoint => checkpoint.id)).toEqual(firstDraft.checkpoints.map(checkpoint => checkpoint.id))
  const next = poolPositionAfterRedemption(contract, descriptor, position, firstBuilt.arkTx, 50000000n)!
  expect(next.state).toMatchObject({ navSats: 50000n, supply: 50000000n })
  const stagedSecond = buildPoolFreshStage(client, descriptor, members[1], await owner.xOnlyPublicKey(), locking.pkScript, authorization)
  const second = buildPoolRedemption(contract, descriptor, next, stagedSecond.stagedInput, 50000000n, undefined, authorization)
  const secondBuilt = await authorizePoolFreshSpend(owner, await second.builder.build(), authorization)
  expect(first.payoutSats + second.payoutSats).toBe(100000n)
  expect(secondBuilt.arkTx.getOutput(0).amount).toBe(50330n)
  expect(secondBuilt.arkTx.getOutput(1).amount).toBe(330n)
  expect(poolPositionAfterRedemption(contract, descriptor, next, secondBuilt.arkTx, 50000000n)).toBeUndefined()
  expect(getVirtualTxs.mock.calls.flatMap(call => call[0])).not.toContain(firstBuilt.arkTx.id)
  const changed = Transaction.fromPSBT(firstBuilt.arkTx.toPSBT())
  changed.updateOutput(0, { amount: 50329n })
  expect(() => poolPositionAfterRedemption(contract, descriptor, position, changed, 50000000n)).toThrow(/accounting/)
})
