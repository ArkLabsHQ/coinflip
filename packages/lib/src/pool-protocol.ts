import type { CommittedGameEconomics } from './stake-math'
import type { PoolGameDescriptor, PoolGameSnapshot } from './pool-game-vault'

export interface PoolHeadRef {
  txid: string
  vout: number
}

export type PoolCommand =
  | { kind: 'subscribe'; depositSats: string; minShares: string }
  | { kind: 'redeem'; burnShares: string; minSats: string }
  | { kind: 'openGame'; gameId: string }
  | { kind: 'settleGame'; gameId: string; playerSecretHex: string; houseSecretHex: string }
  | { kind: 'refundGame'; gameId: string }
  | { kind: 'sweepFees' }

export type PoolOperatorActionRequest = {
  operationId: string
  expectedHead: PoolHeadRef
} & ({ command: { kind: 'sweepFees' } } | {
  command: { kind: 'redeem'; burnShares: string; minSats: string }
  memberOutpoint: PoolHeadRef
})

export interface PoolOperatorCoin {
  outpoint: PoolHeadRef
  valueSats: string
  shares: string
  equitySats: string
  fullRedemptionPayoutSats: string
}

export interface PoolOperatorPosition {
  head: PoolGameSnapshot | null
  coins: PoolOperatorCoin[]
  totalShares: string
  totalEquitySats: string
  feeSweepSats: string
  capabilities: { redeem: boolean; sweepFees: boolean; reason?: string }
  inputRenewal?: PoolInputMaintenanceState
}

export interface PoolInputMaintenanceState {
  status: 'idle' | 'renewing' | 'recovery'
  pending: number
  sourceOutpoints?: PoolHeadRef[]
  error?: string
}

export interface PoolSubmitRequest {
  operationId: string
  expectedHead: PoolHeadRef
  command: PoolCommand
  arkTxid: string
  arkTx: string
  checkpointTxs: string[]
  memberPubkey: string
}

export type PoolOperationStatus = 'submitting' | 'pending' | 'confirmed' | 'rejected' | 'conflict' | 'unknown'

export interface PoolOperationReceipt {
  arkTxid: string
  consumedHead: PoolHeadRef
  nextHead: PoolHeadRef | null
  observedAt: number
}

export interface PoolOperationResponse {
  operationId: string
  arkTxid: string
  status: PoolOperationStatus
  gameId?: string
  receipt?: PoolOperationReceipt
  error?: string
  resolution?: {
    operationId: string
    arkTxid: string
    status: PoolOperationStatus
    houseSecretHex?: string
    winner?: 'player' | 'pool'
  }
}

export interface PoolPrepareRequest {
  requestId: string
  expectedHead: PoolHeadRef
  playerPubkey: string
  playerHash: string
  playerPayoutAddress: string
  playerStakeSats: string
  oddsN: number
  oddsLo: number
  oddsTarget: number
}

export interface PoolPreparedGame {
  gameId: string
  expectedHead: PoolHeadRef
  houseHash: string
  playerHash: string
  playerPubkey: string
  playerPayoutAddress: string
  playerStakeSats: string
  houseStakeSats: string
  oddsN: number
  oddsLo: number
  oddsTarget: number
  cancelAt: number
  finalAt: number
  economics: CommittedGameEconomics
  /** Quote TTL in Unix milliseconds; contract cancelAt/finalAt use Unix seconds. */
  expiresAt: number
}

export interface PoolRevealRequest {
  playerSecretHex: string
}

export interface PoolRevealResponse {
  gameId: string
  operation: PoolOperationResponse
  houseSecretHex?: string
  winner?: 'player' | 'pool'
}

export interface PoolBootstrapRequest {
  name: string
  initialNavSats: string
  operatorFeeBps?: number
  minHouseEdgeBps?: number
  maxStakeBps?: number
}

export interface PoolCapabilities {
  subscribe: boolean
  redeem: boolean
  play: boolean
  reason?: string
}

export interface PoolGameSummary {
  gameId: string
  status: 'quoted' | 'authorized' | 'funded' | 'revealed' | 'settled' | 'refunded' | 'expired' | 'conflict'
  createdAt: number
  playerStakeSats: string
  houseStakeSats: string
  oddsN: number
  oddsLo: number
  oddsTarget: number
  openingTxid?: string
  settlementTxid?: string
  winner?: 'player' | 'pool'
  houseSecretHex?: string
}

export interface PoolPublicResponse {
  status: 'unconfigured' | 'ready' | 'busy' | 'unavailable' | 'error'
  descriptor: PoolGameDescriptor | null
  head: PoolGameSnapshot | null
  capabilities: PoolCapabilities
  history: PoolGameSummary[]
  pricing: { configuredHouseStakeDiscountBps: number; minHouseEdgeBps: number }
  fairnessAssumption: 'unresolved' | 'honest-operator'
  error?: string
  renewal?: {
    status: 'idle' | 'renewing' | 'recovery'
    operationId?: string
    expectedHead?: PoolHeadRef
    stage?: 'prepared' | 'authorized' | 'registered' | 'confirmed'
    error?: string
  }
}
