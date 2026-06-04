/**
 * House wallet bootstrap.
 *
 * Returns the wallet/identity/arkInfo trio that gets placed on `AppDeps`.
 * Consumers downstream read from `deps.wallet` etc. directly rather than
 * reaching for module state here.
 */

import { createHash } from 'crypto'
import { SingleKey, Wallet, type ArkInfo, type Identity } from '@arkade-os/sdk'
import { SQLiteContractRepository, SQLiteWalletRepository } from '@arkade-os/sdk/repositories/sqlite'
import { getSqlExecutor } from './db.js'
import type { ConfigRepository, HouseWalletRepository } from './repositories/types.js'

// Canonical Ark server URL for the whole process. Exported so other modules
// (e.g. crash-recovery reconciliation) resolve the same endpoint instead of
// re-reading the env with their own divergent fallback.
export const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'https://mutinynet.arkade.sh'
// Optional. Leave unset to let the SDK auto-default esplora from the network
// it detects at the Ark server (mutinynet → https://mempool.mutinynet.arkade.sh/api).
// Set it explicitly for regtest/docker where the esplora host isn't the SDK default.
const ESPLORA_URL = process.env.ESPLORA_URL

export interface HouseWalletBundle {
  wallet: Wallet
  identity: Identity
  arkInfo: ArkInfo
}

export interface InitHouseWalletOptions {
  /**
   * Settlement configuration forwarded to `Wallet.create`. Set to `false`
   * to disable the wallet's auto-renewal loop (useful for tests that
   * don't want a background ticker firing INTENT_INSUFFICIENT_FEE every
   * 30 seconds against the regtest fee config).
   */
  settlementConfig?: false | object
}

export async function initHouseWallet(
  repos: {
    houseWallet: HouseWalletRepository
    config: ConfigRepository
    // config is not strictly required today but kept on the signature so
    // future bootstrap-time tweaks (custom URLs, fee policy) have somewhere
    // to read from without re-threading the deps.
  },
  options: InitHouseWalletOptions = {},
): Promise<HouseWalletBundle> {
  void repos.config
  const executor = getSqlExecutor()

  const existing = await repos.houseWallet.get()

  // SingleKey implements Identity; assign through `any` to satisfy
  // the structural-typing gymnastics around the SingleKey static
  // factories that live in the SDK's dist/cjs world.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let identity: any
  if (existing) {
    identity = SingleKey.fromHex(existing.private_key_hex)
    console.log(`House wallet loaded: ${existing.public_key_hex.substring(0, 16)}...`)
  } else {
    identity = SingleKey.fromRandomBytes()
    const privHex = identity.toHex()
    const pubkey = await identity.compressedPublicKey()
    const pubHex = Buffer.from(pubkey).toString('hex')
    await repos.houseWallet.set(privHex, pubHex)
    console.log(`House wallet created: ${pubHex.substring(0, 16)}...`)
  }

  // Key-preserving resync. RESYNC_WALLET_ON_BOOT wipes the SDK's cached chain
  // state (vtxos / utxos / transactions) so a stale ghost — e.g. a boarding
  // UTXO whose funding tx arkd can no longer resolve after a chain reset, which
  // wedges renewal with TX_NOT_FOUND — is dropped and re-synced fresh from arkd
  // on the Wallet.create below. The house KEY lives in HouseWalletRepository (a
  // separate table), so it is NOT touched. One-shot recovery flag: set it,
  // redeploy once, then remove it.
  const walletRepository = new SQLiteWalletRepository(executor)
  if (/^(1|true)$/i.test(process.env.RESYNC_WALLET_ON_BOOT || '')) {
    console.warn('[resync] RESYNC_WALLET_ON_BOOT set — clearing cached wallet state (VTXOs / boarding / txs); house key preserved. Re-syncing from arkd.')
    await walletRepository.clear()
  }

  const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARK_SERVER_URL,
    ...(ESPLORA_URL ? { esploraUrl: ESPLORA_URL } : {}),
    storage: {
      walletRepository,
      contractRepository: new SQLiteContractRepository(executor),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(options.settlementConfig !== undefined ? { settlementConfig: options.settlementConfig as any } : {}),
  })

  const arkInfo = await wallet.arkProvider.getInfo()

  const address = await wallet.getAddress()
  const boardingAddress = await wallet.getBoardingAddress()
  console.log(`Ark address: ${address}`)
  console.log(`Boarding address: ${boardingAddress}`)
  console.log(`Ark server pubkey: ${arkInfo.signerPubkey.substring(0, 16)}...`)
  console.log(`Network: ${arkInfo.network}`)

  if (process.env.NODE_ENV !== 'test') {
    console.warn('⚠️  WARNING: House private key is stored in plaintext in SQLite.')
    console.warn('   This is acceptable for testnet/regtest. For production, use a secrets manager.')
  }

  return { wallet, identity, arkInfo }
}

export function hashSecret(secret: Uint8Array): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function networkHrpFromArkInfo(arkInfo: ArkInfo): string {
  const network = arkInfo.network
  if (network === 'bitcoin' || network === 'mainnet') return 'ark'
  // testnet / signet / mutinynet / regtest → tark
  return 'tark'
}
