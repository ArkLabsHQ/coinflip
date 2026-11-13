import {
  arkade, asset, ArkAddress, Batch, EmulatorPacket, Estimator, Extension, P2A, Proof, Transaction, UnknownPacket, VtxoScript,
  getAllNormalizedVtxos, isVtxoSpent, resolveEmulatorPubkey, timelockToSequence, toXOnly,
  buildOffchainTx, getArkPsbtFields, VtxoTaprootTree,
  assertAllowedSighashTypes, matchServerCheckpoints, verifyTapscriptSignatures, toOffchainInputFeeParams, withPrevTxs,
  type ArkTxInput, type ExtensionPacket, type Identity, type IndexerProvider, type CSVMultisigTapscript,
  type EmulatorProvider, type NormalizedExtendedVirtualCoin, type SignerSession, type VirtualCoin, type Wallet,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { sha256 } from '@scure/btc-signer/utils.js'
import artifact from './artifact/pool_game_vault.json'
import type { PoolBootstrapRequest, PoolOperationReceipt, PoolOperatorActionRequest, PoolPreparedGame, PoolSubmitRequest } from './pool-protocol'
import { createDurablePoolRenewalSession, PoolRenewalAbandonedError, renewalAbandonable, withIndexedState, type PoolRenewalSessionPersistence } from './pool-renewal-session'
import { createDurablePoolBatchReplay, createPoolTreeNonceReplayGuard, type PoolBatchReplayPersistence } from './pool-batch-replay'
import { authorizePoolFreshSpend, createPoolFreshInput, POOL_FRESH_MIN_TTL, poolFreshInputContext, poolInputPolicy, verifyPoolFreshSpend, type PoolFreshAuthorization, type PoolFreshInput } from './fresh-pool-input'
export * from './fresh-pool-input'
export { arkadeAllSighash, freshPoolOwnerMessage } from './arkade-sighash'

export interface PoolGameDescriptor {
  version: 1
  name: string
  network: string
  operatorUrl: string
  controlAssetId: string
  shareAssetId: string
  operatorPubkey: string
  operatorPayoutPkScript: string
  operatorFeeBps: number
  minHouseEdgeBps: number
  maxStakeBps: number
  bootstrapTxid: string
  checkpointPsbts: [string, string]
}

export interface PoolGameTerms {
  playerHash: Uint8Array
  houseHash: Uint8Array
  playerPayoutPkScript: Uint8Array
  playerStakeSats: bigint
  houseStakeSats: bigint
  oddsN: number
  oddsLo: number
  oddsTarget: number
  cancelAt: number
  finalAt: number
}

export interface PoolGameState {
  supply: bigint
  navSats: bigint
  carriedLossSats: bigint
  accruedFeesSats: bigint
  phase: 'idle' | 'funded' | 'contest'
  game?: PoolGameTerms
  playerSecret?: Uint8Array
}

export interface PoolGamePosition {
  coin: arkade.Utxo
  sourceTx: Uint8Array
  state: PoolGameState
  minimumInputLifetimeSeconds?: number
  recoveryMarginSeconds?: number
}

export interface PoolGameSnapshot {
  outpoint: { txid: string; vout: number }
  valueSats: string
  navSats: string
  supply: string
  carriedLossSats: string
  accruedFeesSats: string
  phase: PoolGameState['phase']
  game?: Omit<PoolGameTerms, 'playerHash' | 'houseHash' | 'playerPayoutPkScript' | 'playerStakeSats' | 'houseStakeSats'> & {
    playerHash: string; houseHash: string; playerPayoutPkScript: string; playerStakeSats: string; houseStakeSats: string
  }
  playerSecretHex?: string
  expiresAt: number | null
  expiresAtHeight: number | null
  readyForOperations: boolean
  admissionClosesAt: number | null
  rescueOpensAt: number | null
  recoveryReason?: string
  requiredLifetimeSeconds: number
  recoveryMarginSeconds: number
}

export const poolGameProgram = arkade.programFromArtifact(artifact)
export const POOL_RESERVE_SATS = 330n
const MAX_NAV = 1_000_000n
const MAX_SUPPLY = 1_000_000_000_000n
const MAX_MONEY = 2_100_000_000_000_000n
const { AssetId, AssetRef, AssetRefType, AssetGroup, AssetInput, AssetOutput, Packet } = asset
type Contract = arkade.ArkadeContract
type Indexer = Pick<IndexerProvider, 'getVtxos' | 'getVirtualTxs'>
export interface PoolSubscriptionBuild { builder: arkade.ArkadeTransactionBuilder; mintedShares: bigint; nextSupply: bigint }
export interface PoolRedemptionBuild { builder: arkade.ArkadeTransactionBuilder; payoutSats: bigint; nextSupply: bigint }
export interface PoolResolutionBuild { builder: arkade.ArkadeTransactionBuilder; winner: 'player' | 'pool'; payoutSats: bigint }

function bound(value: bigint, minimum: bigint, maximum: bigint, name: string): void {
  if (typeof value !== 'bigint' || value < minimum || value > maximum) throw new Error(`Invalid pool ${name}`)
}

function same(a: Uint8Array | undefined, b: Uint8Array): boolean { return !!a && hex.encode(a) === hex.encode(b) }
function total(items: readonly { amount: bigint }[]): bigint { return items.reduce((sum, item) => sum + item.amount, 0n) }
function packet(type: number, bytes: Uint8Array): UnknownPacket { return new UnknownPacket(type, bytes) }
function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0))
  let offset = 0
  for (const value of values) { result.set(value, offset); offset += value.length }
  return result
}

function fixed(value: bigint, width: number): Uint8Array {
  bound(value, 0n, (1n << BigInt(width * 8 - 1)) - 1n, 'fixed-width integer')
  const result = new Uint8Array(width)
  let remaining = value
  for (let i = 0; i < width; i++) { result[i] = Number(remaining & 255n); remaining >>= 8n }
  return result
}

function readFixed(value: Uint8Array, width: number): bigint {
  if (value.length !== width || value[width - 1] & 128) throw new Error('Invalid pool fixed-width state')
  return value.reduceRight((sum, byte) => sum * 256n + BigInt(byte), 0n)
}

function ids(descriptor: PoolGameDescriptor) {
  const control = AssetId.fromString(descriptor.controlAssetId), shares = AssetId.fromString(descriptor.shareAssetId)
  if (control.toString() === shares.toString()) throw new Error('Pool asset IDs must differ')
  return { control, shares }
}

function policy(descriptor: PoolGameDescriptor): Uint8Array {
  ids(descriptor)
  for (const [value, minimum, maximum] of [[descriptor.operatorFeeBps, 0, 3000], [descriptor.minHouseEdgeBps, 0, 1000], [descriptor.maxStakeBps, 1, 2000]]) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('Invalid pool policy')
  }
  const script = hex.decode(descriptor.operatorPayoutPkScript)
  if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) throw new Error('Pool operator payout must be Taproot')
  toXOnly(hex.decode(descriptor.operatorPubkey))
  return script
}

export function createPoolGameVault(client: arkade.Arkade, descriptor: PoolGameDescriptor): Contract {
  const { control, shares } = ids(descriptor), payout = policy(descriptor)
  const delay = client.serverExitDelay
  if (!delay || delay <= 0n || (delay >= 512n && delay % 512n !== 0n)) throw new Error('Unsupported pool exit delay')
  const emulatorKey = client.emulatorKey ?? hex.decode(resolveEmulatorPubkey(client.network))
  return new arkade.ArkadeContract(client, poolGameProgram, {
    controlTxid: Uint8Array.from(control.txid).reverse(), controlGidx: BigInt(control.groupIndex),
    shareTxid: Uint8Array.from(shares.txid).reverse(), shareGidx: BigInt(shares.groupIndex),
    operator: toXOnly(hex.decode(descriptor.operatorPubkey)),
    operatorPayout: { version: 1n, program: payout.slice(2) },
    operatorFeeBps: BigInt(descriptor.operatorFeeBps), minHouseEdgeBps: BigInt(descriptor.minHouseEdgeBps), maxStakeBps: BigInt(descriptor.maxStakeBps),
    server: client.serverKey, SERVER_EXIT_DELAY: BigInt(timelockToSequence({ type: delay >= 512n ? 'seconds' : 'blocks', value: delay })),
    recoveryMargin: BigInt(poolInputPolicy(client).recoveryMarginSeconds),
    contract_FreshPoolInput_controlTxid_controlGidx_shareTxid_shareGidx_recoveryMargin: createPoolFreshInput(client, descriptor).pkScript.slice(2),
  }, { serverKey: client.serverKey, emulatorKey })
}

function assertContract(contract: Contract, descriptor: PoolGameDescriptor): void {
  if (contract.program !== poolGameProgram) throw new Error('Contract is not the bundled pool game program')
  const { control, shares } = ids(descriptor), payout = policy(descriptor)
  if (!same(contract.args.controlTxid as Uint8Array, Uint8Array.from(control.txid).reverse()) ||
      !same(contract.args.shareTxid as Uint8Array, Uint8Array.from(shares.txid).reverse()) ||
      contract.args.controlGidx !== BigInt(control.groupIndex) || contract.args.shareGidx !== BigInt(shares.groupIndex) ||
      !same(contract.args.operator as Uint8Array, toXOnly(hex.decode(descriptor.operatorPubkey))) ||
      !same(contract.args['operatorPayout.program'] as Uint8Array, payout.slice(2)) ||
      contract.args['operatorPayout.version'] !== 1n || contract.args.operatorFeeBps !== BigInt(descriptor.operatorFeeBps) ||
      contract.args.minHouseEdgeBps !== BigInt(descriptor.minHouseEdgeBps) || contract.args.maxStakeBps !== BigInt(descriptor.maxStakeBps) ||
      contract.args.recoveryMargin !== BigInt(poolInputPolicy(contract.client).recoveryMarginSeconds) ||
      !same(contract.args.contract_FreshPoolInput_controlTxid_controlGidx_shareTxid_shareGidx_recoveryMargin as Uint8Array, createPoolFreshInput(contract.client, descriptor).pkScript.slice(2))) {
    throw new Error('Pool descriptor does not match its constructor')
  }
}

export function poolStatePackets(state: Pick<PoolGameState, 'supply' | 'carriedLossSats' | 'accruedFeesSats' | 'phase'>): UnknownPacket[] {
  bound(state.supply, 1n, MAX_SUPPLY, 'supply')
  bound(state.carriedLossSats, 0n, MAX_NAV, 'loss')
  bound(state.accruedFeesSats, 0n, MAX_NAV, 'fees')
  const phase = ['idle', 'funded', 'contest'].indexOf(state.phase)
  if (phase < 0) throw new Error('Invalid pool phase')
  return [packet(32, arkade.BigNum.encode(state.supply)), packet(33, fixed(state.carriedLossSats, 4)),
    packet(34, fixed(state.accruedFeesSats, 4)), packet(35, fixed(BigInt(phase), 1))]
}

export function poolGamePackets(game: PoolGameTerms): UnknownPacket[] {
  bound(game.playerStakeSats, 330n, MAX_NAV, 'player stake')
  bound(game.houseStakeSats, 330n, MAX_NAV, 'house stake')
  if (game.playerHash.length !== 32 || game.houseHash.length !== 32 || game.playerPayoutPkScript.length !== 34 ||
      game.playerPayoutPkScript[0] !== 0x51 || game.playerPayoutPkScript[1] !== 0x20 ||
      !Number.isInteger(game.oddsN) || !Number.isInteger(game.oddsLo) || !Number.isInteger(game.oddsTarget) ||
      game.oddsN < 2 || game.oddsN > 128 || game.oddsLo < 0 || game.oddsLo >= game.oddsTarget || game.oddsTarget > game.oddsN ||
      !Number.isInteger(game.cancelAt) || !Number.isInteger(game.finalAt) || game.cancelAt < 500_000_000 ||
      game.cancelAt >= game.finalAt || game.finalAt > 0xffff_ffff || game.finalAt - game.cancelAt > 86_400) {
    throw new Error('Invalid committed pool game')
  }
  return [packet(36, concat(game.playerHash, game.houseHash)), packet(37, concat(new Uint8Array([1]), game.playerPayoutPkScript.slice(2))),
    packet(38, concat(fixed(game.playerStakeSats, 4), fixed(game.houseStakeSats, 4))),
    packet(39, concat(fixed(BigInt(game.oddsN), 2), fixed(BigInt(game.oddsLo), 2), fixed(BigInt(game.oddsTarget), 2))),
    packet(40, concat(fixed(BigInt(game.cancelAt), 5), fixed(BigInt(game.finalAt), 5)))]
}

function readState(tx: Transaction, value: bigint): PoolGameState {
  const ext = Extension.fromTx(tx)
  const read = (type: number) => {
    const result = ext.getPacketByType(type)?.serialize()
    if (!result) throw new Error(`Missing pool state packet ${type}`)
    return result
  }
  const issued = read(32), supply = arkade.BigNum.decode(issued)
  bound(supply, 1n, MAX_SUPPLY, 'supply')
  if (!same(issued, arkade.BigNum.encode(supply)) || issued.length > 6) throw new Error('Non-minimal pool supply')
  const carriedLossSats = readFixed(read(33), 4), accruedFeesSats = readFixed(read(34), 4), phaseNumber = Number(readFixed(read(35), 1))
  bound(carriedLossSats, 0n, MAX_NAV, 'loss'); bound(accruedFeesSats, 0n, MAX_NAV, 'fees')
  if (phaseNumber > 2) throw new Error('Invalid pool phase')
  const phase = (['idle', 'funded', 'contest'] as const)[phaseNumber]
  let game: PoolGameTerms | undefined, playerSecret: Uint8Array | undefined
  if (phase === 'idle') {
    if ([36, 37, 38, 39, 40].some(type => ext.getPacketByType(type))) throw new Error('Idle pool retains game fields')
  } else {
    const hashes = read(36), payout = read(37), stakes = read(38), odds = read(39), deadlines = read(40)
    if (hashes.length !== 64 || payout.length !== 33 || payout[0] !== 1 || stakes.length !== 8 || odds.length !== 6 || deadlines.length !== 10) {
      throw new Error('Invalid pool game packet lengths')
    }
    game = { playerHash: hashes.slice(0, 32), houseHash: hashes.slice(32), playerPayoutPkScript: concat(new Uint8Array([0x51, 0x20]), payout.slice(1)),
      playerStakeSats: readFixed(stakes.slice(0, 4), 4), houseStakeSats: readFixed(stakes.slice(4), 4),
      oddsN: Number(readFixed(odds.slice(0, 2), 2)), oddsLo: Number(readFixed(odds.slice(2, 4), 2)), oddsTarget: Number(readFixed(odds.slice(4), 2)),
      cancelAt: Number(readFixed(deadlines.slice(0, 5), 5)), finalAt: Number(readFixed(deadlines.slice(5), 5)) }
    const canonical = poolGamePackets(game)
    if (canonical.some(entry => !same(entry.serialize(), read(entry.type())))) throw new Error('Non-canonical pool game encoding')
    if (phase === 'contest') {
      playerSecret = read(16)
      if (playerSecret.length < 17 || !same(sha256(playerSecret), game.playerHash)) throw new Error('Invalid recorded player reveal')
    }
  }
  const navSats = value - POOL_RESERVE_SATS - accruedFeesSats - (game?.playerStakeSats ?? 0n)
  bound(navSats, 1n, MAX_NAV, 'NAV')
  return { supply, navSats, carriedLossSats, accruedFeesSats, phase, game, playerSecret }
}

function outputAssets(tx: Transaction, vout: number) {
  return Extension.fromTx(tx).getAssetPacket()?.groups.flatMap((group, index) => group.outputs.filter(output => output.vout === vout)
    .map(output => ({ assetId: (group.assetId ?? AssetId.create(tx.id, index)).toString(), amount: output.amount }))) ?? []
}

async function source(txid: string, indexer: Pick<IndexerProvider, 'getVirtualTxs'>): Promise<Transaction> {
  const txs = (await indexer.getVirtualTxs([txid])).txs.map(encoded => Transaction.fromPSBT(base64.decode(encoded))).filter(tx => tx.id === txid)
  if (txs.length !== 1) throw new Error('Pool source transaction is unavailable or mismatched')
  return txs[0]
}

function assertPosition(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition): void {
  assertContract(contract, descriptor)
  const tx = Transaction.fromRaw(position.sourceTx), output = tx.getOutput(position.coin.vout)
  const assets = outputAssets(tx, position.coin.vout)
  if (position.coin.vout !== 0 || tx.id !== position.coin.txid || !Number.isSafeInteger(position.coin.value) ||
      output.amount !== BigInt(position.coin.value) || !same(output.script, contract.pkScript) ||
      assets.length !== 1 || assets[0].assetId !== descriptor.controlAssetId || assets[0].amount !== 1n) {
    throw new Error('Pool position is not the canonical control output')
  }
  const canonical = readState(tx, output.amount)
  if (JSON.stringify(snapshotState(canonical)) !== JSON.stringify(snapshotState(position.state))) throw new Error('Pool state differs from its source transaction')
}

function snapshotState(state: PoolGameState) {
  return { navSats: state.navSats.toString(), supply: state.supply.toString(), carriedLossSats: state.carriedLossSats.toString(),
    accruedFeesSats: state.accruedFeesSats.toString(), phase: state.phase,
    ...(state.game ? { game: { ...state.game, playerHash: hex.encode(state.game.playerHash), houseHash: hex.encode(state.game.houseHash),
      playerPayoutPkScript: hex.encode(state.game.playerPayoutPkScript), playerStakeSats: state.game.playerStakeSats.toString(), houseStakeSats: state.game.houseStakeSats.toString() } } : {}),
    ...(state.playerSecret ? { playerSecretHex: hex.encode(state.playerSecret) } : {}) }
}

export function poolGameSnapshot(position: PoolGamePosition): PoolGameSnapshot {
  const coin = position.coin as arkade.Utxo & { expiresAtHeight?: number }
  const expiresAt = coin.expiresAt?.getTime() ?? null, expiresAtHeight = coin.expiresAtHeight ?? null
  const requiredLifetimeSeconds = position.minimumInputLifetimeSeconds ?? POOL_FRESH_MIN_TTL, recoveryMarginSeconds = position.recoveryMarginSeconds ?? 2400
  const admissionClosesAt = !coin.isSwept && expiresAtHeight === null && expiresAt !== null ? expiresAt - (requiredLifetimeSeconds + 60) * 1000 : null
  const readyForOperations = admissionClosesAt !== null && admissionClosesAt > Date.now()
  const rescueOpensAt = expiresAtHeight === null && expiresAt !== null ? expiresAt - requiredLifetimeSeconds * 1000 : null
  return { outpoint: { txid: coin.txid, vout: coin.vout }, valueSats: String(coin.value), ...snapshotState(position.state),
    expiresAt, expiresAtHeight, readyForOperations, admissionClosesAt, rescueOpensAt, requiredLifetimeSeconds, recoveryMarginSeconds,
    ...(!readyForOperations ? { recoveryReason: 'Pool batch lifetime is unknown or too close to expiry; renewal is required before new operations' } : {}) }
}

export async function readPoolGamePositionAt(contract: Contract, descriptor: PoolGameDescriptor,
  outpoint: { txid: string; vout: number }, indexer: Indexer): Promise<PoolGamePosition> {
  const tx = await source(outpoint.txid, indexer), output = tx.getOutput(outpoint.vout)
  if (output.amount === undefined || output.amount > MAX_MONEY || output.amount < 0n) throw new Error('Invalid historical pool amount')
  const indexed = (await indexer.getVtxos({ outpoints: [outpoint], spendableOnly: false })).vtxos.find(coin => coin.txid === outpoint.txid && coin.vout === outpoint.vout)
  const sourceTx = tx.toBytes()
  const position: PoolGamePosition = { coin: { ...indexed, ...outpoint, value: Number(output.amount), script: hex.encode(contract.pkScript),
    assets: [{ assetId: descriptor.controlAssetId, amount: 1n }], sourceTx }, sourceTx, state: readState(tx, output.amount),
    minimumInputLifetimeSeconds: poolInputPolicy(contract.client).minTTL, recoveryMarginSeconds: poolInputPolicy(contract.client).recoveryMarginSeconds }
  assertPosition(contract, descriptor, position)
  return position
}

/** `includeExpired` admits expired or swept heads for batch renewal and display; offchain operations must not spend them. */
export async function readPoolGamePosition(contract: Contract, descriptor: PoolGameDescriptor, indexer: Indexer,
  options: { includeExpired?: boolean } = {}): Promise<PoolGamePosition | undefined> {
  assertContract(contract, descriptor)
  const script = hex.encode(contract.pkScript)
  const coins = (await getAllNormalizedVtxos(indexer, [script], { spendableOnly: false })).filter(coin =>
    coin.script === script && !isVtxoSpent(coin) && coin.assets?.length === 1 &&
    coin.assets[0].assetId === descriptor.controlAssetId && coin.assets[0].amount === 1n)
  if (coins.length > 1) throw new Error('Multiple unspent pool control outputs')
  if (!coins.length) return undefined
  const coin = coins[0]
  const expired = coin.isSwept || !!coin.expiresAt && coin.expiresAt.getTime() <= Date.now()
  if (coin.isUnrolled || coin.expiresAtHeight !== undefined || expired && !options.includeExpired) {
    throw new Error('Pool control output is unavailable offchain; recovery is required')
  }
  const tx = await source(coin.txid, indexer), sourceTx = tx.toBytes()
  const position = { coin: { ...coin, sourceTx }, sourceTx, state: readState(tx, BigInt(coin.value)),
    minimumInputLifetimeSeconds: poolInputPolicy(contract.client).minTTL, recoveryMarginSeconds: poolInputPolicy(contract.client).recoveryMarginSeconds }
  assertPosition(contract, descriptor, position)
  return position
}

export async function readPoolSnapshot(contract: Contract, descriptor: PoolGameDescriptor, indexer: Indexer): Promise<PoolGameSnapshot | undefined> {
  const position = await readPoolGamePosition(contract, descriptor, indexer, { includeExpired: true })
  return position && poolGameSnapshot(position)
}

function memberInput(contract: Contract, member: NormalizedExtendedVirtualCoin): { input: ArkTxInput; script: Uint8Array } {
  if (!Number.isSafeInteger(member.value)) throw new Error('Invalid member carrier')
  bound(BigInt(member.value), 330n, MAX_MONEY, 'member carrier')
  const script = VtxoScript.decode(member.tapTree).pkScript
  if (hex.encode(script) !== member.script || same(script, contract.pkScript) || isVtxoSpent(member) || member.isSwept || member.isUnrolled ||
      member.expiresAtHeight !== undefined || (member.expiresAt && member.expiresAt.getTime() <= Date.now())) throw new Error('Member coin is unavailable or mismatched')
  return { input: { txid: member.txid, vout: member.vout, value: member.value, tapLeafScript: member.forfeitTapLeafScript, tapTree: member.tapTree }, script }
}

function freshMemberInput(contract: Contract, descriptor: PoolGameDescriptor, member: NormalizedExtendedVirtualCoin, authorization?: PoolFreshAuthorization) {
  memberInput(contract, member)
  const context = poolFreshInputContext(contract.client, descriptor, member, authorization)
  return { script: context.script, coin: { ...member, sourceTx: context.sourceTx }, unlocker: context.unlocker }
}

function addState(builder: arkade.ArkadeTransactionBuilder, state: PoolGameState): arkade.ArkadeTransactionBuilder {
  for (const entry of poolStatePackets(state)) builder.withPacket(entry)
  if (state.game) for (const entry of poolGamePackets(state.game)) builder.withPacket(entry)
  if (state.playerSecret) builder.withPacket(packet(16, state.playerSecret))
  return builder
}

function controlGroup(descriptor: PoolGameDescriptor, retire = false) {
  return AssetGroup.create(ids(descriptor).control, null, [AssetInput.create(0, 1n)], retire ? [] : [AssetOutput.create(0, 1n)], [])
}

function idle(position: PoolGamePosition): void { if (position.state.phase !== 'idle') throw new Error('Pool is busy with a funded game') }

export function buildPoolSubscription(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition,
  member: NormalizedExtendedVirtualCoin, deposit: bigint, minShares?: bigint, authorization?: PoolFreshAuthorization): PoolSubscriptionBuild {
  assertPosition(contract, descriptor, position); idle(position)
  const { state } = position, { script, coin, unlocker } = freshMemberInput(contract, descriptor, member, authorization)
  bound(deposit, 1n, MAX_NAV - state.navSats, 'deposit')
  if (member.assets?.length || BigInt(member.value) < deposit + 330n) throw new Error('Subscription requires a plain coin with 330 sats change')
  const mintedShares = deposit * state.supply / state.navSats, minimum = minShares ?? mintedShares, nextSupply = state.supply + mintedShares
  bound(mintedShares, 1n, MAX_SUPPLY - state.supply, 'minted shares'); bound(minimum, 1n, mintedShares, 'minimum shares')
  const builder = contract.functions.subscribe(deposit, minimum).from({ ...position.coin, sourceTx: position.sourceTx }).from(coin, unlocker)
    .to([{ script: contract.pkScript, amount: BigInt(position.coin.value) + deposit }, { script, amount: BigInt(member.value) - deposit }])
    .withPacket(Packet.create([controlGroup(descriptor), AssetGroup.create(ids(descriptor).shares, null, [], [AssetOutput.create(1, mintedShares)], [])]))
  addState(builder, { ...state, supply: nextSupply, navSats: state.navSats + deposit })
  return { builder, mintedShares, nextSupply }
}

export function buildPoolRedemption(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition,
  member: NormalizedExtendedVirtualCoin, burnShares: bigint, minSats?: bigint, authorization?: PoolFreshAuthorization): PoolRedemptionBuild {
  assertPosition(contract, descriptor, position); idle(position)
  const { state } = position, { script, coin, unlocker } = freshMemberInput(contract, descriptor, member, authorization), held = member.assets?.[0]?.amount ?? 0n
  if (member.assets?.length !== 1 || member.assets[0].assetId !== descriptor.shareAssetId) throw new Error('Redemption requires a sole-share coin')
  bound(held, 1n, state.supply, 'member shares'); bound(burnShares, 1n, held, 'share burn')
  const payoutSats = burnShares * state.navSats / state.supply, minimum = minSats ?? payoutSats
  bound(minimum, 1n, payoutSats, 'minimum redemption')
  const nextSupply = state.supply - burnShares, remaining = held - burnShares
  const builder = contract.functions.redeem(burnShares, minimum).from({ ...position.coin, sourceTx: position.sourceTx }).from(coin, unlocker)
    .withPacket(Packet.create([controlGroup(descriptor, nextSupply === 0n),
      AssetGroup.create(ids(descriptor).shares, null, [AssetInput.create(1, held)], remaining ? [AssetOutput.create(1, remaining)] : [], [])]))
  if (nextSupply === 0n) {
    builder.to([{ script, amount: BigInt(member.value) + state.navSats }, { script: policy(descriptor), amount: POOL_RESERVE_SATS + state.accruedFeesSats }])
  } else {
    const next = { ...state, supply: nextSupply, navSats: state.navSats - payoutSats,
      carriedLossSats: (state.carriedLossSats * nextSupply + state.supply - 1n) / state.supply }
    bound(next.navSats, 1n, MAX_NAV, 'remaining NAV')
    builder.to([{ script: contract.pkScript, amount: BigInt(position.coin.value) - payoutSats }, { script, amount: BigInt(member.value) + payoutSats }])
    addState(builder, next)
  }
  return { builder, payoutSats, nextSupply }
}

export function poolPositionAfterRedemption(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition,
  transaction: Transaction, burnShares: bigint): PoolGamePosition | undefined {
  assertPosition(contract, descriptor, position)
  bound(burnShares, 1n, position.state.supply, 'share burn')
  if (burnShares === position.state.supply) return undefined
  const output = transaction.getOutput(0), sourceTx = transaction.toBytes()
  if (output.amount === undefined || output.amount > MAX_MONEY) throw new Error('Invalid next pool carrier')
  const state = readState(transaction, output.amount), nextSupply = position.state.supply - burnShares
  const payout = burnShares * position.state.navSats / position.state.supply
  if (state.phase !== 'idle' || state.supply !== nextSupply || state.navSats !== position.state.navSats - payout ||
      state.accruedFeesSats !== position.state.accruedFeesSats || state.carriedLossSats !==
        (position.state.carriedLossSats * nextSupply + position.state.supply - 1n) / position.state.supply) throw new Error('Next pool accounting does not match the approved redemption')
  const next: PoolGamePosition = { coin: { ...position.coin, txid: transaction.id, vout: 0, value: Number(output.amount), sourceTx }, sourceTx, state,
    minimumInputLifetimeSeconds: poolInputPolicy(contract.client).minTTL, recoveryMarginSeconds: poolInputPolicy(contract.client).recoveryMarginSeconds }
  assertPosition(contract, descriptor, next)
  return next
}

export function buildPoolShareCashRelease(member: NormalizedExtendedVirtualCoin, shareAssetId: string,
  serverUnrollScript: CSVMultisigTapscript.Type): { arkTx: Transaction; checkpoints: Transaction[]; inputs: ArkTxInput[]; outputs: Array<ReturnType<Transaction['getOutput']>>; cashSats: bigint } {
  const script = VtxoScript.decode(member.tapTree).pkScript
  if (member.assets?.length !== 1 || member.assets[0].assetId !== shareAssetId || member.assets[0].amount <= 0n ||
      hex.encode(script) !== member.script || !Number.isSafeInteger(member.value) || member.value < 660 || isVtxoSpent(member) || member.isSwept || member.isUnrolled) {
    throw new Error('Cash release requires an available sole-share carrier with 330 sats of releasable cash')
  }
  const inputs = [{ txid: member.txid, vout: member.vout, value: member.value, tapTree: member.tapTree, tapLeafScript: member.forfeitTapLeafScript }]
  const cashSats = BigInt(member.value) - 330n
  const outputs = [{ script, amount: 330n }, { script, amount: cashSats }, Extension.create([Packet.create([
    AssetGroup.create(AssetId.fromString(shareAssetId), null, [AssetInput.create(0, member.assets[0].amount)], [AssetOutput.create(0, member.assets[0].amount)], []),
  ])]).txOut()]
  return { ...buildOffchainTx(inputs, outputs, serverUnrollScript), inputs, outputs, cashSats }
}

export function buildPoolOpenGame(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition,
  member: NormalizedExtendedVirtualCoin, terms: PoolPreparedGame, authorization?: PoolFreshAuthorization): { builder: arkade.ArkadeTransactionBuilder } {
  assertPosition(contract, descriptor, position); idle(position)
  const { script, coin, unlocker } = freshMemberInput(contract, descriptor, member, authorization), { state } = position
  if (terms.expectedHead.txid !== position.coin.txid || terms.expectedHead.vout !== position.coin.vout) throw new Error('Pool game quote refers to a different head')
  const game: PoolGameTerms = { playerHash: hex.decode(terms.playerHash), houseHash: hex.decode(terms.houseHash), playerPayoutPkScript: script,
    playerStakeSats: BigInt(terms.playerStakeSats), houseStakeSats: BigInt(terms.houseStakeSats), oddsN: terms.oddsN, oddsLo: terms.oddsLo,
    oddsTarget: terms.oddsTarget, cancelAt: terms.cancelAt, finalAt: terms.finalAt }
  poolGamePackets(game)
  if (member.assets?.length || BigInt(member.value) < game.playerStakeSats + 330n) throw new Error('Pool bet requires a plain coin with 330 sats change')
  bound(game.playerStakeSats, 330n, MAX_NAV - state.navSats, 'player stake')
  bound(game.houseStakeSats, 330n, state.navSats * BigInt(descriptor.maxStakeBps) / 10_000n, 'house exposure')
  const wins = BigInt(game.oddsTarget - game.oddsLo), n = BigInt(game.oddsN)
  if (((n - wins) * game.playerStakeSats - wins * game.houseStakeSats) * 10_000n < n * game.playerStakeSats * BigInt(descriptor.minHouseEdgeBps)) throw new Error('Pool game violates its house edge policy')
  if (terms.expiresAt <= Date.now() || game.cancelAt <= Math.floor(Date.now() / 1000)) throw new Error('Pool game quote expired')
  const margin = poolInputPolicy(contract.client).recoveryMarginSeconds
  if (game.finalAt > 0xffffffff - margin || [position.coin, member].some(input => !input.expiresAt || ('expiresAtHeight' in input && input.expiresAtHeight != null) ||
      input.expiresAt.getTime() < (game.finalAt + margin) * 1000)) throw new Error('Pool game inputs do not cover its recovery deadline')
  const builder = contract.functions.openGame(game.playerHash, game.houseHash, game.playerStakeSats, game.houseStakeSats,
    game.oddsN, game.oddsLo, game.oddsTarget, game.cancelAt, game.finalAt)
    .from({ ...position.coin, sourceTx: position.sourceTx }).from(coin, unlocker)
    .to([{ script: contract.pkScript, amount: BigInt(position.coin.value) + game.playerStakeSats }, { script, amount: BigInt(member.value) - game.playerStakeSats }])
    .withPacket(Packet.create([controlGroup(descriptor)]))
  addState(builder, { ...state, phase: 'funded', game })
  return { builder }
}

function reveal(position: PoolGamePosition, secret: Uint8Array): PoolGameTerms {
  const game = position.state.game
  if (!game || secret.length < 17 || !same(sha256(secret), game.playerHash)) throw new Error('Player secret does not match the active game')
  return game
}

export function buildPoolPlayerReveal(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition, playerSecret: Uint8Array): arkade.ArkadeTransactionBuilder {
  assertPosition(contract, descriptor, position); reveal(position, playerSecret)
  if (position.state.phase !== 'funded') throw new Error('Pool is not waiting for the player reveal')
  const builder = contract.functions.playerReveal().from({ ...position.coin, sourceTx: position.sourceTx })
    .to(contract.pkScript, BigInt(position.coin.value)).withPacket(Packet.create([controlGroup(descriptor)]))
  return addState(builder, { ...position.state, phase: 'contest', playerSecret })
}

function terminal(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition,
  mode: 'settle' | 'refund' | 'timeout', playerSecret?: Uint8Array, houseSecret?: Uint8Array): PoolResolutionBuild {
  assertPosition(contract, descriptor, position)
  const { state } = position, game = state.game
  if (!game || state.phase === 'idle') throw new Error('Pool has no active game')
  let winner: 'player' | 'pool' = 'pool', payoutSats = 0n, loss = state.carriedLossSats, fees = state.accruedFeesSats
  if (mode === 'settle') {
    if (!playerSecret || !houseSecret || houseSecret.length < 17 || !same(sha256(houseSecret), game.houseHash)) throw new Error('Missing or mismatched game reveals')
    reveal(position, playerSecret)
    if (state.phase === 'contest' && !same(state.playerSecret, playerSecret)) throw new Error('Player reveal differs from the recorded contest')
    const playerDigit = playerSecret[0], houseDigit = houseSecret[0], roll = (playerDigit + houseDigit) % game.oddsN
    winner = houseDigit >= game.oddsN || (playerDigit < game.oddsN && roll >= game.oddsLo && roll < game.oddsTarget) ? 'player' : 'pool'
  } else if (mode === 'timeout') {
    if (state.phase !== 'contest' || Math.floor(Date.now() / 1000) < game.finalAt) throw new Error('Pool contest deadline has not matured')
    winner = 'player'
  } else if (state.phase !== 'funded' || Math.floor(Date.now() / 1000) < game.cancelAt) throw new Error('Pool cancellation deadline has not matured')
  if (mode === 'refund') payoutSats = game.playerStakeSats
  else if (winner === 'player') { payoutSats = game.playerStakeSats + game.houseStakeSats; loss += game.houseStakeSats }
  else {
    fees += (game.playerStakeSats > loss ? game.playerStakeSats - loss : 0n) * BigInt(descriptor.operatorFeeBps) / 10_000n
    loss = loss > game.playerStakeSats ? loss - game.playerStakeSats : 0n
  }
  bound(loss, 0n, MAX_NAV, 'next carried loss'); bound(fees, 0n, MAX_NAV, 'next accrued fees')
  const builder = contract.functions[mode === 'settle' ? 'settleGame' : mode === 'refund' ? 'refundGame' : 'playerTimeout']()
    .from({ ...position.coin, sourceTx: position.sourceTx }).to(contract.pkScript, BigInt(position.coin.value) - payoutSats)
    .withPacket(Packet.create([controlGroup(descriptor)]))
  if (payoutSats) builder.to(game.playerPayoutPkScript, payoutSats)
  addState(builder, { supply: state.supply, navSats: BigInt(position.coin.value) - payoutSats - POOL_RESERVE_SATS - fees,
    carriedLossSats: loss, accruedFeesSats: fees, phase: 'idle' })
  if (mode === 'settle') builder.withPacket(packet(16, playerSecret!)).withPacket(packet(17, houseSecret!))
  return { builder, winner, payoutSats }
}

export function buildPoolSettlement(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition, playerSecret: Uint8Array, houseSecret: Uint8Array): PoolResolutionBuild {
  return terminal(contract, descriptor, position, 'settle', playerSecret, houseSecret)
}
export function buildPoolRefund(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition): PoolResolutionBuild { return terminal(contract, descriptor, position, 'refund') }
export function buildPoolTimeout(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition): PoolResolutionBuild { return terminal(contract, descriptor, position, 'timeout') }

export function buildPoolFeeSweep(contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition): arkade.ArkadeTransactionBuilder {
  assertPosition(contract, descriptor, position); idle(position)
  bound(position.state.accruedFeesSats, 330n, MAX_NAV, 'withdrawable fee')
  const builder = contract.functions.sweepFees().from({ ...position.coin, sourceTx: position.sourceTx })
    .to([{ script: contract.pkScript, amount: BigInt(position.coin.value) - position.state.accruedFeesSats }, { script: policy(descriptor), amount: position.state.accruedFeesSats }])
    .withPacket(Packet.create([controlGroup(descriptor)]))
  return addState(builder, { ...position.state, accruedFeesSats: 0n })
}

async function walletClient(wallet: Wallet): Promise<arkade.Arkade> {
  const info = await wallet.getArkadeInfo({ requireLive: true })
  return arkade.Arkade.connect({ arkade: { getInfo: async () => info }, indexer: wallet.indexerProvider, network: wallet.network })
}

export async function verifyPoolBootstrap(contract: Contract, descriptor: PoolGameDescriptor, indexer: Indexer): Promise<{ navSats: bigint; supply: bigint }> {
  assertContract(contract, descriptor)
  const { control, shares } = ids(descriptor), genesis = await source(hex.encode(control.txid), indexer)
  if (!same(control.txid, shares.txid)) throw new Error('Pool bootstrap assets must share one genesis transaction')
  const groups = Extension.fromTx(genesis).getAssetPacket()?.groups
  const cg = groups?.[control.groupIndex], sg = groups?.[shares.groupIndex]
  if (!cg?.isIssuance() || cg.controlAsset || cg.outputs.length !== 1 || cg.outputs[0].amount !== 1n ||
      !sg?.isIssuance() || sg.outputs.length !== 1 || sg.controlAsset?.ref.type !== AssetRefType.ByGroup || sg.controlAsset.ref.groupIndex !== control.groupIndex) throw new Error('Invalid pool genesis authority')
  const supply = total(sg.outputs), activation = await source(descriptor.bootstrapTxid, indexer)
  const checkpoints = descriptor.checkpointPsbts.map(encoded => Transaction.fromPSBT(base64.decode(encoded)))
  if (activation.inputsLength !== 2 || activation.outputsLength !== 4 || checkpoints.length !== 2 || new Set(checkpoints.map(tx => tx.id)).size !== 2) throw new Error('Invalid pool activation shape')
  for (const [vin, output] of [cg.outputs[0], sg.outputs[0]].entries()) {
    const input = activation.getInput(vin), checkpoint = checkpoints.find(tx => tx.id === hex.encode(input.txid!))
    if (!checkpoint || input.index !== 0 || checkpoint.inputsLength !== 1 || checkpoint.outputsLength !== 2 ||
        hex.encode(checkpoint.getInput(0).txid!) !== genesis.id || checkpoint.getInput(0).index !== output.vout ||
        checkpoint.getOutput(0).amount !== genesis.getOutput(output.vout).amount || checkpoint.getOutput(1).amount !== 0n || !same(checkpoint.getOutput(1).script, P2A.script)) throw new Error('Pool activation does not directly spend its genesis')
  }
  const transfer = Extension.fromTx(activation).getAssetPacket(), controlMoved = transfer?.groups.find(group => group.assetId?.toString() === control.toString()), sharesMoved = transfer?.groups.find(group => group.assetId?.toString() === shares.toString())
  const output = activation.getOutput(0), state = readState(activation, output.amount!)
  if (transfer?.groups.length !== 2 || transfer.groups.some(group => group.isIssuance() || group.isReissuance()) ||
      controlMoved?.inputs.length !== 1 || controlMoved.inputs[0].vin !== 0 || controlMoved.inputs[0].amount !== 1n ||
      controlMoved.outputs.length !== 1 || controlMoved.outputs[0].vout !== 0 || controlMoved.outputs[0].amount !== 1n ||
      sharesMoved?.inputs.length !== 1 || sharesMoved.inputs[0].vin !== 1 || sharesMoved.inputs[0].amount !== supply ||
      sharesMoved.outputs.length !== 1 || sharesMoved.outputs[0].vout !== 1 || sharesMoved.outputs[0].amount !== supply ||
      !same(output.script, contract.pkScript) || state.phase !== 'idle' || state.supply !== supply || state.carriedLossSats || state.accruedFeesSats ||
      !same(activation.getOutput(1).script, genesis.getOutput(sg.outputs[0].vout).script!) ||
      output.amount! + activation.getOutput(1).amount! !== genesis.getOutput(cg.outputs[0].vout).amount! + genesis.getOutput(sg.outputs[0].vout).amount! ||
      activation.getOutput(2).amount !== 0n || !Extension.isExtension(activation.getOutput(2).script!) || activation.getOutput(3).amount !== 0n || !same(activation.getOutput(3).script, P2A.script)) throw new Error('Pool activation changes genesis supply or destinations')
  return { navSats: state.navSats, supply }
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

export interface PoolBootstrapStage {
  arkTxid: string
  arkTx: string
  checkpointTxs: string[]
  inputOutpoints: Array<{ txid: string; vout: number }>
  submitted: boolean
  finalizeCheckpointTxs?: string[]
  confirmed?: boolean
}
export interface PoolBootstrapJournal {
  version: 1
  optionsHash: string
  descriptor?: PoolGameDescriptor
  genesis?: PoolBootstrapStage
  activation?: PoolBootstrapStage
  complete?: boolean
}
export interface PoolBootstrapPersistence {
  load(): Promise<PoolBootstrapJournal | undefined>
  save(journal: PoolBootstrapJournal): Promise<void>
}
const bootstrapHolds = new WeakMap<Wallet, Map<string, ReturnType<Wallet['reserveVtxos']>>>()
const bootstrapRunning = new WeakSet<Wallet>()

function bootstrapHold(wallet: Wallet, key: string, points: PoolBootstrapStage['inputOutpoints']): void {
  let held = bootstrapHolds.get(wallet)
  if (!held) { held = new Map(); bootstrapHolds.set(wallet, held) }
  const previous = held.get(key)
  if (previous) {
    if (canonical(previous.outpoints) !== canonical(points)) throw new Error('Bootstrap reservation changed its committed inputs')
  } else held.set(key, wallet.reserveVtxos(points))
}
function releaseBootstrapHold(wallet: Wallet, key: string): void {
  const held = bootstrapHolds.get(wallet)
  held?.get(key)?.release(); held?.delete(key)
}
export function restorePoolBootstrapHolds(wallet: Wallet, journal: PoolBootstrapJournal): void {
  if (journal.version !== 1 || !/^[a-f0-9]{64}$/.test(journal.optionsHash)) throw new Error('Invalid pool bootstrap journal')
  for (const name of ['genesis', 'activation'] as const) {
    const stage = journal[name]
    if (stage && !stage.confirmed) {
      bootstrapTransactions(stage)
      bootstrapHold(wallet, `${journal.optionsHash}:${name}`, stage.inputOutpoints)
    }
  }
  if (journal.genesis && !journal.activation?.confirmed) bootstrapHold(wallet, `${journal.optionsHash}:activation`,
    [{ txid: journal.genesis.arkTxid, vout: 0 }, { txid: journal.genesis.arkTxid, vout: 1 }])
}
function bootstrapTransactions(stage: PoolBootstrapStage) {
  const arkTx = Transaction.fromPSBT(base64.decode(stage.arkTx)), checkpoints = stage.checkpointTxs.map(value => Transaction.fromPSBT(base64.decode(value)))
  if (arkTx.id !== stage.arkTxid || checkpoints.length !== arkTx.inputsLength || stage.inputOutpoints.length !== checkpoints.length ||
      new Set(checkpoints.map(value => value.id)).size !== checkpoints.length) throw new Error('Invalid saved bootstrap transaction')
  assertAllowedSighashTypes(arkTx)
  const ordered = Array.from({ length: arkTx.inputsLength }, (_, vin) => {
    const input = arkTx.getInput(vin), point = stage.inputOutpoints[vin]
    const checkpoint = checkpoints.find(value => value.id === hex.encode(input.txid ?? new Uint8Array()))
    if (!checkpoint || input.index !== 0 || checkpoint.inputsLength !== 1 || !point ||
        hex.encode(checkpoint.getInput(0).txid ?? new Uint8Array()) !== point.txid || checkpoint.getInput(0).index !== point.vout) throw new Error('Bootstrap checkpoints changed their original inputs')
    assertAllowedSighashTypes(checkpoint)
    return checkpoint
  })
  if (new Set(stage.inputOutpoints.map(value => `${value.txid}:${value.vout}`)).size !== stage.inputOutpoints.length) throw new Error('Duplicate bootstrap input')
  return { arkTx, checkpoints: ordered }
}
class PoolWalletStageConflict extends Error {}
async function bootstrapAccepted(wallet: Wallet, stage: PoolBootstrapStage): Promise<boolean> {
  const built = bootstrapTransactions(stage)
  const coins = (await wallet.indexerProvider.getVtxos({ outpoints: stage.inputOutpoints, spendableOnly: false })).vtxos
  for (const [vin, point] of stage.inputOutpoints.entries()) {
    const matches = coins.filter(value => value.txid === point.txid && value.vout === point.vout)
    if (matches.length !== 1) return false
    const coin = matches[0], checkpoint = built.checkpoints[vin], previous = checkpoint.getInput(0).witnessUtxo
    if (!previous || coin.value !== Number(previous.amount) || coin.script !== hex.encode(previous.script)) throw new Error('Bootstrap input differs from its indexed source')
    if (!isVtxoSpent(coin)) return false
    if (coin.spentBy !== checkpoint.id || coin.arkTxId !== stage.arkTxid) throw new PoolWalletStageConflict('Bootstrap input was consumed by a different transaction; retain its recovery journal')
  }
  return (await source(stage.arkTxid, wallet.indexerProvider)).id === built.arkTx.id
}
async function signBootstrapStage(wallet: Wallet, built: ReturnType<typeof buildOffchainTx>): Promise<PoolBootstrapStage> {
  const signed = await wallet.identity.sign(built.arkTx.clone())
  approvedTransaction(built.arkTx, signed)
  const checkpoints = await Promise.all(built.checkpoints.map(async value => {
    const result = await wallet.identity.sign(value.clone())
    approvedTransaction(value, result)
    return result
  }))
  return { arkTxid: signed.id, arkTx: base64.encode(signed.toPSBT()), checkpointTxs: checkpoints.map(value => base64.encode(value.toPSBT())),
    inputOutpoints: built.checkpoints.map(value => ({ txid: hex.encode(value.getInput(0).txid!), vout: value.getInput(0).index! })), submitted: false }
}

export async function signPoolWalletStage(wallet: Wallet, built: ReturnType<typeof buildOffchainTx>): Promise<PoolBootstrapStage> {
  return signBootstrapStage(wallet, built)
}
export async function verifyPoolWalletStage(wallet: Wallet, stage: PoolBootstrapStage): Promise<boolean> {
  try { return await bootstrapAccepted(wallet, stage) }
  catch (error) { if (error instanceof PoolWalletStageConflict) return false; throw error }
}
export async function submitPoolWalletStage(wallet: Wallet, stage: PoolBootstrapStage,
  save: (next: PoolBootstrapStage) => Promise<void>): Promise<PoolBootstrapStage> {
  let current = stage
  const built = bootstrapTransactions(current)
  if (!await bootstrapAccepted(wallet, current)) {
    if (!current.finalizeCheckpointTxs) {
      current = { ...current, submitted: true }
      await save(current)
      const response = await wallet.arkProvider.submitTx(current.arkTx, current.checkpointTxs)
      if (response.arkTxid !== current.arkTxid) throw new Error('Wallet staging submission changed its approved transaction ID')
      const pairs = matchServerCheckpoints(response.signedCheckpointTxs, built.checkpoints, 'pool wallet stage')
      const checkpoints = pairs.map(({ server, local }) => {
        approvedTransaction(local, server)
        return server.combine(local)
      })
      current = { ...current, finalizeCheckpointTxs: checkpoints.map(tx => base64.encode(tx.toPSBT())) }
      await save(current)
    }
    const pairs = matchServerCheckpoints(current.finalizeCheckpointTxs!, built.checkpoints, 'saved pool wallet stage')
    for (const { server, local } of pairs) {
      approvedTransaction(local, server)
      const required = local.getInput(0).tapScriptSig ?? []
      if (!required.length || required.some(([key, sig]) => !(server.getInput(0).tapScriptSig ?? [])
        .some(([other, value]) => same(key.pubKey, other.pubKey) && same(key.leafHash, other.leafHash) && same(sig, value)))) {
        throw new Error('Wallet staging finalization removed an approved owner signature')
      }
    }
    if (!await bootstrapAccepted(wallet, current)) await wallet.arkProvider.finalizeTx(current.arkTxid, current.finalizeCheckpointTxs!)
    await waitFor(async () => await bootstrapAccepted(wallet, current) ? true : undefined, 'pool wallet staging exact spend proof')
  }
  current = { ...current, confirmed: true }
  await save(current)
  return current
}

export async function bootstrapPool(wallet: Wallet, options: PoolBootstrapRequest & { network: string; operatorUrl: string; operatorPubkey?: string; operatorPayoutPkScript?: string }, persistence: PoolBootstrapPersistence): Promise<{ descriptor: PoolGameDescriptor; snapshot: PoolGameSnapshot }> {
  if (!persistence || typeof persistence.load !== 'function' || typeof persistence.save !== 'function') throw new Error('Durable pool bootstrap persistence is required')
  if (bootstrapRunning.has(wallet)) throw new Error('Pool bootstrap is already running for this wallet')
  bootstrapRunning.add(wallet)
  let client: arkade.Arkade | undefined, journal: PoolBootstrapJournal | undefined, optionsHash: string | undefined
  try {
    const initialNavSats = BigInt(options.initialNavSats)
    bound(initialNavSats, 330n, MAX_NAV, 'initial NAV')
    if (typeof options.name !== 'string' || !options.name.trim() || options.name.length > 80) throw new Error('Invalid pool name')
    const operatorUrl = new URL(options.operatorUrl).toString().replace(/\/+$/, '')
    if (!/^https?:/.test(operatorUrl)) throw new Error('Invalid pool operator URL')
    const info = await wallet.getArkadeInfo({ requireLive: true })
    if (info.network !== options.network) throw new Error('Pool bootstrap network differs from the wallet operator')
    client = await walletClient(wallet)
    const address = await wallet.getAddress(), script = ArkAddress.decode(address).pkScript
    const operatorPubkey = options.operatorPubkey ?? hex.encode(await wallet.identity.xOnlyPublicKey())
    const preview: PoolGameDescriptor = { version: 1, name: options.name.trim(), network: options.network, operatorUrl,
      controlAssetId: AssetId.create('11'.repeat(32), 0).toString(), shareAssetId: AssetId.create('11'.repeat(32), 1).toString(),
      operatorPubkey, operatorPayoutPkScript: options.operatorPayoutPkScript ?? hex.encode(script), operatorFeeBps: options.operatorFeeBps ?? 2000,
      minHouseEdgeBps: options.minHouseEdgeBps ?? 0, maxStakeBps: options.maxStakeBps ?? 2000, bootstrapTxid: '', checkpointPsbts: ['', ''] }
    const previewContract = createPoolGameVault(client, preview)
    optionsHash = hex.encode(sha256(new TextEncoder().encode(JSON.stringify({ initialNavSats: String(initialNavSats), descriptor: preview,
      walletPubkey: hex.encode(await wallet.identity.xOnlyPublicKey()), memberScript: hex.encode(script), script: hex.encode(previewContract.pkScript), artifact }))))
    journal = await persistence.load()
    if (journal && (journal.version !== 1 || journal.optionsHash !== optionsHash)) throw new Error('Saved pool bootstrap belongs to different options, wallet or compiler artifact')
    if (journal?.descriptor && canonical({ ...journal.descriptor, controlAssetId: preview.controlAssetId, shareAssetId: preview.shareAssetId,
      bootstrapTxid: '', checkpointPsbts: ['', ''] }) !== canonical(preview)) throw new Error('Saved bootstrap descriptor changed its constructor policy')
    journal ??= { version: 1, optionsHash }
    restorePoolBootstrapHolds(wallet, journal)
    const save = async (next: PoolBootstrapJournal) => {
      await persistence.save(next)
      journal = next
    }
    const confirm = async (name: 'genesis' | 'activation') => {
      let stage = journal![name]!
      const key = `${optionsHash}:${name}`
      bootstrapHold(wallet, key, stage.inputOutpoints)
      if (!await bootstrapAccepted(wallet, stage)) {
        if (stage.finalizeCheckpointTxs) await wallet.arkProvider.finalizeTx(stage.arkTxid, stage.finalizeCheckpointTxs)
        else {
          stage = { ...stage, submitted: true }
          await save({ ...journal!, [name]: stage })
          const response = await wallet.arkProvider.submitTx(stage.arkTx, stage.checkpointTxs)
          if (response.arkTxid !== stage.arkTxid) throw new Error('Bootstrap submission returned a different transaction ID')
          const built = bootstrapTransactions(stage), matched = matchServerCheckpoints(response.signedCheckpointTxs, built.checkpoints, 'pool bootstrap')
          const carriesOwner = matched.every(({ server, local }) => (local.getInput(0).tapScriptSig ?? []).every(([key, sig]) =>
            (server.getInput(0).tapScriptSig ?? []).some(([other, value]) => same(key.pubKey, other.pubKey) && same(key.leafHash, other.leafHash) && same(sig, value))))
          const final = matched.map(({ server, local }) => {
            approvedTransaction(local, server)
            return server.combine(local)
          })
          if (!carriesOwner) {
            stage = { ...stage, finalizeCheckpointTxs: final.map(value => base64.encode(value.toPSBT())) }
            await save({ ...journal!, [name]: stage })
            await wallet.arkProvider.finalizeTx(stage.arkTxid, stage.finalizeCheckpointTxs!)
          }
        }
        await waitFor(async () => await bootstrapAccepted(wallet, stage) ? true : undefined, `pool ${name} exact spend proof`)
      }
      await save({ ...journal!, [name]: { ...stage, confirmed: true } })
      releaseBootstrapHold(wallet, key)
    }
    const supply = initialNavSats * 1_000_000n
    if (!journal.genesis) {
      const target = initialNavSats + 660n, coins: NormalizedExtendedVirtualCoin[] = []
      const plain = (await wallet.getSpendableVtxos({ requireSynced: true, genericallySpendableOnly: true })).filter(coin => !coin.assets?.length)
      const minimumExpiry = Date.now() + (poolInputPolicy(client).minTTL + 120) * 1000
      const available = plain.filter(coin => coin.expiresAtHeight === undefined && coin.expiresAt && coin.expiresAt.getTime() >= minimumExpiry).sort((a, b) => b.value - a.value)
      let selected = 0n
      for (const coin of available) { if (selected >= target) break; coins.push(coin); selected += BigInt(coin.value) }
      if (selected < target) {
        if (plain.reduce((sum, coin) => sum + BigInt(coin.value), 0n) >= target) throw new Error('Renew plain wallet capital before bootstrapping the pool; its lifetime must cover the recovery window')
        throw new Error('Insufficient plain capital to bootstrap the pool and both carriers')
      }
      bootstrapHold(wallet, `${optionsHash}:genesis`, coins.map(coin => ({ txid: coin.txid, vout: coin.vout })))
      const change = selected - target, founderCarrier = 330n + (change < 330n ? change : 0n)
      const genesisPacket = Packet.create([AssetGroup.create(null, null, [], [AssetOutput.create(0, 1n)], []), AssetGroup.create(null, AssetRef.fromGroupIndex(0), [], [AssetOutput.create(1, supply)], [])])
      const outputs = [{ script, amount: initialNavSats + 330n }, { script, amount: founderCarrier }, ...(change >= 330n ? [{ script, amount: change }] : []), Extension.create([genesisPacket]).txOut()]
      const built = buildOffchainTx(coins.map(coin => ({ txid: coin.txid, vout: coin.vout, value: coin.value, tapTree: coin.tapTree, tapLeafScript: coin.forfeitTapLeafScript })), outputs, client.checkpoint)
      const genesis = await signBootstrapStage(wallet, built)
      const descriptor = { ...preview, controlAssetId: AssetId.create(genesis.arkTxid, 0).toString(), shareAssetId: AssetId.create(genesis.arkTxid, 1).toString() }
      await save({ ...journal, descriptor, genesis })
      restorePoolBootstrapHolds(wallet, journal)
    }
    await confirm('genesis')
    const descriptor = journal.descriptor!
    if (!descriptor || descriptor.controlAssetId !== AssetId.create(journal.genesis!.arkTxid, 0).toString() || descriptor.shareAssetId !== AssetId.create(journal.genesis!.arkTxid, 1).toString()) throw new Error('Bootstrap descriptor changed its saved genesis asset IDs')
    const contract = createPoolGameVault(client, descriptor)
    if (!journal.activation) {
      const genesis = Transaction.fromPSBT(base64.decode(journal.genesis!.arkTx))
      const genesisCoins = await waitFor(async () => {
        const owned = await wallet.getVtxos({ withRecoverable: false })
        const control = owned.find(coin => coin.txid === genesis.id && coin.vout === 0), shares = owned.find(coin => coin.txid === genesis.id && coin.vout === 1)
        return control && shares ? [control, shares] as const : undefined
      }, 'pool genesis outputs')
      bootstrapHold(wallet, `${optionsHash}:activation`, genesisCoins.map(coin => ({ txid: coin.txid, vout: coin.vout })))
      const outputs = [{ script: contract.pkScript, amount: initialNavSats + 330n }, { script, amount: genesis.getOutput(1).amount! },
        Extension.create([Packet.create([controlGroup(descriptor), AssetGroup.create(ids(descriptor).shares, null, [AssetInput.create(1, supply)], [AssetOutput.create(1, supply)], [])]),
          ...poolStatePackets({ supply, carriedLossSats: 0n, accruedFeesSats: 0n, phase: 'idle' })]).txOut()]
      const built = buildOffchainTx(genesisCoins.map(coin => ({ txid: coin.txid, vout: coin.vout, value: coin.value, tapTree: coin.tapTree, tapLeafScript: coin.forfeitTapLeafScript })), outputs, client.checkpoint)
      const activation = await signBootstrapStage(wallet, built)
      await save({ ...journal, descriptor: { ...descriptor, bootstrapTxid: activation.arkTxid, checkpointPsbts: activation.checkpointTxs as [string, string] }, activation })
    }
    await confirm('activation')
    const finalDescriptor = journal.descriptor!
    await verifyPoolBootstrap(contract, finalDescriptor, wallet.indexerProvider)
    const snapshot = await waitFor(() => readPoolSnapshot(contract, finalDescriptor, wallet.indexerProvider), 'pool activation')
    await save({ ...journal, complete: true })
    return { descriptor: finalDescriptor, snapshot }
  } catch (error) {
    if (optionsHash) {
      try {
        const saved = await persistence.load()
        if (saved) restorePoolBootstrapHolds(wallet, saved)
        if (!saved?.genesis) releaseBootstrapHold(wallet, `${optionsHash}:genesis`)
        if (!saved?.genesis && !saved?.activation) releaseBootstrapHold(wallet, `${optionsHash}:activation`)
      } catch { /* Failed storage reads cannot prove that a saved financial intent is absent. */ }
    }
    throw error
  } finally { bootstrapRunning.delete(wallet); await client?.dispose() }
}

export async function readPoolState(wallet: Wallet, descriptor: PoolGameDescriptor): Promise<PoolGameSnapshot | undefined> {
  const client = await walletClient(wallet)
  try { return await readPoolSnapshot(createPoolGameVault(client, descriptor), descriptor, wallet.indexerProvider) }
  finally { client.dispose() }
}

function canonical(value: unknown): string {
  if (value instanceof Uint8Array) return `bytes:${hex.encode(value)}`
  if (typeof value === 'bigint') return `bigint:${value}`
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

function signingData(tx: Transaction, vin: number): unknown {
  const { tapScriptSig, partialSig, tapKeySig, ...input } = tx.getInput(vin)
  void tapScriptSig; void partialSig; void tapKeySig
  return { ...input, sighashType: input.sighashType ?? 0 }
}

function approvedTransaction(local: Transaction, received: Transaction, allowedSighashTypes = [0]): Transaction {
  assertAllowedSighashTypes(received, allowedSighashTypes)
  if (local.id !== received.id || local.inputsLength !== received.inputsLength || local.outputsLength !== received.outputsLength) throw new Error('Pool submission differs from the approved transaction')
  for (let i = 0; i < local.inputsLength; i++) if (canonical(signingData(local, i)) !== canonical(signingData(received, i))) throw new Error('Pool submission changed signing metadata')
  for (let i = 0; i < local.outputsLength; i++) if (canonical(local.getOutput(i)) !== canonical(received.getOutput(i))) throw new Error('Pool submission changed output metadata')
  return Transaction.fromPSBT(local.toPSBT())
}

function copyInputSignatures(target: Transaction, received: Transaction, vin: number): void {
  const { tapScriptSig, partialSig } = received.getInput(vin)
  target.updateInput(vin, { ...(tapScriptSig ? { tapScriptSig } : {}), ...(partialSig ? { partialSig } : {}) })
}

function requestTransactions(request: PoolSubmitRequest) {
  const arkTx = Transaction.fromPSBT(base64.decode(request.arkTx))
  if (arkTx.id !== request.arkTxid) throw new Error('Pool request transaction ID does not match its PSBT')
  const checkpoints = request.checkpointTxs.map(encoded => Transaction.fromPSBT(base64.decode(encoded)))
  if (checkpoints.length !== arkTx.inputsLength || new Set(checkpoints.map(tx => tx.id)).size !== checkpoints.length) throw new Error('Invalid pool checkpoint set')
  const ordered = Array.from({ length: arkTx.inputsLength }, (_, vin) => {
    const input = arkTx.getInput(vin), checkpoint = checkpoints.find(tx => tx.id === hex.encode(input.txid ?? new Uint8Array()))
    if (!checkpoint || input.index !== 0 || checkpoint.inputsLength !== 1) throw new Error('Pool checkpoints do not match the actual inputs')
    return checkpoint
  })
  const first = ordered[0].getInput(0)
  if (hex.encode(first.txid ?? new Uint8Array()) !== request.expectedHead.txid || first.index !== request.expectedHead.vout) throw new Error('Pool checkpoint does not spend the expected head')
  return { arkTx, checkpoints: ordered }
}

async function submissionMember(checkpoint: Transaction, indexer: Indexer): Promise<NormalizedExtendedVirtualCoin> {
  const input = checkpoint.getInput(0), txid = hex.encode(input.txid ?? new Uint8Array()), vout = input.index
  if (vout === undefined) throw new Error('Missing pool member outpoint')
  const coin = (await indexer.getVtxos({ outpoints: [{ txid, vout }] })).vtxos.find(item => item.txid === txid && item.vout === vout)
  if (!coin || isVtxoSpent(coin) || coin.isUnrolled || coin.isSwept) throw new Error('Pool member input is unavailable')
  const tx = await source(txid, indexer), output = tx.getOutput(vout)
  const [tapTree] = getArkPsbtFields(checkpoint, 0, VtxoTaprootTree), leaf = input.tapLeafScript?.[0]
  if (!tapTree || !leaf || output.amount !== BigInt(coin.value) || !same(output.script, hex.decode(coin.script)) ||
      !same(VtxoScript.decode(tapTree).pkScript, output.script!) || input.witnessUtxo?.amount !== output.amount || !same(input.witnessUtxo.script, output.script!)) {
    throw new Error('Pool member signing context does not match the indexed source')
  }
  return { ...coin, tapTree, forfeitTapLeafScript: leaf, intentTapLeafScript: leaf, sourceTx: tx.toBytes() } as NormalizedExtendedVirtualCoin
}

export interface PoolRelayBody { arkTx: string; checkpointTxs: string[] }

export async function preparePoolSubmission(wallet: Wallet, operatorIdentity: Identity, descriptor: PoolGameDescriptor,
  request: PoolSubmitRequest, game?: PoolPreparedGame): Promise<{ arkTxid: string; body: PoolRelayBody }> {
  const received = requestTransactions(request), client = await walletClient(wallet)
  try {
    const contract = createPoolGameVault(client, descriptor)
    const position = await readPoolGamePositionAt(contract, descriptor, request.expectedHead, wallet.indexerProvider)
    const live = (await wallet.indexerProvider.getVtxos({ outpoints: [request.expectedHead] })).vtxos.find(coin => coin.txid === request.expectedHead.txid && coin.vout === request.expectedHead.vout)
    if (!live || isVtxoSpent(live) || live.isUnrolled || live.isSwept) throw new Error('Pool expected head is no longer available')
    const command = request.command
    let builder: arkade.ArkadeTransactionBuilder
    if (command.kind === 'subscribe' || command.kind === 'redeem' || command.kind === 'openGame') {
      if (received.checkpoints.length !== 2) throw new Error('Capital and game funding require exactly one member input')
      const member = await submissionMember(received.checkpoints[1], wallet.indexerProvider)
      const memberKey = hex.encode(toXOnly(hex.decode(request.memberPubkey)))
      const authorization = verifyPoolFreshSpend(received)
      const fresh = poolFreshInputContext(client, descriptor, member, authorization)
      if (hex.encode(authorization.owner) !== memberKey || !same(authorization.owner, fresh.owner)) throw new Error('Pool staged owner does not match its source and request')
      if (command.kind === 'subscribe') builder = buildPoolSubscription(contract, descriptor, position, member, BigInt(command.depositSats), BigInt(command.minShares), authorization).builder
      else if (command.kind === 'redeem') builder = buildPoolRedemption(contract, descriptor, position, member, BigInt(command.burnShares), BigInt(command.minSats), authorization).builder
      else {
        if (!game || game.gameId !== command.gameId || game.playerPubkey !== request.memberPubkey ||
            !same(fresh.script, ArkAddress.decode(game.playerPayoutAddress).pkScript) ||
            !same(await operatorIdentity.xOnlyPublicKey(), toXOnly(hex.decode(descriptor.operatorPubkey)))) throw new Error('Pool operator authorization does not match the stored player quote')
        builder = buildPoolOpenGame(contract, descriptor, position, member, game, authorization).builder
      }
    } else if (command.kind === 'settleGame') {
      builder = buildPoolSettlement(contract, descriptor, position, hex.decode(command.playerSecretHex), hex.decode(command.houseSecretHex)).builder
    } else if (command.kind === 'refundGame') builder = buildPoolRefund(contract, descriptor, position).builder
    else if (command.kind === 'sweepFees') builder = buildPoolFeeSweep(contract, descriptor, position)
    else throw new Error('Unsupported pool operation')
    const built = await builder.build(), arkTx = approvedTransaction(built.arkTx, received.arkTx)
    const pairs = matchServerCheckpoints(request.checkpointTxs, built.checkpoints, 'pool operation')
    const checkpoints = pairs.map(({ server, local }) => approvedTransaction(local, server))
    if (received.arkTx.inputsLength === 2) {
      copyInputSignatures(arkTx, received.arkTx, 1)
      const localIndex = checkpoints.findIndex(checkpoint => checkpoint.id === received.checkpoints[1].id)
      copyInputSignatures(checkpoints[localIndex], received.checkpoints[1], 0)
    }
    if (command.kind === 'openGame') {
      const signedArk = await operatorIdentity.sign(arkTx, [0])
      const controlIndex = checkpoints.findIndex(checkpoint => checkpoint.id === received.checkpoints[0].id)
      checkpoints[controlIndex] = await operatorIdentity.sign(checkpoints[controlIndex], [0])
      return { arkTxid: signedArk.id, body: { arkTx: base64.encode(signedArk.toPSBT()), checkpointTxs: checkpoints.map(tx => base64.encode(tx.toPSBT())) } }
    }
    return { arkTxid: arkTx.id, body: { arkTx: base64.encode(arkTx.toPSBT()), checkpointTxs: checkpoints.map(tx => base64.encode(tx.toPSBT())) } }
  } finally { client.dispose() }
}

export async function verifyPoolSubmission(wallet: Wallet, descriptor: PoolGameDescriptor, request: PoolSubmitRequest,
  options: { loadRenewalProof?: (txid: string) => Promise<string> } = {}): Promise<{ status: 'pending' | 'confirmed' | 'conflict'; receipt?: PoolOperationReceipt }> {
  const approved = requestTransactions(request)
  const points = approved.checkpoints.map(checkpoint => {
    const input = checkpoint.getInput(0)
    return { txid: hex.encode(input.txid!), vout: input.index! }
  })
  const coins = (await wallet.indexerProvider.getVtxos({ outpoints: points, spendableOnly: false })).vtxos
  const heads = coins.filter(coin => coin.txid === request.expectedHead.txid && coin.vout === request.expectedHead.vout)
  const head = heads.length === 1 ? heads[0] : undefined
  if (head && isVtxoSpent(head) && head.arkTxId && head.arkTxId !== request.arkTxid && head.spentBy) {
    const evidence = (await wallet.indexerProvider.getVirtualTxs([head.arkTxId, head.spentBy])).txs.map(encoded => Transaction.fromPSBT(base64.decode(encoded)))
    const conflicting = evidence.find(tx => tx.id === head.arkTxId), checkpoint = evidence.find(tx => tx.id === head.spentBy)
    if (conflicting && checkpoint?.inputsLength === 1 && hex.encode(checkpoint.getInput(0).txid!) === head.txid && checkpoint.getInput(0).index === head.vout &&
        Array.from({ length: conflicting.inputsLength }, (_, i) => conflicting.getInput(i)).some(input => hex.encode(input.txid ?? new Uint8Array()) === checkpoint.id && input.index === 0)) return { status: 'conflict' }
  }
  if (head && isVtxoSpent(head) && head.settledBy && options.loadRenewalProof) {
    const client = await walletClient(wallet)
    try {
      const contract = createPoolGameVault(client, descriptor)
      const history = await getAllNormalizedVtxos(wallet.indexerProvider, [hex.encode(contract.pkScript)], { spendableOnly: false })
      for (const coin of history.filter(value => value.commitmentTxIds.includes(head.settledBy!) && value.assets?.length === 1 &&
        value.assets[0].assetId === descriptor.controlAssetId && value.assets[0].amount === 1n)) {
        try {
          const next = await readPoolGamePositionAt(contract, descriptor, coin, wallet.indexerProvider)
          const previous = await readPoolRenewalPredecessor(contract, descriptor, next, wallet.indexerProvider, options.loadRenewalProof)
          if (previous?.coin.txid === request.expectedHead.txid && previous.coin.vout === request.expectedHead.vout) return { status: 'conflict' }
        } catch { /* Missing batch evidence leaves the saved operation pending. */ }
      }
    } finally { client.dispose() }
  }
  for (const [index, point] of points.entries()) {
    const matches = coins.filter(coin => coin.txid === point.txid && coin.vout === point.vout)
    const checkpoint = approved.checkpoints[index], previous = checkpoint.getInput(0).witnessUtxo
    if (matches.length !== 1 || !previous) return { status: 'pending' }
    const coin = matches[0]
    if (coin.value !== Number(previous.amount) || coin.script !== hex.encode(previous.script) ||
        !isVtxoSpent(coin) || coin.spentBy !== checkpoint.id || coin.arkTxId !== request.arkTxid) return { status: 'pending' }
  }
  const raws = (await wallet.indexerProvider.getVirtualTxs([request.arkTxid])).txs
  const actual = raws.map(encoded => Transaction.fromPSBT(base64.decode(encoded))).find(tx => tx.id === request.arkTxid)
  if (!actual || actual.id !== approved.arkTx.id) return { status: 'pending' }
  const first = actual.getOutput(0)
  const observed = (await wallet.indexerProvider.getVtxos({ outpoints: [{ txid: actual.id, vout: 0 }] })).vtxos.find(coin => coin.txid === actual.id && coin.vout === 0)
  if (!observed || observed.value !== Number(first.amount) || observed.script !== hex.encode(first.script!)) return { status: 'pending' }
  const client = await walletClient(wallet)
  try {
    const contract = createPoolGameVault(client, descriptor), carried = outputAssets(actual, 0)
    const continuing = same(first.script, contract.pkScript) && carried.length === 1 && carried[0].assetId === descriptor.controlAssetId && carried[0].amount === 1n
    if (!continuing) {
      const control = Extension.fromTx(actual).getAssetPacket()?.groups.find(group => group.assetId?.toString() === descriptor.controlAssetId)
      if (request.command.kind !== 'redeem' || !control || control.outputs.length !== 0 || total(control.inputs) !== 1n) throw new Error('Pool receipt does not prove continuation or retirement')
    } else readState(actual, first.amount!)
    return { status: 'confirmed', receipt: { arkTxid: actual.id, consumedHead: request.expectedHead,
      nextHead: continuing ? { txid: actual.id, vout: 0 } : null, observedAt: Date.now() } }
  } finally { client.dispose() }
}

export async function buildPoolResolution(wallet: Wallet, descriptor: PoolGameDescriptor, game: PoolPreparedGame,
  houseSecretHex: string, playerSecretHex: string | undefined, mode: 'settle' | 'refund'): Promise<{
    arkTxid: string; body: PoolRelayBody; expectedHead: { txid: string; vout: number }; request: PoolSubmitRequest
  }> {
  const client = await walletClient(wallet)
  try {
    const contract = createPoolGameVault(client, descriptor), position = await readPoolGamePosition(contract, descriptor, wallet.indexerProvider)
    const current = position?.state.game
    if (!position || !current || hex.encode(current.playerHash) !== game.playerHash || hex.encode(current.houseHash) !== game.houseHash ||
        current.playerStakeSats !== BigInt(game.playerStakeSats) || current.houseStakeSats !== BigInt(game.houseStakeSats) ||
        current.oddsN !== game.oddsN || current.oddsLo !== game.oddsLo || current.oddsTarget !== game.oddsTarget ||
        current.cancelAt !== game.cancelAt || current.finalAt !== game.finalAt || !same(current.playerPayoutPkScript, ArkAddress.decode(game.playerPayoutAddress).pkScript)) throw new Error('Active pool game does not match the stored resolution')
    const player = playerSecretHex ? hex.decode(playerSecretHex) : position.state.playerSecret
    const resolution = mode === 'refund' ? buildPoolRefund(contract, descriptor, position) :
      buildPoolSettlement(contract, descriptor, position, player ?? new Uint8Array(), hex.decode(houseSecretHex))
    const built = await resolution.builder.build(), body = { arkTx: base64.encode(built.arkTx.toPSBT()), checkpointTxs: built.checkpoints.map(tx => base64.encode(tx.toPSBT())) }
    const expectedHead = { txid: position.coin.txid, vout: position.coin.vout }
    const request: PoolSubmitRequest = { operationId: `${mode}:${game.gameId}:${expectedHead.txid}:${expectedHead.vout}`, expectedHead, arkTxid: built.arkTx.id,
      ...body, memberPubkey: descriptor.operatorPubkey,
      command: mode === 'refund' ? { kind: 'refundGame', gameId: game.gameId } :
        { kind: 'settleGame', gameId: game.gameId, playerSecretHex: hex.encode(player ?? new Uint8Array()), houseSecretHex } }
    return { arkTxid: built.arkTx.id, body, expectedHead, request }
  } finally { client.dispose() }
}

export function reservePoolSubmissionInputs(wallet: Wallet, request: PoolSubmitRequest): ReturnType<Wallet['reserveVtxos']> {
  const { checkpoints } = requestTransactions(request)
  const points = checkpoints.map(checkpoint => ({ txid: hex.encode(checkpoint.getInput(0).txid!), vout: checkpoint.getInput(0).index! }))
  if (new Set(points.map(point => `${point.txid}:${point.vout}`)).size !== points.length) throw new Error('Duplicate pool submission input')
  return wallet.reserveVtxos(points)
}

export async function buildPoolOperatorAction(wallet: Wallet, descriptor: PoolGameDescriptor, action: PoolOperatorActionRequest,
  options?: { stagedInput: PoolFreshInput; authorization: PoolFreshAuthorization }): Promise<{
  request: PoolSubmitRequest
  relay: { arkTxid: string; body: PoolRelayBody }
  reservation: ReturnType<Wallet['reserveVtxos']>
}> {
  if (!action.operationId || action.operationId.length > 128) throw new Error('Invalid pool operator operation ID')
  const publicKey = await wallet.identity.xOnlyPublicKey()
  if (!same(publicKey, toXOnly(hex.decode(descriptor.operatorPubkey)))) throw new Error('Pool operator action requires its configured wallet identity')
  const client = await walletClient(wallet)
  let reservation: ReturnType<Wallet['reserveVtxos']> | undefined
  try {
    const contract = createPoolGameVault(client, descriptor), position = await readPoolGamePosition(contract, descriptor, wallet.indexerProvider)
    if (!position || position.coin.txid !== action.expectedHead.txid || position.coin.vout !== action.expectedHead.vout) throw new Error('Pool operator action refers to a stale head')
    idle(position)
    let member: NormalizedExtendedVirtualCoin | undefined
    if (action.command.kind === 'redeem') {
      if (!('memberOutpoint' in action)) throw new Error('Pool operator redemption requires an explicit member outpoint')
      const point = action.memberOutpoint
      member = options?.stagedInput
      if (!member || member.txid !== point.txid || member.vout !== point.vout || member.assets?.length !== 1 || member.assets[0].assetId !== descriptor.shareAssetId) throw new Error('Pool operator redemption requires its explicitly staged share coin')
      const context = poolFreshInputContext(client, descriptor, member, options!.authorization)
      if (!same(context.owner, publicKey) || !same(context.script, ArkAddress.decode(await wallet.getAddress()).pkScript)) throw new Error('Pool operator staged owner or payout differs from its wallet')
    }
    reservation = wallet.reserveVtxos([position.coin, ...(member ? [member] : [])])
    const builder = action.command.kind === 'sweepFees' ? buildPoolFeeSweep(contract, descriptor, position) :
      buildPoolRedemption(contract, descriptor, position, member!, BigInt(action.command.burnShares), BigInt(action.command.minSats), options!.authorization).builder
    let built = await builder.build()
    if (member) {
      built = await authorizePoolFreshSpend(wallet.identity, built, options!.authorization)
    }
    const body = { arkTx: base64.encode(built.arkTx.toPSBT()), checkpointTxs: built.checkpoints.map(checkpoint => base64.encode(checkpoint.toPSBT())) }
    const request: PoolSubmitRequest = { operationId: action.operationId, expectedHead: action.expectedHead, command: action.command,
      memberPubkey: hex.encode(publicKey), arkTxid: built.arkTx.id, ...body }
    return { request, relay: { arkTxid: request.arkTxid, body }, reservation }
  } catch (error) { reservation?.release(); throw error }
  finally { client.dispose() }
}

export interface PoolRenewalDraft {
  proof: Transaction
  message: Proof.RegisterMessage
  inputs: arkade.ArkadeBatchInput[]
  session: SignerSession
  feeSats: bigint
  expectedHead: { txid: string; vout: number }
}

export interface PoolRenewalJournal {
  version: 1
  contractScript: string
  expectedHead: { txid: string; vout: number }
  proof: string
  message: Proof.RegisterMessage
  feeSats: string
  intentId?: string
  registrationAttempted?: boolean
  commitmentTxid?: string
  nextHead?: { txid: string; vout: number }
  status: 'prepared' | 'authorized' | 'registered' | 'confirmed'
  rescue?: true
}

export interface PoolRenewalPersistence {
  load(): Promise<PoolRenewalJournal | undefined>
  save(journal: PoolRenewalJournal): Promise<void>
  loadSession?: PoolRenewalSessionPersistence['load']
  saveSession?: PoolRenewalSessionPersistence['save']
  loadReplay?: PoolBatchReplayPersistence['load']
  saveReplay?: PoolBatchReplayPersistence['save']
}

export interface PoolRenewalReceipt {
  intentId: string | null
  proofTxid: string
  commitmentTxid: string
  nextHead: { txid: string; vout: number }
  snapshot: PoolGameSnapshot
  feeSats: string
}

function preservedPoolPackets(tx: Transaction): ExtensionPacket[] {
  return Extension.fromTx(tx).getPackets().filter(entry => entry.type() === 16 || entry.type() === 17 || entry.type() >= 32 && entry.type() <= 40)
}

function samePoolPackets(first: Transaction, second: Transaction): boolean {
  const encode = (tx: Transaction) => preservedPoolPackets(tx).map(entry => [entry.type(), hex.encode(entry.serialize())]).sort(([a], [b]) => Number(a) - Number(b))
  return canonical(encode(first)) === canonical(encode(second))
}

function renewalUnlocker(contract: Contract, sponsored: boolean, rescue: boolean) {
  return rescue ? (sponsored ? contract.unlock.rescueSponsored() : contract.unlock.rescue()) : sponsored ? contract.unlock.renewSponsored() : contract.unlock.renew()
}

export async function buildPoolRenewalIntent(wallet: Wallet, contract: Contract, descriptor: PoolGameDescriptor, position: PoolGamePosition,
  options: { sponsor?: NormalizedExtendedVirtualCoin; validSeconds?: number; session?: SignerSession; rescue?: boolean } = {}): Promise<PoolRenewalDraft> {
  assertPosition(contract, descriptor, position)
  const operatorKey = toXOnly(hex.decode(descriptor.operatorPubkey))
  if (!options.rescue && !same(await wallet.identity.xOnlyPublicKey(), operatorKey)) throw new Error('Pool renewal requires the configured operator identity')
  const indexed = (await wallet.indexerProvider.getVtxos({ outpoints: [{ txid: position.coin.txid, vout: position.coin.vout }], spendableOnly: false })).vtxos
  if (indexed.length !== 1 || isVtxoSpent(indexed[0]) || indexed[0].isUnrolled || indexed[0].value !== position.coin.value || indexed[0].script !== hex.encode(contract.pkScript)) throw new Error('Pool renewal head is unavailable')
  const sponsor = options.sponsor, unlocker = renewalUnlocker(contract, !!sponsor, !!options.rescue)
  if (!unlocker.fn.arkadeScript) throw new Error('Pool renewal covenant is unavailable')
  const control: arkade.ArkadeExtendedVirtualCoin = { ...indexed[0], tapTree: contract.tapTree,
    forfeitTapLeafScript: unlocker.fn.tapLeafScript, intentTapLeafScript: unlocker.fn.tapLeafScript, arkadeScriptBytes: unlocker.fn.arkadeScript }
  const inputs: arkade.ArkadeBatchInput[] = [control]
  let sponsorScript: Uint8Array | undefined
  if (sponsor) {
    sponsorScript = memberInput(contract, sponsor).script
    if (sponsor.assets?.length) throw new Error('Pool renewal sponsor must be a plain coin')
    const found = (await wallet.indexerProvider.getVtxos({ outpoints: [{ txid: sponsor.txid, vout: sponsor.vout }], spendableOnly: false })).vtxos
    if (found.length !== 1 || isVtxoSpent(found[0]) || found[0].value !== sponsor.value || found[0].script !== sponsor.script) throw new Error('Pool renewal sponsor is unavailable')
    inputs.push({ ...sponsor, isSwept: found[0].isSwept, isSpent: found[0].isSpent, isUnrolled: found[0].isUnrolled, arkadeScriptBytes: new Uint8Array() })
  }
  const info = await wallet.getArkadeInfo({ requireLive: true }), estimator = new Estimator(info.fees.intentFee)
  let feeSats = 0n
  const outputs = () => [{ script: contract.pkScript, amount: BigInt(position.coin.value) },
    ...(sponsor ? [{ script: sponsorScript!, amount: BigInt(sponsor.value) - feeSats }] : [])]
  let stable = false
  for (let i = 0; i < 16; i++) {
    const fee = BigInt(estimator.evaluate(inputs.map(input => toOffchainInputFeeParams(input as NormalizedExtendedVirtualCoin)), [],
      outputs().map(output => ({ amount: output.amount, script: hex.encode(output.script) })), []).satoshis)
    if (fee === feeSats) { stable = true; break }
    feeSats = fee
    if (!sponsor && feeSats) throw new Error('Pool renewal needs a plain sponsor for the operator intent fee')
    bound(feeSats, 0n, 100_000n, 'renewal fee')
    if (sponsor && BigInt(sponsor.value) - feeSats < 330n) throw new Error('Pool renewal sponsor cannot cover the intent fee and its carrier')
  }
  if (!stable) throw new Error('Pool renewal fee did not converge')
  const validSeconds = options.validSeconds ?? 120
  if (!Number.isSafeInteger(validSeconds) || validSeconds < 30 || validSeconds > 600) throw new Error('Invalid pool renewal validity window')
  const session = options.session ?? wallet.identity.signerSession(), now = Math.floor(Date.now() / 1000)
  const message: Proof.RegisterMessage = { type: 'register', onchain_output_indexes: [], valid_at: now - 1,
    expire_at: now + validSeconds, cosigners_public_keys: [hex.encode(await session.getPublicKey())] }
  const packets: ExtensionPacket[] = [Packet.create([AssetGroup.create(ids(descriptor).control, null, [AssetInput.create(1, 1n)], [AssetOutput.create(0, 1n)], [])]),
    EmulatorPacket.create([{ vin: 1, script: unlocker.fn.arkadeScript, witness: new Uint8Array([0]) }]),
    ...preservedPoolPackets(Transaction.fromRaw(position.sourceTx))]
  const proofInputs = await withPrevTxs(inputs.map(input => ({ ...input, prevTx: input.txid === position.coin.txid && input.vout === position.coin.vout ? position.sourceTx : undefined })), wallet.indexerProvider, wallet.onchainProvider)
  let proof = Proof.create(message, proofInputs, [...outputs(), Extension.create(packets).txOut()])
  if (proof.getInput(0).witnessUtxo?.amount !== 0n || !same(proof.getInput(0).witnessUtxo?.script, contract.pkScript) ||
      !same(proof.getInput(1).witnessUtxo?.script, contract.pkScript)) throw new Error('Pool renewal synthetic ownership input changed')
  // A rescuer holds no key on the vault leaves; it signs only its own sponsor and the emulator co-signs the rest.
  const owned = options.rescue ? (sponsor ? [2] : []) : sponsor ? [0, 1, 2] : [0, 1]
  const signed = owned.length ? await wallet.identity.sign(Transaction.fromPSBT(proof.toPSBT()), owned) : Transaction.fromPSBT(proof.toPSBT())
  approvedTransaction(proof, signed, [1])
  if (!options.rescue) {
    verifyTapscriptSignatures(signed, 0, [hex.encode(operatorKey)], undefined, [1])
    verifyTapscriptSignatures(signed, 1, [hex.encode(operatorKey)], undefined, [1])
  }
  proof = signed
  return { proof, message, inputs, session, feeSats, expectedHead: { txid: position.coin.txid, vout: position.coin.vout } }
}

export async function readPoolRenewalPredecessor(contract: Contract, descriptor: PoolGameDescriptor, next: PoolGamePosition,
  indexer: Indexer, loadProof: (txid: string) => Promise<string>): Promise<PoolGamePosition | undefined> {
  assertPosition(contract, descriptor, next)
  const transaction = Transaction.fromRaw(next.sourceTx), groups = Extension.fromTx(transaction).getAssetPacket()?.groups
  const group = groups?.find(entry => entry.assetId?.toString() === descriptor.controlAssetId)
  const reference = group?.inputs[0]?.input
  if (!reference || reference.type !== asset.AssetInputType.Proof) return undefined
  if (groups!.length !== 1 || group!.inputs.length !== 1 || reference.vin !== 0 || reference.amount !== 0n || group!.outputs.length !== 1 || group!.outputs[0].vout !== 0 || group!.outputs[0].amount !== 1n) throw new Error('Invalid pool renewal asset lineage')
  const proof = Transaction.fromPSBT(base64.decode(await loadProof(hex.encode(reference.txid))))
  if (proof.id !== hex.encode(reference.txid) || proof.inputsLength < 2 || proof.inputsLength > 3) throw new Error('Pool renewal proof does not match its batch leaf')
  const localAsset = Packet.create([AssetGroup.create(ids(descriptor).control, null, [AssetInput.create(1, 1n)], [AssetOutput.create(0, 1n)], [])])
  if (!same(Extension.fromTx(proof).getAssetPacket()?.serialize(), localAsset.serialize())) throw new Error('Pool renewal proof does not conserve its original control input')
  const input = proof.getInput(1), previous = await readPoolGamePositionAt(contract, descriptor, { txid: hex.encode(input.txid!), vout: input.index! }, indexer)
  const output = proof.getOutput(0)
  if (previous.coin.value !== next.coin.value || output.amount !== BigInt(next.coin.value) || !same(output.script, contract.pkScript) ||
      !samePoolPackets(Transaction.fromRaw(previous.sourceTx), proof) || !samePoolPackets(proof, transaction) ||
      canonical(snapshotState(previous.state)) !== canonical(snapshotState(next.state))) throw new Error('Pool renewal changes value or authenticated state')
  const indexed = (await indexer.getVtxos({ outpoints: [{ txid: previous.coin.txid, vout: previous.coin.vout }], spendableOnly: false })).vtxos
  const old = indexed.find(coin => coin.txid === previous.coin.txid && coin.vout === previous.coin.vout)
  if (!old || !isVtxoSpent(old) || !old.settledBy || !(next.coin as VirtualCoin).commitmentTxIds?.includes(old.settledBy)) throw new Error('Pool renewal is missing its indexed batch-consumption proof')
  return previous
}

const renewalHolds = new WeakMap<Wallet, Map<string, ReturnType<Wallet['reserveVtxos']>>>()
const renewalSessions = new WeakMap<Wallet, Map<string, PoolRenewalDraft>>()
const renewalRunning = new WeakSet<Wallet>()

type PoolRenewalSponsorReservation = { readonly outpoints: readonly { txid: string; vout: number }[]; release(): void }
export function restorePoolRenewalHolds(wallet: Wallet, journal: PoolRenewalJournal, sponsorReservation?: PoolRenewalSponsorReservation): void {
  if (journal.status === 'confirmed') return
  const proof = Transaction.fromPSBT(base64.decode(journal.proof)), key = proof.id
  let holds = renewalHolds.get(wallet)
  if (!holds) { holds = new Map(); renewalHolds.set(wallet, holds) }
  const points = Array.from({ length: proof.inputsLength - 1 }, (_, index) => {
    const input = proof.getInput(index + 1)
    return { txid: hex.encode(input.txid!), vout: input.index! }
  })
  if (!holds.has(key)) {
    if (sponsorReservation?.outpoints.length) {
      const sponsor = points[1]
      if (!sponsor || sponsorReservation.outpoints.length !== 1 || sponsorReservation.outpoints[0].txid !== sponsor.txid ||
          sponsorReservation.outpoints[0].vout !== sponsor.vout) throw new Error('Pool renewal reservation differs from its approved sponsor')
      const control = wallet.reserveVtxos([points[0]])
      holds.set(key, { outpoints: points, release: () => { control.release(); sponsorReservation.release() } })
    } else holds.set(key, wallet.reserveVtxos(points))
  }
}

async function restoreRenewalDraft(wallet: Wallet, contract: Contract, descriptor: PoolGameDescriptor, journal: PoolRenewalJournal, session: SignerSession): Promise<PoolRenewalDraft> {
  const proof = Transaction.fromPSBT(base64.decode(journal.proof)), position = await readPoolGamePositionAt(contract, descriptor, journal.expectedHead, wallet.indexerProvider)
  if (proof.inputsLength < 2 || proof.inputsLength > 3 || journal.message.cosigners_public_keys.length !== 1 ||
      !same(toXOnly(hex.decode(journal.message.cosigners_public_keys[0])), toXOnly(await session.getPublicKey()))) {
    throw new Error('Saved pool renewal does not match its durable signing session')
  }
  const input = proof.getInput(1)
  if (hex.encode(input.txid!) !== journal.expectedHead.txid || input.index !== journal.expectedHead.vout) throw new Error('Saved pool renewal changed its original head')
  const indexed = (await wallet.indexerProvider.getVtxos({ outpoints: [journal.expectedHead], spendableOnly: false })).vtxos
  const coin = indexed.find(value => value.txid === journal.expectedHead.txid && value.vout === journal.expectedHead.vout)
  if (!coin || isVtxoSpent(coin) || coin.isUnrolled || coin.value !== position.coin.value || coin.script !== hex.encode(contract.pkScript)) {
    throw new Error('Saved pool renewal head is unavailable or changed')
  }
  const unlocker = renewalUnlocker(contract, proof.inputsLength === 3, !!journal.rescue)
  const inputs: arkade.ArkadeBatchInput[] = [{ ...coin, tapTree: contract.tapTree,
    forfeitTapLeafScript: unlocker.fn.tapLeafScript, intentTapLeafScript: unlocker.fn.tapLeafScript, arkadeScriptBytes: unlocker.fn.arkadeScript! }]
  if (proof.inputsLength === 3) {
    const point = proof.getInput(2), coins = await wallet.getVtxos({ withRecoverable: true })
    const stored = coins.find(coin => coin.txid === hex.encode(point.txid!) && coin.vout === point.index)
    const [sponsor] = stored ? await withIndexedState(wallet.indexerProvider, [stored]) : []
    if (!sponsor || isVtxoSpent(sponsor) || sponsor.assets?.length || point.witnessUtxo?.amount !== BigInt(sponsor.value) ||
        hex.encode(point.witnessUtxo.script) !== sponsor.script) throw new Error('Saved pool renewal sponsor is unavailable or changed')
    inputs.push({ ...sponsor, arkadeScriptBytes: new Uint8Array() })
  }
  return { proof, message: journal.message, inputs, session, feeSats: BigInt(journal.feeSats), expectedHead: journal.expectedHead }
}

export async function renewPool(wallet: Wallet, descriptor: PoolGameDescriptor, emulator: EmulatorProvider, persistence: PoolRenewalPersistence,
  options: { sponsor?: NormalizedExtendedVirtualCoin; sponsorReservation?: PoolRenewalSponsorReservation; signal?: AbortSignal; validSeconds?: number; rescue?: boolean } = {}): Promise<PoolRenewalReceipt> {
  if (renewalRunning.has(wallet)) throw new Error('Pool renewal is already running for this wallet')
  renewalRunning.add(wallet)
  let client: arkade.Arkade | undefined
  try {
    const operatorKey = toXOnly(hex.decode(descriptor.operatorPubkey)), rescue = !!options.rescue
    if (!rescue && !same(await wallet.identity.xOnlyPublicKey(), operatorKey)) throw new Error('Pool renewal requires the configured operator identity')
    const info = await emulator.getInfo()
    if (!same(toXOnly(hex.decode(info.signerPubkey)), toXOnly(hex.decode(resolveEmulatorPubkey(wallet.network))))) throw new Error('Pool renewal emulator does not match the trusted SDK key')
    client = await walletClient(wallet)
    const contract = createPoolGameVault(client, descriptor)
    let journal = await persistence.load(), draft: PoolRenewalDraft | undefined, durableSession: SignerSession | undefined
    if (journal && (journal.version !== 1 || journal.contractScript !== hex.encode(contract.pkScript) || !!journal.rescue !== rescue)) throw new Error('Saved pool renewal belongs to another contract or path')
    if (persistence.loadSession && persistence.saveSession && (!journal || await persistence.loadSession())) {
      durableSession = await createDurablePoolRenewalSession({ load: persistence.loadSession, save: persistence.saveSession })
    }
    if (!journal) {
      const position = await readPoolGamePosition(contract, descriptor, wallet.indexerProvider, { includeExpired: true })
      if (!position) throw new Error('Pool has no canonical control output to renew')
      draft = await buildPoolRenewalIntent(wallet, contract, descriptor, position, { ...options, session: durableSession })
      journal = { version: 1, contractScript: hex.encode(contract.pkScript), expectedHead: draft.expectedHead,
        proof: base64.encode(draft.proof.toPSBT()), message: draft.message, feeSats: String(draft.feeSats), status: 'prepared', ...(rescue ? { rescue: true as const } : {}) }
      await persistence.save(journal)
      let sessions = renewalSessions.get(wallet)
      if (!sessions) { sessions = new Map(); renewalSessions.set(wallet, sessions) }
      sessions.set(draft.proof.id, draft)
    }
    restorePoolRenewalHolds(wallet, journal, options.sponsorReservation)
    const proofId = Transaction.fromPSBT(base64.decode(journal.proof)).id
    draft ??= renewalSessions.get(wallet)?.get(proofId)
    const lineage = (next: PoolGamePosition) => {
      const group = Extension.fromTx(Transaction.fromRaw(next.sourceTx)).getAssetPacket()?.groups.find(entry => entry.assetId?.toString() === descriptor.controlAssetId)
      const reference = group?.inputs[0]?.input
      return reference?.type === asset.AssetInputType.Proof ? hex.encode(reference.txid) : undefined
    }
    const renewedHead = async (): Promise<PoolGamePosition | undefined> => {
      if (journal!.nextHead) return readPoolGamePositionAt(contract, descriptor, journal!.nextHead, wallet.indexerProvider)
      const current = await readPoolGamePosition(contract, descriptor, wallet.indexerProvider, { includeExpired: true })
      if (current && lineage(current) === proofId) return current
      const consumed = (await wallet.indexerProvider.getVtxos({ outpoints: [journal!.expectedHead], spendableOnly: false })).vtxos
        .find(coin => coin.txid === journal!.expectedHead.txid && coin.vout === journal!.expectedHead.vout)
      if (!consumed?.settledBy) return undefined
      const history = await getAllNormalizedVtxos(wallet.indexerProvider, [hex.encode(contract.pkScript)], { spendableOnly: false })
      for (const coin of history.filter(value => value.commitmentTxIds.includes(consumed.settledBy!) && value.assets?.length === 1 &&
        value.assets[0].assetId === descriptor.controlAssetId && value.assets[0].amount === 1n)) {
        const next = await readPoolGamePositionAt(contract, descriptor, coin, wallet.indexerProvider)
        if (lineage(next) === proofId) return next
      }
    }
    const confirm = async (): Promise<PoolRenewalReceipt | undefined> => {
      const next = await renewedHead()
      if (!next || next.coin.txid === journal!.expectedHead.txid && next.coin.vout === journal!.expectedHead.vout || lineage(next) !== proofId) return undefined
      const previous = await readPoolRenewalPredecessor(contract, descriptor, next, wallet.indexerProvider, async id => {
        if (id !== proofId) throw new Error('Unexpected pool renewal proof')
        return journal!.proof
      })
      const commitments = (next.coin as VirtualCoin).commitmentTxIds
      const commitmentTxid = (previous?.coin as VirtualCoin | undefined)?.settledBy
      if (!commitmentTxid || !commitments?.includes(commitmentTxid)) return undefined
      if (journal!.commitmentTxid && journal!.commitmentTxid !== commitmentTxid) throw new Error('Saved pool renewal commitment differs from the indexed consumed head')
      journal = { ...journal!, status: 'confirmed', commitmentTxid, nextHead: { txid: next.coin.txid, vout: next.coin.vout } }
      await persistence.save(journal)
      renewalHolds.get(wallet)?.get(proofId)?.release(); renewalHolds.get(wallet)?.delete(proofId)
      renewalSessions.get(wallet)?.delete(proofId)
      return { intentId: journal.intentId ?? null, proofTxid: proofId, commitmentTxid, nextHead: journal.nextHead!, snapshot: poolGameSnapshot(next), feeSats: journal.feeSats }
    }
    const completed = await confirm()
    if (completed) return completed
    if (renewalAbandonable(journal.message)) {
      renewalHolds.get(wallet)?.get(proofId)?.release(); renewalHolds.get(wallet)?.delete(proofId)
      renewalSessions.get(wallet)?.delete(proofId)
      throw new PoolRenewalAbandonedError('Saved pool renewal intent lapsed without a batch outcome; a fresh renewal may start')
    }
    if (journal.registrationAttempted && !journal.intentId) throw new Error('Pool renewal registration result is unknown; retain this exact intent until completion or a proven abort')
    if (!draft && durableSession) draft = await restoreRenewalDraft(wallet, contract, descriptor, journal, durableSession)
    if (!draft) throw new Error('Pool renewal needs recovery: the saved batch signing session is unavailable; reservations remain held')
    if (journal.message.expire_at <= Math.floor(Date.now() / 1000)) throw new Error('Pool renewal intent expired; reconcile its exact batch before starting another attempt')
    if (journal.status === 'prepared') {
      let cosigned: string
      try { cosigned = await emulator.submitIntent({ proof: journal.proof, message: journal.message }) }
      catch (error) { renewalHolds.get(wallet)?.get(proofId)?.release(); renewalHolds.get(wallet)?.delete(proofId); throw error }
      const signed = Transaction.fromPSBT(base64.decode(cosigned))
      const local = Transaction.fromPSBT(base64.decode(journal.proof)), approved = approvedTransaction(local, signed, [1])
      for (let i = 0; i < approved.inputsLength; i++) copyInputSignatures(approved, signed, i)
      if (!rescue) {
        verifyTapscriptSignatures(approved, 0, [hex.encode(operatorKey)], undefined, [1])
        verifyTapscriptSignatures(approved, 1, [hex.encode(operatorKey)], undefined, [1])
      }
      journal = { ...journal, proof: base64.encode(approved.toPSBT()), status: 'authorized' }
      await persistence.save(journal)
    }
    const signer: Identity = { xOnlyPublicKey: () => wallet.identity.xOnlyPublicKey(), compressedPublicKey: () => wallet.identity.compressedPublicKey(),
      signerSession: () => draft!.session, signMessage: (message, kind) => wallet.identity.signMessage(message, kind),
      sign: async (transaction, indexes) => {
        const requested = indexes ?? Array.from({ length: transaction.inputsLength }, (_, i) => i)
        for (const index of requested) {
          const input = transaction.getInput(index), original = draft!.inputs.find(value => value.txid === hex.encode(input.txid ?? new Uint8Array()) && value.vout === input.index)
          if (!original || input.witnessUtxo?.amount !== BigInt(original.value) ||
              !same(input.witnessUtxo.script, VtxoScript.decode(original.tapTree).pkScript)) throw new Error('Pool renewal requested a signature for an unapproved original input')
        }
        const owned = rescue ? requested.filter(index => !same(transaction.getInput(index).witnessUtxo?.script, contract.pkScript)) : requested
        if (!owned.length) return transaction
        const signed = await wallet.identity.sign(Transaction.fromPSBT(transaction.toPSBT()), owned)
        approvedTransaction(transaction, signed)
        return signed
      } }
    const abortController = new AbortController(), abort = () => abortController.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const topics = [...journal.message.cosigners_public_keys, ...draft.inputs.map(input => `${input.txid}:${input.vout}`)]
    const stream = wallet.arkProvider.getEventStream(abortController.signal, topics), firstNext = stream.next()
    void firstNext.catch(() => {})
    const primedStream = (async function* () {
      const first = await firstNext
      if (!first.done) yield first.value
      yield* stream
    })()
    try {
      if (!journal.intentId) {
        journal = { ...journal, registrationAttempted: true }
        await persistence.save(journal)
        const intentId = await wallet.arkProvider.registerIntent({ proof: journal.proof, message: journal.message })
        journal = { ...journal, intentId, status: 'registered' }
        await persistence.save(journal)
      }
      const replay = persistence.loadReplay && persistence.saveReplay
        ? await createDurablePoolBatchReplay({ load: persistence.loadReplay, save: persistence.saveReplay }, { intentId: journal.intentId! }) : undefined
      const savedEvents = replay?.savedEvents() ?? []
      const nonceReplay = createPoolTreeNonceReplayGuard(draft.session, savedEvents)
      const baseHandler = arkade.createArkadeBatchHandler(journal.intentId!, draft.inputs, signer, journal.proof, journal.message,
        nonceReplay.session, wallet.arkProvider, emulator, wallet.network)
      const handler = nonceReplay.handler(baseHandler)
      const commitmentTxid = await Batch.join(replay ? replay.stream(primedStream, abortController.signal) : primedStream, handler, { abortController })
      journal = { ...journal, commitmentTxid }
      await persistence.save(journal)
      return await waitFor(confirm, 'renewed pool control output')
    } finally { options.signal?.removeEventListener('abort', abort); abortController.abort(); await stream.return?.() }
  } finally { renewalRunning.delete(wallet); await client?.dispose() }
}
