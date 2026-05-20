/**
 * House wallet bootstrap.
 *
 * Returns the wallet/identity/arkInfo trio that gets placed on `AppDeps`.
 * Consumers downstream read from `deps.wallet` etc. directly rather than
 * reaching for module state here.
 */

import { createHash } from 'crypto'
import type { ArkInfo, Identity, Wallet } from '@arkade-os/sdk'
import type { ConfigRepository, HouseWalletRepository } from './repositories/types.js'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'https://mutinynet.arkade.sh'
const ESPLORA_URL = process.env.ESPLORA_URL || 'https://mutinynet.com/api'

export interface HouseWalletBundle {
  wallet: Wallet
  identity: Identity
  arkInfo: ArkInfo
}

export async function initHouseWallet(repos: {
  houseWallet: HouseWalletRepository
  config: ConfigRepository
  // config is not strictly required today but kept on the signature so
  // future bootstrap-time tweaks (custom URLs, fee policy) have somewhere
  // to read from without re-threading the deps.
}): Promise<HouseWalletBundle> {
  void repos.config
  const { Wallet, SingleKey } = await import('@arkade-os/sdk')
  const { SQLiteWalletRepository, SQLiteContractRepository } = await import('@arkade-os/sdk/repositories/sqlite')
  const { getSqlExecutor } = await import('./db.js')
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

  const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARK_SERVER_URL,
    esploraUrl: ESPLORA_URL,
    storage: {
      walletRepository: new SQLiteWalletRepository(executor),
      contractRepository: new SQLiteContractRepository(executor),
    },
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
