import { arkade, asset, buildOffchainTx, CSVMultisigTapscript, DefaultVtxo, EmulatorPacket, Extension, getArkPsbtFields, SingleKey, Transaction, UnknownPacket, VtxoScript, VtxoTaprootTree } from '@arkade-os/sdk'
import { RawWitness } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { sha256 } from '@scure/btc-signer/utils.js'
import { arkadeAllSignatureMessage, arkadeAllSighash, freshPoolOwnerMessage } from 'arkade-coinflip/dist/arkade-sighash'

const bytes = (n: number) => new Uint8Array(32).fill(n)
const concat = (...values: Uint8Array[]) => new Uint8Array(Buffer.concat(values.map(value => Buffer.from(value))))
async function fixture() {
  const owner = SingleKey.fromPrivateKey(bytes(1)), server = SingleKey.fromPrivateKey(bytes(2))
  const script = new DefaultVtxo.Script({ pubKey: await owner.xOnlyPublicKey(), serverPubKey: await server.xOnlyPublicKey(), csvTimelock: { type: 'seconds', value: 1536n } })
  const checkpoint = CSVMultisigTapscript.encode({ pubkeys: [await server.xOnlyPublicKey()], timelock: { type: 'seconds', value: 1536n } })
  const emulator = EmulatorPacket.create([0, 1].map(vin => ({ vin, script: arkade.ArkadeScript.encode([1]), witness: RawWitness.encode([new Uint8Array(64).fill(vin + 1)]) })))
  const assetPacket = asset.Packet.create([asset.AssetGroup.create(asset.AssetId.create('11'.repeat(32), 0), null,
    [asset.AssetInput.create(0, 1n)], [asset.AssetOutput.create(0, 1n)], [])])
  const built = buildOffchainTx([0, 1].map(vout => ({ txid: '22'.repeat(32), vout, value: 10000,
    tapTree: script.encode(), tapLeafScript: script.forfeit() })), [
    { script: script.pkScript, amount: 10000n }, { script: script.pkScript, amount: 10000n },
    Extension.create([emulator, assetPacket, new UnknownPacket(32, arkade.BigNum.encode(100n)), new UnknownPacket(36, bytes(3))]).txOut(),
  ], checkpoint)
  return { ...built, owner }
}

function replace(tx: Transaction, transform: (packets: ReturnType<Extension['getPackets']>) => ReturnType<Extension['getPackets']>): void {
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i)
    if (output.script && Extension.isExtension(output.script)) tx.updateOutput(i, { script: Extension.create([...transform(Extension.fromBytes(output.script).getPackets())]).serialize() })
  }
}

it('matches the public scure BIP342 digest byte layout with only the pinned Arkade domain tag changed', async () => {
  const { arkTx } = await fixture(), masked = Transaction.fromPSBT(arkTx.toPSBT())
  replace(masked, packets => packets.map(packet => packet.type() === 1 ? EmulatorPacket.create(EmulatorPacket.fromBytes(packet.serialize()).entries.map(entry => ({ ...entry, witness: new Uint8Array() }))) : packet))
  const inputs = [0, 1].map(index => arkTx.getInput(index)), leaf = inputs[1].tapLeafScript![0][1]
  const standard = masked.preimageWitnessV1(1, inputs.map(input => input.witnessUtxo!.script), 1, inputs.map(input => input.witnessUtxo!.amount),
    undefined, leaf.slice(0, -1), leaf[leaf.length - 1])
  const tag = sha256(new TextEncoder().encode('TapSighash'))
  expect(hex.encode(sha256(concat(tag, tag, arkadeAllSignatureMessage(arkTx, 1))))).toBe(hex.encode(standard))
  expect(hex.encode(arkadeAllSighash(arkTx, 1))).not.toBe(hex.encode(standard))
})

it('masks all emulator witness blobs while binding emulator scripts and every other packet', async () => {
  const { arkTx } = await fixture(), original = hex.encode(arkadeAllSighash(arkTx, 1))
  const signatures = Transaction.fromPSBT(arkTx.toPSBT())
  replace(signatures, packets => packets.map(packet => packet.type() === 1 ? EmulatorPacket.create(EmulatorPacket.fromBytes(packet.serialize()).entries.map(entry => ({ ...entry, witness: RawWitness.encode([new Uint8Array(64).fill(9), bytes(7)]) }))) : packet))
  expect(hex.encode(arkadeAllSighash(signatures, 1))).toBe(original)
  for (const changedType of [1, asset.Packet.PACKET_TYPE, 32, 36]) {
    const changed = Transaction.fromPSBT(arkTx.toPSBT())
    replace(changed, packets => packets.map(packet => packet.type() !== changedType ? packet : changedType === 1 ?
      EmulatorPacket.create(EmulatorPacket.fromBytes(packet.serialize()).entries.map(entry => ({ ...entry, script: arkade.ArkadeScript.encode([2]) }))) :
      changedType === asset.Packet.PACKET_TYPE ? asset.Packet.create([asset.AssetGroup.create(asset.AssetId.create('11'.repeat(32), 0), null,
        [asset.AssetInput.create(0, 2n)], [asset.AssetOutput.create(0, 2n)], [])]) : new UnknownPacket(changedType, new Uint8Array([...packet.serialize(), 1]))))
    expect(hex.encode(arkadeAllSighash(changed, 1))).not.toBe(original)
  }
})

it('binds physical checkpoint outpoints, input values and sequences, output values and selected Bitcoin leaf', async () => {
  const { arkTx } = await fixture(), original = hex.encode(arkadeAllSighash(arkTx, 1))
  const mutations: Array<(tx: Transaction) => Transaction | void> = [
    (tx: Transaction) => tx.updateInput(0, { txid: '33'.repeat(32) }),
    (tx: Transaction) => tx.updateInput(0, { witnessUtxo: { ...tx.getInput(0).witnessUtxo!, amount: 10001n } }),
    (tx: Transaction) => tx.updateInput(0, { sequence: 3 }),
    (tx: Transaction) => tx.updateOutput(1, { amount: 9999n }),
    (tx: Transaction) => {
      const result = new Transaction({ version: tx.version, lockTime: tx.lockTime })
      for (let i = 0; i < tx.inputsLength; i++) {
        const input = tx.getInput(i), leaf = input.tapLeafScript![0]
        const [tree] = getArkPsbtFields(tx, i, VtxoTaprootTree)
        const alternate = VtxoScript.decode(tree).leaves.find(value => hex.encode(value[1]) !== hex.encode(leaf[1]))!
        result.addInput({ ...input, ...(i === 1 ? { tapLeafScript: [alternate] } : {}) })
      }
      for (let i = 0; i < tx.outputsLength; i++) result.addOutput(tx.getOutput(i))
      return result
    },
  ]
  for (const mutate of mutations) {
    const changed = Transaction.fromPSBT(arkTx.toPSBT()), result = mutate(changed)
    expect(hex.encode(arkadeAllSighash(result instanceof Transaction ? result : changed, 1))).not.toBe(original)
  }
})

it('authenticates masked authorization deadlines and TTL separately with distinct refund and authorization domains', async () => {
  const { arkTx, owner } = await fixture(), deadline = 1_900_000_000
  const message = freshPoolOwnerMessage(arkTx, 1, 'authorize', deadline, 6000)
  expect((await owner.signMessage(message, 'schnorr')).length).toBe(64)
  expect(hex.encode(message)).not.toBe(hex.encode(freshPoolOwnerMessage(arkTx, 1, 'authorize', deadline + 1, 6000)))
  expect(hex.encode(message)).not.toBe(hex.encode(freshPoolOwnerMessage(arkTx, 1, 'authorize', deadline, 6001)))
  expect(hex.encode(message)).not.toBe(hex.encode(freshPoolOwnerMessage(arkTx, 1, 'refund', deadline, 6000)))
})
