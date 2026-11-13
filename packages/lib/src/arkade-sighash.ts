import { EmulatorPacket, Extension, Transaction } from '@arkade-os/sdk'
import { RawOutput, VarBytes } from '@scure/btc-signer/script.js'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { sha256 } from '@scure/btc-signer/utils.js'

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0))
  let offset = 0
  for (const value of values) { result.set(value, offset); offset += value.length }
  return result
}

function uint(value: bigint, width: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(width * 8)) throw new Error('Invalid Arkade signature integer')
  const result = new Uint8Array(width)
  for (let i = 0; i < width; i++) { result[i] = Number(value & 255n); value >>= 8n }
  return result
}

function maskedOutputs(tx: Transaction): Uint8Array[] {
  let extensions = 0
  return Array.from({ length: tx.outputsLength }, (_, index) => {
    const output = tx.getOutput(index)
    if (output.amount === undefined || !output.script) throw new Error('Incomplete Arkade signature output')
    let script = output.script
    if (Extension.isExtension(script)) {
      if (++extensions > 1) throw new Error('Multiple Arkade signature extensions')
      const extension = Extension.fromBytes(script)
      const packets = extension.getPackets().map(packet => {
        if (packet.type() !== EmulatorPacket.PACKET_TYPE) return packet
        const emulator = EmulatorPacket.fromBytes(packet.serialize())
        return EmulatorPacket.create(emulator.entries.map(entry => ({ vin: entry.vin, script: entry.script, witness: new Uint8Array() })))
      })
      script = Extension.create(packets).serialize()
    }
    return RawOutput.encode({ amount: output.amount, script })
  })
}

export function arkadeAllSignatureMessage(tx: Transaction, inputIndex: number): Uint8Array {
  if (!Number.isSafeInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputsLength) throw new Error('Invalid Arkade signature input index')
  const inputs = Array.from({ length: tx.inputsLength }, (_, index) => tx.getInput(index))
  const leaf = inputs[inputIndex].tapLeafScript
  if (leaf?.length !== 1 || leaf[0][1].length < 2) throw new Error('Arkade signature requires one selected Bitcoin tapleaf')
  const script = leaf[0][1].slice(0, -1), version = leaf[0][1][leaf[0][1].length - 1]
  if (version !== 0xc0) throw new Error('Unsupported Arkade signature leaf version')
  const points: Uint8Array[] = [], amounts: Uint8Array[] = [], scripts: Uint8Array[] = [], sequences: Uint8Array[] = []
  for (const input of inputs) {
    if (!input.txid || input.txid.length !== 32 || input.index === undefined || !input.witnessUtxo || input.finalScriptWitness?.length || input.finalScriptSig?.length) throw new Error('Incomplete or finalized Arkade signature input')
    points.push(concat(Uint8Array.from(input.txid).reverse(), uint(BigInt(input.index), 4)))
    amounts.push(uint(input.witnessUtxo.amount, 8))
    scripts.push(VarBytes.encode(input.witnessUtxo.script))
    sequences.push(uint(BigInt(input.sequence ?? 0xffffffff), 4))
  }
  return concat(new Uint8Array([0, 1]), uint(BigInt(tx.version >>> 0), 4), uint(BigInt(tx.lockTime), 4),
    sha256(concat(...points)), sha256(concat(...amounts)), sha256(concat(...scripts)), sha256(concat(...sequences)),
    sha256(concat(...maskedOutputs(tx))), new Uint8Array([2]), uint(BigInt(inputIndex), 4),
    tapLeafHash(script, version), new Uint8Array([0]), new Uint8Array([255, 255, 255, 255]))
}

export function arkadeAllSighash(tx: Transaction, inputIndex: number): Uint8Array {
  const tag = sha256(new TextEncoder().encode('ArkadeTapSighash'))
  return sha256(concat(tag, tag, arkadeAllSignatureMessage(tx, inputIndex)))
}

export function freshPoolOwnerMessage(tx: Transaction, inputIndex: number, mode: 'authorize' | 'refund', validUntil: number, minTTL = 6000): Uint8Array {
  if (!Number.isSafeInteger(validUntil) || validUntil < 500_000_000 || validUntil > 0xffffffff ||
      !Number.isSafeInteger(minTTL) || minTTL < 6000 || minTTL > 33557520) throw new Error('Invalid fresh pool authorization bounds')
  return sha256(concat(new TextEncoder().encode(`coinflip/fresh-input/${mode}/v1`), arkadeAllSighash(tx, inputIndex),
    uint(BigInt(validUntil), 5), ...(mode === 'authorize' ? [uint(BigInt(minTTL), 4)] : [])))
}
