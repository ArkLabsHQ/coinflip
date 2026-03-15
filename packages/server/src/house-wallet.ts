import { getHouseWallet, setHouseWallet } from './db'
import { createHash, randomBytes } from 'crypto'

let housePrivateKey: Uint8Array
let housePublicKey: Uint8Array
let houseBalance = 0
let lockedBalance = 0

export async function initHouseWallet(): Promise<void> {
  const existing = getHouseWallet()

  if (existing) {
    housePrivateKey = Buffer.from(existing.private_key_hex, 'hex')
    housePublicKey = Buffer.from(existing.public_key_hex, 'hex')
    console.log(`House wallet loaded: ${existing.public_key_hex.substring(0, 16)}...`)
  } else {
    // Generate new keypair using secp256k1
    const { getPublicKey } = await import('@noble/secp256k1')
    const privKey = randomBytes(32)
    const pubKey = getPublicKey(privKey, true) // compressed

    housePrivateKey = new Uint8Array(privKey)
    housePublicKey = new Uint8Array(pubKey)

    setHouseWallet(
      Buffer.from(housePrivateKey).toString('hex'),
      Buffer.from(housePublicKey).toString('hex')
    )
    console.log(`House wallet created: ${Buffer.from(housePublicKey).toString('hex').substring(0, 16)}...`)
  }

  // TODO: Initialize SDK Wallet for real VTXO management
  // For MVP, house balance is tracked manually via admin deposits
  houseBalance = 0
}

export function getHousePubkey(): Uint8Array {
  return housePublicKey
}

export function getHousePubkeyHex(): string {
  return Buffer.from(housePublicKey).toString('hex')
}

export function getHousePrivateKey(): Uint8Array {
  return housePrivateKey
}

export function getHouseBalanceSats(): number {
  return houseBalance
}

export function setHouseBalanceSats(balance: number): void {
  houseBalance = balance
}

export function getLockedBalance(): number {
  return lockedBalance
}

export function addLockedBalance(amount: number): void {
  lockedBalance += amount
}

export function releaseLockedBalance(amount: number): void {
  lockedBalance = Math.max(0, lockedBalance - amount)
}

export function getAvailableBalance(): number {
  return Math.max(0, houseBalance - lockedBalance)
}

export function getHouseAddress(): string {
  // Generate a deposit address from the house pubkey
  // For MVP, return a placeholder — real implementation uses ArkAddress from SDK
  const pubkeyHex = Buffer.from(housePublicKey).toString('hex')
  return `ark1house${pubkeyHex.substring(0, 32)}`
}

export function hashSecret(secret: Uint8Array): string {
  return createHash('sha256').update(secret).digest('hex')
}
