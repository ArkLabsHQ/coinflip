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
  addConditionWitness,
  getConditionWitness,
  type BuiltOffchainTx,
} from './transactions'

// Coin selection — see `coinselect.ts` for the note on the SDK's
// internal `selectVirtualCoins` and why we keep our own greedy variant.
export { coinSelect } from './coinselect'

// Re-export the SDK's global contract registry so consumers that resolve
// the lib via npm workspaces get the same singleton — avoids
// dueling-instance issues when the SDK ends up installed in multiple
// package node_modules trees.
export { contractHandlers } from '@arkade-os/sdk'

// Arkade-script forfeit support — see arkade-forfeit.ts module header.
export {
  ARKADE_OP,
  arkadeScriptHash,
  computeArkadeScriptPublicKey,
  buildForfeitArkadeScript,
  buildForfeitLeafSpec,
  type ForfeitLeafSpec,
  encodeEmulatorWitness,
  encodeOutputIndexWitness,
  addEmulatorPacket,
} from './arkade-forfeit'
