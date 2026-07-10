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
