import { getHouseWallet, setHouseWallet } from './db'
import { createHash } from 'crypto'
import type { IWallet, Identity } from '@arkade-os/sdk'

let wallet: IWallet | null = null
let identity: Identity | null = null

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'https://mutinynet.arkade.sh'
const ESPLORA_URL = process.env.ESPLORA_URL || 'https://mutinynet.com/api'

export async function initHouseWallet(): Promise<void> {
  const { Wallet, SingleKey } = await import('@arkade-os/sdk')

  const existing = getHouseWallet()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let singleKey: any
  if (existing) {
    singleKey = SingleKey.fromHex(existing.private_key_hex)
    console.log(`House wallet loaded: ${existing.public_key_hex.substring(0, 16)}...`)
  } else {
    singleKey = SingleKey.fromRandomBytes()
    const privHex = singleKey.toHex()
    const pubkey = await singleKey.compressedPublicKey()
    const pubHex = Buffer.from(pubkey).toString('hex')

    setHouseWallet(privHex, pubHex)
    console.log(`House wallet created: ${pubHex.substring(0, 16)}...`)
  }

  identity = singleKey

  // Use SQLite storage backed by the same sql.js database for persistence
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { SQLiteWalletRepository, SQLiteContractRepository } = require('@arkade-os/sdk/repositories/sqlite')
  const { getSqlExecutor } = await import('./db')
  const executor = getSqlExecutor()

  wallet = await Wallet.create({
    identity: singleKey,
    arkServerUrl: ARK_SERVER_URL,
    esploraUrl: ESPLORA_URL,
    storage: {
      walletRepository: new SQLiteWalletRepository(executor),
      contractRepository: new SQLiteContractRepository(executor),
    },
  })

  const address = await wallet.getAddress()
  const boardingAddress = await wallet.getBoardingAddress()
  console.log(`Ark address: ${address}`)
  console.log(`Boarding address: ${boardingAddress}`)
}

function requireWallet(): IWallet {
  if (!wallet) throw new Error('House wallet not initialized')
  return wallet
}

function requireIdentity(): Identity {
  if (!identity) throw new Error('House wallet not initialized')
  return identity
}

export async function getHouseAddress(): Promise<string> {
  return requireWallet().getAddress()
}

export async function getHouseBoardingAddress(): Promise<string> {
  return requireWallet().getBoardingAddress()
}

export async function getHousePubkeyHex(): Promise<string> {
  const pubkey = await requireIdentity().compressedPublicKey()
  return Buffer.from(pubkey).toString('hex')
}

export async function getHouseBalanceSats(): Promise<number> {
  const balance = await requireWallet().getBalance()
  return balance.available
}

export async function getHouseBalance(): Promise<{
  available: number
  settled: number
  preconfirmed: number
  boarding: { confirmed: number; unconfirmed: number; total: number }
  total: number
}> {
  const balance = await requireWallet().getBalance()
  return {
    available: balance.available,
    settled: balance.settled,
    preconfirmed: balance.preconfirmed,
    boarding: balance.boarding,
    total: balance.total,
  }
}

export async function getHouseVtxos() {
  return requireWallet().getVtxos()
}

export function hashSecret(secret: Uint8Array): string {
  return createHash('sha256').update(secret).digest('hex')
}
