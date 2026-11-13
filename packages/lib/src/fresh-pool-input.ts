import {
  arkade, asset, EmulatorPacket, Extension, Transaction, UnknownPacket, VtxoScript,
  buildOffchainTx, isVtxoSpent, resolveEmulatorPubkey, toXOnly,
  type ArkTxInput, type Identity, type IndexerProvider, type NormalizedExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { RawWitness } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import artifact from './artifact/fresh_pool_input.json'
import { freshPoolOwnerMessage } from './arkade-sighash'
import type { PoolGameDescriptor } from './pool-game-vault'

export interface PoolFreshAuthorization { validUntil: number; minTTL: number; ownerSig?: Uint8Array }
export type PoolFreshInput = NormalizedExtendedVirtualCoin & { sourceTx: Uint8Array; freshOwner: Uint8Array; freshPayout: Uint8Array }
export type PoolFreshBuilt = { arkTx: Transaction; checkpoints: Transaction[] }
export interface PoolFreshStageBuild extends PoolFreshBuilt { inputs: ArkTxInput[]; outputs: Array<ReturnType<Transaction['getOutput']>>; stagedInput: PoolFreshInput }
export const freshPoolInputProgram = arkade.programFromArtifact(artifact)
export const POOL_FRESH_MIN_TTL = 6000
export const POOL_FRESH_MAX_TTL = 33557520

export function poolInputPolicy(client: arkade.Arkade): { minTTL: number; recoveryMarginSeconds: number } {
  const delay = client.serverExitDelay
  if (!delay || delay < 512n || delay % 512n !== 0n || delay > 33553920n) throw new Error('Pool recovery requires a supported time-based operator exit delay')
  const recoveryMarginSeconds = Math.max(2400, Number(delay) + 300)
  if (recoveryMarginSeconds > 33553920) throw new Error('Operator exit delay exceeds the pool recovery bound')
  return { minTTL: Math.max(POOL_FRESH_MIN_TTL, recoveryMarginSeconds + 3600), recoveryMarginSeconds }
}

function same(first: Uint8Array | undefined, second: Uint8Array): boolean { return !!first && hex.encode(first) === hex.encode(second) }
function payout(script: Uint8Array): Uint8Array {
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) throw new Error('Fresh pool payout must be Taproot')
  return new Uint8Array([1, ...script.slice(2)])
}

export function createPoolFreshInput(client: arkade.Arkade, descriptor: Pick<PoolGameDescriptor, 'controlAssetId' | 'shareAssetId'>): arkade.ArkadeContract {
  const control = asset.AssetId.fromString(descriptor.controlAssetId), shares = asset.AssetId.fromString(descriptor.shareAssetId)
  return new arkade.ArkadeContract(client, freshPoolInputProgram, {
    controlTxid: Uint8Array.from(control.txid).reverse(), controlGidx: BigInt(control.groupIndex),
    shareTxid: Uint8Array.from(shares.txid).reverse(), shareGidx: BigInt(shares.groupIndex), server: client.serverKey,
    recoveryMargin: BigInt(poolInputPolicy(client).recoveryMarginSeconds),
  }, { serverKey: client.serverKey, emulatorKey: client.emulatorKey ?? hex.decode(resolveEmulatorPubkey(client.network)) })
}

function sourceFields(gate: arkade.ArkadeContract, descriptor: Pick<PoolGameDescriptor, 'shareAssetId'>,
  coin: NormalizedExtendedVirtualCoin & { sourceTx?: Uint8Array }): { owner: Uint8Array; script: Uint8Array; sourceTx: Uint8Array } {
  if (!coin.sourceTx) throw new Error('Fresh pool input source is missing')
  const source = Transaction.fromRaw(coin.sourceTx), output = source.getOutput(coin.vout), extension = Extension.fromTx(source)
  const owner = extension.getPacketByType(42)?.serialize(), target = extension.getPacketByType(43)?.serialize()
  if (source.id !== coin.txid || output.amount !== BigInt(coin.value) || !same(output.script, gate.pkScript) || coin.script !== hex.encode(gate.pkScript) ||
      owner?.length !== 32 || target?.length !== 33 || target[0] !== 1) throw new Error('Fresh pool input does not match its authenticated source')
  toXOnly(owner)
  const groups = extension.getAssetPacket()?.groups ?? []
  const assets = groups.flatMap(group => group.outputs.filter(value => value.vout === coin.vout).map(value => ({ assetId: group.assetId?.toString(), amount: value.amount })))
  const held = coin.assets ?? []
  if (assets.length !== held.length || held.length > 1 || held.some((value, i) => value.assetId !== descriptor.shareAssetId ||
    assets[i].assetId !== value.assetId || assets[i].amount !== value.amount || value.amount <= 0n)) throw new Error('Fresh pool input assets differ from its source')
  return { owner, script: new Uint8Array([0x51, 0x20, ...target.slice(1)]), sourceTx: coin.sourceTx }
}

export function poolFreshInputContext(client: arkade.Arkade, descriptor: PoolGameDescriptor, input: NormalizedExtendedVirtualCoin,
  authorization?: PoolFreshAuthorization): { gate: arkade.ArkadeContract; owner: Uint8Array; script: Uint8Array; sourceTx: Uint8Array; authorization: PoolFreshAuthorization; unlocker: arkade.ArkadeUnlocker } {
  const gate = createPoolFreshInput(client, descriptor), fields = sourceFields(gate, descriptor, input)
  const policy = poolInputPolicy(client)
  const auth = authorization ?? { validUntil: Math.floor(Date.now() / 1000) + 60, minTTL: policy.minTTL }
  if (!Number.isSafeInteger(auth.validUntil) || auth.validUntil <= Math.floor(Date.now() / 1000) || auth.validUntil > 0xffffffff ||
      !Number.isSafeInteger(auth.minTTL) || auth.minTTL < policy.minTTL || auth.minTTL > POOL_FRESH_MAX_TTL) throw new Error('Invalid fresh pool authorization window')
  const unlocker = gate.unlock.authorize(fields.owner, auth.ownerSig ?? new Uint8Array(64), auth.validUntil, auth.minTTL)
  return { gate, ...fields, authorization: auth, unlocker }
}

export function buildPoolFreshStage(client: arkade.Arkade, descriptor: PoolGameDescriptor, member: NormalizedExtendedVirtualCoin,
  ownerPubkey: Uint8Array, payoutScript: Uint8Array, authorization: PoolFreshAuthorization): PoolFreshStageBuild {
  const gate = createPoolFreshInput(client, descriptor), owner = toXOnly(ownerPubkey), target = payout(payoutScript)
  const policy = poolInputPolicy(client)
  if (!Number.isSafeInteger(authorization.minTTL) || authorization.minTTL < policy.minTTL || authorization.minTTL > POOL_FRESH_MAX_TTL ||
      !Number.isSafeInteger(authorization.validUntil) || authorization.validUntil <= Math.floor(Date.now() / 1000) || authorization.validUntil > 0xffffffff) throw new Error('Invalid fresh pool staging policy')
  if (!Number.isSafeInteger(member.value) || member.value < 330 || isVtxoSpent(member) || member.isUnrolled || member.isSwept ||
      !member.expiresAt || member.expiresAtHeight != null || member.expiresAt.getTime() < (authorization.validUntil + authorization.minTTL) * 1000 ||
      member.assets && (member.assets.length > 1 || member.assets.some(value => value.assetId !== descriptor.shareAssetId || value.amount <= 0n))) throw new Error('Renew this wallet input before staging it for the pool')
  const inputScript = VtxoScript.decode(member.tapTree).pkScript
  if (hex.encode(inputScript) !== member.script || !same(inputScript, payoutScript)) throw new Error('Fresh pool staging payout differs from the selected wallet input')
  const inputs = [{ txid: member.txid, vout: member.vout, value: member.value, tapTree: member.tapTree, tapLeafScript: member.forfeitTapLeafScript }]
  const held = member.assets?.[0], packets = [new UnknownPacket(42, owner), new UnknownPacket(43, target)]
  const extension = Extension.create([...(held ? [asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(held.assetId), null,
    [asset.AssetInput.create(0, held.amount)], [asset.AssetOutput.create(0, held.amount)], [])])] : []), ...packets])
  const outputs = [{ script: gate.pkScript, amount: BigInt(member.value) }, extension.txOut()]
  const built = buildOffchainTx(inputs, outputs, client.checkpoint), sourceTx = built.arkTx.toBytes()
  const leaf = gate.unlock.authorize(owner, new Uint8Array(64), authorization.validUntil, authorization.minTTL).fn.tapLeafScript
  const stagedInput: PoolFreshInput = { ...member, txid: built.arkTx.id, vout: 0, script: hex.encode(gate.pkScript), sourceTx,
    tapTree: gate.tapTree, forfeitTapLeafScript: leaf, intentTapLeafScript: leaf, freshOwner: owner, freshPayout: payoutScript,
    isSpent: false, spentBy: '', settledBy: '', arkTxId: '', isUnrolled: false, isSwept: false, isPreconfirmed: true }
  return { ...built, inputs, outputs, stagedInput }
}

export async function readPoolFreshInput(gate: arkade.ArkadeContract, descriptor: PoolGameDescriptor, outpoint: { txid: string; vout: number },
  indexer: Pick<IndexerProvider, 'getVtxos' | 'getVirtualTxs'>): Promise<PoolFreshInput> {
  const coins = (await indexer.getVtxos({ outpoints: [outpoint], spendableOnly: false })).vtxos.filter(coin => coin.txid === outpoint.txid && coin.vout === outpoint.vout)
  if (coins.length !== 1 || isVtxoSpent(coins[0]) || coins[0].isSwept || coins[0].isUnrolled) throw new Error('Fresh pool input is not available')
  const sources = (await indexer.getVirtualTxs([outpoint.txid])).txs.map(value => Transaction.fromPSBT(base64.decode(value))).filter(tx => tx.id === outpoint.txid)
  if (sources.length !== 1) throw new Error('Fresh pool input source is not indexed')
  const coin = { ...coins[0], sourceTx: sources[0].toBytes() } as PoolFreshInput
  const fields = sourceFields(gate, descriptor, coin), leaf = gate.unlock.authorize(fields.owner, new Uint8Array(64), 0xffffffff, POOL_FRESH_MIN_TTL).fn.tapLeafScript
  return { ...coin, tapTree: gate.tapTree, forfeitTapLeafScript: leaf, intentTapLeafScript: leaf, freshOwner: fields.owner, freshPayout: fields.script }
}

export function buildPoolFreshRefund(gate: arkade.ArkadeContract, descriptor: PoolGameDescriptor, input: PoolFreshInput,
  authorization: PoolFreshAuthorization): arkade.ArkadeTransactionBuilder {
  const fields = sourceFields(gate, descriptor, input)
  const builder = gate.functions.refund(fields.owner, authorization.ownerSig ?? new Uint8Array(64), authorization.validUntil)
    .from(input).to(fields.script, BigInt(input.value))
  const held = input.assets?.[0]
  if (held) builder.withPacket(asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(held.assetId), null,
    [asset.AssetInput.create(0, held.amount)], [asset.AssetOutput.create(0, held.amount)], [])]))
  return builder
}

export function readPoolFreshAuthorization(built: PoolFreshBuilt, mode: 'authorize' | 'refund' = 'authorize'): PoolFreshAuthorization & { owner: Uint8Array } {
  const vin = mode === 'authorize' ? 1 : 0, extension = Extension.fromTx(built.arkTx), packet = extension.getPacketByType(EmulatorPacket.PACKET_TYPE)
  if (!packet) throw new Error('Fresh pool authorization packet is missing')
  const entries = EmulatorPacket.fromBytes(packet.serialize()).entries, entry = entries.find(value => value.vin === vin)
  if (!entry) throw new Error('Fresh pool authorization input is missing')
  const witness = RawWitness.decode(entry.witness ?? new Uint8Array()), offset = mode === 'authorize' ? 1 : 0
  if (witness.length !== offset + 3 || witness[offset + 1].length !== 64 || witness[offset + 2].length !== 32) throw new Error('Invalid fresh pool authorization witness')
  return { owner: witness[offset + 2], ownerSig: witness[offset + 1], validUntil: Number(arkade.BigNum.decode(witness[offset])),
    minTTL: mode === 'authorize' ? Number(arkade.BigNum.decode(witness[0])) : POOL_FRESH_MIN_TTL }
}

export function verifyPoolFreshSpend(built: PoolFreshBuilt, mode: 'authorize' | 'refund' = 'authorize'): PoolFreshAuthorization & { owner: Uint8Array } {
  const authorization = readPoolFreshAuthorization(built, mode)
  const message = freshPoolOwnerMessage(built.arkTx, mode === 'authorize' ? 1 : 0, mode, authorization.validUntil, authorization.minTTL)
  if (!authorization.ownerSig || !schnorr.verify(authorization.ownerSig, message, authorization.owner)) throw new Error('Fresh pool owner authorization is invalid')
  return authorization
}

export async function authorizePoolFreshSpend(identity: Identity, built: PoolFreshBuilt, authorization: PoolFreshAuthorization,
  mode: 'authorize' | 'refund' = 'authorize'): Promise<PoolFreshBuilt & { authorization: PoolFreshAuthorization; message: Uint8Array }> {
  const vin = mode === 'authorize' ? 1 : 0, actual = readPoolFreshAuthorization(built, mode), owner = await identity.xOnlyPublicKey()
  if (!same(owner, actual.owner) || actual.validUntil !== authorization.validUntil || mode === 'authorize' && actual.minTTL !== authorization.minTTL) throw new Error('Fresh pool authorization differs from its consented plan')
  const message = freshPoolOwnerMessage(built.arkTx, vin, mode, actual.validUntil, actual.minTTL)
  const signature = authorization.ownerSig ?? await identity.signMessage(message, 'schnorr')
  if (signature.length !== 64 || !schnorr.verify(signature, message, owner)) throw new Error('Fresh pool owner signature is invalid')
  const arkTx = Transaction.fromPSBT(built.arkTx.toPSBT())
  for (let i = 0; i < arkTx.inputsLength; i++) if (arkTx.getInput(i).tapScriptSig?.length || arkTx.getInput(i).partialSig?.length || arkTx.getInput(i).tapKeySig) throw new Error('Authorize the fresh pool owner before native transaction signing')
  for (let i = 0; i < arkTx.outputsLength; i++) {
    const output = arkTx.getOutput(i)
    if (!output.script || !Extension.isExtension(output.script)) continue
    const extension = Extension.fromBytes(output.script), packets = extension.getPackets().map(packet => {
      if (packet.type() !== EmulatorPacket.PACKET_TYPE) return packet
      return EmulatorPacket.create(EmulatorPacket.fromBytes(packet.serialize()).entries.map(entry => {
        if (entry.vin !== vin) return entry
        const witness = RawWitness.decode(entry.witness ?? new Uint8Array())
        witness[mode === 'authorize' ? 2 : 1] = signature
        return { ...entry, witness: RawWitness.encode(witness) }
      }))
    })
    arkTx.updateOutput(i, { script: Extension.create(packets).serialize() })
  }
  if (!same(message, freshPoolOwnerMessage(arkTx, vin, mode, actual.validUntil, actual.minTTL))) throw new Error('Fresh pool owner signature changed the approved transaction semantics')
  return { arkTx, checkpoints: built.checkpoints.map(tx => Transaction.fromPSBT(tx.toPSBT())), message, authorization: { ...authorization, ownerSig: signature } }
}
