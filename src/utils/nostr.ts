import { bech32 } from 'bech32'
import { hex } from '@scure/base'
import { NostrEvent } from '@/types/nostr'
import { GameEvent } from './game'

export const GAME_KIND = 32000 // Custom event kind for games

export function parseGameEvent(event: NostrEvent): GameEvent {
  try {
    const data = JSON.parse(event.content) as GameEvent
    return data
  } catch (err) {
    throw new Error(`Failed to parse game event: ${err instanceof Error ? err.message : 'Unknown error'}`)
  }
}

export function privateKeyToNsec(privateKey: string): string {
  const words = bech32.toWords(Array.from(hex.decode(privateKey)))
  return bech32.encode('nsec', words, 1023)
}
