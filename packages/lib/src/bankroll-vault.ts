import {
  arkade, asset, Extension, P2A, Transaction, UnknownPacket, VtxoScript,
  getAllNormalizedVtxos, isVtxoSpent,
  type Asset, type IndexerProvider, type NormalizedExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import artifact from './artifact/bankroll_vault.json'

export interface BankrollVaultAssets {
  controlAssetId: string
  shareAssetId: string
}

export interface BankrollVaultPosition {
  coin: arkade.Utxo
  navSats: bigint
  supply: bigint
  sourceTx: Uint8Array
}

export type BankrollVaultContract = arkade.ArkadeContract
type Vault = BankrollVaultContract
type Indexer = Pick<IndexerProvider, 'getVtxos' | 'getVirtualTxs'>
const DUST = 330n
const MAX_NAV = 1_000_000n
const MAX_SUPPLY = 1_000_000_000_000n
const MAX_MONEY = 2_100_000_000_000_000n
const STATE_PACKET = 32
const { AssetId, AssetRefType, AssetInputType, AssetGroup, AssetInput, AssetOutput, Packet } = asset

export const bankrollVaultProgram = arkade.programFromArtifact(artifact)

function bounded(value: bigint, min: bigint, max: bigint, name: string): void {
  if (typeof value !== 'bigint' || value < min || value > max) throw new Error(`Invalid ${name}`)
}

function same(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return !!left && hex.encode(left) === hex.encode(right)
}

function assetIds(assets: BankrollVaultAssets) {
  const control = AssetId.fromString(assets.controlAssetId)
  const shares = AssetId.fromString(assets.shareAssetId)
  if (control.toString() === shares.toString()) throw new Error('Control and share assets must differ')
  return { control, shares }
}

function assertContract(contract: Vault, assets: BankrollVaultAssets): void {
  const { control, shares } = assetIds(assets)
  for (const [prefix, id] of [['control', control], ['share', shares]] as const) {
    const txid = contract.args[`${prefix}Txid`]
    const gidx = contract.args[`${prefix}Gidx`]
    if (!(txid instanceof Uint8Array) || !same(txid, Uint8Array.from(id.txid).reverse()) ||
        (typeof gidx !== 'bigint' && typeof gidx !== 'number') || BigInt(gidx) !== BigInt(id.groupIndex)) {
      throw new Error('Vault constructor does not bind the supplied assets')
    }
  }
  const expected = new arkade.ArkadeProgramScript(bankrollVaultProgram, contract.args, contract.keys)
  if (!same(expected.pkScript, contract.pkScript)) throw new Error('Contract is not the compiled bankroll vault')
}

export function createBankrollVault(client: arkade.Arkade, assets: BankrollVaultAssets): Vault {
  const { control, shares } = assetIds(assets)
  return client.contract(bankrollVaultProgram, {
    controlTxid: Uint8Array.from(control.txid).reverse(), controlGidx: BigInt(control.groupIndex),
    shareTxid: Uint8Array.from(shares.txid).reverse(), shareGidx: BigInt(shares.groupIndex),
  })
}

export function bankrollStatePacket(supply: bigint): UnknownPacket {
  bounded(supply, 1n, MAX_SUPPLY, 'share supply')
  return new UnknownPacket(STATE_PACKET, arkade.BigNum.encode(supply))
}

function stateSupply(tx: Transaction): bigint {
  const bytes = Extension.fromTx(tx).getPacketByType(STATE_PACKET)?.serialize()
  if (!bytes || bytes.length < 1 || bytes.length > 6) throw new Error('Missing or invalid vault supply packet')
  const supply = arkade.BigNum.decode(bytes)
  bounded(supply, 1n, MAX_SUPPLY, 'share supply')
  if (!same(bytes, arkade.BigNum.encode(supply))) throw new Error('Non-minimal vault supply packet')
  return supply
}

function outputAssets(tx: Transaction, vout: number): Asset[] {
  const packet = Extension.fromTx(tx).getAssetPacket()
  if (!packet) throw new Error('Missing vault asset packet')
  return packet.groups.flatMap((group, index) => group.outputs
    .filter(output => output.vout === vout)
    .map(output => ({ assetId: (group.assetId ?? AssetId.create(tx.id, index)).toString(), amount: output.amount })))
}

function soleAsset(assets: readonly Asset[] | undefined, id: string, amount: bigint): boolean {
  return assets?.length === 1 && assets[0].assetId === id && assets[0].amount === amount
}

async function sourceTransaction(txid: string, indexer: Pick<IndexerProvider, 'getVirtualTxs'>): Promise<Transaction> {
  const { txs } = await indexer.getVirtualTxs([txid])
  const matching = txs.map(encoded => Transaction.fromPSBT(base64.decode(encoded))).filter(tx => tx.id === txid)
  if (matching.length !== 1) throw new Error('Indexer did not return exactly the requested source transaction')
  return matching[0]
}

function assertPosition(contract: Vault, assets: BankrollVaultAssets, position: BankrollVaultPosition): void {
  assertContract(contract, assets)
  bounded(position.navSats, DUST, MAX_NAV, 'vault NAV')
  bounded(position.supply, 1n, MAX_SUPPLY, 'share supply')
  const { coin } = position
  const source = Transaction.fromRaw(position.sourceTx)
  const output = source.getOutput(coin.vout)
  if (coin.vout !== 0 || source.id !== coin.txid || !Number.isSafeInteger(coin.value) ||
      BigInt(coin.value) !== position.navSats || output.amount !== position.navSats ||
      !same(output.script, contract.pkScript) || stateSupply(source) !== position.supply ||
      !soleAsset(outputAssets(source, coin.vout), assets.controlAssetId, 1n) ||
      !soleAsset(coin.assets, assets.controlAssetId, 1n)) {
    throw new Error('Vault position does not match its source transaction')
  }
}

export async function readBankrollVaultPosition(
  contract: Vault, assets: BankrollVaultAssets, indexer: Indexer,
): Promise<BankrollVaultPosition | undefined> {
  assertContract(contract, assets)
  const script = hex.encode(contract.pkScript)
  const coins = (await getAllNormalizedVtxos(indexer, [script], { spendableOnly: false })).filter(coin =>
    coin.script === script && !isVtxoSpent(coin) && soleAsset(coin.assets, assets.controlAssetId, 1n))
  if (coins.length > 1) throw new Error('Multiple live control-bearing vault outputs')
  if (coins.length === 0) return undefined
  const coin = coins[0]
  if (coin.isUnrolled || coin.isSwept || (coin.expiresAt && coin.expiresAt.getTime() <= Date.now())) {
    throw new Error('Vault control coin is unavailable offchain and requires recovery')
  }
  if (coin.expiresAtHeight !== undefined) throw new Error('Vault control coin availability requires a current chain height')
  const source = await sourceTransaction(coin.txid, indexer)
  const sourceTx = source.toBytes()
  const position = { coin: { ...coin, sourceTx }, navSats: BigInt(coin.value), supply: stateSupply(source), sourceTx }
  assertPosition(contract, assets, position)
  return position
}

function memberInput(contract: Vault, position: BankrollVaultPosition, member: NormalizedExtendedVirtualCoin) {
  if (!Number.isSafeInteger(member.value)) throw new Error('Invalid member carrier')
  bounded(BigInt(member.value), DUST, MAX_MONEY, 'member carrier')
  const script = VtxoScript.decode(member.tapTree).pkScript
  if (member.script !== hex.encode(script) || same(script, contract.pkScript) || isVtxoSpent(member) ||
      member.isUnrolled || member.isSwept || (member.expiresAt && member.expiresAt.getTime() <= Date.now()) ||
      (member.txid === position.coin.txid && member.vout === position.coin.vout)) {
    throw new Error('Member input is unavailable or does not match its spending script')
  }
  return {
    input: { txid: member.txid, vout: member.vout, value: member.value,
      tapLeafScript: member.forfeitTapLeafScript, tapTree: member.tapTree },
    script,
  }
}

export function buildBankrollSubscription(
  contract: Vault, assets: BankrollVaultAssets, position: BankrollVaultPosition,
  member: NormalizedExtendedVirtualCoin, deposit: bigint, minShares?: bigint,
): { builder: arkade.ArkadeTransactionBuilder; mintedShares: bigint; nextSupply: bigint } {
  assertPosition(contract, assets, position)
  bounded(deposit, 1n, MAX_NAV - position.navSats, 'deposit')
  const { input, script } = memberInput(contract, position, member)
  if (member.assets?.length || BigInt(member.value) < deposit + DUST) throw new Error('Deposit needs a plain input and viable change')
  const mintedShares = deposit * position.supply / position.navSats
  bounded(mintedShares, 1n, MAX_SUPPLY - position.supply, 'minted shares')
  const minimum = minShares ?? mintedShares
  bounded(minimum, 1n, MAX_SUPPLY, 'minimum shares')
  if (mintedShares < minimum) throw new Error('Subscription quote is below minimum shares')
  const nextSupply = position.supply + mintedShares
  const { control, shares } = assetIds(assets)
  const packet = Packet.create([
    AssetGroup.create(control, null, [AssetInput.create(0, 1n)], [AssetOutput.create(0, 1n)], []),
    AssetGroup.create(shares, null, [], [AssetOutput.create(1, mintedShares)], []),
  ])
  const builder = contract.functions.subscribe(deposit, minimum)
    .from({ ...position.coin, sourceTx: position.sourceTx }).fund([input])
    .to([{ script: contract.pkScript, amount: position.navSats + deposit },
      { script, amount: BigInt(member.value) - deposit }])
    .withPacket(packet).withPacket(bankrollStatePacket(nextSupply))
  return { builder, mintedShares, nextSupply }
}

export function buildBankrollRedemption(
  contract: Vault, assets: BankrollVaultAssets, position: BankrollVaultPosition,
  member: NormalizedExtendedVirtualCoin, burnShares: bigint, minSats?: bigint,
): { builder: arkade.ArkadeTransactionBuilder; payoutSats: bigint; nextSupply: bigint } {
  assertPosition(contract, assets, position)
  const { input, script } = memberInput(contract, position, member)
  const held = member.assets?.[0]?.amount ?? 0n
  if (!soleAsset(member.assets, assets.shareAssetId, held)) throw new Error('Redemption requires only the pool share asset')
  bounded(held, 1n, position.supply, 'member shares')
  bounded(burnShares, 1n, held, 'share burn')
  const payoutSats = burnShares * position.navSats / position.supply
  const minimum = minSats ?? payoutSats
  bounded(minimum, 1n, MAX_NAV, 'minimum sats')
  bounded(payoutSats, minimum, position.navSats, 'redemption payout')
  const nextSupply = position.supply - burnShares
  const remaining = held - burnShares
  const { control, shares } = assetIds(assets)
  const packet = Packet.create([
    AssetGroup.create(control, null, [AssetInput.create(0, 1n)], nextSupply ? [AssetOutput.create(0, 1n)] : [], []),
    AssetGroup.create(shares, null, [AssetInput.create(1, held)], remaining ? [AssetOutput.create(1, remaining)] : [], []),
  ])
  const builder = contract.functions.redeem(burnShares, minimum)
    .from({ ...position.coin, sourceTx: position.sourceTx }).fund([input]).withPacket(packet)
  if (nextSupply === 0n) {
    builder.to(script, BigInt(member.value) + position.navSats)
  } else {
    bounded(position.navSats - payoutSats, DUST, MAX_NAV, 'remaining NAV')
    builder.to([{ script: contract.pkScript, amount: position.navSats - payoutSats },
      { script, amount: BigInt(member.value) + payoutSats }]).withPacket(bankrollStatePacket(nextSupply))
  }
  return { builder, payoutSats, nextSupply }
}

export async function verifyBankrollBootstrap(
  contract: Vault, assets: BankrollVaultAssets,
  proof: { bootstrapTxid: string; checkpointPsbts: string[] }, indexer: Pick<IndexerProvider, 'getVirtualTxs'>,
): Promise<{ navSats: bigint; supply: bigint }> {
  assertContract(contract, assets)
  const { control, shares } = assetIds(assets)
  const controlGenesis = await sourceTransaction(hex.encode(control.txid), indexer)
  const shareGenesis = same(control.txid, shares.txid) ? controlGenesis : await sourceTransaction(hex.encode(shares.txid), indexer)
  const controlGroup = Extension.fromTx(controlGenesis).getAssetPacket()?.groups[control.groupIndex]
  const shareGroup = Extension.fromTx(shareGenesis).getAssetPacket()?.groups[shares.groupIndex]
  if (!controlGroup?.isIssuance() || controlGroup.controlAsset || controlGroup.inputs.length ||
      controlGroup.outputs.length !== 1 || controlGroup.outputs[0].amount !== 1n || !shareGroup?.isIssuance() ||
      shareGroup.outputs.length !== 1) {
    throw new Error('Bootstrap requires a singleton non-reissuable control asset and fresh shares')
  }
  const reference = shareGroup.controlAsset?.ref
  const controlsShares = reference?.type === AssetRefType.ByID
    ? reference.assetId.toString() === control.toString()
    : reference?.type === AssetRefType.ByGroup && same(control.txid, shares.txid) && reference.groupIndex === control.groupIndex
  if (!controlsShares) throw new Error('Share genesis does not bind the singleton control asset')
  const initialSupply = shareGroup.outputs.reduce((sum, output) => sum + output.amount, 0n)
  bounded(initialSupply, 1n, MAX_SUPPLY, 'initial supply')
  const bootstrap = await sourceTransaction(proof.bootstrapTxid, indexer)
  if (bootstrap.inputsLength !== 2 || proof.checkpointPsbts.length !== 2) throw new Error('Bootstrap requires exactly two genesis inputs')
  const checkpoints = proof.checkpointPsbts.map(encoded => Transaction.fromPSBT(base64.decode(encoded)))
  if (new Set(checkpoints.map(tx => tx.id)).size !== 2) throw new Error('Duplicate bootstrap checkpoints')
  const genesisOutputs = [
    { tx: controlGenesis, vout: controlGroup.outputs[0].vout },
    { tx: shareGenesis, vout: shareGroup.outputs[0].vout },
  ]
  for (const [vin, genesis] of genesisOutputs.entries()) {
    const input = bootstrap.getInput(vin)
    const checkpoint = checkpoints.find(tx => tx.id === hex.encode(input.txid ?? new Uint8Array()))
    if (!checkpoint || checkpoint.inputsLength !== 1 || checkpoint.outputsLength !== 2 || input.index !== 0) {
      throw new Error('Bootstrap checkpoint set does not match the activation inputs')
    }
    const original = checkpoint.getInput(0)
    if (hex.encode(original.txid ?? new Uint8Array()) !== genesis.tx.id || original.index !== genesis.vout ||
        checkpoint.getOutput(0).amount !== genesis.tx.getOutput(genesis.vout).amount ||
        checkpoint.getOutput(1).amount !== 0n || !same(checkpoint.getOutput(1).script, P2A.script)) {
      throw new Error('Bootstrap checkpoint does not spend the exact genesis output')
    }
  }
  const packet = Extension.fromTx(bootstrap).getAssetPacket()
  const movedControl = packet?.groups.find(group => group.assetId?.toString() === control.toString())
  const movedShares = packet?.groups.find(group => group.assetId?.toString() === shares.toString())
  const output = bootstrap.getOutput(0)
  const memberOutput = bootstrap.getOutput(1)
  const originalControl = controlGenesis.getOutput(controlGroup.outputs[0].vout)
  const originalShares = shareGenesis.getOutput(shareGroup.outputs[0].vout)
  if (bootstrap.outputsLength !== 4 || !packet || packet.groups.length !== 2 ||
      packet.groups.some(group => group.isIssuance() || group.isReissuance()) ||
      movedControl?.inputs.length !== 1 || movedControl.inputs[0].input.type !== AssetInputType.Local ||
      movedControl.inputs[0].vin !== 0 || movedControl.inputs[0].amount !== 1n ||
      movedControl.outputs.length !== 1 || movedControl.outputs[0].vout !== 0 || movedControl.outputs[0].amount !== 1n ||
      movedShares?.inputs.length !== 1 || movedShares.inputs[0].input.type !== AssetInputType.Local ||
      movedShares.inputs[0].vin !== 1 || movedShares.inputs[0].amount !== initialSupply ||
      movedShares.outputs.length !== 1 || movedShares.outputs[0].vout !== 1 || movedShares.outputs[0].amount !== initialSupply ||
      !same(memberOutput.script, originalShares.script ?? new Uint8Array()) || (memberOutput.amount ?? 0n) < DUST ||
      (output.amount ?? 0n) + (memberOutput.amount ?? 0n) !== (originalControl.amount ?? 0n) + (originalShares.amount ?? 0n) ||
      bootstrap.getOutput(2).amount !== 0n || !Extension.isExtension(bootstrap.getOutput(2).script ?? new Uint8Array()) ||
      bootstrap.getOutput(3).amount !== 0n || !same(bootstrap.getOutput(3).script, P2A.script) ||
      !same(output.script, contract.pkScript) || !soleAsset(outputAssets(bootstrap, 0), assets.controlAssetId, 1n) ||
      stateSupply(bootstrap) !== initialSupply) {
    throw new Error('Bootstrap does not bind the genesis control spend, vault output, and initial supply')
  }
  const navSats = output.amount ?? 0n
  bounded(navSats, DUST, MAX_NAV, 'bootstrap NAV')
  return { navSats, supply: initialSupply }
}
