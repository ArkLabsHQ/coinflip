/**
 * v4 joint-pot game — server side (barrel).
 *
 * v4 replaces v3's two per-party escrows + lazy house funding with ONE joint-pot
 * VTXO funded by an atomic two-party co-fund, settled in 2 on-chain txs. The
 * protocol + tx-builders are proven (v4-game-probe, v4-scale, lib/joint-pot-tx).
 *
 * The implementation is split across ./v4/* for maintainability; this module is a
 * thin barrel that re-exports the same public surface it always has, so existing
 * `import { … } from './trustless-game-v4.js'` consumers keep working unchanged:
 *   - ./v4/play      — handleV4Play (reserve stake, derive covenant, persist) +
 *                      the protocol-version / roll helpers.
 *   - ./v4/cofund    — handleV4Cofund / handleV4CofundFinalize (the 2-round co-fund).
 *   - ./v4/reveal    — handleV4Reveal (settle to the winner) + handleV4CooperativeExit.
 *   - ./v4/reconcile — broadcastV4Refund / settleV4StageTwo + their reconcilers and
 *                      the periodic startV4RefundTimer.
 *   - ./v4/types, ./v4/concurrency, ./v4/shared — data shapes + shared primitives.
 */

export { computeGameRoll, newGameProtocolVersion, handleV4Play } from './v4/play.js'
export { handleV4Cofund, handleV4CofundFinalize } from './v4/cofund.js'
export { handleV4Reveal, handleV4CooperativeExit } from './v4/reveal.js'
export {
  broadcastV4Refund,
  reconcileV4Refunds,
  settleV4StageTwo,
  reconcileV4StageTwo,
  startV4RefundTimer,
} from './v4/reconcile.js'
export type {
  V4PlayRequest,
  V4PlayResult,
  V4CovenantParams,
  V4State,
  V4CofundRequest,
  V4CofundResult,
  V4CofundFinalizeRequest,
  V4CofundFinalizeResult,
  V4RevealRequest,
  V4RevealResult,
  V4CooperativeExitRequest,
  V4CooperativeExitResult,
} from './v4/types.js'
