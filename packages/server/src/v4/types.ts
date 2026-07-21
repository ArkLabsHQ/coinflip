/**
 * v4 joint-pot game — request/response + persisted-state shapes.
 *
 * The data shapes for the co-fund handshake and reveal/settle endpoints, plus the
 * per-game state persisted on the game row. Split out of trustless-game-v4.ts so
 * the handler/reconcile modules share one source of truth for these types.
 */

import type { SerializedHouseInput } from 'arkade-coinflip'

export interface V4PlayRequest {
  tier: number
  /** x-only pubkey hex (32 bytes). */
  playerPubkey: string
  /** sha256 commitment to the player's reveal, hex. */
  playerHash: string
  /** Ark address the pot pays to if the PLAYER wins. */
  playerPayoutAddress: string
  /** Ark address for the player's co-fund change. */
  playerChangeAddress: string
  oddsN?: number
  oddsTarget?: number
  oddsLo?: number
  /** Sub-dust top-up (sats) the client folds into its stake: when the player's
   *  selected VTXOs would leave a change ≤ dust, staking that remainder keeps the
   *  co-fund balanced (a dust output can't exist). Validated 0 < topUp ≤ dust. */
  stakeTopUp?: number
}

/** Covenant params the client re-derives the identical CoinflipJointPotScript from. */
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

export interface V4PlayResult {
  gameId: string
  potAddress: string
  /** bech32m HRP the server encoded potAddress with — the client re-derives + parses with it. */
  networkHrp: string
  pot: number
  betAmount: number
  houseStake: number
  /** The house's RESERVED stake inputs (one or many, summing to ≥ houseStake) —
   *  the TRAILING inputs of the co-fund. Each carries its forfeit leaf + tapTree
   *  so the client assembles them with no server-side VTXO access. */
  houseInputs: SerializedHouseInput[]
  housePubkey: string
  houseHash: string
  serverPubkey: string
  emulatorPubkey: string
  finalExpiration: number
  oddsN: number
  oddsTarget: number
  oddsLo: number
  covenant: V4CovenantParams
}

/** v4 per-game state persisted on the game row (house_vtxos_json). */
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
  cofundArkTxid?: string
  houseSignedCheckpoints?: string[]
  /** Player input count (the leading k vins), set by /cofund so /cofund-finalize
   *  can reject a wrong number of player checkpoints early. */
  playerInputCount?: number
  /** Set by /cofund-finalize: the on-chain co-fund txid (== the pot VTXO txid). */
  cofundTxid?: string
}

export interface V4CofundRequest {
  /** The co-fund arkTx (player-signed input vin 0), base64 PSBT. */
  arkTx: string
  /** The co-fund checkpoints (one per input), base64 PSBTs. */
  checkpoints: string[]
}
export interface V4CofundResult {
  arkTxid: string
  /** The player's checkpoints (the LEADING k inputs) for the client to sign, base64. */
  playerCheckpoints: string[]
}

export interface V4CofundFinalizeRequest {
  /** The player's checkpoints (the leading k inputs), now player-signed, base64. */
  playerCheckpoints: string[]
}
export interface V4CofundFinalizeResult {
  cofundTxid: string
  potOutpoint: { txid: string; vout: number; value: number }
}

export interface V4CooperativeExitRequest {
  /** The client's player-signed leaf-7 (cooperativeSpendExit) split-back PSBT, base64. */
  exitTxPsbt: string
  /** The UNROLLED pot UTXO's on-chain outpoint (the client unrolled it via SDK Unroll). */
  potOnchain: { txid: string; vout: number; value: number }
  /** The on-chain fee the split-back pays (must match the client's build). */
  feeSats: number
}
export interface V4CooperativeExitResult {
  /** The exit PSBT co-signed by the house (creator) — the client finalizes + broadcasts. */
  exitTxPsbt: string
}

export interface V4RevealRequest {
  /** The player's reveal bytes (`[digit] || salt`, = packets.encodeReveal), hex. */
  playerSecretHex: string
}
export interface V4RevealResult {
  winner: 'player' | 'house'
  settleTxid: string
  payout: number
  /** Now-public house reveal. */
  houseSecretHex: string
  /** Rolled value (digitC + digitP) mod n, or null on a cheat-penalty. */
  roll: number | null
}
