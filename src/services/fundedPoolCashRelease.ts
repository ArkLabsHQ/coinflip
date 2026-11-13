import {
  CSVMultisigTapscript, RestOperatorProvider, Transaction, assertAllowedSighashTypes,
  buildOffchainTx, isVtxoSpent, signAndSubmitOffchainTx, type Identity, type Wallet,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import type { FundedPoolCashRelease } from './fundedPoolJournal'

const decode = (value: string) => Transaction.fromPSBT(base64.decode(value))
const encode = (value: Transaction) => base64.encode(value.toPSBT())
function canonical(value: unknown): string {
  if (value instanceof Uint8Array) return hex.encode(value)
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${key}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
function assertApproved(local: Transaction, received: Transaction): void {
  assertAllowedSighashTypes(received)
  if (received.id !== local.id || received.inputsLength !== 1 || received.outputsLength !== local.outputsLength) throw new Error('Cash release differs from its approved transaction')
  const signing = (value: Transaction) => {
    const { partialSig, tapScriptSig, tapKeySig, ...input } = value.getInput(0)
    void partialSig; void tapScriptSig; void tapKeySig
    return { ...input, sighashType: input.sighashType ?? 0 }
  }
  if (canonical(signing(local)) !== canonical(signing(received))) throw new Error('Cash release signing metadata changed')
  for (let i = 0; i < local.outputsLength; i++) if (canonical(local.getOutput(i)) !== canonical(received.getOutput(i))) throw new Error('Cash release outputs changed')
}

export function mergePoolCashRelease(saved: FundedPoolCashRelease, proposed: FundedPoolCashRelease): FundedPoolCashRelease {
  const unsigned = ({ signedArkTx, signedCheckpoints, ...value }: FundedPoolCashRelease) => {
    void signedArkTx; void signedCheckpoints
    return value
  }
  if (canonical(unsigned(saved)) !== canonical(unsigned(proposed))) throw new Error('Saved native transfer identity changed')
  const merge = (local: string, prior?: string, next?: string): string | undefined => {
    if (!prior && !next) return undefined
    const approved = decode(local), winner = decode(prior ?? next!)
    assertApproved(approved, winner)
    if (prior && next) {
      const candidate = decode(next); assertApproved(approved, candidate)
      const left = winner.getInput(0), right = candidate.getInput(0)
      const signatures = <T extends [unknown, Uint8Array]>(a?: T[], b?: T[]): T[] | undefined => {
        if (!a && !b) return undefined
        const result = [...(a ?? [])]
        for (const item of b ?? []) if (!result.some(value => canonical(value[0]) === canonical(item[0]))) result.push(item)
        return result
      }
      winner.updateInput(0, { partialSig: signatures(left.partialSig, right.partialSig),
        tapScriptSig: signatures(left.tapScriptSig, right.tapScriptSig), tapKeySig: left.tapKeySig ?? right.tapKeySig })
    }
    return encode(winner)
  }
  if (saved.unsignedCheckpoints.length !== 1 || proposed.signedCheckpoints && proposed.signedCheckpoints.length !== 1) throw new Error('Saved native transfer checkpoint count changed')
  const checkpoint = merge(saved.unsignedCheckpoints[0], saved.signedCheckpoints?.[0], proposed.signedCheckpoints?.[0])
  return { ...saved, signedArkTx: merge(saved.unsignedArkTx, saved.signedArkTx, proposed.signedArkTx),
    signedCheckpoints: checkpoint ? [checkpoint] : undefined }
}

export async function provePoolCashRelease(wallet: Wallet, plan: FundedPoolCashRelease): Promise<boolean> {
  const approved = decode(plan.unsignedArkTx), checkpoint = decode(plan.unsignedCheckpoints[0])
  if (approved.id !== plan.arkTxid || approved.inputsLength !== 1 || plan.unsignedCheckpoints.length !== 1 || checkpoint.inputsLength !== 1 ||
      hex.encode(approved.getInput(0).txid!) !== checkpoint.id || approved.getInput(0).index !== 0 ||
      hex.encode(checkpoint.getInput(0).txid!) !== plan.sourceOutpoint.txid || checkpoint.getInput(0).index !== plan.sourceOutpoint.vout) {
    throw new Error('Cash release source does not match its approved checkpoint')
  }
  const coins = (await wallet.indexerProvider.getVtxos({ outpoints: [plan.sourceOutpoint], spendableOnly: false })).vtxos
  const matches = coins.filter(coin => coin.txid === plan.sourceOutpoint.txid && coin.vout === plan.sourceOutpoint.vout)
  if (matches.length !== 1 || !isVtxoSpent(matches[0]) || matches[0].spentBy !== checkpoint.id || matches[0].arkTxId !== approved.id) return false
  const previous = checkpoint.getInput(0).witnessUtxo
  if (!previous || matches[0].value !== Number(previous.amount) || matches[0].script !== hex.encode(previous.script)) throw new Error('Indexed cash release input changed')
  const actual = (await wallet.indexerProvider.getVirtualTxs([approved.id])).txs.map(decode).filter(transaction => transaction.id === approved.id)
  return actual.length === 1
}

export async function submitPoolCashRelease(options: {
  wallet: Wallet; operatorUrl: string; plan: FundedPoolCashRelease; allowSign: boolean
  isCurrent(): boolean
  save(plan: FundedPoolCashRelease): Promise<FundedPoolCashRelease>
}): Promise<void> {
  const { wallet, operatorUrl, allowSign, isCurrent, save } = options
  let plan = options.plan
  const current = () => { if (!isCurrent()) throw new Error('Wallet context changed during cash release') }
  const unroll = CSVMultisigTapscript.decode(hex.decode(plan.serverUnrollScriptHex))
  const built = buildOffchainTx(plan.inputs, plan.outputs, unroll)
  assertApproved(decode(plan.unsignedArkTx), built.arkTx)
  if (built.arkTx.id !== plan.arkTxid || built.checkpoints.length !== 1) throw new Error('Cash release reconstruction changed the approved transaction')
  assertApproved(decode(plan.unsignedCheckpoints[0]), built.checkpoints[0])
  const expected = new Map([[built.arkTx.id, built.arkTx], [built.checkpoints[0].id, built.checkpoints[0]]])
  const identity = new Proxy(wallet.identity, { get(target, property) {
    if (property === 'sign') return async (transaction: Transaction, indexes?: number[]) => {
      current()
      const local = expected.get(transaction.id)
      if (!local || indexes?.some(index => index !== 0)) throw new Error('Cash release requested an unapproved signature')
      assertApproved(local, transaction)
      const prior = transaction.id === built.arkTx.id ? plan.signedArkTx : plan.signedCheckpoints?.[0]
      if (prior) {
        const signed = decode(prior); assertApproved(local, signed)
        signed.combine(transaction); assertApproved(local, signed)
        plan = transaction.id === built.arkTx.id ? { ...plan, signedArkTx: encode(signed) } : { ...plan, signedCheckpoints: [encode(signed)] }
        plan = await save(plan); current()
        return decode(transaction.id === built.arkTx.id ? plan.signedArkTx! : plan.signedCheckpoints![0])
      }
      if (!allowSign) throw new Error('The saved cash release needs explicit recovery confirmation before signing')
      const signed = await target.sign(transaction, [0]); current()
      assertApproved(local, signed)
      plan = transaction.id === built.arkTx.id ? { ...plan, signedArkTx: encode(signed) } : { ...plan, signedCheckpoints: [encode(signed)] }
      plan = await save(plan); current()
      return decode(transaction.id === built.arkTx.id ? plan.signedArkTx! : plan.signedCheckpoints![0])
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as Identity
  const actual = new RestOperatorProvider(operatorUrl)
  const provider = new Proxy(actual, { get(target, property) {
    if (property === 'submitTx') return async (ark: string, checkpoints: string[]) => {
      current()
      assertApproved(built.arkTx, decode(ark))
      if (!plan.signedArkTx || ark !== plan.signedArkTx || checkpoints.length !== 1) throw new Error('Cash release submission has not been durably approved')
      assertApproved(built.checkpoints[0], decode(checkpoints[0]))
      plan = await save(plan); current()
      if (!plan.signedArkTx || !plan.signedCheckpoints) throw new Error('Cash release submission is missing its saved signatures')
      const response = await target.submitTx(plan.signedArkTx, plan.signedCheckpoints); current()
      if (response.arkTxid !== plan.arkTxid || response.signedCheckpointTxs.length !== 1) throw new Error('Cash release operator response changed the approved transaction')
      assertApproved(built.arkTx, decode(response.finalArkTx))
      assertApproved(built.checkpoints[0], decode(response.signedCheckpointTxs[0]))
      return response
    }
    if (property === 'finalizeTx') return async (id: string, checkpoints: string[]) => {
      current()
      if (id !== plan.arkTxid || checkpoints.length !== 1 || !plan.signedCheckpoints) throw new Error('Cash release finalization has not been durably approved')
      assertApproved(built.checkpoints[0], decode(checkpoints[0]))
      const signed = decode(checkpoints[0]), approvedSignatures = decode(plan.signedCheckpoints[0]).getInput(0).tapScriptSig ?? []
      if (!approvedSignatures.length || approvedSignatures.some(signature => !signed.getInput(0).tapScriptSig?.some(value => canonical(value) === canonical(signature)))) throw new Error('Cash release finalization removed approved signatures')
      plan = { ...plan, signedCheckpoints: checkpoints }
      plan = await save(plan); current()
      return target.finalizeTx(id, plan.signedCheckpoints!)
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const id = await signAndSubmitOffchainTx({ identity, provider, inputs: plan.inputs, outputs: plan.outputs, serverUnrollScript: unroll,
    verifyServerSignatures: { serverPubkey: hex.decode(plan.serverPubkeyHex) } })
  current()
  if (id !== plan.arkTxid) throw new Error('Cash release receipt changed the approved transaction')
}
