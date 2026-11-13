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
  /** Bet rails: any integer in [betMin, betMax] is a valid amount. */
  betMin?: number
  betMax?: number
  /** Per-bet ceiling — reservation-aware, distinct from houseBankroll (the whole
   *  spendable balance). The server caps each individual bet at this. */
  capacity?: number
  maxBetFractionBps?: number
}

export interface Outpoint {
  txid: string
  vout: number
  value: number
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

/** Ceiling for a single server round-trip. The play chain (play → co-fund →
 *  reveal) makes several of these in sequence, each of which can fan out to the
 *  emulator + arkd server-side; 60s bounds a dead/hung connection without
 *  tripping a legitimately-slow reveal. Without it a stalled server freezes the
 *  flip on "FLIPPING…" forever (fetch has no default timeout). */
const REQUEST_TIMEOUT_MS = 60_000

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: options?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    })
  } catch (e) {
    // AbortSignal.timeout rejects with a TimeoutError DOMException; give it a
    // message the UI can show instead of a bare "signal is aborted".
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new Error(`Request to ${path} timed out — the server may be busy. Please try again.`)
    }
    throw e
  }

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
 *  client posts forfeit txs to `emulator.url`. v4 REQUIRES the emulator, so
 *  null means the client can't play (playV4Game aborts before funding). */
export interface NetworkResponse {
  network: string
  operatorUrl: string
  esploraUrl: string | null
  emulator: null | {
    url: string
    signerPubkey: string
    version: string
  }
  /** Game protocol the client should drive. The v4-only server always returns
   *  'v4' (joint pot, /api/v4 flow); the field is retained for forward-compat
   *  and the client falls back gracefully if it's ever absent. */
  protocolVersion?: 'v4'
}
export async function getNetwork(signal?: AbortSignal): Promise<NetworkResponse> {
  const resp = await request<NetworkResponse>('/api/network', signal ? { signal } : undefined)
  const reachable = (url: string): string => {
    if (typeof window === 'undefined' || !window.location.hostname) return url
    const parsed = new URL(url)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') parsed.hostname = window.location.hostname
    return parsed.toString().replace(/\/$/, '')
  }
  resp.operatorUrl = reachable(resp.operatorUrl)
  if (resp.esploraUrl) resp.esploraUrl = reachable(resp.esploraUrl)
  if (resp.emulator) resp.emulator = { ...resp.emulator, url: reachable(resp.emulator.url) }
  return resp
}

export function getGame(gameId: string): Promise<GameResponse> {
  return request(`/api/game/${gameId}`)
}

// ── v0.4 joint-pot endpoints ────────────────────────────────────────────────
// The 2-tx joint-pot flow: play → (build+sign co-fund) → cofund → (sign
// checkpoint) → cofund-finalize → reveal. Shapes mirror the server's
// trustless-game-v4 handlers; V4PlayResponse is structurally a lib
// `PlayResponseForCofund`, so `buildCofundFromPlay` consumes it directly.

export interface V4SerializedTapLeaf {
  controlBlock: { version: number; internalKey: string; merklePath: string[] }
  script: string
}
export interface V4HouseInput {
  txid: string
  vout: number
  value: number
  leaf: V4SerializedTapLeaf
  tapTree: string
}
export type { V4CovenantParams } from 'arkade-coinflip'
import type { V4CovenantParams } from 'arkade-coinflip'
export interface V4PlayResponse {
  gameId: string
  potAddress: string
  networkHrp: string
  pot: number
  betAmount: number
  houseStake: number
  houseInputs: V4HouseInput[]
  housePubkey: string
  houseHash: string
  serverPubkey: string
  emulatorPubkey: string
  finalExpiration: number
  oddsN: number; oddsTarget: number; oddsLo: number
  covenant: V4CovenantParams
}
export interface V4CofundResponse { arkTxid: string; playerCheckpoints: string[] }
export interface V4CofundFinalizeResponse {
  cofundTxid: string
  potOutpoint: { txid: string; vout: number; value: number }
}
export interface V4RevealResponse {
  winner: 'player' | 'house'
  settleTxid: string
  payout: number
  houseSecretHex: string
  roll: number | null
}

export function v4Play(
  tier: number,
  playerPubkey: string,
  playerHash: string,
  playerPayoutAddress: string,
  playerChangeAddress: string,
  odds?: { oddsN: number; oddsTarget: number; oddsLo?: number },
  /** Sub-dust remainder (sats) folded into the player's stake when the selected
   *  VTXOs would otherwise leave a dust change. Server validates 0 < topUp ≤ dust. */
  stakeTopUp?: number,
): Promise<V4PlayResponse> {
  return request('/api/v4/play', {
    method: 'POST',
    body: JSON.stringify({
      tier, playerPubkey, playerHash, playerPayoutAddress, playerChangeAddress,
      oddsN: odds?.oddsN, oddsTarget: odds?.oddsTarget, oddsLo: odds?.oddsLo,
      stakeTopUp: stakeTopUp || undefined,
    }),
  })
}

export function v4Cofund(gameId: string, arkTx: string, checkpoints: string[]): Promise<V4CofundResponse> {
  return request(`/api/v4/game/${gameId}/cofund`, {
    method: 'POST',
    body: JSON.stringify({ arkTx, checkpoints }),
  })
}

export function v4CofundFinalize(gameId: string, playerCheckpoints: string[]): Promise<V4CofundFinalizeResponse> {
  return request(`/api/v4/game/${gameId}/cofund-finalize`, {
    method: 'POST',
    body: JSON.stringify({ playerCheckpoints }),
  })
}

export function v4Reveal(gameId: string, playerSecretHex: string): Promise<V4RevealResponse> {
  return request(`/api/v4/game/${gameId}/reveal`, {
    method: 'POST',
    body: JSON.stringify({ playerSecretHex }),
  })
}

/** /api/v4/game/:id/cooperative-exit — the house co-signs the client's leaf-7
 *  on-chain split-back (emulator-free recovery). The client sends its
 *  player-signed exit PSBT + the unrolled pot outpoint; the house verifies the
 *  split is exactly what it expects and returns the co-signed PSBT. */
export interface V4CooperativeExitResponse { exitTxPsbt: string }
export function v4CooperativeExit(
  gameId: string,
  body: { exitTxPsbt: string; potOnchain: { txid: string; vout: number; value: number }; feeSats: number },
): Promise<V4CooperativeExitResponse> {
  return request(`/api/v4/game/${gameId}/cooperative-exit`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** /api/game/:id/details — full game state (txids, params, preimages).
 *  The server gates on the playerPubkey query param matching the game's
 *  recorded pubkey, so this only returns data to the owning player.
 *  Preimages are only included once the game is in a terminal state
 *  (resolved or expired). */
export interface GameDetailsResponse {
  id: string
  tier: number
  status: string
  winner: string | null
  payoutAmount: number | null
  rakeAmount: number
  createdAt: string
  resolvedAt: string | null
  /** Fair roll `(digitHouse + digitPlayer) mod n`, terminal-only; null for the
   *  forfeit paths and pre-terminal games. */
  roll: number | null
  contractVersion: 'v4'
  covenant: V4CovenantParams | null
  houseHash: string
  playerHash: string
  finalExpiration: number | null
  setupExpiration: number | null
  oddsN: number | null
  oddsTarget: number | null
  oddsLo: number | null
  houseStake: number | null
  playerStake: number | null
  emulatorPubkey: string | null
  exitDelay: number | null
  potOutpoint: Outpoint | null
  settleTxid: string | null
  refundTxid: string | null
  houseSecret: string | null
  playerSecret: string | null
}
export function getGameDetails(gameId: string, playerPubkey: string): Promise<GameDetailsResponse> {
  return request(`/api/game/${gameId}/details?playerPubkey=${encodeURIComponent(playerPubkey)}`)
}

// ── Restore my games (history) ────────────────────────────────────────────────
// "Restore Games from Server": after a browser clear / new device the client
// has the key but no local history. It proves it holds the key behind
// `playerPubkey` (so a stranger can't pull someone's history) and pulls the
// summaries back. Two-step, signature-proof challenge:
//   1. GET /api/games/challenge?playerPubkey= -> { nonce }
//   2. client schnorr-signs sha256(utf8(nonce)) (see @/utils/signChallenge)
//   3. GET /api/games?playerPubkey=&nonce=&sig=&… -> { games, reclaimHints }
// Mirrors the server's public-routes.ts restore handlers + restore-auth.ts.

/** One game's history summary, as returned by GET /api/games. */
export interface GameSummary {
  gameId: string
  tier: number
  status: string
  winner: string | null
  payoutAmount: number | null
  rakeAmount: number
  createdAt: string
  resolvedAt: string | null
  /** The normal joint-pot game protocol. */
  protocolVersion: 'v4'
}

/**
 * Self-refund hint for a PENDING v4 game, echoed by GET /api/games. The server
 * never holds the take-the-pot key, so `playerSecretHex` is ALWAYS null here.
 * On restore, `restoreFromServer` → `rearmV4ReclaimHints` re-arms each hint into a
 * client-side self-refund stash that auto-claim fires once the CLTV matures — so a
 * restored device DOES recover its stalled v4 stakes (independent of the server's
 * own refund timer, which is the redundant backstop).
 */
export interface V4ReclaimHint {
  gameId: string
  contractVersion: 'v4'
  potOutpoint: { txid: string | null; vout: number; value: number | null }
  covenant: V4CovenantParams | null
  forfeitClaimableAt: number | null
  forfeitEmulatorUrl: string | null
  playerSecretHex: null
}

export interface RestoreChallengeResponse {
  nonce: string
}

export interface RestoreGamesResponse {
  games: GameSummary[]
  reclaimHints: V4ReclaimHint[]
}

/** Step 1: fetch a signature-proof challenge nonce for `playerPubkey`. */
export function getRestoreChallenge(playerPubkey: string): Promise<RestoreChallengeResponse> {
  return request(`/api/games/challenge?playerPubkey=${encodeURIComponent(playerPubkey)}`)
}

/**
 * Step 3: fetch the player's game history. `nonce` is the challenge from
 * `getRestoreChallenge` and `sig` is `signChallenge(nonce, privKeyHex)`. The
 * server verifies the signature against `playerPubkey` before any DB read, so a
 * bad/expired proof returns 401. Optional paging/filter via `opts`.
 */
export function restoreGamesFromServer(
  playerPubkey: string,
  nonce: string,
  sig: string,
  opts?: { limit?: number; offset?: number; status?: string },
): Promise<RestoreGamesResponse> {
  const params = new URLSearchParams({ playerPubkey, nonce, sig })
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts?.offset !== undefined) params.set('offset', String(opts.offset))
  if (opts?.status !== undefined) params.set('status', opts.status)
  return request(`/api/games?${params.toString()}`)
}
