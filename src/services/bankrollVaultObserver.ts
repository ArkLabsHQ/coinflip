import {
  arkade, asset, isVtxoSpent, resolveEmulatorPubkey, toXOnly,
  Transaction, type Wallet, type IContractManager, type VirtualCoin,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { isSyncConfirmed } from '@/store/modules/ark/balanceReady'

export interface BankrollPoolDescriptor {
  version: 1
  name: string
  network: string
  operatorUrl: string
  controlAssetId: string
  shareAssetId: string
  bootstrapTxid: string
  checkpointPsbts: [string, string]
}

export type BankrollPoolStatus = 'disconnected' | 'unconfigured' | 'validating' | 'loading'
  | 'ready' | 'absent' | 'unavailable' | 'error'

export interface BankrollPoolDisplay {
  status: BankrollPoolStatus
  descriptor?: BankrollPoolDescriptor
  navSats: string | null
  supply: string | null
  memberShares: string | null
  availableShares: string | null
  estimatedClaimSats: string | null
  verifiedAt: number | null
  error: string | null
  canDeposit: false
  canRedeem: false
}

export function emptyBankrollDisplay(
  status: BankrollPoolStatus, descriptor?: BankrollPoolDescriptor, error: string | null = null,
): BankrollPoolDisplay {
  return { status, descriptor, navSats: null, supply: null, memberShares: null,
    availableShares: null, estimatedClaimSats: null, verifiedAt: null, error,
    canDeposit: false, canRedeem: false }
}

export function normalizePoolOperatorUrl(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Pool operator URL must be an HTTP or HTTPS endpoint without credentials or query parameters')
  }
  return url.toString().replace(/\/+$/, '')
}

export function parseBankrollDescriptor(
  text: string, expected?: { network: string; operatorUrl: string },
): BankrollPoolDescriptor {
  if (typeof text !== 'string' || text.length > 131_072) throw new Error('Pool descriptor exceeds the size limit')
  let value: Record<string, unknown>
  try { value = JSON.parse(text) } catch { throw new Error('Pool descriptor must be valid JSON') }
  const fields = ['version', 'name', 'network', 'operatorUrl', 'controlAssetId', 'shareAssetId', 'bootstrapTxid', 'checkpointPsbts']
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !(key in value))) {
    throw new Error('Pool descriptor must use the complete version 1 format')
  }
  for (const name of fields.filter(name => name !== 'version' && name !== 'checkpointPsbts')) {
    if (typeof value[name] !== 'string') throw new Error(`Pool descriptor ${name} must be a string`)
  }
  const name = (value.name as string).trim()
  const network = value.network as string
  if (!name || name.length > 80 || Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(network)) {
    throw new Error('Invalid pool name or network')
  }
  const operatorUrl = normalizePoolOperatorUrl(value.operatorUrl as string)
  if (expected && (network !== expected.network || operatorUrl !== normalizePoolOperatorUrl(expected.operatorUrl))) {
    throw new Error('Pool descriptor does not match the connected wallet network and operator')
  }
  const controlAssetId = asset.AssetId.fromString(value.controlAssetId as string).toString()
  const shareAssetId = asset.AssetId.fromString(value.shareAssetId as string).toString()
  if (controlAssetId === shareAssetId) throw new Error('Pool control and share assets must differ')
  const bootstrapTxid = (value.bootstrapTxid as string).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(bootstrapTxid) || /^0+$/.test(bootstrapTxid)) throw new Error('Invalid pool bootstrap transaction ID')
  const checkpoints = value.checkpointPsbts
  if (!Array.isArray(checkpoints) || checkpoints.length !== 2 || checkpoints.some(checkpoint =>
    typeof checkpoint !== 'string' || checkpoint.length > 60_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(checkpoint))) {
    throw new Error('Pool descriptor requires two bounded checkpoint PSBTs')
  }
  let checkpointIds: string[]
  try { checkpointIds = checkpoints.map(checkpoint => Transaction.fromPSBT(base64.decode(checkpoint)).id) }
  catch { throw new Error('Invalid pool checkpoint PSBT') }
  if (checkpointIds[0] === checkpointIds[1]) throw new Error('Pool checkpoint proofs must be distinct')
  return { version: 1, name, network, operatorUrl, controlAssetId, shareAssetId, bootstrapTxid,
    checkpointPsbts: [checkpoints[0], checkpoints[1]] }
}

export interface BankrollVaultObserver {
  refresh(): Promise<void>
  dispose(): Promise<void>
}

export interface BankrollVaultObserverOptions {
  wallet: Wallet
  descriptor: BankrollPoolDescriptor
  network: string
  operatorUrl: string
  isCurrent(): boolean
  onState(state: BankrollPoolDisplay): void
}

interface ScriptWatch {
  users: number
  owned: boolean
  ready: Promise<void>
  closing?: Promise<void>
}
const scriptWatches = new WeakMap<IContractManager, Map<string, ScriptWatch>>()

async function acquireWatch(manager: IContractManager, script: string, label: string): Promise<() => Promise<void>> {
  if (!manager.watchScript || !manager.unwatchScript || !manager.getWatchedScripts) {
    throw new Error('Wallet does not support read-only pool observation')
  }
  let scripts = scriptWatches.get(manager)
  if (!scripts) { scripts = new Map(); scriptWatches.set(manager, scripts) }
  let entry = scripts.get(script)
  if (entry?.closing) { await entry.closing.catch(() => {}); return acquireWatch(manager, script, label) }
  if (!entry) {
    entry = { users: 0, owned: false, ready: Promise.resolve() }
    scripts.set(script, entry)
    const registration = entry
    entry.ready = (async () => {
      registration.owned = !(await manager.getWatchedScripts!()).some(watch => watch.script === script)
      if (registration.owned) await manager.watchScript!(script, { label })
    })()
  }
  entry.users++
  const watch = entry, registrations = scripts
  const close = () => {
    if (!watch.closing) watch.closing = watch.ready.catch(() => {}).then(async () => {
      if (watch.owned) await manager.unwatchScript!(script)
    }).finally(() => { if (registrations.get(script) === watch) registrations.delete(script) })
    return watch.closing
  }
  try { await watch.ready } catch (error) {
    if (--watch.users === 0) await close().catch(() => {})
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    if (--watch.users === 0) await close()
  }
}

function sharesHeld(coins: VirtualCoin[], shareAssetId: string): bigint {
  let total = 0n
  const outpoints = new Set<string>()
  for (const coin of coins) {
    if (isVtxoSpent(coin)) continue
    const outpoint = `${coin.txid}:${coin.vout}`
    if (outpoints.has(outpoint)) throw new Error('Duplicate wallet share output')
    outpoints.add(outpoint)
    const shares = (coin.assets ?? []).filter(owned => owned.assetId === shareAssetId)
    if (shares.length > 1) throw new Error('Duplicate wallet share asset')
    for (const owned of shares) {
      if (typeof owned.amount !== 'bigint' || owned.amount <= 0n || owned.amount > 1_000_000_000_000n) {
        throw new Error('Invalid wallet share quantity')
      }
      total += owned.amount
      if (total > 1_000_000_000_000n) throw new Error('Wallet shares exceed the vault supply limit')
    }
  }
  return total
}

export async function createBankrollVaultObserver(options: BankrollVaultObserverOptions): Promise<BankrollVaultObserver> {
  const { wallet, isCurrent, onState } = options
  const descriptor = parseBankrollDescriptor(JSON.stringify(options.descriptor), options)
  let disposed = false
  let client: arkade.Arkade | undefined
  let manager: IContractManager | undefined
  let script: string | undefined
  let watchPending: Promise<() => Promise<void>> | undefined
  let unsubscribe: (() => void) | undefined
  let sequence = 0
  let running: Promise<void> | undefined
  const current = () => !disposed && isCurrent()
  const assertCurrent = () => { if (!current()) throw new Error('Wallet context changed while reading the pool') }
  const publish = (display: BankrollPoolDisplay) => { if (current()) onState(display) }
  const dispose = async () => {
    if (disposed) return
    disposed = true
    sequence++
    unsubscribe?.()
    const release = await watchPending?.catch(() => undefined)
    try { await release?.() }
    finally { await client?.dispose() }
  }
  try {
    assertCurrent()
    publish(emptyBankrollDisplay('validating', descriptor))
    const vault = await import('arkade-coinflip/dist/bankroll-vault.js')
    assertCurrent()
    const info = await wallet.getArkadeInfo({ requireLive: true })
    assertCurrent()
    if (info.network !== descriptor.network) throw new Error('Connected operator reports a different pool network')
    manager = await wallet.getContractManager()
    assertCurrent()
    const emulatorKey = toXOnly(hex.decode(resolveEmulatorPubkey(wallet.network, process.env.VUE_APP_EMULATOR_PUBKEY?.trim() || undefined)))
    client = await arkade.Arkade.connect({
      arkade: { getInfo: async () => info }, indexer: wallet.indexerProvider,
      network: wallet.network, contractManager: manager,
    })
    assertCurrent()
    const control = asset.AssetId.fromString(descriptor.controlAssetId)
    const shares = asset.AssetId.fromString(descriptor.shareAssetId)
    const serverKey = toXOnly(hex.decode(info.signerPubkey))
    const contract = new arkade.ArkadeContract(client, vault.bankrollVaultProgram, {
      server: serverKey,
      controlTxid: Uint8Array.from(control.txid).reverse(), controlGidx: BigInt(control.groupIndex),
      shareTxid: Uint8Array.from(shares.txid).reverse(), shareGidx: BigInt(shares.groupIndex),
    }, { serverKey, emulatorKey })
    await vault.verifyBankrollBootstrap(contract, descriptor, descriptor, wallet.indexerProvider)
    assertCurrent()
    script = hex.encode(contract.pkScript)
    const read = async (request: number) => {
      publish(emptyBankrollDisplay('loading', descriptor))
      try {
        const position = await vault.readBankrollVaultPosition(contract, descriptor, wallet.indexerProvider)
        assertCurrent()
        const owned = await wallet.getVtxos({ withRecoverable: true, withUnrolled: true })
        assertCurrent()
        const available = await wallet.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true, requireSynced: true })
        assertCurrent()
        if (!isSyncConfirmed(manager!.getSyncState())) throw new Error('Wallet share holdings have not completed a live sync')
        const memberShares = sharesHeld(owned, descriptor.shareAssetId)
        const availableShares = sharesHeld(available, descriptor.shareAssetId)
        if (availableShares > memberShares || (position && memberShares > position.supply)) throw new Error('Wallet share holdings are inconsistent with the vault supply')
        if (request !== sequence) return
        publish({ ...emptyBankrollDisplay(position ? 'ready' : 'absent', descriptor),
          navSats: position?.navSats.toString() ?? null, supply: position?.supply.toString() ?? null,
          memberShares: memberShares.toString(), availableShares: availableShares.toString(),
          estimatedClaimSats: position ? (memberShares * position.navSats / position.supply).toString() : null,
          verifiedAt: Date.now() })
      } catch (error) {
        if (request === sequence) publish(emptyBankrollDisplay('unavailable', descriptor,
          error instanceof Error ? error.message : 'Pool information is unavailable'))
      }
    }
    const refresh = (): Promise<void> => {
      if (!current()) return Promise.resolve()
      sequence++
      if (!running) {
        running = (async () => {
          let request: number
          do { request = sequence; await read(request) } while (current() && request !== sequence)
        })().finally(() => { running = undefined })
      }
      return running
    }
    unsubscribe = manager.onContractEvent(event => {
      if (event.type === 'connection_reset' || event.contractScript === script || 'contract' in event) void refresh()
    })
    watchPending = acquireWatch(manager, script, descriptor.name)
    await watchPending
    assertCurrent()
    await refresh()
    assertCurrent()
    return { refresh, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
