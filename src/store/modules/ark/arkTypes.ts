import type { WalletBalance, Activity } from '@arkade-os/sdk'

export interface ArkServerInfo {
  pubkey: string
  network: string
  dust: string
  unilateralExitDelay: string
  boardingExitDelay?: string
  sessionDuration?: string
}

export interface ArkVTXO {
  outpoint: {
    txid: string
    vout: number
  }
  redeemTx?: string
  amount: string
  tapscripts: string[]
  isPreconfirmed?: boolean
}

export interface BoardingUtxo {
  outpoint: { txid: string; vout: number }
  amount: string
  confirmations?: number
}

/**
 * Per-game in-flight claim. Set when either the manual button or the
 * background auto-claim poll starts a forfeit/refund submission; cleared
 * in the `finally` of the same action so a failure doesn't strand the
 * lock. `mode` lets the UI distinguish "Auto-claiming…" from a click in
 * progress.
 */
export type ClaimKind = 'forfeit' | 'refund'
export type ClaimMode = 'manual' | 'auto'
export interface ClaimingInfo { kind: ClaimKind; mode: ClaimMode }

/**
 * The ark module's reactive Vuex state. Declared here (not in `ark.ts`) so the
 * `walletRuntime.ts` action implementations can type the ActionContext the
 * `ark.ts` wrappers pass them without importing the store shell.
 */
export interface ArkState {
  server: string
  esplora: string
  networkPreset: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  lastError: Error | null
  info: ArkServerInfo | null
  vtxos: ArkVTXO[]
  boardingUtxos: BoardingUtxo[]
  walletBalance: WalletBalance | null
  /**
   * Whether `walletBalance` reflects a sync that DEMONSTRABLY completed, per
   * the SDK's contract-sync state. A balance object exists (with `settled: 0`)
   * before the vtxos land, so `walletBalance != null` cannot tell a real empty
   * wallet from one that simply has not loaded — and we force a
   * non-dismissible "fund me" drawer on that distinction. See `balanceReady`.
   */
  balanceSynced: boolean
  arkAddress: string | null
  boardingAddress: string | null
  /** Grouped activity view from the SDK's `wallet.getActivityHistory()` — a
   *  game's co-fund + settle collapse into one "Dice game" row via the resolver
   *  registered at connect (see `gameActivityResolver`). */
  activityHistory: Activity[]
  /** Load state for the Activity tab, so a failed/slow getActivityHistory reads
   *  as an error the user can retry — not as a genuinely empty "No activity yet". */
  activityStatus: 'idle' | 'loading' | 'ready' | 'error'
  claimingGames: Record<string, ClaimingInfo>
  /**
   * Which leg of the v4 bet is in flight, so the play view can say what it is
   * waiting on instead of a static "FLIPPING…" for the whole round trip.
   *
   * A production HAR measured an 8.2s median autoplay cycle — ~5s of it inside
   * `/api/v4/play` alone — during which the UI said nothing, which reads as the
   * game having stopped. Null when no bet is in flight.
   */
  flipStage: FlipStage | null
}

/** The v4 bet's network legs, in the order `playV4Game` performs them. */
export type FlipStage = 'placing' | 'funding' | 'signing' | 'settling'
