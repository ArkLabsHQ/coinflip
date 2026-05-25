/**
 * Core types for the coinflip protocol.
 * Preserved from the original game.ts with SDK type integration.
 */

export enum GameStatus {
  Unknown = 0,
  Created = 1,
  Joined = 2,
  SetupStarted = 3,
  SetupFinalized = 4,
  Finalized = 5,
  Resolved = 6,
}

/** Minimal VTXO reference used in game events */
export interface VtxoRef {
  outpoint: { txid: string; vout: number }
  amount: string
  tapscripts: string[]
}

/** A VTXO input selecting a specific spending leaf */
export interface VtxoInput {
  vtxo: VtxoRef
  leaf: string
}

export interface PlayerData {
  pubkey?: Uint8Array
  hash?: Uint8Array
  vtxos?: VtxoInput[]
  changeAddress?: string
  setupTxSignatures?: Uint8Array[]
  finalTxSignature?: Uint8Array
  revealedSecret?: Uint8Array
}

export interface Game {
  status?: GameStatus
  gameId?: string
  serverPubkey?: Uint8Array
  betAmount?: bigint
  creator?: PlayerData
  player?: PlayerData
  setupExpiration?: number
  finalExpiration?: number
  /**
   * Variable-odds parameters. When `oddsN`/`oddsTarget` are set the escrow win
   * condition is `(oddsLo ?? 0) <= roll < oddsTarget` over `oddsN` outcomes
   * (probability `(oddsTarget - (oddsLo ?? 0))/oddsN`); unset → the 50/50 coin.
   * Flows into `CoinflipEscrowScript`.
   */
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
}

// -- Game Events --

export type GameEvent =
  | CreateEvent
  | JoinEvent
  | SetupStartedEvent
  | SetupFinalizedEvent
  | FinalizeEvent
  | ResolveEvent

export interface CreateEvent {
  type: 'create'
  gameId: string
  creatorPubkey: string
  creatorVtxos: VtxoInput[]
  creatorChangeAddress: string
  betAmount: string
  serverPubkey: string
  setupExpiration: number
  finalExpiration: number
}

export interface JoinEvent {
  type: 'join'
  gameId: string
  playerPubkey: string
  playerVtxos: VtxoInput[]
  playerChangeAddress: string
  playerHash: string
}

export interface SetupStartedEvent {
  type: 'setupStarted'
  gameId: string
  creatorHash: string
  creatorFinalSignature: string
}

export interface SetupFinalizedEvent {
  type: 'setupFinalized'
  gameId: string
  playerFinalSignature: string
  playerSetupSignatures: string[]
}

export interface FinalizeEvent {
  type: 'finalize'
  gameId: string
  creatorSetupSignatures: string[]
}

export interface ResolveEvent {
  type: 'resolve'
  gameId: string
  playerSecret: string
}

// -- Transport interface --

/** A game listing returned by the transport's listGames */
export interface GameListing {
  gameId: string
  creatorPubkey: string
  betAmount: string
  createdAt: number
}

/**
 * Transport-agnostic interface for game coordination.
 * Consumers implement this — could be WebSocket, SSE, polling, QR codes, anything.
 */
export interface GameTransport {
  /** Publish a game event */
  publish(gameId: string, event: GameEvent): Promise<void>
  /** Subscribe to events for a game. Returns an unsubscribe function. */
  subscribe(gameId: string, handler: (event: GameEvent) => void): () => void
  /** List available games (optional) */
  listGames?(): Promise<GameListing[]>
}
