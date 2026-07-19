/**
 * Helpers for verifying the HOUSE can actually co-sign a VTXO / checkpoint.
 *
 * A house VTXO is spent through a 2-of-2 forfeit leaf
 * `<house> OP_CHECKSIGVERIFY <arkServer> OP_CHECKSIG`. arkd (the operator) only
 * ever validates that ITS key is in that leaf — never the house's — yet at
 * `finalizeTx` it requires a valid signature for BOTH keys. So a house VTXO whose
 * forfeit leaf doesn't embed the CURRENT house key is un-co-signable: the house's
 * `identity.sign` finds no matching leaf ("No taproot scripts signed"), and arkd
 * then rejects the whole co-fund at finalize with a cryptic `INVALID_SIGNATURE (18)`
 * — surfaced to the player as an intermittent, unexplained flip failure.
 *
 * These pure helpers let the co-fund path (1) exclude such VTXOs from house-stake
 * selection and (2) fail loudly if one slips through, instead of forwarding a
 * checkpoint that's missing the mandatory house signature. Zero SDK / vuex deps so
 * they're unit-testable in isolation.
 */

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Index of the first occurrence of `needle` as a contiguous subsequence of `hay`,
 *  or -1. Inputs are tiny (a tapscript, a 32-byte key) so the naive scan is fine. */
function bytesIndexOf(hay: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > hay.length) return -1
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/**
 * True iff the 32-byte x-only `key` appears as a push inside the tapscript. The
 * argument is a leaf script WITH its trailing 1-byte leaf version (btc-signer's
 * `TapLeafScript[1]` shape), so drop that byte first. This mirrors how btc-signer
 * decides it can sign a script-path spend: it scans the leaf for the signer's key.
 */
export function xOnlyInTapscript(scriptWithVersion: Uint8Array | undefined, key: Uint8Array): boolean {
  if (!scriptWithVersion || scriptWithVersion.length === 0) return false
  return bytesIndexOf(scriptWithVersion.subarray(0, -1), key) >= 0
}

/** A VTXO exposing its forfeit leaf as btc-signer's `[controlBlock, scriptWithVersion]`. */
export interface ForfeitLeafVtxo {
  forfeitTapLeafScript: [unknown, Uint8Array]
}

/**
 * Split VTXOs into those the house can co-sign (its x-only key is in the forfeit
 * leaf) and those it can't. The latter must never be reserved for a co-fund — the
 * house can't produce the mandatory 2-of-2 signature, so arkd rejects the finalize.
 */
export function partitionHouseSignable<T extends ForfeitLeafVtxo>(
  vtxos: T[],
  houseXOnly: Uint8Array,
): { signable: T[]; unsignable: T[] } {
  const signable: T[] = []
  const unsignable: T[] = []
  for (const v of vtxos) {
    // Defensive: a VTXO with a missing/malformed forfeit leaf is treated as
    // unsignable (excluded) rather than throwing and breaking the whole selection.
    if (xOnlyInTapscript(v.forfeitTapLeafScript?.[1], houseXOnly)) signable.push(v)
    else unsignable.push(v)
  }
  return { signable, unsignable }
}

/** A parsed checkpoint input's taproot script-spend signatures (btc-signer shape). */
export type TapScriptSig = ReadonlyArray<readonly [{ pubKey: Uint8Array }, Uint8Array]>

/** True iff a signature for the house key is attached to the checkpoint input —
 *  i.e. `identity.sign` actually added the mandatory house co-signature. */
export function houseSigAttached(tapScriptSig: TapScriptSig | undefined, houseXOnly: Uint8Array): boolean {
  return (tapScriptSig ?? []).some(([k]) => bytesEqual(k.pubKey, houseXOnly))
}
