/**
 * v0.4 COOPERATIVE EXIT — the client's half of the emulator-free on-chain
 * recovery. When the emulator is unreachable after the pot is co-funded, the
 * player unrolls the pot on-chain (SDK `Unroll`) and spends the leaf-7
 * `cooperativeSpendExit` split-back, co-signed by the house via
 * `POST /api/v4/game/:id/cooperative-exit`.
 *
 * This module isolates the SECURITY-CRITICAL, deterministic part — building the
 * exact split-back the house will co-sign — so a unit test can assert it against
 * a fixture covenant without the SDK wallet / Unroll / network. The unroll +
 * broadcast integration is the caller's (ark.ts): it needs the live on-chain
 * wallet (an OnchainWallet fee source to bump the unroll anchors) + the chain,
 * and its end-to-end path is verified by the v4-cooperative-exit probe.
 *
 * Mirrors v4SelfRefund.ts's structure (pure core + injected signer).
 */
import { hex, base64 } from '@scure/base'
import { Transaction } from '@arkade-os/sdk'
import { buildCooperativeSpendExitTx } from 'arkade-coinflip/dist/joint-pot-tx'
import { rebuildJointPot } from './v4SelfRefund'
import type { StashedV4Forfeit, V4PotOutpoint } from './v4ForfeitStash'

/** The request body for POST /api/v4/game/:id/cooperative-exit. */
export interface CooperativeExitRequest {
  exitTxPsbt: string
  potOnchain: V4PotOutpoint
  feeSats: number
}

/**
 * Build the player-signed leaf-7 split-back for a stash's UNROLLED pot, ready for
 * the house co-sign endpoint. Mirrors the server's expected build EXACTLY (same
 * `buildCooperativeSpendExitTx` inputs from the same covenant), so the house's
 * fail-closed shape check passes. `signInput0` injects the player signature (the
 * wallet's identity in prod, a fixture key in tests); everything else is
 * deterministic from the stash. The stash's `potOutpoint` is the pot's on-chain
 * outpoint after the unroll (same txid:vout as the co-fund, now confirmed).
 */
export async function buildCooperativeExitRequest(args: {
  stash: Pick<StashedV4Forfeit, 'covenant' | 'potOutpoint'>
  feeSats: bigint
  signInput0: (tx: Transaction) => Promise<Transaction>
}): Promise<CooperativeExitRequest> {
  const cv = args.stash.covenant
  const potOnchain = args.stash.potOutpoint
  const pot = rebuildJointPot(cv)
  const { tx } = buildCooperativeSpendExitTx({
    pot,
    potOnchain: { txid: potOnchain.txid, vout: potOnchain.vout, value: potOnchain.value },
    playerStake: BigInt(cv.playerStake),
    houseStake: BigInt(cv.houseStake),
    playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
    housePayoutPkScript: hex.decode(cv.housePayoutPkScript),
    exitDelay: BigInt(cv.exitDelay),
    feeSats: args.feeSats,
  })
  const signed = await args.signInput0(tx)
  return {
    exitTxPsbt: base64.encode(signed.toPSBT()),
    potOnchain: { txid: potOnchain.txid, vout: potOnchain.vout, value: potOnchain.value },
    feeSats: Number(args.feeSats),
  }
}

/** Progress of the multi-tick cooperative-exit flow (persisted so it resumes). */
export type CooperativeExitStage =
  | 'needs-fee' // the on-chain bumper wallet must be funded before the unroll can CPFP the anchors
  | 'unrolling' // unroll broadcast in flight / awaiting on-chain confirmation
  | 'awaiting-csv' // pot confirmed on-chain; waiting for the exit CSV to mature
  | 'done' // exit tx broadcast

export interface CooperativeExitProgress {
  stage: CooperativeExitStage
  /** Human detail for the UI (fee needed, time remaining, the exit txid). */
  detail?: string
  /** Set once stage === 'done'. */
  exitTxid?: string
}

/**
 * The thin, injected LIVE edge (SDK unroll / esplora / api). Isolated behind an
 * interface so `stepCooperativeExit`'s orchestration is fully unit-testable; the
 * underlying mechanism (unroll → leaf-7 spend) is validated by the
 * v4-cooperative-exit probe.
 */
export interface CooperativeExitIo {
  /** Spendable on-chain (mainchain) sats of the unroll fee-bumper wallet. */
  bumperBalanceSats(): Promise<number>
  /** The pot VTXO's on-chain status after (attempting) an unroll: null = not yet
   *  on-chain; else confirmed + the time (unix seconds) it confirmed at. */
  potOnchainStatus(): Promise<{ confirmed: boolean; confirmedAt: number } | null>
  /** Start / continue the SDK unroll of the pot (idempotent per call). */
  unrollPot(): Promise<void>
  /** Chain median-time-past (unix seconds), for the CSV gate. */
  chainTime(): Promise<number>
  /** Build the player-signed leaf-7 request (buildCooperativeExitRequest bound to the wallet). */
  buildRequest(): Promise<CooperativeExitRequest>
  /** House co-signs the request (api.v4CooperativeExit) → the co-signed PSBT. */
  houseCosign(req: CooperativeExitRequest): Promise<string>
  /** Finalize + broadcast the co-signed PSBT → the on-chain txid. */
  broadcast(cosignedPsbt: string): Promise<string>
}

/**
 * One tick of the cooperative-exit state machine. Drive it from runAutoClaim,
 * persist the returned stage, resume next tick. Advances at most one on-chain
 * step per tick and NEVER proceeds without the fee source AND a matured CSV —
 * fail-safe like the rest of the recovery. Pure orchestration over `io`, so it's
 * fully unit-testable; `io` is the thin, probe-validated live edge.
 *
 * The exit CSV is relative to the pot's ON-CHAIN confirmation, so it's gated on
 * `confirmedAt + exitDelaySeconds` against the chain's MTP — not the wall clock.
 */
export async function stepCooperativeExit(args: {
  exitDelaySeconds: number
  minFeeSats: number
  io: CooperativeExitIo
}): Promise<CooperativeExitProgress> {
  const { io, minFeeSats, exitDelaySeconds } = args
  // 1. Fee source: the unroll must CPFP the tree anchors from mainchain sats.
  if ((await io.bumperBalanceSats()) < minFeeSats) {
    return { stage: 'needs-fee', detail: `Fund the on-chain exit-fee address (~${minFeeSats} sats needed).` }
  }
  // 2. Land the pot on-chain (idempotent unroll; wait for confirmation).
  const onchain = await io.potOnchainStatus()
  if (!onchain) {
    await io.unrollPot()
    return { stage: 'unrolling', detail: 'Broadcasting the unilateral exit…' }
  }
  if (!onchain.confirmed) return { stage: 'unrolling', detail: 'Waiting for the unroll to confirm…' }
  // 3. Wait the exit CSV (relative to the pot's on-chain confirmation, MTP-gated).
  const matureAt = onchain.confirmedAt + exitDelaySeconds
  const now = await io.chainTime()
  if (now < matureAt) {
    const mins = Math.max(1, Math.ceil((matureAt - now) / 60))
    return { stage: 'awaiting-csv', detail: `Exit timelock matures in ~${mins} min (chain time).` }
  }
  // 4. Build → house co-sign → broadcast. Only reached with funds + a matured CSV.
  const req = await io.buildRequest()
  const cosigned = await io.houseCosign(req)
  const exitTxid = await io.broadcast(cosigned)
  return { stage: 'done', detail: exitTxid, exitTxid }
}
