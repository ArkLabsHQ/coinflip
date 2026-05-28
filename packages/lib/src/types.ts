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
   * Relative timelock (in seconds, BIP68) after the escrow VTXO is confirmed,
   * after which the player can sweep BOTH escrows via the `playerPenalty`
   * leaf on `CoinflipEscrowScript` with only its own secret — the forfeit a
   * withholding house suffers (R1). MUST be less than the time-to-
   * `finalExpiration` so the player's penalty beats the house's self-refund.
   * BIP68 grants 512-second granularity for seconds-type timelocks; values
   * rounded to multiples of 512 avoid surprises. Optional here to match the
   * rest of `Game`'s builder-state pattern (events.ts assembles a Game
   * incrementally), but `CoinflipEscrowOptions` requires it so the script-
   * bytes API cannot silently default — `escrowScript()` asserts it.
   *
   * **BIP68 silent-floor warning.** Seconds-type timelocks are encoded in
   * 512-second units; the SDK encoder silently floors non-multiples of 512
   * down to the nearest lower multiple. A value below 512 encodes as 0 —
   * producing an **immediately-spendable** leaf, which **nullifies the R1
   * forfeit entirely**. Callers MUST pass a value that is `>= 512` and a
   * multiple of 512. The documented default is `1024` (2 × 512s ≈ 17 min).
   */
  penaltyTimelockSeconds?: number
  /**
   * Variable-odds parameters. When `oddsN`/`oddsTarget` are set the escrow win
   * condition is `(oddsLo ?? 0) <= roll < oddsTarget` over `oddsN` outcomes
   * (probability `(oddsTarget - (oddsLo ?? 0))/oddsN`); unset → the 50/50 coin.
   * Flows into `CoinflipEscrowScript`.
   */
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
  /**
   * Compressed (33-byte) emulator pubkey. When set, `CoinflipEscrowScript`
   * adds a 5th `playerForfeit` leaf — a `CLTVMultisigTapscript` closure
   * (execution-bucket, arkd-recognized) wrapping an arkade-script covenant
   * that enforces "output 0 pays the player ≥ pot". The CLTV gate uses the
   * same `finalExpiration` value as the abort/refund leaves, so once the
   * game window has passed and the house hasn't revealed, the player can
   * trustlessly sweep BOTH escrows via this leaf — **without** the
   * unilateral-exit downgrade today's CSV `playerPenalty` forces.
   *
   * Optional/additive: when undefined, the escrow keeps the 4-leaf layout
   * (creatorWin/playerWin/refund/playerPenalty) and the CSV penalty remains
   * the only forfeit path. Clients that don't trust the operator's emulator
   * stay on the CSV path; clients that do get the cleaner execution-path
   * forfeit. See `arkade-forfeit.ts` and the design doc in
   * `docs/superpowers/specs/2026-05-28-r1-via-arkade-script-research.md`.
   */
  emulatorPubkey?: Uint8Array
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
