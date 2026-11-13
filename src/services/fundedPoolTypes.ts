export type FundedPoolPhase = 'idle' | 'funded' | 'contest'
export type FundedPoolOperationKind = 'subscribe' | 'redeem' | 'openGame'

export interface PoolOutpoint { txid: string; vout: number }

export interface FundedPoolDescriptor {
  version: 1
  name: string
  network: string
  operatorUrl: string
  controlAssetId: string
  shareAssetId: string
  operatorPubkey: string
  operatorPayoutPkScript: string
  operatorFeeBps: number
  minHouseEdgeBps: number
  maxStakeBps: number
  bootstrapTxid: string
  checkpointPsbts: [string, string]
}

export interface FundedPoolQuote {
  readonly id: string
  readonly kind: FundedPoolOperationKind
  readonly transactionCount?: number
  readonly cashReleasedSats?: string
  readonly head: Readonly<PoolOutpoint>
  readonly expiresAt: number
  readonly amountSats: string
  readonly feeSats: string
  readonly mintedShares: string
  readonly burnShares: string
  readonly minShares: string
  readonly minSats: string
  readonly payoutSats: string
  readonly equitySats: string
  readonly ownershipBps: string
  readonly playerStakeSats: string
  readonly houseStakeSats: string
  readonly expectedPayoutSats: string
  readonly oddsN: number | null
  readonly oddsLo: number | null
  readonly oddsTarget: number | null
}

export interface FundedPoolPending {
  id: string
  kind: FundedPoolOperationKind
  stage: 'prepared' | 'authorizing' | 'staging' | 'signing' | 'submitting' | 'confirming' | 'revealing' | 'settling' | 'refunding' | 'reconciling' | 'recovery'
  arkTxid: string | null
  error: string | null
}

export interface FundedPoolReceipt {
  operationId: string
  kind: FundedPoolOperationKind
  arkTxid: string
  settlementTxid?: string
  cashReleaseTxid?: string
  poolOutpoint: PoolOutpoint | null
  memberOutpoint: PoolOutpoint | null
  depositedSats: string
  mintedShares: string
  burnedShares: string
  payoutSats: string
  playerStakeSats: string
  houseStakeSats: string
  memberDeltaSats: string
  outcome: 'player' | 'house' | 'refund' | null
  verifiedAt: number
}

export interface FundedPoolDisplay {
  status: 'disconnected' | 'loading' | 'unconfigured' | 'unavailable' | 'ready' | 'pending' | 'recovery' | 'error'
  descriptor: FundedPoolDescriptor | null
  network: string | null
  name: string | null
  operatorFeeBps: number | null
  minHouseEdgeBps: number | null
  maxStakeBps: number | null
  verified: boolean
  fairnessTrust: 'operator'
  head: PoolOutpoint | null
  phase: FundedPoolPhase | null
  navSats: string | null
  supply: string | null
  memberShares: string | null
  availableShares: string | null
  estimatedClaimSats: string | null
  accruedFeesSats: string | null
  carriedLossSats: string | null
  pending: FundedPoolPending | null
  recovery: { operationId: string; reason: string } | null
  receipts: readonly FundedPoolReceipt[]
  capabilities: { subscribe: boolean; redeem: boolean; bet: boolean; recover: boolean; renewInputs?: boolean; rescue?: boolean }
  verifiedAt: number | null
  error: string | null
}

export interface FundedPoolBetInput {
  playerStakeSats: bigint
  oddsN: number
  oddsLo: number
  oddsTarget: number
  choice?: number
}

export interface FundedPoolInputRenewalQuote {
  readonly id: string
  readonly expiresAt: number
  readonly network: string
  readonly operatorUrl: string
  readonly inputs: readonly {
    readonly outpoint: Readonly<PoolOutpoint>
    readonly valueSats: string
    readonly expiresAt: number | null
    readonly assets: readonly { readonly assetId: string; readonly amount: string }[]
  }[]
  readonly inputTotalSats: string
  readonly estimatedFeeSats: string
  readonly estimatedOutputSats: string
  readonly feeEstimateOnly: false
}

export interface FundedPoolInputRenewalDisplay {
  status: 'idle' | 'needed' | 'preparing' | 'renewing' | 'recovery'
  error: string | null
  intentId: string | null
}
