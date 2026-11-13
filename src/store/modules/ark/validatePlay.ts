import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import type { V4PlayResponse } from '@/services/api'
import { rebuildJointPot } from './v4SelfRefund'

export interface ExpectedGameTerms {
  playerPubkey: string
  playerHash: string
  payoutPkScript: string
  serverPubkey: string
  emulatorPubkey: string
  chainTime: number
  wallTime: number
  playerStake: number
  minimumHouseStake?: number
  oddsN: number
  oddsTarget: number
  oddsLo: number
}
const xOnly = (key: string) => key.length === 66 ? key.slice(2) : key
export const MIN_REFUND_WINDOW_SECONDS = 120
export const MIN_CONTEST_WINDOW_SECONDS = 120
export const MAX_GAME_WINDOW_SECONDS = 86_400

/** Bind the transaction we sign to the terms the player chose, not an arbitrary address. */
export function validatePlay(play: V4PlayResponse, expected: ExpectedGameTerms): void {
  const cv = play.covenant
  const now = Math.max(expected.chainTime, expected.wallTime)
  if (![expected.chainTime, expected.wallTime, cv.cancelDelay, cv.finalExpiration].every(Number.isSafeInteger) ||
      now < 500_000_000 || cv.cancelDelay < now + MIN_REFUND_WINDOW_SECONDS ||
      cv.finalExpiration - cv.cancelDelay < MIN_CONTEST_WINDOW_SECONDS ||
      cv.finalExpiration > now + MAX_GAME_WINDOW_SECONDS || play.finalExpiration !== cv.finalExpiration) {
    throw new Error('The game refund and contest deadlines leave an unsafe funding window')
  }
  if (cv.playerPubkey !== expected.playerPubkey || cv.playerHash !== expected.playerHash || cv.playerPayoutPkScript !== expected.payoutPkScript) {
    throw new Error('The game does not commit to this player, secret, and payout')
  }
  if (cv.serverPubkey !== xOnly(expected.serverPubkey) || play.serverPubkey !== cv.serverPubkey) {
    throw new Error('The game uses a different Arkade operator')
  }
  if (cv.emulatorPubkey !== xOnly(expected.emulatorPubkey) || cv.emulatorPubkey !== play.emulatorPubkey) {
    throw new Error('The game uses a different covenant cosigner')
  }
  if (cv.creatorPubkey !== play.housePubkey || cv.creatorHash !== play.houseHash) throw new Error('House commitment does not match the pot')
  if (cv.oddsN !== expected.oddsN || cv.oddsTarget !== expected.oddsTarget || cv.oddsLo !== expected.oddsLo ||
      play.oddsN !== cv.oddsN || play.oddsTarget !== cv.oddsTarget || play.oddsLo !== cv.oddsLo) {
    throw new Error('The game changed the selected odds')
  }
  if (![cv.playerStake, cv.houseStake, play.pot].every(Number.isSafeInteger) || cv.playerStake !== expected.playerStake ||
      cv.houseStake <= 0 || cv.houseStake !== play.houseStake || play.pot !== cv.playerStake + cv.houseStake ||
      (expected.minimumHouseStake !== undefined && cv.houseStake < expected.minimumHouseStake)) {
    throw new Error('The game changed the agreed stakes or payout')
  }
  const actual = ArkAddress.decode(play.potAddress)
  const rebuilt = rebuildJointPot(cv)
  if (hex.encode(actual.pkScript) !== hex.encode(rebuilt.pkScript)) {
    throw new Error('The funding address does not match the verified game covenant')
  }
}
