import { hex } from "@scure/base";
import { p2tr, p2tr_ms, taprootListToTree } from "@scure/btc-signer";
import { TAP_LEAF_VERSION } from "@scure/btc-signer/payment";
import { Bytes } from "@scure/btc-signer/utils";

export const UNSPENDABLE_KEY = new Uint8Array([
  0x50, 0x92, 0x9b, 0x74, 0xc1, 0xa0, 0x49, 0x54, 
  0xb7, 0x8b, 0x4b, 0x60, 0x35, 0xe9, 0x7a, 0x5e, 
  0x07, 0x8a, 0x5a, 0x0f, 0x28, 0xec, 0x96, 0xd5, 
  0x47, 0xbf, 0xee, 0x9a, 0xce, 0x80, 0x3a, 0xc0
]);

export function vtxoScript(tapscripts: string[]): ReturnType<typeof p2tr> {
    const tapTree = taprootListToTree(tapscripts.map(s => ({ script: hex.decode(s), leafVersion: TAP_LEAF_VERSION })))
    return p2tr(UNSPENDABLE_KEY, tapTree, undefined, true)
}

export function defaultVtxoTapscripts(pubkey: Bytes, serverPubKey: Bytes): string[] {
  if (!pubkey || pubkey.length !== 32) {
    throw new Error('Public key must be a 32-byte x-only pubkey')
  }
  if (!serverPubKey || serverPubKey.length !== 32) {
    throw new Error('Server public key must be a 32-byte x-only pubkey')
  }

  const script = p2tr_ms(2, [pubkey, serverPubKey]).script
  return [hex.encode(script)]
}
