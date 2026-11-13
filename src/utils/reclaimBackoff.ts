/** Repeated permanent self-refund refusals pause submission until recovery is available. */
export const MAX_RECLAIM_ATTEMPTS = 3

export function hasExhaustedReclaim(claimFailures: number | undefined): boolean {
  return (claimFailures ?? 0) >= MAX_RECLAIM_ATTEMPTS
}
