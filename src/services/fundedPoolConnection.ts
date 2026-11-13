import type { NetworkResponse } from './api'
import type { FundedPoolContext } from './fundedPoolJournal'
import type { FundedPoolDescriptor } from './fundedPoolTypes'
import { normalizePoolOperatorUrl } from './bankrollVaultObserver'

const networkKey = (publicKey: string, operatorUrl: string) => `coinflip.verified-network.v1:${encodeURIComponent(JSON.stringify([publicKey, normalizePoolOperatorUrl(operatorUrl)]))}`
const poolKey = (context: FundedPoolContext) => `coinflip.funded-pool.v1:${encodeURIComponent(JSON.stringify([context.publicKey, context.network, context.operatorUrl]))}`

function network(value: NetworkResponse, expectedOperator: string): NetworkResponse {
  if (!value || typeof value.network !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.network) ||
      normalizePoolOperatorUrl(value.operatorUrl) !== normalizePoolOperatorUrl(expectedOperator)) throw new Error('Saved connection does not match the wallet operator')
  const operatorUrl = normalizePoolOperatorUrl(value.operatorUrl)
  const esploraUrl = value.esploraUrl ? normalizePoolOperatorUrl(value.esploraUrl) : null
  if (value.emulator && (!/^(02|03)?[a-f0-9]{64}$/i.test(value.emulator.signerPubkey) || typeof value.emulator.version !== 'string')) throw new Error('Saved covenant connection is invalid')
  return { network: value.network, operatorUrl, esploraUrl, emulator: value.emulator ? {
    url: normalizePoolOperatorUrl(value.emulator.url), signerPubkey: value.emulator.signerPubkey, version: value.emulator.version,
  } : null, protocolVersion: 'v4' }
}

export function rememberVerifiedWalletNetwork(publicKey: string, config: NetworkResponse): void {
  localStorage.setItem(networkKey(publicKey, config.operatorUrl), JSON.stringify(network(config, config.operatorUrl)))
}

export function readVerifiedWalletNetwork(publicKey: string, operatorUrl: string): NetworkResponse | undefined {
  const saved = localStorage.getItem(networkKey(publicKey, operatorUrl))
  if (!saved) return undefined
  if (saved.length > 10_000) throw new Error('Saved wallet connection exceeds its size limit')
  return network(JSON.parse(saved), operatorUrl)
}

export function rememberVerifiedFundedPool(context: FundedPoolContext, descriptor: FundedPoolDescriptor, config: NetworkResponse): void {
  if (descriptor.network !== context.network || descriptor.operatorUrl !== context.operatorUrl || config.network !== context.network) throw new Error('Verified pool context mismatch')
  const connection = network(config, context.operatorUrl)
  localStorage.setItem(poolKey(context), JSON.stringify({ descriptor, network: connection }))
  rememberVerifiedWalletNetwork(context.publicKey, connection)
}

export function readVerifiedFundedPool(context: FundedPoolContext): { descriptor: FundedPoolDescriptor; network: NetworkResponse } | undefined {
  const saved = localStorage.getItem(poolKey(context))
  if (!saved) return undefined
  if (saved.length > 150_000) throw new Error('Saved pool connection exceeds its size limit')
  const value = JSON.parse(saved)
  const connection = network(value.network, context.operatorUrl)
  if (connection.network !== context.network) throw new Error('Saved pool network does not match the wallet')
  return { descriptor: value.descriptor, network: connection }
}
