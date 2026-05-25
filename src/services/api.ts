// In Docker: nginx proxies /api to the server, so BASE_URL is empty.
// In dev: override via VUE_APP_API_URL to point at the server directly.
const BASE_URL = process.env.VUE_APP_API_URL || ''

export interface TiersResponse {
  tiers: number[]
  maxAvailable: number
  houseReady: boolean
  rakeType?: string
  rakeValue?: number
}

export interface Outpoint {
  txid: string
  vout: number
  value: number
}

/** /api/play — the house has escrowed its stake; the player funds `escrowAddress`. */
export interface PlayResponse {
  gameId: string
  escrowAddress: string
  houseHash: string
  housePubkey: string
  serverPubkey: string
  betAmount: number
  finalExpiration: number
  houseEscrow: Outpoint
}

/** /api/game/:id/commit — resolved. House win → server swept (txid). Player win
 *  → the client signs + submits the returned sweep PSBT. */
export interface CommitResponse {
  winner: 'house' | 'player'
  houseSecret: string
  playerSecret: string
  payout: number
  rake: number
  proof: string
  txid?: string
  sweep?: {
    sweepPsbt: string
    sweepCheckpoints: string[]
    inputCount: number
    witnessHex: [string, string]
  }
}

/** /api/game/:id/refund — unsigned PlayerEscrow refund tx the client signs +
 *  submits to reclaim a stalled game (only succeeds after `finalExpiration`). */
export interface RefundResponse {
  refundPsbt: string
  refundCheckpoints: string[]
  finalExpiration: number
  refundAddress: string
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
  playerPubkey: string,
  playerHash: string,
  playerChangeAddress: string,
): Promise<PlayResponse> {
  return request('/api/play', {
    method: 'POST',
    body: JSON.stringify({ tier, playerPubkey, playerHash, playerChangeAddress }),
  })
}

export function commit(
  gameId: string,
  playerSecretHex: string,
  playerEscrow: Outpoint,
): Promise<CommitResponse> {
  return request(`/api/game/${gameId}/commit`, {
    method: 'POST',
    body: JSON.stringify({ playerSecretHex, playerEscrow }),
  })
}

export function getGame(gameId: string): Promise<GameResponse> {
  return request(`/api/game/${gameId}`)
}

/** Fetch the unsigned refund tx for a (possibly stalled) game's player escrow. */
export function refund(gameId: string, playerEscrow: Outpoint): Promise<RefundResponse> {
  return request(`/api/game/${gameId}/refund`, {
    method: 'POST',
    body: JSON.stringify({ playerEscrow }),
  })
}
