// In Docker: nginx proxies /api to the server, so BASE_URL is empty.
// In dev: override via VUE_APP_API_URL to point at the server directly.
const BASE_URL = process.env.VUE_APP_API_URL || ''

export interface TiersResponse {
  tiers: number[]
  maxAvailable: number
  /** House spendable balance — the ceiling on a single payout (sizes variable-odds bets). */
  houseBankroll?: number
  /** arkd dust limit + the variable-odds house edge — used to clamp the slider's
   *  SAFE end (a high-win bet's house stake must clear dust). */
  dust?: number
  oddsEdgeBps?: number
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
  /** Variable-odds echo + total pot the winner sweeps (player stake + house stake). */
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
  pot?: number
}

/** /api/game/:id/commit — server settles via covenant for both wins, no
 *  client signature required. Always returns the final sweep txid. */
export interface CommitResponse {
  winner: 'house' | 'player'
  houseSecret: string
  playerSecret: string
  payout: number
  proof: string
  /** Variable-odds: rolled value in [0, n) for display; null for the coin. */
  roll?: number | null
  oddsN?: number
  oddsLo?: number
  oddsTarget?: number
  txid?: string
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

/** The network the coinflip server is pinned to (regtest / mutinynet / …),
 *  plus the arkade-script emulator URL when the operator runs one. The
 *  client posts forfeit txs to `emulator.url`; null means no emulator,
 *  fall back to the CSV penalty path. */
export interface NetworkResponse {
  network: string
  emulator: null | {
    url: string
    signerPubkey: string
    version: string
  }
}
export async function getNetwork(): Promise<NetworkResponse> {
  const resp = await request<NetworkResponse>('/api/network')
  // The server publishes `localhost:7073` for the emulator — fine when
  // the browser runs on the same host, broken when the page is loaded
  // from a LAN IP (phone on the same wifi). Rewrite `localhost` /
  // `127.0.0.1` to the page's own hostname so the emulator stays
  // reachable from any LAN client.
  if (resp.emulator && typeof window !== 'undefined' && window.location.hostname) {
    try {
      const u = new URL(resp.emulator.url)
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        u.hostname = window.location.hostname
        resp.emulator = { ...resp.emulator, url: u.toString().replace(/\/$/, '') }
      }
    } catch {
      // leave the URL untouched on parse failure
    }
  }
  return resp
}

export function play(
  tier: number,
  playerPubkey: string,
  playerHash: string,
  playerChangeAddress: string,
  odds?: { oddsN: number; oddsTarget: number; oddsLo?: number },
): Promise<PlayResponse> {
  return request('/api/play', {
    method: 'POST',
    body: JSON.stringify({
      tier, playerPubkey, playerHash, playerChangeAddress,
      oddsN: odds?.oddsN, oddsTarget: odds?.oddsTarget, oddsLo: odds?.oddsLo,
    }),
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

/** /api/game/:id/forfeit — arkade-script forfeit-claim. Available only when
 *  the server probed the emulator at /play time and minted the 5-leaf
 *  escrow (state.arkadeForfeit). Two-input claim spending via the
 *  CLTVMultisigTapscript `playerForfeit` leaf on each escrow. The client
 *  signs both player slots; submitting to the emulator's /v1/tx triggers
 *  covenant validation + emulator + arkd co-signing in one round-trip. */
export interface ForfeitResponse {
  forfeitPsbt: string
  forfeitCheckpoints: string[]
  /** Absolute CLTV (unix seconds) baked into the playerForfeit leaf.
   *  Once chain time crosses this, the forfeit becomes claimable. */
  forfeitClaimableAt: number
  payoutAddress: string
  /** Total amount the single forfeit output pays to the player. Equals
   *  the sum of both stakes (atomic-sweep covenant). */
  potAmount: number
  /** Per-escrow stakes for display: `[houseStake, playerStake]`. Sum
   *  must equal `potAmount`. */
  stakes: [number, number]
}

export function forfeit(gameId: string, playerEscrow: Outpoint): Promise<ForfeitResponse> {
  return request(`/api/game/${gameId}/forfeit`, {
    method: 'POST',
    body: JSON.stringify({ playerEscrow }),
  })
}
