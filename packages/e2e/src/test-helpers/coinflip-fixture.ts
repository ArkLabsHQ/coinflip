import type { CoinflipJointPotOptions } from 'arkade-coinflip'
const { schnorr } = require('@noble/curves/secp256k1.js')

export const secretKey = (seed: number): Uint8Array => new Uint8Array(32).fill(seed)
export const xonly = (seed: number): Uint8Array => schnorr.getPublicKey(secretKey(seed))
export const payout = (seed: number): Uint8Array => new Uint8Array([0x51, 0x20, ...xonly(seed)])
export const toHex = (value: Uint8Array): string => Buffer.from(value).toString('hex')

export function contractOptions(overrides: Partial<CoinflipJointPotOptions> = {}): CoinflipJointPotOptions {
  return {
    creatorPubkey: xonly(1), playerPubkey: xonly(2), serverPubkey: xonly(3), emulatorPubkey: xonly(4),
    creatorHash: new Uint8Array(32).fill(0xc0), playerHash: new Uint8Array(32).fill(0xd0),
    finalExpiration: 1_900_000_000n, cancelDelay: 1_800_000_000n, exitDelay: 86_528n,
    oddsN: 2, oddsLo: 0, oddsTarget: 1,
    playerPayoutPkScript: payout(5), housePayoutPkScript: payout(6),
    playerStake: 50_000n, houseStake: 50_000n, ...overrides,
  }
}
