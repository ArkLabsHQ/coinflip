/** Current joint-pot contract terms and durable handshake state. Hex encodes keys/scripts. */
import type { SerializedHouseInput } from './joint-pot-tx'

export interface V4CovenantParams {
  creatorPubkey: string // house, x-only hex
  playerPubkey: string
  serverPubkey: string
  creatorHash: string
  playerHash: string
  finalExpiration: number
  cancelDelay: number
  exitDelay: number
  oddsN: number
  oddsTarget: number
  oddsLo: number
  emulatorPubkey: string
  playerPayoutPkScript: string // hex
  housePayoutPkScript: string // hex
  playerStake: number
  houseStake: number
}

export interface V4State {
  protocolVersion: 'v4'
  finalExpiration: number
  setupExpiration: number
  oddsN: number
  oddsTarget: number
  oddsLo: number
  exitDelay: number
  pot: number
  houseStake: number
  potAddress: string
  /** The reserved house stake inputs (the trailing co-fund inputs). */
  houseInputs: SerializedHouseInput[]
  covenant: V4CovenantParams
  /** Set by /cofund: the submitted arkTx id + the house-signed checkpoints (one
   *  per house input, in vin order), base64. */
  /** Durable intent, committed before broadcasting. Ambiguous failures retain the input holds. */
  cofundSubmission?: { txid: string; startedAt: number }
  cofundArkTxid?: string
  houseSignedCheckpoints?: string[]
  /** Player input count (the leading k vins), set by /cofund so /cofund-finalize
   *  can reject a wrong number of player checkpoints early. */
  playerInputCount?: number
  /** Set by /cofund-finalize: the on-chain co-fund txid (== the pot VTXO txid). */
  cofundTxid?: string
  settleTxid?: string
  refundTxid?: string
}
