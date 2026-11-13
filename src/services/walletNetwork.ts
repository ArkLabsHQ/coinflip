import { getNetwork, type NetworkResponse } from './api'
import { readVerifiedWalletNetwork, rememberVerifiedWalletNetwork } from './fundedPoolConnection'

export async function getWalletNetwork(publicKey: string, operatorUrl: string): Promise<NetworkResponse> {
  try { return await getNetwork(AbortSignal.timeout(8000)) }
  catch (failure) {
    if (!publicKey) throw failure
    const saved = readVerifiedWalletNetwork(publicKey, operatorUrl)
    if (!saved) throw failure
    const response = await fetch(`${saved.operatorUrl}/v1/info`, { signal: AbortSignal.timeout(12000) })
    if (!response.ok) throw new Error('The saved wallet operator is unavailable')
    const info = await response.json()
    if (info.network !== saved.network) throw new Error('The saved wallet operator now reports a different network')
    return saved
  }
}

export function rememberWalletNetwork(publicKey: string, network: NetworkResponse): boolean {
  if (!publicKey) return false
  try { rememberVerifiedWalletNetwork(publicKey, network); return true }
  catch { return false }
}
