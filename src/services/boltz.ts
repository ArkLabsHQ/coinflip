// Boltz swap service — LN ↔ on-chain bridge for funding and withdrawing
//
// Reverse swap:  User pays LN invoice → Boltz locks BTC on-chain → user claims to boarding address
// Submarine swap: User sends on-chain BTC to Boltz HTLC → Boltz pays user's LN invoice

const BOLTZ_API = 'https://api.testnet.boltz.exchange/v2'

export interface ReversePairInfo {
  hash: string
  rate: number
  limits: { maximal: number; minimal: number }
  fees: { percentage: number; minerFees: { claim: number; lockup: number } }
}

export interface ReverseSwapResponse {
  id: string
  invoice: string
  swapTree: {
    claimLeaf: { version: number; output: string }
    refundLeaf: { version: number; output: string }
  }
  lockupAddress: string
  refundPublicKey: string
  timeoutBlockHeight: number
  onchainAmount: number
}

export interface SubmarinePairInfo {
  hash: string
  rate: number
  limits: { maximal: number; minimal: number }
  fees: { percentage: number; minerFees: { claim: number; lockup: number } }
}

export interface SubmarineSwapResponse {
  id: string
  bip21: string
  address: string
  swapTree: {
    claimLeaf: { version: number; output: string }
    refundLeaf: { version: number; output: string }
  }
  claimPublicKey: string
  timeoutBlockHeight: number
  acceptZeroConf: boolean
  expectedAmount: number
}

export interface SwapStatus {
  status: string
  transaction?: { id: string; hex: string }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BOLTZ_API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Boltz API error: ${res.status}`)
  }
  return res.json()
}

// Get reverse swap (LN → on-chain) pair info and limits
export async function getReversePairs(): Promise<ReversePairInfo> {
  const data = await request<Record<string, Record<string, ReversePairInfo>>>('/swap/reverse')
  return data['BTC']['BTC']
}

// Get submarine swap (on-chain → LN) pair info and limits
export async function getSubmarinePairs(): Promise<SubmarinePairInfo> {
  const data = await request<Record<string, Record<string, SubmarinePairInfo>>>('/swap/submarine')
  return data['BTC']['BTC']
}

// Create a reverse swap: pay LN invoice → receive on-chain BTC
export async function createReverseSwap(
  invoiceAmount: number,
  preimageHash: string,
  claimPublicKey: string,
): Promise<ReverseSwapResponse> {
  return request('/swap/reverse', {
    method: 'POST',
    body: JSON.stringify({
      from: 'BTC',
      to: 'BTC',
      invoiceAmount,
      preimageHash,
      claimPublicKey,
    }),
  })
}

// Create a submarine swap: send on-chain BTC → pay LN invoice
export async function createSubmarineSwap(
  invoice: string,
  refundPublicKey: string,
): Promise<SubmarineSwapResponse> {
  return request('/swap/submarine', {
    method: 'POST',
    body: JSON.stringify({
      from: 'BTC',
      to: 'BTC',
      invoice,
      refundPublicKey,
    }),
  })
}

// Check swap status
export async function getSwapStatus(id: string): Promise<SwapStatus> {
  return request(`/swap/${id}`)
}

// Stream swap status updates via SSE
export function streamSwapStatus(id: string, onStatus: (status: SwapStatus) => void): () => void {
  const es = new EventSource(`${BOLTZ_API}/swap/${id}/stream`)
  es.onmessage = (event) => {
    try {
      onStatus(JSON.parse(event.data))
    } catch { /* ignore parse errors */ }
  }
  return () => es.close()
}

// Calculate how much the user receives on-chain for a given LN payment
export function calcReverseReceiveAmount(invoiceAmount: number, pair: ReversePairInfo): number {
  const boltzFee = Math.ceil(invoiceAmount * pair.fees.percentage / 100)
  return invoiceAmount - boltzFee - pair.fees.minerFees.lockup - pair.fees.minerFees.claim
}

// Calculate how much the user needs to send on-chain for a given LN invoice
export function calcSubmarineSendAmount(invoiceAmount: number, pair: SubmarinePairInfo): number {
  const boltzFee = Math.ceil(invoiceAmount * pair.fees.percentage / 100)
  return invoiceAmount + boltzFee + pair.fees.minerFees.claim + pair.fees.minerFees.lockup
}
