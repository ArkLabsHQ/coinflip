// ---------------------------------------------------------------------------
// locateEscrowVtxo — resolve the player's escrow OUTPOINT after funding it.
//
// `wallet.send({ address: escrow, amount })` returns only a TXID, but the rest
// of the trustless flow (/refund, /commit, /forfeit) needs the full outpoint
// {txid, vout, value} of OUR escrow output. Two facts make that non-trivial:
//
//   1. The SDK's send transaction also carries anchor + metadata outputs in
//      arbitrary positions, so our escrow's `vout` is NOT guaranteed to be 0.
//      We identify it by (txid, value) and read back whatever vout it landed at.
//   2. The Ark indexer is eventually consistent — the VTXO may not be queryable
//      the instant `send` resolves — so we poll briefly, treating transient
//      query errors as retries, until it appears or a deadline passes.
//
// Pulled out of the play action so the matching + poll/timeout logic is testable
// with a fake querier (see locateEscrow.spec.ts) instead of a live regtest.
// ---------------------------------------------------------------------------

/** The slice of the SDK indexer this lookup needs — narrowed for testability. */
export interface VtxoQuerier {
  getVtxos(args: { scripts: string[] }): Promise<{ vtxos: { txid: string; vout: number; value: number }[] }>
}

export interface LocateEscrowOptions {
  /** Hex pkScript of the escrow address (the script we query the indexer by). */
  escrowPkHex: string
  /** TXID returned by `wallet.send` — the tx that funded the escrow. */
  txid: string
  /** Exact escrow amount (sats); disambiguates our output from anchors/change. */
  amount: number
  /** Give-up deadline. Default 10s — comfortably covers indexer lag on regtest. */
  timeoutMs?: number
  /** Delay between polls. Default 250ms. */
  pollMs?: number
}

/**
 * Poll the indexer until the escrow VTXO funded by `txid` (with value `amount`)
 * is visible, then return its outpoint. Throws once `timeoutMs` elapses without
 * a match. Transient indexer errors are swallowed and retried.
 */
export async function locateEscrowVtxo(
  indexer: VtxoQuerier,
  opts: LocateEscrowOptions,
): Promise<{ txid: string; vout: number; value: number }> {
  const { escrowPkHex, txid, amount, timeoutMs = 10_000, pollMs = 250 } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const { vtxos } = await indexer.getVtxos({ scripts: [escrowPkHex] })
      // Match on (txid, value): the funding tx plus the exact stake pins OUR
      // output even when anchor/metadata outputs share the txid.
      const hit = vtxos.find((v) => v.txid === txid && v.value === amount)
      if (hit) return { txid: hit.txid, vout: hit.vout, value: hit.value }
    } catch {
      /* transient indexer hiccup — fall through and retry until the deadline */
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(
    `Could not locate player escrow VTXO in tx ${txid} after ${Math.round(timeoutMs / 1000)}s`,
  )
}
