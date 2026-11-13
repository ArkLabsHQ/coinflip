import { getErrorMessage } from '@/utils/errors'
import { getNetwork, type V4CovenantParams, type GameSummary, type V4ReclaimHint } from '@/services/api'
import { resolveV4ForfeitStash, type V4PotOutpoint } from './v4ForfeitStash'
import { putV4Forfeit, loadV4Forfeits } from './v4ForfeitStashStore'
import { pickV4ClaimPath, rearmV4ReclaimHint } from './v4SelfRefund'
import { addressToPkScriptHex } from './arkHelpers'

/** Persist recovery before submitting funding; refusing storage must refuse the bet. */
export async function stashV4ForfeitRecovery(args: {
  gameId: string
  tier: number
  potOutpoint: V4PotOutpoint
  covenant: V4CovenantParams
  expectedPayoutPkScriptHex: string
  playerSecretHex: string
  emulatorUrl: string | undefined
}): Promise<void> {
  const decision = resolveV4ForfeitStash({
    emulatorUrl: args.emulatorUrl,
    potOutpoint: args.potOutpoint,
    covenant: args.covenant,
    expectedPayoutPkScriptHex: args.expectedPayoutPkScriptHex,
    playerSecretHex: args.playerSecretHex,
  })
  if (decision.kind !== 'stash') throw new Error(`Recovery refused: ${decision.reason}`)
  await putV4Forfeit({
    ...decision.patch,
    gameId: args.gameId,
    tier: args.tier,
    createdAt: Date.now(),
  })
}

/**
 * Actionable-restore re-arm: for each PENDING v4 reclaim hint, persist a no-secret
 * SELF-REFUND stash so StalledBets + auto-claim can reclaim the player's own stake.
 *
 * Pure decision in `rearmV4ReclaimHint` (unit-tested); this wrapper is the network/
 * storage glue. Best-effort and idempotent:
 *  - skips a hint we already hold as a FUNDED (secret-bearing) stash — that one can
 *    sweep the WHOLE pot, so a no-secret restore must never downgrade it;
 *  - refreshes an existing no-secret stash in place (covenant/outpoint may have moved
 *    from null→known since a pre-co-fund restore);
 *  - never throws: a re-arm failure must not break the history return, and the
 *    server's own refund timer remains the backstop.
 */
export async function rearmV4ReclaimHints(
  hints: V4ReclaimHint[],
  games: GameSummary[],
  arkAddress: string | null,
): Promise<void> {
  if (!arkAddress) {
    console.info(`[restore] ${hints.length} v4 reclaim hint(s) returned, but the wallet isn't connected yet — re-arm deferred to a post-connect restore.`)
    return
  }
  let emulatorUrl: string | undefined
  try {
    emulatorUrl = (await getNetwork()).emulator?.url
  } catch (e) {
    console.warn('[restore] could not reach /api/network for the emulator URL (continuing):', getErrorMessage(e))
  }
  let expectedPayout: string
  try {
    expectedPayout = addressToPkScriptHex(arkAddress)
  } catch (e) {
    console.warn('[restore] could not derive payout pkScript — skipping v4 re-arm:', getErrorMessage(e))
    return
  }
  const statusById = new Map(games.map((g) => [g.gameId, g.status]))
  const existing = await loadV4Forfeits()
  let rearmed = 0
  for (const hint of hints) {
    // Never downgrade a funded (secret-bearing) stash to a no-secret restore.
    const prior = existing.find((s) => s.gameId === hint.gameId)
    if (prior && pickV4ClaimPath(prior) === 'forfeit') continue
    const decision = rearmV4ReclaimHint({
      hint,
      status: statusById.get(hint.gameId) ?? 'pending',
      expectedPayoutPkScriptHex: expectedPayout,
      fallbackEmulatorUrl: emulatorUrl,
    })
    if (decision.kind !== 'rearm') {
      console.info(`[restore] v4 hint ${hint.gameId} not re-armed (${decision.reason})`)
      continue
    }
    try {
      // Preserve an existing no-secret stash's stage/backoff bookkeeping across a
      // re-restore (a fresh putV4Forfeit would otherwise reset claimFailures).
      await putV4Forfeit(prior ? { ...decision.stash, claimFailures: prior.claimFailures, lastClaimError: prior.lastClaimError } : decision.stash)
      rearmed++
    } catch (e) {
      console.error(`[restore] could not persist re-armed self-refund for ${hint.gameId} (continuing):`, getErrorMessage(e))
    }
  }
  console.info(`[restore] re-armed ${rearmed}/${hints.length} pending v4 reclaim hint(s) as self-refund stashes.`)
}
