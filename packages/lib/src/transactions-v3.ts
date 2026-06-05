/**
 * v0.3 escrow transaction-building helpers — parallel to transactions.ts.
 *
 * Mirrors the v0.2.x helpers' surface so callers (server, client) can swap
 * between v2 / v3 by routing on `game.contractVersion`. Only the
 * escrow-script construction differs (`CoinflipEscrowScriptV3` vs. v2's
 * `CoinflipEscrowScript`); the broader tx-builder API stays compatible.
 *
 * Sweep / forfeit / refund tx builders for v3 live next to their v2
 * counterparts and reuse the same patterns; the only v3-specific addition
 * is reveal-packet attachment via `addRevealPacket` (called from the
 * server's commit handler, not here — this module stays transport-free).
 */

import { ArkAddress } from '@arkade-os/sdk'
import {
  CoinflipEscrowScriptV3,
  type CoinflipEscrowOptionsV3,
} from './script-v3'
import type { Game } from './types'

function assertDefined<T>(v: T | undefined | null, name: string): asserts v is T {
  if (v === undefined || v === null) throw new Error(`${name} is required for v3`)
}

function escrowScriptV3(game: Game, refundPubkey: Uint8Array): CoinflipEscrowScriptV3 {
  assertDefined(game.creator, 'creator')
  assertDefined(game.player, 'player')
  assertDefined(game.serverPubkey, 'serverPubkey')
  assertDefined(game.creator.hash, 'creator.hash')
  assertDefined(game.creator.pubkey, 'creator.pubkey')
  assertDefined(game.player.pubkey, 'player.pubkey')
  assertDefined(game.player.hash, 'player.hash')
  assertDefined(game.finalExpiration, 'finalExpiration')
  assertDefined(game.emulatorPubkey, 'emulatorPubkey')
  assertDefined(game.playerForfeitPkScript, 'playerForfeitPkScript')
  assertDefined(game.housePayoutPkScript, 'housePayoutPkScript')
  assertDefined(game.playerStake, 'playerStake')
  assertDefined(game.houseStake, 'houseStake')
  assertDefined(game.exitDelay, 'exitDelay')
  assertDefined(game.oddsN, 'oddsN (v3 requires variable-odds; n=2 is the coin)')
  assertDefined(game.oddsTarget, 'oddsTarget')
  // oddsLo defaults to 0 for the coin / "0 to target" range.
  const lo = game.oddsLo ?? 0
  return new CoinflipEscrowScriptV3({
    creatorPubkey: game.creator.pubkey,
    playerPubkey: game.player.pubkey,
    serverPubkey: game.serverPubkey,
    creatorHash: game.creator.hash,
    playerHash: game.player.hash,
    finalExpiration: BigInt(game.finalExpiration),
    refundPubkey,
    exitDelay: BigInt(game.exitDelay),
    oddsN: game.oddsN,
    oddsTarget: game.oddsTarget,
    oddsLo: lo,
    arkadeForfeit: {
      emulatorPubkey: game.emulatorPubkey,
      playerPayoutPkScript: game.playerForfeitPkScript,
      housePayoutPkScript: game.housePayoutPkScript,
      playerStake: BigInt(game.playerStake),
      houseStake: BigInt(game.houseStake),
    },
  })
}

export function getPlayerEscrowScriptV3(game: Game): CoinflipEscrowScriptV3 {
  return escrowScriptV3(game, game.player!.pubkey!)
}

export function getHouseEscrowScriptV3(game: Game): CoinflipEscrowScriptV3 {
  return escrowScriptV3(game, game.creator!.pubkey!)
}

export function getPlayerEscrowAddressV3(game: Game, networkHrp: string): ArkAddress {
  return getPlayerEscrowScriptV3(game).address(networkHrp, game.serverPubkey!)
}

export function getHouseEscrowAddressV3(game: Game, networkHrp: string): ArkAddress {
  return getHouseEscrowScriptV3(game).address(networkHrp, game.serverPubkey!)
}

export function getPlayerEscrowOptionsV3(game: Game): CoinflipEscrowOptionsV3 {
  return getPlayerEscrowScriptV3(game).options
}

export function getHouseEscrowOptionsV3(game: Game): CoinflipEscrowOptionsV3 {
  return getHouseEscrowScriptV3(game).options
}
