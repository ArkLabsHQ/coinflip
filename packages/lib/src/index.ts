/**
 * arkade-coinflip — Trustless coinflip betting protocol for Ark.
 *
 * A standalone, transport-agnostic library implementing a provably fair
 * coin flip game using Bitcoin Taproot scripts on the Ark protocol.
 */

// Core types
export {
  GameStatus,
  type Game,
  type GameEvent,
  type PlayerData,
  type VtxoRef,
  type VtxoInput,
  type CreateEvent,
  type JoinEvent,
  type SetupStartedEvent,
  type SetupFinalizedEvent,
  type FinalizeEvent,
  type ResolveEvent,
  type GameListing,
  type GameTransport,
} from './types'

// Event handling & state machine
export {
  gameFromEvents,
  isCreateEvent,
  isJoinEvent,
  isSetupStartedEvent,
  isSetupFinalizedEvent,
  isFinalizeEvent,
  isResolveEvent,
} from './events'

// Tapscript definitions
export {
  CoinflipEscrowScript,
  VARIABLE_ODDS_BASE_LEN,
  type CoinflipEscrowOptions,
} from './script'

// Transaction building
export {
  getPlayerEscrowScript,
  getHouseEscrowScript,
  getPlayerEscrowAddress,
  getHouseEscrowAddress,
  getHouseEscrowOptions,
  getPlayerEscrowOptions,
  getPotAmount,
  buildForfeitClaimTransaction,
  buildCovenantSweepTransaction,
  buildRefundTransaction,
  type EscrowInput,
  type ForfeitClaimArgs,
  type CovenantSweepArgs,
  type RefundArgs,
  determineWinner,
  generateSecret,
  generateRandomCoinSecret,
  randomUniformInt,
  determineVariableWinner,
  generateVariableSecret,
  computeVariableRoll,
  type BuiltOffchainTx,
} from './transactions'

// ConditionWitness PSBT-field helpers — split out of transactions.ts (crypto-free,
// so the browser bundle can import them via joint-pot-tx without Node `crypto`).
export { addConditionWitness, getConditionWitness } from './condition-witness'

// Coin selection — see `coinselect.ts` for the note on the SDK's
// internal `selectVirtualCoins` and why we keep our own greedy variant.
export { coinSelect } from './coinselect'

// Re-export the SDK's global contract registry so consumers that resolve
// the lib via npm workspaces get the same singleton — avoids
// dueling-instance issues when the SDK ends up installed in multiple
// package node_modules trees.
export { contractHandlers } from '@arkade-os/sdk'

// Coinflip escrow registered as a first-class SDK contract type — lets the
// ContractManager/ContractWatcher track each game's escrow and emit
// vtxo_received / vtxo_spent events.
export {
  COINFLIP_ESCROW_TYPE,
  CoinflipEscrowContractHandler,
  COINFLIP_ESCROW_V3_TYPE,
  CoinflipEscrowV3ContractHandler,
  registerCoinflipContracts,
  type CoinflipContractRegistry,
} from './contract'

// Arkade-script forfeit support — see arkade-forfeit.ts module header.
export {
  ARKADE_OP,
  arkadeScriptHash,
  computeArkadeScriptPublicKey,
  buildForfeitArkadeScript,
  buildSplitArkadeScript,
  buildForfeitLeafSpec,
  type ForfeitLeafSpec,
  encodeEmulatorWitness,
  encodeOutputIndexWitness,
  addEmulatorPacket,
} from './arkade-forfeit'

// Arkade-script win-condition (v0.3) — see arkade-win.ts module header.
export {
  buildVariableOddsWinPredicate,
  buildVariableOddsWinArkadeScript,
  commitDigit,
  digitHash,
  type DigitCommit,
} from './arkade-win'

// v0.3 escrow taptree — see script-v3.ts module header.
export {
  CoinflipEscrowScriptV3,
  type CoinflipEscrowOptionsV3,
} from './script-v3'

// v0.4 joint-pot taptree — see joint-pot.ts module header.
export {
  CoinflipJointPotScript,
  type CoinflipJointPotOptions,
} from './joint-pot'

// v0.4 Phase 2 staged-forfeit StageTwo taptree — see joint-pot-stage2.ts header.
export {
  StageTwoScript,
  type StageTwoOptions,
} from './joint-pot-stage2'

// v0.4 joint-pot tx builders (co-fund + settle) — see joint-pot-tx.ts header.
export {
  buildJointPotCofundTx,
  buildJointPotSettleTx,
  buildPlayerRevealTx,
  buildStageTwoSettleTx,
  buildStageTwoTakeAllTx,
  buildJointPotRefundTx,
  jointPotCofundOutputs,
  encodeSettleForEmulator,
  serializeTapLeaf,
  deserializeTapLeaf,
  buildCofundFromPlay,
  type BuiltJointPotTx,
  type Outpoint,
  type SerializedTapLeaf,
  type SerializedHouseInput,
  type PlayResponseForCofund,
} from './joint-pot-tx'

// v0.3 transaction-building helpers — see transactions-v3.ts module header.
export {
  getPlayerEscrowScriptV3,
  getHouseEscrowScriptV3,
  getPlayerEscrowAddressV3,
  getHouseEscrowAddressV3,
  getPlayerEscrowOptionsV3,
  getHouseEscrowOptionsV3,
  buildCovenantSweepTransactionV3,
  buildRefundTransactionV3,
  buildForfeitClaimTransactionV3,
  determineWinnerV3,
  computeRollV3,
  type EscrowInputV3,
  type CovenantSweepArgsV3,
  type RefundArgsV3,
  type ForfeitClaimArgsV3,
} from './transactions-v3'
