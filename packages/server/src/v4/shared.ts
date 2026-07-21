/**
 * v4 shared helpers — stateless utilities used across the play / cofund / reveal /
 * reconcile modules: x-only key coercion, covenant reconstruction, and the two
 * game-row loaders. Kept in one leaf module so the handler modules don't have to
 * cross-import each other.
 */

import { hex } from '@scure/base'
import { CoinflipJointPotScript } from 'arkade-coinflip'
import type { AppDeps } from '../deps.js'
import type { V4State, V4CovenantParams } from './types.js'

export const toXOnly = (b: Uint8Array): Uint8Array => (b.length === 33 ? b.slice(1) : b)

/** Reconstruct the joint-pot covenant from the persisted (hex) params. */
export function rebuildCovenant(cv: V4CovenantParams): CoinflipJointPotScript {
  return new CoinflipJointPotScript({
    creatorPubkey: hex.decode(cv.creatorPubkey),
    playerPubkey: hex.decode(cv.playerPubkey),
    serverPubkey: hex.decode(cv.serverPubkey),
    creatorHash: hex.decode(cv.creatorHash),
    playerHash: hex.decode(cv.playerHash),
    finalExpiration: BigInt(cv.finalExpiration),
    cancelDelay: BigInt(cv.cancelDelay),
    exitDelay: BigInt(cv.exitDelay),
    oddsN: cv.oddsN, oddsTarget: cv.oddsTarget, oddsLo: cv.oddsLo,
    emulatorPubkey: hex.decode(cv.emulatorPubkey),
    playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
    housePayoutPkScript: hex.decode(cv.housePayoutPkScript),
    playerStake: BigInt(cv.playerStake), houseStake: BigInt(cv.houseStake),
  })
}

export async function loadV4Game(deps: AppDeps, gameId: string): Promise<{ state: V4State; status: string }> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error('Game not found')
  const state = JSON.parse(game.house_vtxos_json || '{}') as V4State
  if (state.protocolVersion !== 'v4') throw new Error('Not a v4 game')
  return { state, status: game.status }
}

/**
 * All co-funded v4 games still awaiting resolution. Scans 'pending' AND 'expired':
 * post-fix a co-funded game never becomes 'expired' (isCofundedGame guards
 * expirePending), but this recovers any that were stranded in 'expired' by the old
 * expiry dead-zone — the reconcilers must still refund/settle their live pots, else a
 * stalling player could sweep the whole pot via playerTakeAll.
 */
export async function listUnresolvedCofundedV4(deps: AppDeps) {
  const [pending, expired] = await Promise.all([
    deps.repos.games.list({ status: 'pending', limit: 500 }),
    deps.repos.games.list({ status: 'expired', limit: 500 }),
  ])
  return [...pending, ...expired].filter((g) => g.player_choice === 'trustless-v4' && g.house_vtxos_json)
}
