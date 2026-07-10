import { bech32 } from 'bech32'
import { hex } from '@scure/base'

/** Encode a raw hex private key as an `nsec1…` bech32 string. Retained from the
 *  legacy nostr identity scheme because wallet key backup/import still accepts
 *  nsec (see #49); the P2P game-event machinery that used to live here is gone. */
export function privateKeyToNsec(privateKey: string): string {
  const words = bech32.toWords(Array.from(hex.decode(privateKey)))
  return bech32.encode('nsec', words, 1023)
}
