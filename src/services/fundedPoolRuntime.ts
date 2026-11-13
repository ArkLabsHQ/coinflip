import {
  arkade, ArkAddress, Extension, RestEmulatorProvider, Transaction, assertAllowedSighashTypes, isVtxoSpent,
  resolveEmulatorPubkey, toXOnly, type NormalizedExtendedVirtualCoin, type VirtualCoin, type Wallet,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { sha256 } from '@scure/btc-signer/utils.js'
import type { PoolCommand, PoolPreparedGame, PoolPublicResponse } from 'arkade-coinflip/dist/pool-protocol.js'
import type { PoolGamePosition, PoolRenewalJournal } from 'arkade-coinflip/dist/pool-game-vault.js'
import type { PoolFreshAuthorization } from 'arkade-coinflip/dist/fresh-pool-input.js'
import { getNetwork, type NetworkResponse } from './api'
import { fundedPoolApi } from './fundedPoolApi'
import {
  confirmFundedPoolJournal, loadFundedPoolJournal, putFundedPoolJournals, releaseFundedPoolInput,
  reserveFundedPoolInput, updateFundedPoolJournal,
  type FundedPoolCashRelease, type FundedPoolContext, type FundedPoolFreshStage, type FundedPoolIntent, type FundedPoolJournalEntry,
} from './fundedPoolJournal'
import type {
  FundedPoolBetInput, FundedPoolDescriptor, FundedPoolDisplay, FundedPoolInputRenewalDisplay, FundedPoolInputRenewalQuote,
  FundedPoolQuote, FundedPoolReceipt, PoolOutpoint,
} from './fundedPoolTypes'
import { normalizePoolOperatorUrl, parseBankrollDescriptor } from './bankrollVaultObserver'
import { isSyncConfirmed } from '@/store/modules/ark/balanceReady'
import { readVerifiedFundedPool, rememberVerifiedFundedPool } from './fundedPoolConnection'
import { mergePoolCashRelease, provePoolCashRelease, submitPoolCashRelease } from './fundedPoolCashRelease'

type Vault = typeof import('arkade-coinflip/dist/pool-game-vault.js')
type Built = { arkTx: Transaction; checkpoints: Transaction[] }
type Contract = arkade.ArkadeContract
interface Plan {
  quote: FundedPoolQuote; descriptor: FundedPoolDescriptor; position: PoolGamePosition
  member: NormalizedExtendedVirtualCoin; built: Built; command: PoolCommand
  secret?: string; game?: PoolPreparedGame
  parts?: Plan[]
  cashRelease?: FundedPoolCashRelease
  freshStage?: FundedPoolFreshStage
}
export interface FundedPoolRuntimeOptions {
  wallet: Wallet; context: FundedPoolContext
  isCurrent(): boolean
  onState(value: FundedPoolDisplay): void
  onRenewalState?(value: FundedPoolInputRenewalDisplay): void
}
export function emptyFundedPoolDisplay(status: FundedPoolDisplay['status'], error: string | null = null): FundedPoolDisplay {
  return { status, descriptor: null, network: null, name: null, operatorFeeBps: null, minHouseEdgeBps: null,
    maxStakeBps: null, verified: false, fairnessTrust: 'operator', head: null, phase: null,
    navSats: null, supply: null, memberShares: null, availableShares: null, estimatedClaimSats: null,
    accruedFeesSats: null, carriedLossSats: null, pending: null, recovery: null, receipts: [],
    capabilities: { subscribe: false, redeem: false, bet: false, recover: false, renewInputs: false }, verifiedAt: null, error }
}
const tx = (encoded: string) => Transaction.fromPSBT(base64.decode(encoded))
const encode = (value: Transaction) => base64.encode(value.toPSBT())
const equalPoint = (a: PoolOutpoint, b: PoolOutpoint) => a.txid === b.txid && a.vout === b.vout
const inputPoint = (value: Transaction, index = 0): PoolOutpoint => {
  const input = value.getInput(index)
  if (!input.txid || input.index === undefined) throw new Error('Pool transaction is missing an input outpoint')
  return { txid: hex.encode(input.txid), vout: input.index }
}
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Pool operation is unavailable'
const sleep = () => new Promise(resolve => setTimeout(resolve, 500))
function canonical(value: unknown): string {
  if (value instanceof Uint8Array) return hex.encode(value)
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${key}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

function descriptor(value: unknown, scope: FundedPoolContext): FundedPoolDescriptor {
  if (!value || typeof value !== 'object') throw new Error('Pool descriptor is unavailable')
  const d = value as FundedPoolDescriptor
  const fields = ['version', 'name', 'network', 'operatorUrl', 'controlAssetId', 'shareAssetId', 'bootstrapTxid', 'checkpointPsbts']
  const base = parseBankrollDescriptor(JSON.stringify(Object.fromEntries(fields.map(key => [key, (d as unknown as Record<string, unknown>)[key]]))), scope)
  if (!/^[a-f0-9]{64}$/i.test(d.operatorPubkey) || !/^5120[a-f0-9]{64}$/i.test(d.operatorPayoutPkScript)) throw new Error('Invalid pool operator policy')
  for (const [value, min, max] of [[d.operatorFeeBps, 0, 3000], [d.minHouseEdgeBps, 0, 1000], [d.maxStakeBps, 1, 2000]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid pool policy bounds')
  }
  return { ...base, operatorPubkey: d.operatorPubkey, operatorPayoutPkScript: d.operatorPayoutPkScript,
    operatorFeeBps: d.operatorFeeBps, minHouseEdgeBps: d.minHouseEdgeBps, maxStakeBps: d.maxStakeBps }
}

function shares(coins: readonly VirtualCoin[], id: string): bigint {
  const seen = new Set<string>()
  let result = 0n
  for (const coin of coins) {
    if (isVtxoSpent(coin)) continue
    const point = `${coin.txid}:${coin.vout}`
    if (seen.has(point)) throw new Error('Duplicate member share output')
    seen.add(point)
    for (const asset of coin.assets ?? []) if (asset.assetId === id) {
      if (typeof asset.amount !== 'bigint' || asset.amount <= 0n) throw new Error('Invalid member share quantity')
      result += asset.amount
    }
  }
  return result
}

export function memberCheckpoint(built: Built, member: PoolOutpoint, head: PoolOutpoint): Transaction {
  if (built.arkTx.inputsLength !== 2 || built.checkpoints.length !== 2) throw new Error('Unexpected pool funding input count')
  const memberMatches = built.checkpoints.filter(checkpoint => checkpoint.inputsLength === 1 && equalPoint(inputPoint(checkpoint), member))
  const poolMatches = built.checkpoints.filter(checkpoint => checkpoint.inputsLength === 1 && equalPoint(inputPoint(checkpoint), head))
  if (memberMatches.length !== 1 || poolMatches.length !== 1 || memberMatches[0] === poolMatches[0] ||
      !equalPoint(inputPoint(built.arkTx, 1), { txid: memberMatches[0].id, vout: 0 }) ||
      !equalPoint(inputPoint(built.arkTx), { txid: poolMatches[0].id, vout: 0 })) throw new Error('Pool checkpoints do not match the approved member and control inputs')
  assertAllowedSighashTypes(built.arkTx)
  for (const checkpoint of built.checkpoints) assertAllowedSighashTypes(checkpoint)
  return memberMatches[0]
}

async function indexedTx(wallet: Wallet, id: string): Promise<Transaction> {
  const matches = (await wallet.indexerProvider.getVirtualTxs([id])).txs.map(tx).filter(value => value.id === id)
  if (matches.length !== 1) throw new Error('Pool transaction is not available from the connected operator indexer')
  return matches[0]
}

export async function proveFundedPoolSpend(wallet: Wallet, intent: FundedPoolIntent): Promise<Transaction | undefined> {
  const local = tx(intent.unsignedArkTx), checkpoints = intent.unsignedCheckpoints.map(tx)
  if (local.id !== intent.arkTxid) throw new Error('Saved pool transaction ID does not match its approved transaction')
  memberCheckpoint({ arkTx: local, checkpoints }, intent.memberOutpoint, intent.expectedHead)
  const points = [intent.expectedHead, intent.memberOutpoint]
  const coins = (await wallet.indexerProvider.getVtxos({ outpoints: points, spendableOnly: false })).vtxos
  for (const point of points) {
    const matches = coins.filter(coin => equalPoint(coin, point))
    if (matches.length !== 1) return undefined
    const coin = matches[0], checkpoint = checkpoints.find(item => equalPoint(inputPoint(item), point))!
    const previous = checkpoint.getInput(0).witnessUtxo
    if (!previous || coin.value !== Number(previous.amount) || coin.script !== hex.encode(previous.script)) throw new Error('Indexed pool input differs from the locally approved coin')
    if (!isVtxoSpent(coin)) return undefined
    if (coin.spentBy !== checkpoint.id || coin.arkTxId !== local.id) return undefined
  }
  const actual = await indexedTx(wallet, local.id)
  if (actual.id !== local.id) throw new Error('Indexed pool receipt does not match the approved transaction')
  return actual
}

export function createFundedPoolRuntime(options: FundedPoolRuntimeOptions) {
  const { wallet } = options
  const context: FundedPoolContext = Object.freeze({ publicKey: options.context.publicKey,
    network: options.context.network, operatorUrl: options.context.operatorUrl })
  let disposed = false, sequence = 0, shown = 0, operation = false, recovering = false
  let client: arkade.Arkade | undefined, contract: Contract | undefined, vault: Vault | undefined
  let selected: FundedPoolDescriptor | undefined, position: PoolGamePosition | undefined
  let publicState: PoolPublicResponse | undefined
  let coordinatorOnline = true, connection: NetworkResponse | undefined
  let renewal: ReturnType<typeof import('./fundedPoolInputRenewal').createFundedPoolInputRenewal> | undefined
  let renewalDisplay: FundedPoolInputRenewalDisplay = { status: 'idle', error: null, intentId: null }
  let renewalRequirement: { kind: 'plain' | 'shares'; amount: bigint } | undefined
  let state = emptyFundedPoolDisplay('loading')
  let watchRelease: (() => Promise<void>) | undefined, unsubscribe: (() => void) | undefined
  let initializing: Promise<void> | undefined, refreshing: Promise<void> | undefined, initialized = false, refreshAgain = false
  let boundary: ReturnType<typeof setTimeout> | undefined
  const plans = new Map<string, Plan>()
  const releasePlan = (plan: Plan) => { for (const part of plan.parts ?? [plan]) {
    releaseFundedPoolInput(wallet, part.quote.id)
    releaseFundedPoolInput(wallet, `${part.quote.id}-source`)
    releaseFundedPoolInput(wallet, `${part.quote.id}-cash`)
  } }
  const expiryTimers = new Set<ReturnType<typeof setTimeout>>()
  const current = () => !disposed && options.isCurrent()
  const assertCurrent = () => { if (!current()) throw new Error('Wallet context changed during the pool operation') }
  const publish = (next: FundedPoolDisplay) => { if (current()) { state = next; options.onState(next) } }
  const patch = (next: Partial<FundedPoolDisplay>) => publish({ ...state, ...next })
  const disabled = { subscribe: false, redeem: false, bet: false, recover: true }
  const pendingState = (entry: FundedPoolJournalEntry, reason?: string) => patch({ status: reason ? 'recovery' : 'pending',
    pending: { id: entry.id, kind: entry.intent!.quote.kind, stage: reason ? 'recovery' : entry.stage,
      arkTxid: entry.intent!.freshStage?.ownerAuthorizationPending ? null : entry.intent!.arkTxid, error: reason ?? null },
    recovery: reason ? { operationId: entry.id, reason } : null, capabilities: disabled, error: reason ?? null })

  async function initialize() {
    if (initialized) return
    if (!initializing) initializing = (async () => {
      const cached = readVerifiedFundedPool(context)
      try { publicState = await fundedPoolApi.get(); assertCurrent(); coordinatorOnline = true }
      catch (error) { assertCurrent(); if (!cached) throw error; coordinatorOnline = false }
      if (coordinatorOnline && !publicState?.descriptor) { publish(emptyFundedPoolDisplay('unconfigured')); return }
      selected = descriptor(coordinatorOnline ? publicState!.descriptor : cached!.descriptor, context)
      let network: NetworkResponse
      try { network = await getNetwork(); assertCurrent() }
      catch (error) { assertCurrent(); if (!cached) throw error; network = cached.network }
      const trusted = toXOnly(hex.decode(resolveEmulatorPubkey(wallet.network, process.env.VUE_APP_EMULATOR_PUBKEY?.trim() || undefined)))
      if (network.network !== context.network || normalizePoolOperatorUrl(network.operatorUrl) !== context.operatorUrl ||
          !network.emulator || hex.encode(toXOnly(hex.decode(network.emulator.signerPubkey))) !== hex.encode(trusted)) {
        throw new Error('Pool coordinator network or emulator key does not match the trusted wallet configuration')
      }
      const info = await wallet.getArkadeInfo({ requireLive: true }); assertCurrent()
      if (info.network !== context.network) throw new Error('Pool operator reports a different network')
      vault = await import('arkade-coinflip/dist/pool-game-vault.js'); assertCurrent()
      const manager = await wallet.getContractManager(); assertCurrent()
      client = await arkade.Arkade.connect({ arkade: { getInfo: async () => info }, indexer: wallet.indexerProvider,
        network: wallet.network, emulatorPubkey: process.env.VUE_APP_EMULATOR_PUBKEY?.trim() || undefined }); assertCurrent()
      contract = vault.createPoolGameVault(client, selected)
      await vault.verifyPoolBootstrap(contract, selected, wallet.indexerProvider); assertCurrent()
      connection = network
      rememberVerifiedFundedPool(context, selected, network)
      const script = hex.encode(contract.pkScript)
      const existing = await manager.getWatchedScripts(); assertCurrent()
      if (!existing.some(item => item.script === script)) {
        await manager.watchScript(script, { label: selected.name })
        watchRelease = () => manager.unwatchScript(script)
        assertCurrent()
      }
      unsubscribe = manager.onContractEvent(event => {
        if (event.type === 'connection_reset' || event.contractScript === script || 'contract' in event) void refresh().catch(() => {})
      })
      const renewals = await import('./fundedPoolInputRenewal'); assertCurrent()
      renewal = renewals.createFundedPoolInputRenewal({ wallet, context, shareAssetId: selected.shareAssetId,
        minimumLifetimeSeconds: vault.poolInputPolicy(client).minTTL, isCurrent: current,
        onState: value => {
          if (!current()) return
          renewalDisplay = value
          options.onRenewalState?.(value)
          const busy = value.status === 'renewing' || value.status === 'recovery'
          patch({ capabilities: { ...state.capabilities, subscribe: !busy && state.capabilities.subscribe,
            redeem: !busy && state.capabilities.redeem, bet: !busy && state.capabilities.bet,
            renewInputs: value.status === 'needed' && !state.pending } })
        } })
      initialized = true
    })().catch(async error => {
      unsubscribe?.(); unsubscribe = undefined
      try { await watchRelease?.() } finally { watchRelease = undefined; await client?.dispose(); client = undefined; contract = undefined }
      throw error
    }).finally(() => { initializing = undefined })
    return initializing
  }

  async function readDisplay(request: number) {
    if (!contract || !selected || !vault) return
    try { publicState = await fundedPoolApi.get(); assertCurrent(); coordinatorOnline = true }
    catch { assertCurrent(); coordinatorOnline = false; publicState = { status: 'unavailable', fairnessAssumption: 'unresolved', descriptor: selected, head: null, history: [],
      capabilities: { subscribe: false, redeem: true, play: false, reason: 'Pool coordinator is unavailable; existing shares can be redeemed directly through the covenant service' },
      pricing: { configuredHouseStakeDiscountBps: 0, minHouseEdgeBps: selected.minHouseEdgeBps } } }
    const advertised = publicState!
    if (JSON.stringify(descriptor(advertised.descriptor, context)) !== JSON.stringify(selected)) throw new Error('The configured pool descriptor changed; reconnect before continuing')
    position = await vault.readPoolGamePosition(contract, selected, wallet.indexerProvider, { includeExpired: true }); assertCurrent()
    const owned = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true }); assertCurrent()
    const spendable = await wallet.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true, requireSynced: true }); assertCurrent()
    const manager = await wallet.getContractManager(); assertCurrent()
    if (!isSyncConfirmed(manager.getSyncState())) throw new Error('Wallet member holdings have not completed a live sync')
    const records = await loadFundedPoolJournal(context); assertCurrent()
    await renewal?.refresh(); assertCurrent()
    const waiting = records.find(entry => entry.status === 'pending')
    const stagedSharesUnknown = !!waiting?.intent?.freshStage?.transfer.signedArkTx &&
      !!waiting.intent.freshStage.sourceMember.assets?.some(asset => asset.assetId === selected!.shareAssetId)
    const held = shares(owned, selected.shareAssetId), available = shares(spendable, selected.shareAssetId)
    if (!stagedSharesUnknown && (available > held || position && held > position.state.supply)) throw new Error('Member holdings are inconsistent with the pool supply')
    // Drop only reads older than one already shown; an unfinished newer read must not hide an action's result.
    if (request < shown) return
    shown = request
    const snapshot = position && vault.poolGameSnapshot(position), idle = position?.state.phase === 'idle'
    clearTimeout(boundary)
    const next = [snapshot?.admissionClosesAt, snapshot?.rescueOpensAt, snapshot?.expiresAt].find((at): at is number => typeof at === 'number' && at > Date.now())
    boundary = next === undefined ? undefined : setTimeout(() => void refresh().catch(() => {}), Math.min(next - Date.now() + 50, 2 ** 31 - 1))
    const ready = !!snapshot?.readyForOperations && idle && !waiting && renewalDisplay.status !== 'renewing' && renewalDisplay.status !== 'recovery'
    publish({ ...emptyFundedPoolDisplay(waiting ? 'recovery' : position ? 'ready' : 'unavailable'),
      descriptor: selected, network: selected.network, name: selected.name, operatorFeeBps: selected.operatorFeeBps,
      minHouseEdgeBps: selected.minHouseEdgeBps, maxStakeBps: selected.maxStakeBps, verified: true,
      head: position ? { txid: position.coin.txid, vout: position.coin.vout } : null, phase: position?.state.phase ?? null,
      navSats: position?.state.navSats.toString() ?? null, supply: position?.state.supply.toString() ?? null,
      accruedFeesSats: position?.state.accruedFeesSats.toString() ?? null, carriedLossSats: position?.state.carriedLossSats.toString() ?? null,
      memberShares: stagedSharesUnknown ? null : held.toString(), availableShares: stagedSharesUnknown ? null : available.toString(),
      estimatedClaimSats: !stagedSharesUnknown && position ? (held * position.state.navSats / position.state.supply).toString() : null,
      receipts: records.flatMap(entry => entry.receipt ? [entry.receipt] : []).reverse(), verifiedAt: Date.now(),
      capabilities: { subscribe: ready && advertised.capabilities.subscribe, redeem: ready && available > 0n && !!connection?.emulator,
        bet: ready && advertised.capabilities.play, recover: !!waiting, renewInputs: !waiting && renewalDisplay.status === 'needed',
        rescue: !waiting && !!connection?.emulator && snapshot?.rescueOpensAt != null && snapshot.rescueOpensAt <= Date.now() },
      error: position ? snapshot?.recoveryReason ?? advertised.capabilities.reason ?? null : 'No unspent pool control output is available; retirement has not been proven' })
    if (waiting) pendingState(waiting, waiting.error ?? 'A saved pool operation needs reconciliation')
  }

  async function fresh() {
    assertCurrent()
    await initialize(); assertCurrent()
    await readDisplay(++sequence); assertCurrent()
    if (!position || !selected || !contract || !vault || !vault.poolGameSnapshot(position).readyForOperations ||
        position.state.phase !== 'idle' || state.pending) throw new Error('Pool is not available for a new operation')
    return { position, descriptor: selected, contract, vault }
  }

  function prepareCashRelease(built: Built, member: NormalizedExtendedVirtualCoin, held: bigint, id: string, reserve = true): FundedPoolCashRelease | undefined {
    const output = built.arkTx.getOutput(1)
    if (held <= 0n || output.amount === undefined || output.amount < 660n) return undefined
    const coin = { ...member, txid: built.arkTx.id, vout: 1, value: Number(output.amount), assets: [{ assetId: selected!.shareAssetId, amount: held }],
      isSpent: false, spentBy: '', arkTxId: '', settledBy: '', isUnrolled: false, isSwept: false }
    const split = vault!.buildPoolShareCashRelease(coin, selected!.shareAssetId, client!.checkpoint)
    const sourceOutpoint = { txid: coin.txid, vout: coin.vout }
    if (reserve) reserveFundedPoolInput(wallet, `${id}-cash`, sourceOutpoint)
    return { arkTxid: split.arkTx.id, sourceOutpoint, unsignedArkTx: encode(split.arkTx), unsignedCheckpoints: split.checkpoints.map(encode),
      inputs: split.inputs, outputs: split.outputs, serverUnrollScriptHex: hex.encode(client!.checkpoint.script),
      serverPubkeyHex: hex.encode(client!.serverKey), cashSats: split.cashSats.toString() }
  }

  function prepareFreshStage(member: NormalizedExtendedVirtualCoin, id: string, authorization: PoolFreshAuthorization): FundedPoolFreshStage {
    const built = vault!.buildPoolFreshStage(client!, selected!, member, hex.decode(context.publicKey), hex.decode(member.script), authorization)
    reserveFundedPoolInput(wallet, id, built.stagedInput)
    return { transfer: { arkTxid: built.arkTx.id, sourceOutpoint: { txid: member.txid, vout: member.vout },
      unsignedArkTx: encode(built.arkTx), unsignedCheckpoints: built.checkpoints.map(encode), inputs: built.inputs, outputs: built.outputs,
      serverUnrollScriptHex: hex.encode(client!.checkpoint.script), serverPubkeyHex: hex.encode(client!.serverKey), cashSats: '0' },
    sourceMember: member, stagedInput: built.stagedInput, authorization, ownerAuthorizationPending: true }
  }

  async function prepareRedemptionSequence(value: Awaited<ReturnType<typeof fresh>>, candidates: NormalizedExtendedVirtualCoin[], amount: bigint, id: string) {
    const chosen: Array<{ member: NormalizedExtendedVirtualCoin; burn: bigint; id: string }> = []
    let remaining = amount
    for (const member of candidates.sort((a, b) => a.assets![0].amount > b.assets![0].amount ? -1 : 1)) {
      const burn = member.assets![0].amount < remaining ? member.assets![0].amount : remaining
      chosen.push({ member, burn, id: `${id}-part-${chosen.length + 1}` }); remaining -= burn
      if (!remaining) break
    }
    if (remaining) throw new Error('Not enough spendable member shares are available')
    if (chosen.length > 50) throw new Error('Redeem at most 50 share outputs in one review')
    const parts: Plan[] = [], expiresAt = Date.now() + 60_000
    let next: PoolGamePosition | undefined = value.position, payout = 0n
    try {
      for (const part of chosen) reserveFundedPoolInput(wallet, `${part.id}-source`, part.member)
      for (const part of chosen) {
        if (!next) throw new Error('The pool retired before all approved share burns')
        const freshStage = prepareFreshStage(part.member, part.id, { validUntil: Math.floor(expiresAt / 1000), minTTL: value.vault.poolInputPolicy(client!).minTTL })
        const result = value.vault.buildPoolRedemption(value.contract, value.descriptor, next, freshStage.stagedInput, part.burn, undefined, freshStage.authorization)
        const built = await result.builder.build(); assertCurrent()
        const head = Object.freeze({ txid: next.coin.txid, vout: next.coin.vout })
        memberCheckpoint(built, freshStage.stagedInput, head)
        const cashRelease = prepareCashRelease(built, part.member, part.member.assets![0].amount - part.burn, part.id, false)
        const quote: FundedPoolQuote = Object.freeze({ id: part.id, kind: 'redeem', transactionCount: cashRelease ? 3 : 2,
          cashReleasedSats: cashRelease?.cashSats ?? '0', head, expiresAt,
          amountSats: result.payoutSats.toString(), feeSats: '0', mintedShares: '0', burnShares: part.burn.toString(), minShares: '0',
          minSats: result.payoutSats.toString(), payoutSats: result.payoutSats.toString(), equitySats: '0', ownershipBps: '0',
          playerStakeSats: '0', houseStakeSats: '0', expectedPayoutSats: result.payoutSats.toString(), oddsN: null, oddsLo: null, oddsTarget: null })
        parts.push({ quote, descriptor: value.descriptor, position: next, member: freshStage.stagedInput, built, cashRelease, freshStage,
          command: { kind: 'redeem', burnShares: part.burn.toString(), minSats: result.payoutSats.toString() } })
        payout += result.payoutSats
        next = value.vault.poolPositionAfterRedemption(value.contract, value.descriptor, next, built.arkTx, part.burn)
      }
      const heldAfter = BigInt(state.memberShares!) - amount
      const quote: FundedPoolQuote = Object.freeze({ ...parts[0].quote, id, transactionCount: parts.reduce((sum, part) => sum + (part.quote.transactionCount ?? 1), 0),
        cashReleasedSats: parts.reduce((sum, part) => sum + BigInt(part.cashRelease?.cashSats ?? '0'), 0n).toString(),
        burnShares: amount.toString(), amountSats: payout.toString(), minSats: payout.toString(), payoutSats: payout.toString(), expectedPayoutSats: payout.toString(),
        equitySats: next ? (heldAfter * next.state.navSats / next.state.supply).toString() : '0',
        ownershipBps: next ? (heldAfter * 10000n / next.state.supply).toString() : '0' })
      const plan = { ...parts[0], quote, parts }
      plans.set(id, plan)
      const timer = setTimeout(() => { expiryTimers.delete(timer); if (plans.delete(id)) releasePlan(plan) }, Math.max(0, expiresAt - Date.now()))
      expiryTimers.add(timer)
      return quote
    } catch (error) { for (const part of chosen) { releaseFundedPoolInput(wallet, part.id); releaseFundedPoolInput(wallet, `${part.id}-source`); releaseFundedPoolInput(wallet, `${part.id}-cash`) } throw error }
  }

  async function prepare(kind: 'subscribe' | 'redeem' | 'openGame', amount: bigint, bet?: FundedPoolBetInput): Promise<FundedPoolQuote> {
    if (operation) throw new Error('Another pool operation is in progress')
    if (typeof amount !== 'bigint' || amount <= 0n) throw new Error('Pool amount must be a positive integer')
    renewalRequirement = { kind: kind === 'redeem' ? 'shares' : 'plain', amount: kind === 'redeem' ? amount : amount + 330n }
    operation = true
    let id: string | undefined
    try {
      for (const [key, plan] of plans) { releasePlan(plan); plans.delete(key) }
      const value = await fresh(); assertCurrent()
      const capability = kind === 'openGame' ? 'bet' : kind
      if (!state.capabilities[capability]) throw new Error('Pool operation is currently unavailable')
      const available = await wallet.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true, requireSynced: true }); assertCurrent()
      const horizon = Date.now() + (value.vault.poolInputPolicy(client!).minTTL + 120) * 1000
      const freshCoins = available.filter(coin => coin.expiresAt && coin.expiresAtHeight === undefined && coin.expiresAt.getTime() >= horizon)
      const sourceMember = freshCoins.filter(coin => kind === 'redeem' ? coin.assets?.length === 1 && coin.assets[0].assetId === value.descriptor.shareAssetId && coin.assets[0].amount >= amount
        : !coin.assets?.length && BigInt(coin.value) >= amount + 330n).sort((a, b) => a.value - b.value)[0]
      id = crypto.randomUUID()
      if (!sourceMember && kind === 'redeem') {
        const shares = freshCoins.filter(coin => coin.assets?.length === 1 && coin.assets[0].assetId === value.descriptor.shareAssetId)
        if (shares.reduce((sum, coin) => sum + coin.assets![0].amount, 0n) < amount) throw new Error('Renew the wallet share inputs before reviewing this redemption')
        return await prepareRedemptionSequence(value, shares, amount, id)
      }
      if (!sourceMember && available.some(coin => !coin.assets?.length && BigInt(coin.value) >= amount + 330n)) throw new Error('Renew this wallet input before reviewing the pool operation')
      if (!sourceMember) throw new Error('A single plain bitcoin output with 330 sats change is required')
      reserveFundedPoolInput(wallet, `${id}-source`, sourceMember)
      const freshStage = prepareFreshStage(sourceMember, id, { validUntil: Math.floor(Date.now() / 1000) + 60, minTTL: value.vault.poolInputPolicy(client!).minTTL })
      const member = freshStage.stagedInput
      const head = { txid: value.position.coin.txid, vout: value.position.coin.vout }
      let minted = 0n, payout = 0n, game: PoolPreparedGame | undefined, secret: string | undefined
      let builder: arkade.ArkadeTransactionBuilder, command: PoolCommand
      let expiresAt = freshStage.authorization.validUntil * 1000
      if (kind === 'subscribe') {
        const result = value.vault.buildPoolSubscription(value.contract, value.descriptor, value.position, member, amount, undefined, freshStage.authorization)
        builder = result.builder; minted = result.mintedShares
        command = { kind, depositSats: amount.toString(), minShares: minted.toString() }
      } else if (kind === 'redeem') {
        const result = value.vault.buildPoolRedemption(value.contract, value.descriptor, value.position, member, amount, undefined, freshStage.authorization)
        builder = result.builder; payout = result.payoutSats
        command = { kind, burnShares: amount.toString(), minSats: payout.toString() }
      } else {
        if (!bet || !Number.isInteger(bet.oddsN) || bet.oddsN < 2 || bet.oddsN > 256 || !Number.isInteger(bet.oddsLo) || !Number.isInteger(bet.oddsTarget) ||
            bet.oddsLo < 0 || bet.oddsTarget <= bet.oddsLo || bet.oddsTarget > bet.oddsN) throw new Error('Invalid pool game odds')
        const address = await wallet.getAddress(); assertCurrent()
        if (hex.encode(ArkAddress.decode(address).pkScript) !== sourceMember.script) throw new Error('The funding coin must use the current wallet payout address')
        const reveal = crypto.getRandomValues(new Uint8Array(17))
        while (reveal[0] >= 256 - 256 % bet.oddsN) crypto.getRandomValues(reveal.subarray(0, 1))
        reveal[0] %= bet.oddsN
        secret = hex.encode(reveal)
        const hash = hex.encode(sha256(reveal))
        game = await fundedPoolApi.prepare({ requestId: id, expectedHead: head, playerPubkey: context.publicKey, playerHash: hash,
          playerPayoutAddress: address, playerStakeSats: amount.toString(), oddsN: bet.oddsN, oddsLo: bet.oddsLo, oddsTarget: bet.oddsTarget }); assertCurrent()
        if (!equalPoint(game.expectedHead, head) || game.playerHash !== hash || game.playerPubkey !== context.publicKey || game.playerPayoutAddress !== address ||
            game.playerStakeSats !== amount.toString() || game.oddsN !== bet.oddsN || game.oddsLo !== bet.oddsLo || game.oddsTarget !== bet.oddsTarget ||
            game.cancelAt < Math.floor(Date.now() / 1000) + 120 || game.finalAt < game.cancelAt + 120 || game.finalAt > Math.floor(Date.now() / 1000) + 86400) {
          throw new Error('Pool game quote changed the approved player terms or recovery deadlines')
        }
        expiresAt = Math.min(expiresAt, game.expiresAt)
        builder = value.vault.buildPoolOpenGame(value.contract, value.descriptor, value.position, member, game, freshStage.authorization).builder
        command = { kind, gameId: game.gameId }
      }
      const built = await builder.build(); assertCurrent()
      memberCheckpoint(built, member, head)
      const cashRelease = kind === 'openGame' ? undefined : prepareCashRelease(built, sourceMember,
        kind === 'subscribe' ? minted : member.assets![0].amount - amount, id, false)
      const nextSupply = value.position.state.supply + minted - (kind === 'redeem' ? amount : 0n)
      const nextShares = BigInt(state.memberShares ?? '0') + minted - (kind === 'redeem' ? amount : 0n)
      const nextNav = value.position.state.navSats + (kind === 'subscribe' ? amount : 0n) - payout
      const quote: FundedPoolQuote = Object.freeze({ id, kind, transactionCount: cashRelease ? 3 : 2, cashReleasedSats: cashRelease?.cashSats ?? '0', head: Object.freeze(head), expiresAt,
        amountSats: kind === 'redeem' ? payout.toString() : amount.toString(), feeSats: '0', mintedShares: minted.toString(),
        burnShares: kind === 'redeem' ? amount.toString() : '0', minShares: minted.toString(), minSats: payout.toString(), payoutSats: payout.toString(),
        equitySats: nextSupply ? (nextShares * nextNav / nextSupply).toString() : '0', ownershipBps: nextSupply ? (nextShares * 10000n / nextSupply).toString() : '0',
        playerStakeSats: game?.playerStakeSats ?? '0', houseStakeSats: game?.houseStakeSats ?? '0',
        expectedPayoutSats: game ? (BigInt(game.playerStakeSats) + BigInt(game.houseStakeSats)).toString() : payout.toString(),
        oddsN: game?.oddsN ?? null, oddsLo: game?.oddsLo ?? null, oddsTarget: game?.oddsTarget ?? null })
      plans.set(id, { quote, descriptor: value.descriptor, position: value.position, member, built, command, secret, game, cashRelease, freshStage })
      const planId = id
      const timer = setTimeout(() => {
        expiryTimers.delete(timer)
        const expired = plans.get(planId)
        if (expired && plans.delete(planId)) releasePlan(expired)
      }, Math.max(0, expiresAt - Date.now()))
      expiryTimers.add(timer)
      return quote
    } catch (error) { if (id) { releaseFundedPoolInput(wallet, id); releaseFundedPoolInput(wallet, `${id}-source`); releaseFundedPoolInput(wallet, `${id}-cash`) } throw error }
    finally { operation = false }
  }

  async function stage(entry: FundedPoolJournalEntry, value: FundedPoolJournalEntry['stage']) {
    const saved = await updateFundedPoolJournal(context, entry.id, current => {
      if (current.status !== 'pending' || !current.intent) throw new Error('This pool operation has already finished')
      return { ...current, stage: value, error: null }
    }); assertCurrent()
    pendingState(saved)
    return saved
  }

  async function authorizeFreshEntry(entry: FundedPoolJournalEntry, before: PoolGamePosition): Promise<FundedPoolJournalEntry> {
    const intent = entry.intent!, fresh = intent.freshStage
    if (!fresh) throw new Error('Saved operation is missing its fresh input staging plan')
    const actualState = { supply: before.state.supply.toString(), navSats: before.state.navSats.toString(),
      carriedLossSats: before.state.carriedLossSats.toString(), accruedFeesSats: before.state.accruedFeesSats.toString() }
    if (canonical(actualState) !== canonical(intent.beforeState)) throw new Error('The original pool accounting changed; request a fresh review')
    let builder: arkade.ArkadeTransactionBuilder
    if (intent.command.kind === 'subscribe') builder = vault!.buildPoolSubscription(contract!, selected!, before, fresh.stagedInput,
      BigInt(intent.command.depositSats), BigInt(intent.command.minShares), fresh.authorization).builder
    else if (intent.command.kind === 'redeem') builder = vault!.buildPoolRedemption(contract!, selected!, before, fresh.stagedInput,
      BigInt(intent.command.burnShares), BigInt(intent.command.minSats), fresh.authorization).builder
    else {
      if (!intent.game) throw new Error('The saved pool game terms are missing')
      if (!intent.playerSecretHex || !/^[a-f0-9]{34}$/i.test(intent.playerSecretHex) ||
          hex.encode(sha256(hex.decode(intent.playerSecretHex))) !== intent.game.playerHash ||
          hex.decode(intent.playerSecretHex)[0] >= intent.game.oddsN || intent.playerPayoutPkScript !== fresh.sourceMember.script ||
          hex.encode(ArkAddress.decode(intent.game.playerPayoutAddress).pkScript) !== fresh.sourceMember.script) {
        throw new Error('The saved pool game credentials do not match the reviewed commitment and payout')
      }
      builder = vault!.buildPoolOpenGame(contract!, selected!, before, fresh.stagedInput, intent.game, fresh.authorization).builder
    }
    const built = await builder.build(); assertCurrent()
    const head = { txid: before.coin.txid, vout: before.coin.vout }
    memberCheckpoint(built, fresh.stagedInput, head)
    await stage(entry, 'authorizing')
    const authorized = await vault!.authorizePoolFreshSpend(wallet.identity, built, fresh.authorization); assertCurrent()
    memberCheckpoint(authorized, fresh.stagedInput, head)
    const held = intent.command.kind === 'subscribe' ? BigInt(intent.quote.mintedShares) : intent.command.kind === 'redeem'
      ? (fresh.sourceMember.assets?.[0].amount ?? 0n) - BigInt(intent.command.burnShares) : 0n
    const cashRelease = prepareCashRelease(authorized, fresh.sourceMember, held, entry.id, false)
    if ((cashRelease?.cashSats ?? '0') !== (intent.quote.cashReleasedSats ?? '0')) {
      throw new Error('Owner authorization changed the reviewed cash release')
    }
    const result = await updateFundedPoolJournal(context, entry.id, saved => {
      const prior = saved.intent, stage = prior?.freshStage
      if (saved.status !== 'pending' || !prior || !stage) throw new Error('This pool operation has already finished')
      if (stage.transfer.arkTxid !== fresh.transfer.arkTxid || canonical(prior.command) !== canonical(intent.command) ||
          canonical(prior.beforeState) !== canonical(actualState)) throw new Error('The saved pool authorization semantics changed')
      if (!stage.ownerAuthorizationPending) {
        if (!equalPoint(prior.expectedHead, head)) throw new Error('The finalized pool authorization refers to another head')
        return saved
      }
      if (prior.arkTxid !== intent.arkTxid) throw new Error('Another authorization changed the pending pool draft')
      return { ...saved, stage: 'prepared', intent: { ...prior,
        arkTxid: authorized.arkTx.id, expectedHead: head, unsignedArkTx: encode(authorized.arkTx), unsignedCheckpoints: authorized.checkpoints.map(encode),
        signedArkTx: encode(authorized.arkTx), signedCheckpoints: authorized.checkpoints.map(encode), cashRelease,
        quote: { ...prior.quote, head }, freshStage: { ...stage, authorization: authorized.authorization,
          ownerMessageHex: hex.encode(authorized.message), ownerAuthorizationPending: false },
      } }
    }); assertCurrent()
    if (result.intent!.cashRelease) reserveFundedPoolInput(wallet, `${entry.id}-cash`, result.intent!.cashRelease!.sourceOutpoint)
    return result
  }

  async function ensureFreshStage(entry: FundedPoolJournalEntry, allowSign: boolean): Promise<void> {
    const fresh = entry.intent?.freshStage
    if (!fresh) throw new Error('Saved operation is missing its fresh input staging plan')
    reserveFundedPoolInput(wallet, `${entry.id}-source`, fresh.transfer.sourceOutpoint)
    reserveFundedPoolInput(wallet, entry.id, fresh.stagedInput)
    if (await provePoolCashRelease(wallet, fresh.transfer)) { assertCurrent(); return }
    assertCurrent()
    await stage(entry, 'staging')
    await submitPoolCashRelease({ wallet, operatorUrl: context.operatorUrl, plan: fresh.transfer, allowSign, isCurrent: current,
      save: async transfer => {
        const saved = await updateFundedPoolJournal(context, entry.id, previous => {
          if (previous.status !== 'pending' || !previous.intent) throw new Error('This pool operation has already finished')
          if (previous.intent.freshStage?.transfer.arkTxid !== transfer.arkTxid ||
              previous.intent.arkTxid !== entry.intent!.arkTxid) throw new Error('The saved staging transaction identity changed')
          return { ...previous, intent: { ...previous.intent, freshStage: { ...previous.intent.freshStage,
            transfer: mergePoolCashRelease(previous.intent.freshStage.transfer, transfer) } } }
        }); assertCurrent()
        entry.intent = saved.intent
        return saved.intent!.freshStage!.transfer
      } }); assertCurrent()
    for (let attempt = 0; attempt < 8; attempt++) {
      if (await provePoolCashRelease(wallet, fresh.transfer)) { assertCurrent(); return }
      await sleep(); assertCurrent()
    }
    throw new Error('The reviewed input staging transaction is waiting for indexed confirmation')
  }

  async function abandonFreshEntry(entry: FundedPoolJournalEntry, reason: string, allowSign: boolean): Promise<boolean> {
    const latest = (await loadFundedPoolJournal(context)).find(value => value.id === entry.id); assertCurrent()
    if (!latest) throw new Error('The saved staging recovery is missing')
    const release = () => {
      releaseFundedPoolInput(wallet, entry.id)
      releaseFundedPoolInput(wallet, `${entry.id}-source`)
      releaseFundedPoolInput(wallet, `${entry.id}-cash`)
    }
    if (latest.status !== 'pending') { release(); return true }
    if (!latest.intent?.freshStage) throw new Error('Saved operation is missing its fresh input staging plan')
    if (latest.intent.arkTxid !== entry.intent!.arkTxid) { entry.intent = latest.intent; return reconcile(entry, allowSign) }
    entry.intent = latest.intent
    let fresh = latest.intent.freshStage
    const finish = async () => {
      const updated = await updateFundedPoolJournal(context, entry.id, saved => {
        if (saved.status !== 'pending') return saved
        if (!saved.intent || saved.intent.arkTxid !== entry.intent!.arkTxid) throw new Error('The finalized pool operation identity changed')
        return { ...saved, status: 'abandoned', stage: 'recovery', error: reason }
      }); assertCurrent()
      if (updated.status === 'pending') return false
      release()
      return true
    }
    if (fresh.refund || fresh.refundHistory?.length) {
      const input = (await wallet.indexerProvider.getVtxos({ outpoints: [entry.intent.memberOutpoint], spendableOnly: false })).vtxos
        .find(coin => equalPoint(coin, entry.intent!.memberOutpoint)); assertCurrent()
      const candidate = [...(fresh.refundHistory ?? []), ...(fresh.refund ? [fresh.refund] : [])].find(refund => refund.arkTxid === input?.arkTxId)
      if (candidate && await provePoolCashRelease(wallet, { ...fresh.transfer, arkTxid: candidate.arkTxid, sourceOutpoint: entry.intent.memberOutpoint,
        unsignedArkTx: candidate.unsignedArkTx, unsignedCheckpoints: candidate.unsignedCheckpoints })) { assertCurrent(); return finish() }
    }
    if (!fresh.transfer.signedArkTx && !fresh.transfer.signedCheckpoints) {
      const updated = await updateFundedPoolJournal(context, entry.id, saved => {
        if (saved.status !== 'pending') return saved
        if (!saved.intent?.freshStage || saved.intent.arkTxid !== entry.intent!.arkTxid) throw new Error('The staging recovery identity changed')
        if (saved.intent.freshStage.transfer.signedArkTx || saved.intent.freshStage.transfer.signedCheckpoints) return saved
        return { ...saved, status: 'abandoned', stage: 'recovery', error: reason }
      }); assertCurrent()
      if (updated.status !== 'pending') { release(); return true }
      entry.intent = updated.intent
      fresh = updated.intent!.freshStage!
    }
    if (!allowSign || !recovering) throw new Error(`${reason}. Confirm recovery to return the staged input to your wallet`)
    await ensureFreshStage(entry, true)
    fresh = entry.intent!.freshStage!
    const gate = vault!.createPoolFreshInput(client!, selected!)
    const input = await vault!.readPoolFreshInput(gate, selected!, entry.intent!.memberOutpoint, wallet.indexerProvider); assertCurrent()
    const authorization: PoolFreshAuthorization = fresh.refund && fresh.refund.authorization.validUntil > Date.now() / 1000
      ? fresh.refund.authorization : { validUntil: Math.floor(Date.now() / 1000) + 60, minTTL: vault!.POOL_FRESH_MIN_TTL }
    const built = await vault!.buildPoolFreshRefund(gate, selected!, input, authorization).build(); assertCurrent()
    const priorId = fresh.refund?.arkTxid ?? null, historyVersion = canonical((fresh.refundHistory ?? []).map(value => value.arkTxid))
    await updateFundedPoolJournal(context, entry.id, saved => {
      const stage = saved.intent?.freshStage
      if (saved.status !== 'pending' || !stage || saved.intent!.arkTxid !== entry.intent!.arkTxid) throw new Error('This pool operation has already finished')
      if ((stage.refund?.arkTxid ?? null) !== priorId || canonical((stage.refundHistory ?? []).map(value => value.arkTxid)) !== historyVersion) {
        throw new Error('Another recovery updated the refund; reconcile its saved transaction')
      }
      const refundHistory = [...(stage.refundHistory ?? [])]
      if (stage.refund?.authorization.ownerSig && stage.refund.arkTxid !== built.arkTx.id && !refundHistory.some(value => value.arkTxid === stage.refund!.arkTxid)) {
        if (refundHistory.length >= 64) throw new Error('Prior refund attempts need indexed reconciliation before another authorization')
        refundHistory.push(stage.refund)
      }
      return { ...saved, stage: 'refunding', intent: { ...saved.intent!, freshStage: { ...stage, refundHistory,
        refund: { unsignedArkTx: encode(built.arkTx), unsignedCheckpoints: built.checkpoints.map(encode), authorization, arkTxid: built.arkTx.id, submitted: false },
      } } }
    }); assertCurrent()
    const authorized = await vault!.authorizePoolFreshSpend(wallet.identity, built, authorization, 'refund'); assertCurrent()
    const saved = await updateFundedPoolJournal(context, entry.id, previous => {
      const stage = previous.intent?.freshStage
      if (previous.status !== 'pending' || !stage || previous.intent!.arkTxid !== entry.intent!.arkTxid) throw new Error('This pool operation has already finished')
      if (stage.refund?.arkTxid !== built.arkTx.id) {
        if (stage.refund?.authorization.ownerSig && stage.refund.authorization.validUntil === authorization.validUntil &&
            stage.refund.authorization.minTTL === authorization.minTTL) return previous
        throw new Error('Another recovery changed the refund authorization')
      }
      return { ...previous, intent: { ...previous.intent!, freshStage: { ...stage,
        refund: { unsignedArkTx: encode(authorized.arkTx), unsignedCheckpoints: authorized.checkpoints.map(encode), authorization: authorized.authorization,
          arkTxid: authorized.arkTx.id, submitted: true },
      } } }
    }); assertCurrent()
    entry.intent = saved.intent
    const relay = saved.intent!.freshStage!.refund!
    if (!relay.authorization.ownerSig) throw new Error('The selected refund has no durable owner authorization')
    if (!connection?.emulator) throw new Error('The verified covenant service is required to return a staged input')
    const response = await new RestEmulatorProvider(connection.emulator.url).submitTx(relay.unsignedArkTx, relay.unsignedCheckpoints); assertCurrent()
    if (tx(response.signedArkTx).id !== relay.arkTxid) throw new Error('Staged input refund changed the approved transaction')
    for (let attempt = 0; attempt < 8; attempt++) {
      if (await provePoolCashRelease(wallet, { ...fresh.transfer, sourceOutpoint: entry.intent!.memberOutpoint, arkTxid: relay.arkTxid,
        unsignedArkTx: relay.unsignedArkTx, unsignedCheckpoints: relay.unsignedCheckpoints })) { assertCurrent(); return finish() }
      await sleep(); assertCurrent()
    }
    throw new Error('The staged input refund is waiting for indexed confirmation')
  }

  function receipt(entry: FundedPoolJournalEntry, actual: Transaction): FundedPoolReceipt {
    const intent = entry.intent!, quote = intent.quote
    const pool = hex.encode(actual.getOutput(0).script!) === hex.encode(contract!.pkScript)
    const memberIndex = pool ? 1 : 0
    const original = tx(intent.unsignedCheckpoints.find(value => equalPoint(inputPoint(tx(value)), intent.memberOutpoint))!).getInput(0).witnessUtxo!.amount
    return { operationId: entry.id, kind: quote.kind, arkTxid: actual.id, poolOutpoint: pool ? { txid: actual.id, vout: 0 } : null,
      memberOutpoint: { txid: actual.id, vout: memberIndex }, depositedSats: quote.kind === 'subscribe' ? quote.amountSats : '0',
      mintedShares: quote.mintedShares, burnedShares: quote.burnShares, payoutSats: quote.payoutSats,
      playerStakeSats: quote.playerStakeSats, houseStakeSats: quote.houseStakeSats,
      memberDeltaSats: (actual.getOutput(memberIndex).amount! - original).toString(), outcome: null, verifiedAt: Date.now() }
  }

  async function loadRenewalProof(id: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid pool renewal proof ID')
    const response = await fetch(`${context.operatorUrl}/v1/intent?txid=${id}`, { signal: AbortSignal.timeout(12_000) }); assertCurrent()
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_000_000) throw new Error('Pool renewal proof is unavailable or too large')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Pool renewal proof response has no readable body')
    const decoder = new TextDecoder()
    let text = '', size = 0
    try {
      while (size <= 1_000_000) {
        const part = await reader.read(); assertCurrent()
        if (part.done) break
        size += part.value.length
        if (size > 1_000_000) throw new Error('Pool renewal proof exceeds its size limit')
        text += decoder.decode(part.value, { stream: true })
      }
      text += decoder.decode()
    } finally { await reader.cancel().catch(() => {}) }
    const proof = JSON.parse(text)?.intent?.proof
    if (typeof proof !== 'string' || proof.length > 750_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(proof)) throw new Error('Invalid pool renewal proof response')
    return proof
  }

  async function proveGameLineage(before: PoolGamePosition, intent: FundedPoolIntent): Promise<void> {
    const opening = { txid: intent.arkTxid, vout: 0 }, visited = new Set<string>()
    let cursor = before, contests = 0
    for (let depth = 0; depth < 64; depth++) {
      if (equalPoint(cursor.coin, opening)) return
      const key = `${cursor.coin.txid}:${cursor.coin.vout}`
      if (visited.has(key)) throw new Error('Cyclic pool game lineage')
      visited.add(key)
      const renewed = await vault!.readPoolRenewalPredecessor(contract!, selected!, cursor, wallet.indexerProvider, loadRenewalProof); assertCurrent()
      if (renewed) { cursor = renewed; continue }
      if (++contests > 1 || cursor.state.phase !== 'contest' || hex.encode(cursor.state.playerSecret ?? new Uint8Array()) !== intent.playerSecretHex) {
        throw new Error('Pool settlement lineage does not preserve the saved game')
      }
      const reveal = Transaction.fromRaw(cursor.sourceTx)
      if (cursor.coin.vout !== 0 || reveal.inputsLength !== 1 || inputPoint(reveal).vout !== 0) throw new Error('Invalid pool contest ancestry')
      const checkpoint = await indexedTx(wallet, inputPoint(reveal).txid); assertCurrent()
      if (checkpoint.inputsLength !== 1) throw new Error('Invalid pool contest checkpoint')
      const prior = await vault!.readPoolGamePositionAt(contract!, selected!, inputPoint(checkpoint), wallet.indexerProvider); assertCurrent()
      const expected = await vault!.buildPoolPlayerReveal(contract!, selected!, prior, hex.decode(intent.playerSecretHex!)).build(); assertCurrent()
      if (expected.arkTx.id !== reveal.id) throw new Error('Pool contest changed the saved player reveal or game state')
      cursor = prior
    }
    throw new Error('Pool game lineage exceeds the recovery limit')
  }

  async function proveRenewedHeadConsumption(intent: FundedPoolIntent): Promise<boolean> {
    let cursor = await vault!.readPoolGamePosition(contract!, selected!, wallet.indexerProvider); assertCurrent()
    const visited = new Set<string>()
    for (let depth = 0; cursor && depth < 64; depth++) {
      if (equalPoint(cursor.coin, intent.expectedHead) || cursor.coin.txid === intent.arkTxid) return false
      const key = `${cursor.coin.txid}:${cursor.coin.vout}`
      if (visited.has(key)) throw new Error('Cyclic canonical pool lineage')
      visited.add(key)
      const renewed = await vault!.readPoolRenewalPredecessor(contract!, selected!, cursor, wallet.indexerProvider, loadRenewalProof); assertCurrent()
      if (renewed) {
        if (equalPoint(renewed.coin, intent.expectedHead)) return true
        cursor = renewed
        continue
      }
      const transaction = Transaction.fromRaw(cursor.sourceTx)
      if (!transaction.inputsLength || inputPoint(transaction).vout !== 0) return false
      const checkpoint = await indexedTx(wallet, inputPoint(transaction).txid); assertCurrent()
      if (checkpoint.inputsLength !== 1) return false
      const point = inputPoint(checkpoint), matches = (await wallet.indexerProvider.getVtxos({ outpoints: [point], spendableOnly: false })).vtxos.filter(coin => equalPoint(coin, point)); assertCurrent()
      if (matches.length !== 1 || !isVtxoSpent(matches[0]) || matches[0].spentBy !== checkpoint.id || matches[0].arkTxId !== transaction.id) return false
      if (equalPoint(point, intent.expectedHead)) return true
      cursor = await vault!.readPoolGamePositionAt(contract!, selected!, point, wallet.indexerProvider); assertCurrent()
    }
    return false
  }

  async function finishGame(entry: FundedPoolJournalEntry): Promise<boolean> {
    const intent = entry.intent!
    if (!intent.playerSecretHex || !intent.game) throw new Error('Saved pool game reveal is missing')
    await stage(entry, 'revealing')
    let candidate: string | undefined, cursor = { txid: intent.arkTxid, vout: 0 }
    for (let depth = 0; depth < 2; depth++) {
      const matches = (await wallet.indexerProvider.getVtxos({ outpoints: [cursor], spendableOnly: false })).vtxos.filter(coin => equalPoint(coin, cursor)); assertCurrent()
      if (matches.length !== 1 || !isVtxoSpent(matches[0]) || !matches[0].spentBy || !matches[0].arkTxId) break
      const spender = await indexedTx(wallet, matches[0].arkTxId); assertCurrent()
      const phase = Extension.fromTx(spender).getPacketByType(35)?.serialize()
      if (depth === 0 && phase?.length === 1 && phase[0] === 2) { cursor = { txid: spender.id, vout: 0 }; continue }
      candidate = spender.id
      break
    }
    if (!candidate) {
      const response = await fundedPoolApi.reveal(entry.id, intent.playerSecretHex); assertCurrent()
      candidate = response.operation.arkTxid
    }
    if (!/^[a-f0-9]{64}$/.test(candidate)) return false
    const actual = await indexedTx(wallet, candidate); assertCurrent()
    if (actual.inputsLength !== 1) throw new Error('Pool settlement has unexpected inputs')
    const checkpoint = await indexedTx(wallet, inputPoint(actual).txid); assertCurrent()
    if (checkpoint.inputsLength !== 1 || inputPoint(actual).vout !== 0) throw new Error('Pool settlement checkpoint is invalid')
    const consumed = inputPoint(checkpoint)
    const before = await vault!.readPoolGamePositionAt(contract!, selected!, consumed, wallet.indexerProvider); assertCurrent()
    await proveGameLineage(before, intent); assertCurrent()
    const approved = tx(intent.unsignedArkTx), game = before.state.game
    const originalPackets = Extension.fromTx(approved), consumedPackets = Extension.fromTx(Transaction.fromRaw(before.sourceTx))
    if ([36, 37, 38, 39, 40].some(type => hex.encode(originalPackets.getPacketByType(type)?.serialize() ?? new Uint8Array()) !==
        hex.encode(consumedPackets.getPacketByType(type)?.serialize() ?? new Uint8Array()))) throw new Error('Pool game terms changed before settlement')
    if (!game || hex.encode(game.playerHash) !== intent.game.playerHash || hex.encode(game.houseHash) !== intent.game.houseHash ||
        hex.encode(game.playerPayoutPkScript) !== intent.playerPayoutPkScript || BigInt(before.coin.value) !== approved.getOutput(0).amount ||
        before.state.supply.toString() !== intent.beforeState?.supply || before.state.carriedLossSats.toString() !== intent.beforeState?.carriedLossSats ||
        before.state.accruedFeesSats.toString() !== intent.beforeState?.accruedFeesSats) throw new Error('Pool settlement changed the saved game accounting')
    const ext = Extension.fromTx(actual), house = ext.getPacketByType(17)?.serialize()
    const candidates: Array<{ builder: arkade.ArkadeTransactionBuilder; payout: bigint; outcome: 'player' | 'house' | 'refund' }> = []
    if (house) {
      const settled = vault!.buildPoolSettlement(contract!, selected!, before, hex.decode(intent.playerSecretHex), house)
      candidates.push({ builder: settled.builder, payout: settled.payoutSats, outcome: settled.winner === 'player' ? 'player' : 'house' })
    }
    if (before.state.phase === 'funded' && Date.now() / 1000 >= game.cancelAt) candidates.push({ builder: vault!.buildPoolRefund(contract!, selected!, before).builder, payout: game.playerStakeSats, outcome: 'refund' })
    if (before.state.phase === 'contest' && Date.now() / 1000 >= game.finalAt) candidates.push({ builder: vault!.buildPoolTimeout(contract!, selected!, before).builder, payout: game.playerStakeSats + game.houseStakeSats, outcome: 'player' })
    let verified: typeof candidates[number] | undefined
    for (const candidate of candidates) {
      const expected = await candidate.builder.build(); assertCurrent()
      if (expected.arkTx.id === actual.id) verified = candidate
    }
    if (!verified) throw new Error('Pool settlement does not match any locally verified game outcome')
    const spent = (await wallet.indexerProvider.getVtxos({ outpoints: [consumed], spendableOnly: false })).vtxos; assertCurrent()
    if (spent.length !== 1 || spent[0].spentBy !== checkpoint.id || spent[0].arkTxId !== actual.id || !isVtxoSpent(spent[0])) return false
    const openingReceipt = receipt(entry, approved)
    await confirmFundedPoolJournal(context, entry.id, { ...openingReceipt, settlementTxid: actual.id,
      poolOutpoint: { txid: actual.id, vout: 0 }, memberOutpoint: verified.payout ? { txid: actual.id, vout: 1 } : null,
      payoutSats: verified.payout.toString(), memberDeltaSats: (verified.payout - game.playerStakeSats).toString(),
      outcome: verified.outcome, verifiedAt: Date.now() }); assertCurrent()
    releaseFundedPoolInput(wallet, entry.id)
    releaseFundedPoolInput(wallet, `${entry.id}-source`)
    return true
  }

  async function reconcile(entry: FundedPoolJournalEntry, allowSign = false): Promise<boolean> {
    assertCurrent()
    if (!entry.intent) throw new Error('Saved pool operation has no recovery transaction')
    if (JSON.stringify(entry.descriptor) !== JSON.stringify(selected)) throw new Error('Pending operation belongs to a different configured pool')
    reserveFundedPoolInput(wallet, entry.id, entry.intent.memberOutpoint)
    if (entry.intent.cashRelease) reserveFundedPoolInput(wallet, `${entry.id}-cash`, entry.intent.cashRelease.sourceOutpoint)
    pendingState(entry)
    const actual = entry.intent.freshStage?.ownerAuthorizationPending ? undefined : await proveFundedPoolSpend(wallet, entry.intent); assertCurrent()
    if (actual) {
      if (entry.intent.quote.kind === 'openGame') return finishGame(entry)
      let verified = receipt(entry, actual)
      if (entry.intent.cashRelease) {
        const cash = entry.intent.cashRelease
        let complete = await provePoolCashRelease(wallet, cash); assertCurrent()
        if (!complete) {
          await submitPoolCashRelease({ wallet, operatorUrl: context.operatorUrl, plan: cash, allowSign, isCurrent: current,
            save: async plan => {
              const saved = await updateFundedPoolJournal(context, entry.id, previous => {
                if (previous.status !== 'pending' || !previous.intent) throw new Error('This pool operation has already finished')
                if (previous.intent.cashRelease?.arkTxid !== plan.arkTxid) throw new Error('Saved cash release operation identity changed')
                return { ...previous, intent: { ...previous.intent, cashRelease: mergePoolCashRelease(previous.intent.cashRelease, plan) } }
              }); assertCurrent()
              entry.intent = saved.intent
              return saved.intent!.cashRelease!
            } }); assertCurrent()
          for (let attempt = 0; attempt < 8; attempt++) {
            complete = await provePoolCashRelease(wallet, cash); assertCurrent()
            if (complete) break
            await sleep(); assertCurrent()
          }
        }
        if (!complete) throw new Error('Capital is confirmed; its reviewed cash release still needs indexed confirmation')
        verified = { ...verified, cashReleaseTxid: cash.arkTxid, memberOutpoint: { txid: cash.arkTxid, vout: 0 } }
      }
      await confirmFundedPoolJournal(context, entry.id, verified); assertCurrent()
      releaseFundedPoolInput(wallet, entry.id)
      releaseFundedPoolInput(wallet, `${entry.id}-source`)
      releaseFundedPoolInput(wallet, `${entry.id}-cash`)
      return true
    }
    const fresh = entry.intent.freshStage
    const inputs = (await wallet.indexerProvider.getVtxos({ outpoints: [entry.intent.expectedHead, entry.intent.memberOutpoint,
      ...(fresh ? [fresh.transfer.sourceOutpoint] : [])], spendableOnly: false })).vtxos; assertCurrent()
    const head = inputs.find(coin => equalPoint(coin, entry.intent!.expectedHead))
    const member = inputs.find(coin => equalPoint(coin, entry.intent!.memberOutpoint)) ??
      (fresh ? inputs.find(coin => equalPoint(coin, fresh.transfer.sourceOutpoint)) : undefined)
    if (head?.spentBy && head.arkTxId && head.arkTxId !== entry.intent.arkTxid && member && !isVtxoSpent(member) && !member.isUnrolled && !member.isSwept) {
      const checkpoint = await indexedTx(wallet, head.spentBy); assertCurrent()
      const winner = await indexedTx(wallet, head.arkTxId); assertCurrent()
      if (checkpoint.inputsLength !== 1 || !equalPoint(inputPoint(checkpoint), entry.intent.expectedHead) ||
          !Array.from({ length: winner.inputsLength }, (_, i) => inputPoint(winner, i)).some(point => equalPoint(point, { txid: checkpoint.id, vout: 0 }))) {
        throw new Error('Conflicting pool transaction does not prove the approved head was consumed')
      }
      const original = fresh && equalPoint(member, fresh.transfer.sourceOutpoint) ? tx(fresh.transfer.unsignedCheckpoints[0]).getInput(0).witnessUtxo! :
        tx(entry.intent.unsignedCheckpoints.find(value => equalPoint(inputPoint(tx(value)), entry.intent!.memberOutpoint))!).getInput(0).witnessUtxo!
      if (member.value !== Number(original.amount) || member.script !== hex.encode(original.script)) throw new Error('Conflicting pool operation changed the member input')
      return abandonFreshEntry(entry, 'The original pool head was consumed by another indexed transaction', allowSign)
    }
    if (head?.settledBy && isVtxoSpent(head) && member && !isVtxoSpent(member) && !member.isUnrolled && !member.isSwept && await proveRenewedHeadConsumption(entry.intent)) {
      assertCurrent()
      const original = fresh && equalPoint(member, fresh.transfer.sourceOutpoint) ? tx(fresh.transfer.unsignedCheckpoints[0]).getInput(0).witnessUtxo! :
        tx(entry.intent.unsignedCheckpoints.find(value => equalPoint(inputPoint(tx(value)), entry.intent!.memberOutpoint))!).getInput(0).witnessUtxo!
      if (member.value !== Number(original.amount) || member.script !== hex.encode(original.script)) throw new Error('Renewal conflict changed the member input')
      return abandonFreshEntry(entry, 'The approved pool head was consumed by an authenticated renewal', allowSign)
    }
    return false
  }

  async function submit(entry: FundedPoolJournalEntry, allowSign = false) {
    const intent = entry.intent!
    if (intent.freshStage?.ownerAuthorizationPending) throw new Error('The saved pool operation needs explicit owner authorization')
    if (!intent.signedArkTx || !intent.signedCheckpoints) throw new Error('Pool operation has no durable signed intent; review recovery before continuing')
    const signedArkTx = intent.signedArkTx, signedCheckpoints = intent.signedCheckpoints
    const signed = { arkTx: tx(signedArkTx), checkpoints: signedCheckpoints.map(tx) }
    memberCheckpoint(signed, intent.memberOutpoint, intent.expectedHead)
    if (signed.arkTx.id !== intent.arkTxid || signed.checkpoints.length !== intent.unsignedCheckpoints.length ||
        signed.checkpoints.some(checkpoint => !intent.unsignedCheckpoints.some(value => tx(value).id === checkpoint.id))) throw new Error('Saved signed pool transaction differs from its approved plan')
    await ensureFreshStage(entry, allowSign); assertCurrent()
    await stage(entry, 'submitting')
    const directRedemption = async () => {
      if (!connection?.emulator) throw new Error('A previously verified covenant service connection is required for direct redemption')
      const response = await new RestEmulatorProvider(connection.emulator.url).submitTx(signedArkTx, signedCheckpoints); assertCurrent()
      if (tx(response.signedArkTx).id !== intent.arkTxid) throw new Error('Covenant service changed the approved redemption transaction')
    }
    if (intent.command.kind === 'redeem' && (!coordinatorOnline || !publicState?.capabilities.redeem)) await directRedemption()
    else try {
      await fundedPoolApi.submit({ operationId: entry.id, expectedHead: intent.expectedHead, command: intent.command,
        arkTxid: intent.arkTxid, arkTx: intent.signedArkTx, checkpointTxs: intent.signedCheckpoints, memberPubkey: context.publicKey }); assertCurrent()
    } catch (error) { assertCurrent(); if (intent.command.kind !== 'redeem') throw error; await directRedemption() }
    await stage(entry, 'confirming')
    for (let attempt = 0; attempt < 8; attempt++) {
      if (await reconcile(entry, allowSign)) return
      await sleep(); assertCurrent()
    }
    throw new Error('The operation has been submitted; indexed confirmation is pending')
  }

  async function recoverPending() {
    const records = await loadFundedPoolJournal(context); assertCurrent()
    for (const entry of records.filter(item => item.status === 'pending')) {
      try {
        if (await reconcileBatchDependency(entry)) continue
        if (await reconcile(entry)) continue
        await submit(entry)
      } catch (error) {
        assertCurrent()
        const reason = errorText(error)
        await updateFundedPoolJournal(context, entry.id, saved => ({ ...saved, stage: 'recovery', error: reason })); assertCurrent()
        pendingState(entry, reason)
        return
      }
    }
  }

  async function reconcileBatchDependency(entry: FundedPoolJournalEntry, allowSign = false): Promise<boolean> {
    if (!entry.batch || entry.batch.index === 0) return false
    const previous = (await loadFundedPoolJournal(context)).find(item => item.batch?.id === entry.batch!.id && item.batch.index === entry.batch!.index - 1); assertCurrent()
    if (!previous) throw new Error('A saved redemption sequence is missing its preceding operation')
    if (previous.status === 'pending') throw new Error('The preceding redemption must be reconciled before continuing this sequence')
    if (previous.status !== 'abandoned') return false
    const intent = entry.intent!
    const source = intent.freshStage?.transfer.sourceOutpoint ?? intent.memberOutpoint
    const matches = (await wallet.indexerProvider.getVtxos({ outpoints: [intent.memberOutpoint, source], spendableOnly: false })).vtxos
    const member = matches.find(coin => equalPoint(coin, intent.memberOutpoint)) ?? matches.find(coin => equalPoint(coin, source)); assertCurrent()
    const original = member && equalPoint(member, source) && intent.freshStage ? tx(intent.freshStage.transfer.unsignedCheckpoints[0]).getInput(0).witnessUtxo! :
      tx(intent.unsignedCheckpoints.find(value => equalPoint(inputPoint(tx(value)), intent.memberOutpoint))!).getInput(0).witnessUtxo!
    if (!member || isVtxoSpent(member) || member.isSwept || member.isUnrolled ||
        member.value !== Number(original.amount) || member.script !== hex.encode(original.script)) throw new Error('The dependent member input is not proven unspent')
    return abandonFreshEntry(entry, 'A preceding redemption was proven impossible; this dependent member input remains unspent', allowSign)
  }

  async function authorizeFreshSequence(entries: FundedPoolJournalEntry[], before: PoolGamePosition): Promise<FundedPoolJournalEntry[]> {
    const result: FundedPoolJournalEntry[] = []
    let cursor: PoolGamePosition | undefined = before
    for (const entry of entries) {
      if (!cursor) throw new Error('The pool retired before the reviewed redemption sequence finished')
      const updated = await authorizeFreshEntry(entry, cursor); assertCurrent()
      result.push(updated)
      if (entry.intent!.command.kind === 'redeem') cursor = vault!.poolPositionAfterRedemption(contract!, selected!, cursor,
        tx(updated.intent!.unsignedArkTx), BigInt(entry.intent!.quote.burnShares))
    }
    return result
  }

  async function recover() {
    if (operation) throw new Error('Another pool operation is in progress')
    operation = true; recovering = true
    try {
      await initialize(); assertCurrent()
      if (!contract || !vault || !selected) return
      await renewal?.refresh(); assertCurrent()
      if (renewalDisplay.status === 'recovery' || renewalDisplay.status === 'renewing') {
        await renewal?.recover(); assertCurrent()
        if (renewalDisplay.status === 'recovery' || renewalDisplay.status === 'renewing') throw new Error('The existing wallet renewal must be reconciled before another pool action')
      }
      let waiting = (await loadFundedPoolJournal(context)).filter(entry => entry.status === 'pending'); assertCurrent()
      if (waiting.some(entry => entry.intent?.freshStage?.ownerAuthorizationPending)) {
        const first = waiting[0]
        if (!await reconcile(first, true)) {
          const before = await vault.readPoolGamePosition(contract, selected, wallet.indexerProvider); assertCurrent()
          if (!before || !equalPoint(before.coin, first.intent!.expectedHead)) throw new Error('The reviewed pool head is unavailable; keep recovery data until its consumption is verified')
          if (waiting.some(entry => entry.intent!.quote.expiresAt <= Date.now())) {
            for (const entry of waiting) await abandonFreshEntry(entry, 'The unsigned review expired before input staging', true)
          } else await authorizeFreshSequence(waiting, before)
        }
        waiting = (await loadFundedPoolJournal(context)).filter(entry => entry.status === 'pending'); assertCurrent()
      }
      for (const entry of waiting) {
        if (await reconcileBatchDependency(entry, true)) continue
        if (await reconcile(entry, true)) continue
        if (!entry.intent?.freshStage) throw new Error('The saved operation has no fresh input staging plan')
        if (entry.intent.freshStage.authorization.validUntil <= Date.now() / 1000 ||
            entry.intent.game && entry.intent.game.expiresAt <= Date.now()) {
          await abandonFreshEntry(entry, 'The original pool authorization expired before funding', true)
          continue
        }
        await submit(entry, true)
      }
      await readDisplay(++sequence)
    } catch (error) {
      if (current()) patch({ status: 'recovery', error: errorText(error), capabilities: disabled })
      throw error
    } finally { operation = false; recovering = false }
  }
  async function confirm(quote: FundedPoolQuote) {
    const plan = plans.get(quote.id)
    if (!plan || plan.quote !== quote) throw new Error('Pool quote is not the locally prepared immutable quote')
    if (operation) throw new Error('Another pool operation is in progress')
    operation = true
    let durable = false
    try {
      assertCurrent()
      if (Date.now() >= quote.expiresAt) throw new Error('Pool quote expired; request a fresh quote')
      const actualPosition = await vault!.readPoolGamePosition(contract!, selected!, wallet.indexerProvider); assertCurrent()
      if (!actualPosition || !equalPoint(actualPosition.coin, quote.head)) throw new Error('Pool head changed; request a fresh quote')
      if (Date.now() >= quote.expiresAt || plans.get(quote.id) !== plan) throw new Error('Pool quote expired; request a fresh quote')
      const parts = plan.parts ?? [plan], createdAt = Date.now()
      const entries: FundedPoolJournalEntry[] = parts.map((part, index) => ({
        version: 1, id: part.quote.id, context, descriptor: part.descriptor, createdAt: createdAt + index,
        ...(parts.length > 1 ? { batch: { id: quote.id, index, count: parts.length } } : {}),
        status: 'pending', stage: 'prepared', error: null, intent: { arkTxid: part.built.arkTx.id, expectedHead: { ...part.quote.head },
          memberOutpoint: { txid: part.member.txid, vout: part.member.vout }, unsignedArkTx: encode(part.built.arkTx),
          unsignedCheckpoints: part.built.checkpoints.map(encode), command: part.command, quote: part.quote,
          playerSecretHex: part.secret, game: part.game, playerPayoutPkScript: part.freshStage!.sourceMember.script,
          freshStage: part.freshStage,
          beforeState: { supply: part.position.state.supply.toString(), navSats: part.position.state.navSats.toString(),
            carriedLossSats: part.position.state.carriedLossSats.toString(), accruedFeesSats: part.position.state.accruedFeesSats.toString() } },
      }))
      for (const part of parts) memberCheckpoint(part.built, part.member, part.quote.head)
      plans.delete(quote.id)
      await putFundedPoolJournals(entries); durable = true; assertCurrent()
      const finalized = await authorizeFreshSequence(entries, actualPosition); assertCurrent()
      for (const entry of finalized) await submit(entry, true)
      await readDisplay(++sequence)
    } catch (error) {
      if (durable) {
        const reason = errorText(error)
        const saved = (await loadFundedPoolJournal(context)).find(item => item.status === 'pending' && (item.id === quote.id || item.batch?.id === quote.id))
        if (saved?.status === 'pending') {
          const entry = await updateFundedPoolJournal(context, saved.id, current => ({ ...current, stage: 'recovery', error: reason }))
          if (current()) pendingState(entry, reason)
        } else if (current()) patch({ status: 'unavailable', error: reason })
      } else { releasePlan(plan); plans.delete(quote.id) }
      throw error
    } finally { operation = false }
  }

  async function refresh(): Promise<void> {
    if (!current()) return
    // A request during a read may have missed its event, so drain it with one more read.
    if (refreshing) { refreshAgain = true; return refreshing }
    refreshing = (async () => {
      try {
        for (;;) {
          refreshAgain = false
          try {
            await initialize(); assertCurrent()
            if (!contract) return
            if (!operation) { operation = true; try { await recoverPending() } finally { operation = false } }
            await readDisplay(++sequence)
            if (!refreshAgain) return
          } catch (error) {
            if (refreshAgain && current()) continue
            if (current()) patch({ status: 'error', error: errorText(error), capabilities: { ...disabled, recover: !!state.pending } })
            throw error
          }
        }
      } finally { refreshing = undefined }
    })()
    return refreshing
  }

  async function dispose() {
    if (disposed) return
    disposed = true; sequence++
    clearTimeout(boundary)
    unsubscribe?.()
    for (const timer of expiryTimers) clearTimeout(timer)
    expiryTimers.clear()
    for (const [, plan] of plans) releasePlan(plan)
    plans.clear()
    try { await watchRelease?.() } finally { await renewal?.dispose(); await client?.dispose() }
  }
  async function prepareRenewInputs(): Promise<FundedPoolInputRenewalQuote> {
    assertCurrent()
    await initialize(); assertCurrent()
    if (!renewal || operation) throw new Error('Wallet input renewal is unavailable while another operation is active')
    const pending = (await loadFundedPoolJournal(context)).some(entry => entry.status === 'pending'); assertCurrent()
    if (pending) throw new Error('Reconcile the existing pool operation before renewing wallet inputs')
    for (const [id, plan] of plans) { releasePlan(plan); plans.delete(id) }
    let requirement = renewalRequirement
    if (requirement) {
      const available = await wallet.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true, requireSynced: true }); assertCurrent()
      const horizon = Date.now() + (vault!.poolInputPolicy(client!).minTTL + 120) * 1000
      const fresh = available.filter(coin => coin.expiresAt && coin.expiresAtHeight === undefined && coin.expiresAt.getTime() >= horizon)
      if (requirement.kind === 'plain' && fresh.some(coin => !coin.assets?.length && BigInt(coin.value) >= requirement!.amount)) {
        throw new Error('A fresh wallet funding input is already available; review the pool operation again')
      }
      if (requirement.kind === 'shares') {
        const held = fresh.reduce((sum, coin) => sum + (coin.assets?.length === 1 && coin.assets[0].assetId === selected!.shareAssetId ? coin.assets[0].amount : 0n), 0n)
        if (held >= requirement.amount) throw new Error('Fresh wallet shares are already available; review the redemption again')
        requirement = { kind: 'shares', amount: requirement.amount - held }
      }
    }
    const quote = await renewal.prepare(requirement); assertCurrent()
    return quote
  }
  /** Renews an aging pool unchanged without the casino; only a plain fee sponsor from this wallet is ever spent. */
  async function rescue(): Promise<void> {
    assertCurrent()
    await initialize(); assertCurrent()
    if (operation || !vault || !selected || !connection?.emulator) throw new Error('Pool renewal is unavailable while another operation is active')
    operation = true
    try {
      const emulator = new RestEmulatorProvider(connection.emulator.url)
      const memory = () => { let saved: PoolRenewalJournal | undefined; return { load: async () => saved, save: async (value: PoolRenewalJournal) => { saved = value } } }
      try { await vault.renewPool(wallet, selected, emulator, memory(), { rescue: true }) }
      catch (error) {
        if (!/plain sponsor/.test(errorText(error))) throw error
        const sponsor = (await wallet.getSpendableVtxos({ requireSynced: true, genericallySpendableOnly: true }))
          .filter(coin => !coin.assets?.length && !coin.isSwept && coin.value >= 660).sort((a, b) => b.value - a.value)[0]
        if (!sponsor) throw new Error('Renewing the pool needs a plain wallet coin to pay its batch fee')
        assertCurrent()
        await vault.renewPool(wallet, selected, emulator, memory(), { rescue: true, sponsor })
      }
      assertCurrent(); await readDisplay(++sequence)
    } finally { operation = false }
  }
  async function confirmRenewInputs(quote: FundedPoolInputRenewalQuote): Promise<void> {
    assertCurrent()
    if (!renewal || operation) throw new Error('Wallet input renewal is unavailable while another operation is active')
    operation = true
    try { await renewal.confirm(quote); assertCurrent(); await readDisplay(++sequence) }
    finally { operation = false }
  }
  return { refresh, recover, rescue, confirm, dispose, prepareRenewInputs, confirmRenewInputs,
    prepareSubscribe: (amount: bigint) => prepare('subscribe', amount),
    prepareRedeem: (amount: bigint) => prepare('redeem', amount),
    prepareBet: (bet: FundedPoolBetInput) => prepare('openGame', bet.playerStakeSats, bet) }
}
