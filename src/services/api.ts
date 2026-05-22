// In Docker: nginx proxies /api to the server, so BASE_URL is empty.
// In dev: override via VUE_APP_API_URL to point at the server directly.
const BASE_URL = process.env.VUE_APP_API_URL || ''

export interface TiersResponse {
  tiers: number[]
  maxAvailable: number
  houseReady: boolean
}

export interface PlayResponse {
  gameId: string
  housePubkey: string
  houseHash: string
  setupTx: string
  finalTx: string
  houseSetupSignatures: string[]
  houseFinalSignature: string
}

export interface SignResponse {
  winner: 'player' | 'house'
  houseSecret: string
  playerSecret: string
  houseSecretSize: number
  playerSecretSize: number
  payout: number
  rake: number
  proof: string
}

export interface GameResponse {
  id: string
  tier: number
  playerChoice: string
  winner: string | null
  rakeAmount: number
  payoutAmount: number | null
  status: string
  createdAt: string
  resolvedAt: string | null
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `HTTP ${response.status}`)
  }

  return response.json()
}

export function getTiers(): Promise<TiersResponse> {
  return request('/api/tiers')
}

/** The network the coinflip server is pinned to (regtest / mutinynet / …). */
export function getNetwork(): Promise<{ network: string }> {
  return request('/api/network')
}

export function play(
  tier: number,
  choice: 'heads' | 'tails',
  playerPubkey: string,
  playerHash: string,
  playerVtxos: unknown[] = [],
  playerChangeAddress = ''
): Promise<PlayResponse> {
  return request('/api/play', {
    method: 'POST',
    body: JSON.stringify({ tier, choice, playerPubkey, playerHash, playerVtxos, playerChangeAddress }),
  })
}

export function sign(
  gameId: string,
  playerSetupSignatures: string[] = [],
  playerFinalSignature = '',
  playerSecretHex: string
): Promise<SignResponse> {
  return request(`/api/game/${gameId}/sign`, {
    method: 'POST',
    body: JSON.stringify({ playerSetupSignatures, playerFinalSignature, playerSecretHex }),
  })
}

export function getGame(gameId: string): Promise<GameResponse> {
  return request(`/api/game/${gameId}`)
}
