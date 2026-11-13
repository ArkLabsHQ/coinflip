import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asset, buildOffchainTx, CSVMultisigTapscript, DefaultVtxo, Extension, RestOperatorProvider, SingleKey, Transaction, type Wallet } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { base64, hex } from '@scure/base'
import { mergePoolCashRelease, provePoolCashRelease, submitPoolCashRelease } from './fundedPoolCashRelease'
import type { FundedPoolCashRelease } from './fundedPoolJournal'

const key = (value: number) => new Uint8Array(32).fill(value)
const locking = new DefaultVtxo.Script({ pubKey: schnorr.getPublicKey(key(1)), serverPubKey: schnorr.getPublicKey(key(2)),
  csvTimelock: { type: 'seconds', value: 86_528n } })
const unroll = CSVMultisigTapscript.encode({ pubkeys: [schnorr.getPublicKey(key(2))], timelock: { type: 'seconds', value: 86_528n } })
const encode = (transaction: Transaction) => base64.encode(transaction.toPSBT())
const decode = (value: string) => Transaction.fromPSBT(base64.decode(value))
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected unit-test network request') })) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture() {
  const { AssetGroup, AssetInput, AssetOutput, AssetId, Packet } = asset
  const shares = AssetId.create(hex.encode(key(20)), 1)
  const inputs = [{ txid: hex.encode(key(11)), vout: 1, value: 20000, tapTree: locking.encode(), tapLeafScript: locking.forfeit() }]
  const outputs = [{ script: locking.pkScript, amount: 330n }, { script: locking.pkScript, amount: 19670n },
    Extension.create([Packet.create([AssetGroup.create(shares, null, [AssetInput.create(0, 5000000n)], [AssetOutput.create(0, 5000000n)], [])])]).txOut()]
  const built = buildOffchainTx(inputs, outputs, unroll)
  const plan: FundedPoolCashRelease = { arkTxid: built.arkTx.id, sourceOutpoint: { txid: inputs[0].txid, vout: 1 },
    unsignedArkTx: encode(built.arkTx), unsignedCheckpoints: built.checkpoints.map(encode), inputs, outputs,
    serverUnrollScriptHex: hex.encode(unroll.script), serverPubkeyHex: hex.encode(schnorr.getPublicKey(key(2))), cashSats: '19670' }
  const identity = SingleKey.fromHex(hex.encode(key(1))), operator = SingleKey.fromHex(hex.encode(key(2)))
  const sign = vi.spyOn(identity, 'sign')
  let saved = plan
  const save = vi.fn(async (value: FundedPoolCashRelease) => { saved = mergePoolCashRelease(saved, value); return saved })
  const coin = { ...plan.sourceOutpoint, script: hex.encode(locking.pkScript), value: 20000, isSpent: false, spentBy: '', arkTxId: '' }
  const getVtxos = vi.fn(async () => ({ vtxos: [coin] }))
  let actual = built.arkTx
  const wallet = { identity, indexerProvider: { getVtxos, getVirtualTxs: vi.fn(async () => ({ txs: [encode(actual)] })) } } as unknown as Wallet
  const submit = vi.spyOn(RestOperatorProvider.prototype, 'submitTx').mockImplementation(async (ark, checkpoints) => {
    expect(saved.signedArkTx === ark).toBe(true)
    expect(saved.signedCheckpoints?.[0] === checkpoints[0]).toBe(true)
    actual = await operator.sign(decode(ark), [0])
    const checkpoint = await operator.sign(decode(checkpoints[0]), [0])
    coin.isSpent = true; coin.spentBy = checkpoint.id; coin.arkTxId = actual.id
    return { arkTxid: actual.id, finalArkTx: encode(actual), signedCheckpointTxs: [encode(checkpoint)] }
  })
  const finalize = vi.spyOn(RestOperatorProvider.prototype, 'finalizeTx').mockResolvedValue()
  return { plan, built, identity, operator, sign, wallet, save, submit, finalize, get saved() { return saved } }
}

describe('reviewed asset-preserving cash release', () => {
  it('preserves all shares on330 sats and durably saves both user signatures before SDK submission', async () => {
    const f = fixture()
    const packet = Extension.fromTx(f.built.arkTx).getAssetPacket()!
    expect(packet.groups[0].inputs[0].amount).toBe(5000000n)
    expect(packet.groups[0].outputs).toMatchObject([{ vout: 0, amount: 5000000n }])
    expect(f.built.arkTx.getOutput(0).amount).toBe(330n)
    expect(f.built.arkTx.getOutput(1).amount).toBe(19670n)
    expect(await provePoolCashRelease(f.wallet, f.plan)).toBe(false)
    await submitPoolCashRelease({ wallet: f.wallet, operatorUrl: 'http://unused.test', plan: f.plan, allowSign: true,
      isCurrent: () => true, save: f.save })
    expect(f.sign).toHaveBeenCalledTimes(2)
    expect(f.save).toHaveBeenCalled()
    expect(f.submit).toHaveBeenCalledOnce()
    expect(await provePoolCashRelease(f.wallet, f.saved)).toBe(true)
  })

  it('refuses fresh signatures on refresh and blocks a changed frozen output plan before signing', async () => {
    const f = fixture()
    await expect(submitPoolCashRelease({ wallet: f.wallet, operatorUrl: 'http://unused.test', plan: f.plan, allowSign: false,
      isCurrent: () => true, save: f.save })).rejects.toThrow(/explicit recovery/)
    const changed = { ...f.plan, outputs: f.plan.outputs.map((output, index) => index === 1 ? { ...output, amount: 19669n } : output) }
    await expect(submitPoolCashRelease({ wallet: f.wallet, operatorUrl: 'http://unused.test', plan: changed, allowSign: true,
      isCurrent: () => true, save: f.save })).rejects.toThrow()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('reuses cached signatures while preserving new operator checkpoint signatures during SDK fallback finalization', async () => {
    const f = fixture()
    const ark = await f.identity.sign(f.built.arkTx, [0]), checkpoint = await f.identity.sign(f.built.checkpoints[0], [0])
    const plan = { ...f.plan, signedArkTx: encode(ark), signedCheckpoints: [encode(checkpoint)] }
    f.sign.mockClear()
    f.submit.mockImplementation(async (encodedArk, checkpoints) => {
      const signedArk = await f.operator.sign(decode(encodedArk), [0])
      const serverOnly = await f.operator.sign(decode(f.plan.unsignedCheckpoints[0]), [0])
      expect(decode(checkpoints[0]).getInput(0).tapScriptSig?.length).toBe(1)
      return { arkTxid: signedArk.id, finalArkTx: encode(signedArk), signedCheckpointTxs: [encode(serverOnly)] }
    })
    f.finalize.mockImplementation(async (_id, checkpoints) => {
      expect(decode(checkpoints[0]).getInput(0).tapScriptSig).toHaveLength(2)
      expect(f.saved.signedCheckpoints?.[0] === checkpoints[0]).toBe(true)
    })
    await submitPoolCashRelease({ wallet: f.wallet, operatorUrl: 'http://unused.test', plan, allowSign: false,
      isCurrent: () => true, save: f.save })
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.finalize).toHaveBeenCalledOnce()
  })

  it('rejects changed operator checkpoint signing data even when the unsigned transaction ID matches', async () => {
    const f = fixture()
    f.submit.mockImplementation(async (ark, checkpoints) => {
      const signedArk = await f.operator.sign(decode(ark), [0]), changed = decode(f.plan.unsignedCheckpoints[0])
      changed.updateInput(0, { witnessUtxo: { script: locking.pkScript, amount: 21000n } })
      changed.updateInput(0, { tapScriptSig: decode(checkpoints[0]).getInput(0).tapScriptSig })
      expect(changed.id).toBe(f.built.checkpoints[0].id)
      return { arkTxid: signedArk.id, finalArkTx: encode(signedArk), signedCheckpointTxs: [encode(changed)] }
    })
    await expect(submitPoolCashRelease({ wallet: f.wallet, operatorUrl: 'http://unused.test', plan: f.plan, allowSign: true,
      isCurrent: () => true, save: f.save })).rejects.toThrow(/signing metadata/)
    expect(f.finalize).not.toHaveBeenCalled()
    expect(f.saved.signedArkTx).toBeTruthy()
    expect(f.saved.signedCheckpoints).toHaveLength(1)
  })
})
