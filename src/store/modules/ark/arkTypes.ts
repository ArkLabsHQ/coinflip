/**
 * Shared data shapes for the Ark wallet store module.
 *
 * Pure type declarations relocated from `ark.ts` so the Vuex module shell and
 * its sibling helper modules (`arkHelpers.ts`, `v4Recovery.ts`) can reference
 * them without importing the store. `ark.ts` re-exports the previously-public
 * ones (`StashedRefund`, `ArkServerInfo`, `ClaimingInfo`, …) so external import
 * paths (`@/store/modules/ark/ark`) are unchanged.
 */
import type { Outpoint } from '@/services/api'
import type { WalletBalance, Activity } from '@arkade-os/sdk'

/**
 * Stalled-bet refunds. When the player escrows a stake we immediately fetch the
 * server-built refund tx and persist it locally — BEFORE revealing/committing.
 * If the server then stalls (or the tab closes mid-game), the player still holds
 * a self-submittable refund and can reclaim the stake after the CLTV with no
 * trust in the server. The stash is cleared once the game resolves.
 */
export interface StashedRefund {
  gameId: string
  tier: number
  playerEscrow: Outpoint
  refundPsbt: string
  refundCheckpoints: string[]
  finalExpiration: number
  createdAt: number
  /** Arkade-script forfeit-claim PSBT. Submitted to the EMULATOR's /v1/tx
   *  (not arkd directly) — the emulator validates the covenant + cosigns
   *  the tweaked slot, then forwards to arkd. */
  forfeitPsbt?: string
  forfeitCheckpoints?: string[]
  /** Absolute CLTV (unix seconds) baked into the playerForfeit leaf —
   *  forfeit becomes claimable once chain time crosses this. */
  forfeitClaimableAt?: number
  /** Emulator base URL the client posts the forfeit PSBT to. */
  forfeitEmulatorUrl?: string
  /** Set true once the player has actually called /commit (revealed their
   * secret). Gates penalty (revealer-takes-all) vs self-refund (own stake).
   * If the player never revealed, only the self-refund applies. */
  revealed?: boolean
  /** Player's secret in hex — required as the condition witness when claiming
   * the penalty. Stored ONLY in the stash, never sent off-device. */
  playerSecretHex?: string
  /**
   * Serialized params of the PLAYER escrow's `coinflip-escrow` contract (from
   * /api/play). Persisted so a page reload can RE-REGISTER the escrow with the
   * SDK ContractManager and re-arm the watcher that clears this stash on the
   * sweep's `vtxo_spent`. */
  escrowContractParams?: Record<string, string>
  /** The player escrow's Ark address — its pkScript is the contract's key
   *  (and what we deactivate when the bet is done). */
  escrowAddress?: string
  /**
   * Contract version used by this game. 'v2' is the legacy length-encoded
   * predicate; 'v3' uses the arkade-script + packet-borne reveals shape.
   * Undefined means v2 (forward-compat with stashes written before this field).
   * Drives which SDK contract handler type the ContractWatcher registers.
   */
  contractVersion?: 'v2' | 'v3'
  /**
   * v3 only — the player's commit (digit + salt). Salt stored hex-encoded for
   * JSON serializability. Stored ONLY in the stash; never sent off-device
   * except as the /commit payload at reveal time.
   */
  reveal?: { digit: number; salt: string }
  /**
   * Count of consecutive PERMANENT auto-claim failures (a witness-utxo script
   * mismatch — the stashed refund no longer matches the Service's VTXO, e.g. a
   * pre-v4 or rotated-signer escrow). Auto-claim backs off once this reaches
   * MAX_RECLAIM_ATTEMPTS; the stake still recovers via the operator sweep.
   * Transient (network / CLTV-timing) failures do NOT increment it.
   */
  claimFailures?: number
  /** Last permanent auto-claim error message, for surfacing in the UI. */
  lastClaimError?: string
}

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
}
