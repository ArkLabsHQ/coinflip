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
  CoinflipSetupScript,
  CoinflipFinalScript,
  type CoinflipSetupOptions,
  type CoinflipFinalOptions,
} from './script'

// Transaction building
export {
  getSetupScript,
  getFinalScript,
  getSetupAddress,
  getFinalAddress,
  getPotAmount,
  buildGameTransactions,
  determineWinner,
  generateSecret,
  addConditionWitness,
  getConditionWitness,
} from './transactions'

// Coin selection
export { coinSelect } from './coinselect'
