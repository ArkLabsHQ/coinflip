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

// Version-neutral game math — CSPRNG + winner/roll, relocated out of the
// v2/v3 tx modules so v4 keeps a stable import. See game-math.ts.
export { randomUniformInt, determineWinnerV3, computeRollV3 } from './game-math'

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

// Arkade-script forfeit support — see arkade-forfeit.ts module header.
export {
  arkadeScriptHash,
  computeArkadeScriptPublicKey,
  buildForfeitArkadeScript,
  encodeEmulatorWitness,
  encodeOutputIndexWitness,
  addEmulatorPacket,
} from './arkade-forfeit'

// Arkade-script win-condition — see arkade-win.ts module header.
export {
  buildVariableOddsWinPredicate,
  commitDigit,
  digitHash,
  type DigitCommit,
} from './arkade-win'

// v4 artifact-JSON covenant fragments — asm-token templates that reproduce
// the v4 covenant bytecode for the SDK's artifact model (ts-sdk PR #319).
// See artifact/covenants.ts module header.
export {
  payToAsm,
  winPredicateAsm,
  fullWinAsm,
  splitAsm,
} from './artifact/covenants'

// v4 joint-pot contract assembled from the artifact fragments — byte-identical
// drop-in for CoinflipJointPotScript. See artifact/joint-pot.ts module header.
export {
  buildJointPotArtifactContract,
  type JointPotArtifactContract,
  type JointPotArkadeScripts,
} from './artifact/joint-pot'

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
  buildCooperativeSpendExitTx,
  jointPotCofundOutputs,
  foldSubDustStake,
  encodeSettleForEmulator,
  serializeTapLeaf,
  deserializeTapLeaf,
  tapLeafHasKey,
  buildCofundFromPlay,
  type BuiltJointPotTx,
  type BuiltExitTx,
  type Outpoint,
  type SerializedTapLeaf,
  type SerializedHouseInput,
  type PlayResponseForCofund,
} from './joint-pot-tx'
