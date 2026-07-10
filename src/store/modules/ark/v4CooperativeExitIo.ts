/**
 * v0.4 COOPERATIVE EXIT — the LIVE edge (SDK unroll / esplora / house co-sign).
 *
 * `makeCooperativeExitIo` binds the pure `stepCooperativeExit` orchestration (see
 * v4CooperativeExit.ts) to the real SDK primitives, so `runAutoClaim` can drive the
 * emulator-free on-chain recovery one non-blocking step per tick. The MECHANISM
 * (Unroll.Session → leaf-7 `cooperativeSpendExit` spend) is proven end-to-end on
 * regtest by `packages/e2e/src/v4-cooperative-exit-probe.test.ts`; this adapts that
 * exact recipe into the injected `CooperativeExitIo` edge.
 *
 * ⚠️ LIVE-UNVERIFIED IN-BROWSER. The probe runs in Node with a background miner; the
 * MULTI-TICK browser stepping here (recreate the session each tick, advance one
 * UNROLL wave, break on WAIT so the browser never blocks on a confirmation) still
 * needs a live regtest/browser run to confirm. It is fail-safe BY CONSTRUCTION —
 * `stepCooperativeExit` never unrolls without a funded bumper, never proceeds while
 * unconfirmed, and never broadcasts before the exit CSV matures — so a glue bug
 * stalls the flow VISIBLY rather than moving funds wrongly. The two non-trivial bits
 * of glue logic (`potOnchainStatus` mapping + `unrollPot` stepping) are unit-tested
 * against mock providers in v4CooperativeExitIo.spec.ts; only the real-SDK runtime
 * integration is unverified here.
 */
import { base64 } from '@scure/base'
import {
  OnchainWallet, Unroll, Transaction,
  type Identity, type OnchainProvider, type IndexerProvider, type NetworkName,
} from '@arkade-os/sdk'
import {
  buildCooperativeExitRequest,
  type CooperativeExitIo,
  type CooperativeExitRequest,
} from './v4CooperativeExit'
import type { StashedV4Forfeit } from './v4ForfeitStash'

/**
 * On-chain fee (sats) the leaf-7 split-back tx pays; `buildCooperativeSpendExitTx`
 * splits it evenly between the two funders. A 1-in / 2-out P2TR tx is ~150 vB; this
 * is a conservative flat budget. TODO(live): derive from a real fee-rate estimate
 * (the probe used 500 on a quiet regtest).
 */
export const V4_EXIT_FEE_SATS = 1000

/**
 * Minimum spendable balance (sats) the on-chain bumper wallet must hold before the
 * unroll starts — it CPFPs each unroll anchor (1C1P) from mainchain sats, and the
 * pot's tx chain is a few levels deep. A conservative floor; the exact need depends
 * on the tree depth + fee rate. TODO(live): size against the real chain + fee rate
 * (the probe funded 0.002 BTC = 200_000 sats, deliberately generous).
 */
export const V4_EXIT_BUMPER_MIN_SATS = 20_000

/** Everything the live cooperative-exit edge needs, from a connected wallet + a v4 stash. */
export interface CooperativeExitIoDeps {
  /** The player's identity — signs the leaf-7 input + owns the on-chain bumper. */
  identity: Identity
  /** On-chain provider (the connected wallet's) — bumper CPFP, tx status, broadcast. */
  explorer: OnchainProvider
  /** Ark indexer — `Unroll.Session` loads the pot's tx chain from it. */
  indexer: IndexerProvider
  /** Bitcoin network — for the bumper's on-chain (mainchain) wallet. */
  network: NetworkName
  /** The game whose pot is being exited (for the house co-sign endpoint). */
  gameId: string
  /** The stalled pot: covenant params + its on-chain outpoint (same txid:vout as the
   *  co-fund, landed on-chain by the unroll). */
  stash: Pick<StashedV4Forfeit, 'covenant' | 'potOutpoint'>
  /** On-chain fee (sats) the leaf-7 split-back tx pays. */
  exitFeeSats: number
  /** House co-sign: POST /api/v4/game/:id/cooperative-exit → the co-signed exit PSBT. */
  cosign: (gameId: string, req: CooperativeExitRequest) => Promise<{ exitTxPsbt: string }>
}

/**
 * Build the injected live edge for `stepCooperativeExit`. Each method is a thin,
 * faithful adaptation of the proven probe; the orchestration + all money gating stays
 * in the pure state machine.
 */
export function makeCooperativeExitIo(deps: CooperativeExitIoDeps): CooperativeExitIo {
  const { identity, explorer, indexer, network, gameId, stash, exitFeeSats, cosign } = deps
  // Memoise the on-chain bumper (derives a P2TR from the identity) — reused by the
  // balance read AND the unroll's anchor CPFP.
  let bumperP: Promise<OnchainWallet> | null = null
  const getBumper = () => (bumperP ??= OnchainWallet.create(identity, network, explorer))
  const potOutpoint = { txid: stash.potOutpoint.txid, vout: stash.potOutpoint.vout }

  return {
    async bumperBalanceSats() {
      return (await getBumper()).getBalance()
    },

    async potOnchainStatus() {
      // Map the provider to the step machine's null / confirmed contract, treating
      // "not yet on-chain" (BOTH not-broadcast AND in-mempool) as null so the machine
      // (re)drives the idempotent unroll, and a confirmed status only once mined.
      // NB: EsploraProvider.getTxStatus THROWS (404) for a txid esplora has never seen
      // — i.e. the pot tx BEFORE the unroll broadcasts it — and only resolves
      // {confirmed:false} once the tx is in the mempool. Catch the throw as null (not
      // yet broadcast); without this the very first tick that reaches here stalls the
      // whole flow, never calling unrollPot. The SDK's own Unroll.Session.next wraps
      // this same call in try/catch for exactly this reason.
      let st: Awaited<ReturnType<OnchainProvider['getTxStatus']>>
      try {
        st = await explorer.getTxStatus(potOutpoint.txid)
      } catch {
        return null
      }
      // blockTime is the confirming block's time — the basis the exit CSV (relative,
      // seconds) is measured from.
      return st.confirmed ? { confirmed: true, confirmedAt: st.blockTime } : null
    },

    async unrollPot() {
      // Advance the unroll AT MOST one broadcast-wave per tick, never blocking on a
      // confirmation: create a session (re-reads the chain, skips already-on-chain
      // txs), broadcast each ready UNROLL step, and STOP at the first WAIT (its tx is
      // in mempool — a later tick resumes once it confirms) or DONE. Idempotent: safe
      // to call every 'unrolling' tick (a no-op once the wave is in mempool).
      let session: Unroll.Session
      try {
        session = await Unroll.Session.create(potOutpoint, await getBumper(), explorer, indexer)
      } catch {
        // The pot VTXO may not be indexed yet (the chain load 500s) — retry next tick.
        return
      }
      for (;;) {
        const step = await session.next()
        if (step.type === Unroll.StepType.DONE || step.type === Unroll.StepType.WAIT) return
        await step.do() // UNROLL: broadcast this 1C1P package, then continue the wave
      }
    },

    async chainTime() {
      return (await explorer.getChainTip()).time
    },

    buildRequest() {
      return buildCooperativeExitRequest({
        stash,
        feeSats: BigInt(exitFeeSats),
        signInput0: (tx) => identity.sign(tx, [0]),
      })
    },

    async houseCosign(req) {
      return (await cosign(gameId, req)).exitTxPsbt
    },

    async broadcast(cosignedPsbt) {
      const tx = Transaction.fromPSBT(base64.decode(cosignedPsbt))
      tx.finalize()
      return explorer.broadcastTransaction(tx.hex)
    },
  }
}
