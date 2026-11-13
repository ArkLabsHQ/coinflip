import type { OperatorInfo } from '@arkade-os/sdk'
import { ARK_SYNC_TIMEOUT_MS, ARK_SUBMIT_TIMEOUT_MS } from './async-timeout.js'

export const VTXO_LIFETIME_BUFFER_MS = 30 * 60_000
export const RENEWAL_EXPIRY_BUFFER_MS = 259_200_000
export const HOUSE_RENEWAL_INTERVAL_MS = 600_000

export interface HouseRenewalTiming {
  intervalMs?: number
  syncTimeoutMs?: number
  submitTimeoutMs?: number
}

const completedLifetimes = new WeakMap<object, bigint>()

export function rememberCompletedHouseBatchLifetime(wallet: object, lifetime: bigint): void {
  if (typeof lifetime !== 'bigint' || lifetime <= 0n) throw new Error('Completed house batch has an invalid native lifetime')
  completedLifetimes.set(wallet, lifetime)
}

export function houseRenewalBufferForWalletMs(wallet: object, info?: Pick<OperatorInfo, 'vtxoTreeExpiry'>, timing?: HouseRenewalTiming): number {
  return houseRenewalBufferMs({ vtxoTreeExpiry: info?.vtxoTreeExpiry ?? completedLifetimes.get(wallet) }, timing)
}

/** Missing or block-domain advertisements retain the legacy timestamp policy. */
export function houseRenewalBufferMs(info?: Pick<OperatorInfo, 'vtxoTreeExpiry'>, timing: HouseRenewalTiming = {}): number {
  const interval = timing.intervalMs ?? HOUSE_RENEWAL_INTERVAL_MS
  const sync = timing.syncTimeoutMs ?? ARK_SYNC_TIMEOUT_MS
  const submit = timing.submitTimeoutMs ?? ARK_SUBMIT_TIMEOUT_MS
  if (![interval, sync, submit].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('House renewal policy requires positive finite scheduling and timeout budgets')
  }
  const minimum = VTXO_LIFETIME_BUFFER_MS + interval + sync + 2 * submit
  if (!Number.isSafeInteger(minimum) || minimum >= RENEWAL_EXPIRY_BUFFER_MS) {
    throw new Error('House renewal scheduling budget cannot fit inside its 72-hour maximum lead')
  }
  const lifetime = info?.vtxoTreeExpiry
  if (typeof lifetime !== 'bigint' || lifetime < 512n) return RENEWAL_EXPIRY_BUFFER_MS
  const lifetimeMs = lifetime * 1000n
  if (lifetimeMs <= BigInt(minimum)) {
    throw new Error(`House batch lifetime ${lifetime}s is too short for the ${minimum / 1000}s game and renewal scheduling budget`)
  }
  const halfLifetime = lifetimeMs / 2n
  return halfLifetime >= BigInt(RENEWAL_EXPIRY_BUFFER_MS) ? RENEWAL_EXPIRY_BUFFER_MS : Math.max(minimum, Number(halfLifetime))
}
