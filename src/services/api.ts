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

/**
 * /api/play — the player funds `escrowAddress` with their stake. The house does
 * NOT escrow here: under lazy funding (v0.3.5+) it funds its own side at
 * `/commit`, so there is no `houseEscrow` in this response (it was a stale,
 * never-sent field left over from the eager-funding model and has been removed).
 */
export interface PlayResponse {
  gameId: string
  escrowAddress: string
  houseHash: string
  housePubkey: string
  serverPubkey: string
  betAmount: number
  finalExpiration: number
  /**
   * Serialized params of the PLAYER escrow's `coinflip-escrow` contract. The
   * client registers its escrow with these (via ContractManager.createContract)
   * so the SDK's ContractWatcher fires `vtxo_spent` the instant the atomic sweep
   * settles — clearing the stalled-bet stash without polling getGame.
   */
  escrowContractParams: Record<string, string>
  /** Variable-odds echo + total pot the winner sweeps (player stake + house stake). */
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
  pot?: number
  /**
   * Contract version this game was minted with. 'v2' is the legacy length-
   * encoded predicate; 'v3' uses arkade-script + packet-borne reveals.
   * Drives which SDK contract handler type the ContractWatcher registers AND
   * which on-the-wire shape the client must send at /commit
   * (v2: raw bytes; v3: `[digitByte] ‖ salt` from `commitDigit`).
   */
  contractVersion?: 'v2' | 'v3'
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
  /** Escrow contract version the server mints NEW games with. v2 = legacy
   *  length-encoded predicate; v3 = arkade-script + packet-borne reveals.
   *  Drives client secret format: v2 = raw bytes; v3 = `[digit] ‖ salt`. */
  escrowVersion?: 'v2' | 'v3'
  /** Game protocol the client should drive — 'v3' (per-party escrow, default)
   *  or 'v4' (joint pot, /api/v4 flow). Opt-in via the server's PROTOCOL_VERSION;
   *  the play flow routes to playV4Game when this is 'v4'. */
  protocolVersion?: 'v3' | 'v4'
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

// ── v0.4 joint-pot endpoints ────────────────────────────────────────────────
// The 2-tx joint-pot flow: play → (build+sign co-fund) → cofund → (sign
// checkpoint) → cofund-finalize → reveal. Shapes mirror the server's
// trustless-game-v4 handlers; V4PlayResponse is structurally a lib
// `PlayResponseForCofund`, so `buildCofundFromPlay` consumes it directly.

export interface V4SerializedTapLeaf {
  controlBlock: { version: number; internalKey: string; merklePath: string[] }
  script: string
}
export interface V4CovenantParams {
  creatorPubkey: string; playerPubkey: string; serverPubkey: string
  creatorHash: string; playerHash: string
  finalExpiration: number; exitDelay: number
  oddsN: number; oddsTarget: number; oddsLo: number
  emulatorPubkey: string
  playerPayoutPkScript: string; housePayoutPkScript: string
  playerStake: number; houseStake: number
}
export interface V4PlayResponse {
  gameId: string
  potAddress: string
  networkHrp: string
  pot: number
  betAmount: number
  houseStake: number
  houseVtxo: { txid: string; vout: number; value: number }
  houseLeaf: V4SerializedTapLeaf
  houseTapTree: string
  housePubkey: string
  houseHash: string
  serverPubkey: string
  emulatorPubkey: string
  finalExpiration: number
  oddsN: number; oddsTarget: number; oddsLo: number
  covenant: V4CovenantParams
}
export interface V4CofundResponse { arkTxid: string; playerCheckpoint: string }
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
): Promise<V4PlayResponse> {
  return request('/api/v4/play', {
    method: 'POST',
    body: JSON.stringify({
      tier, playerPubkey, playerHash, playerPayoutAddress, playerChangeAddress,
      oddsN: odds?.oddsN, oddsTarget: odds?.oddsTarget, oddsLo: odds?.oddsLo,
    }),
  })
}

export function v4Cofund(gameId: string, arkTx: string, checkpoints: string[]): Promise<V4CofundResponse> {
  return request(`/api/v4/game/${gameId}/cofund`, {
    method: 'POST',
    body: JSON.stringify({ arkTx, checkpoints }),
  })
}

export function v4CofundFinalize(gameId: string, playerCheckpoint: string): Promise<V4CofundFinalizeResponse> {
  return request(`/api/v4/game/${gameId}/cofund-finalize`, {
    method: 'POST',
    body: JSON.stringify({ playerCheckpoint }),
  })
}

export function v4Reveal(gameId: string, playerSecretHex: string): Promise<V4RevealResponse> {
  return request(`/api/v4/game/${gameId}/reveal`, {
    method: 'POST',
    body: JSON.stringify({ playerSecretHex }),
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
  contractVersion: 'v2' | 'v3'
  playerHash: string
  playerChoice?: string
  finalExpiration: number | null
  setupExpiration: number | null
  oddsN: number | null
  oddsTarget: number | null
  oddsLo: number | null
  houseStake: number | null
  playerStake: number | null
  emulatorPubkey: string | null
  exitDelay: number | null
  houseEscrow: Outpoint | null
  playerEscrow: Outpoint | null
  resolveTxid: string | null
  houseRefundTxid: string | null
  /** Hex preimages — only present when status ∈ {resolved, expired}.
   *  For v3 these are `[digit] ‖ salt`; for v2 they're raw bytes whose
   *  LENGTH encodes the digit. Decode accordingly per contractVersion. */
  houseSecret: string | null
  playerSecret: string | null
}
export function getGameDetails(gameId: string, playerPubkey: string): Promise<GameDetailsResponse> {
  return request(`/api/game/${gameId}/details?playerPubkey=${encodeURIComponent(playerPubkey)}`)
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
