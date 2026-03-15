/**
 * Event type guards and game state reconstruction from events.
 */

import { hex } from '@scure/base'
import {
  Game,
  GameEvent,
  GameStatus,
  CreateEvent,
  JoinEvent,
  SetupStartedEvent,
  SetupFinalizedEvent,
  FinalizeEvent,
  ResolveEvent,
} from './types'

export function isCreateEvent(event: unknown): event is CreateEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'create' &&
    'gameId' in event &&
    typeof event.gameId === 'string' &&
    'creatorPubkey' in event &&
    typeof event.creatorPubkey === 'string' &&
    'creatorVtxos' in event &&
    Array.isArray(event.creatorVtxos)
  )
}

export function isJoinEvent(event: unknown): event is JoinEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'join' &&
    'gameId' in event &&
    typeof event.gameId === 'string'
  )
}

export function isSetupStartedEvent(event: unknown): event is SetupStartedEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'setupStarted' &&
    'gameId' in event &&
    typeof event.gameId === 'string' &&
    'creatorHash' in event &&
    typeof event.creatorHash === 'string' &&
    'creatorFinalSignature' in event &&
    typeof event.creatorFinalSignature === 'string'
  )
}

export function isSetupFinalizedEvent(event: unknown): event is SetupFinalizedEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'setupFinalized' &&
    'gameId' in event &&
    typeof event.gameId === 'string' &&
    'playerFinalSignature' in event &&
    typeof event.playerFinalSignature === 'string' &&
    'playerSetupSignatures' in event &&
    Array.isArray(event.playerSetupSignatures)
  )
}

export function isFinalizeEvent(event: unknown): event is FinalizeEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'finalize' &&
    'gameId' in event &&
    typeof event.gameId === 'string' &&
    'creatorSetupSignatures' in event &&
    Array.isArray(event.creatorSetupSignatures)
  )
}

export function isResolveEvent(event: unknown): event is ResolveEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'resolve' &&
    'gameId' in event &&
    typeof event.gameId === 'string' &&
    'playerSecret' in event &&
    typeof event.playerSecret === 'string'
  )
}

/**
 * Reconstructs a Game object from a sequence of game events.
 * This is the core state machine — events are applied in order.
 */
export function gameFromEvents(...events: GameEvent[]): Game {
  const game: Game = {}

  for (const event of events) {
    if (game.gameId && event.gameId !== game.gameId) {
      throw new Error('Game ID mismatch')
    }

    switch (event.type) {
      case 'create':
        game.status = Math.max(game.status || 0, GameStatus.Created)
        game.gameId = event.gameId
        game.creator = {
          ...(game.creator || {}),
          pubkey: hex.decode(event.creatorPubkey),
          vtxos: event.creatorVtxos,
          changeAddress: event.creatorChangeAddress,
        }
        game.betAmount = BigInt(event.betAmount)
        game.serverPubkey = hex.decode(
          event.serverPubkey.length === 66
            ? event.serverPubkey.slice(2)
            : event.serverPubkey
        )
        game.setupExpiration = event.setupExpiration
        game.finalExpiration = event.finalExpiration
        break

      case 'join':
        game.status = Math.max(game.status || 0, GameStatus.Joined)
        game.gameId = event.gameId
        game.player = {
          ...(game.player || {}),
          pubkey: hex.decode(event.playerPubkey),
          vtxos: event.playerVtxos,
          changeAddress: event.playerChangeAddress,
          hash: hex.decode(event.playerHash),
        }
        break

      case 'setupStarted':
        game.status = Math.max(game.status || 0, GameStatus.SetupStarted)
        game.gameId = event.gameId
        game.creator = {
          ...(game.creator || {}),
          hash: hex.decode(event.creatorHash),
          finalTxSignature: hex.decode(event.creatorFinalSignature),
        }
        break

      case 'setupFinalized':
        game.status = Math.max(game.status || 0, GameStatus.SetupFinalized)
        game.gameId = event.gameId
        game.player = {
          ...(game.player || {}),
          finalTxSignature: hex.decode(event.playerFinalSignature),
          setupTxSignatures: event.playerSetupSignatures.map(hex.decode),
        }
        break

      case 'finalize':
        game.status = Math.max(game.status || 0, GameStatus.Finalized)
        game.gameId = event.gameId
        game.creator = {
          ...(game.creator || {}),
          setupTxSignatures: event.creatorSetupSignatures.map(hex.decode),
        }
        break

      case 'resolve':
        game.status = Math.max(game.status || 0, GameStatus.Resolved)
        game.gameId = event.gameId
        game.player = {
          ...(game.player || {}),
          revealedSecret: hex.decode(event.playerSecret),
        }
        break
    }
  }

  return game
}
