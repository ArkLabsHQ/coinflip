/**
 * Has chain time reached an absolute CLTV (CheckLockTimeVerify) lock?
 *
 * Both trustless recovery paths — the player's self-refund and the R1 forfeit —
 * are gated behind an absolute, unix-second CLTV baked into the escrow's leaves.
 * The client may only submit the recovery once the chain's median-time-past has
 * crossed that lock; submitting early is simply rejected by the network, but we
 * also don't want the UI to offer (or the auto-claim poll to fire) a claim that
 * can't land yet.
 *
 * Two things this centralises, both of which are easy to get subtly wrong when
 * hand-written at each call site (it was, in four places across the store and
 * the StalledBets component):
 *
 *   1. The UNKNOWN-TIP guard. `chainTime === null` means we haven't learned the
 *      chain tip yet — that is NOT "matured". We must default to false and wait,
 *      never optimistically assume the lock is open.
 *   2. The BOUNDARY. A CLTV lock opens AT its value, so the comparison is `>=`,
 *      not `>`. A tip exactly equal to the CLTV is mature. (An off-by-one here
 *      would either strand funds for a block or briefly offer an unspendable
 *      claim — neither catastrophic, but both wrong.)
 *
 * Pure; `chainTime` may legitimately be 0 (treated as a real value, not as the
 * null "unknown" sentinel).
 */
export function isCltvMatured(chainTime: number | null, cltvUnixSeconds: number): boolean {
  return chainTime !== null && chainTime >= cltvUnixSeconds
}
