/**
 * `splitCheckpointsByOutpoint` — the fix for the co-fund `INVALID_SIGNATURE (18)`
 * checkpoint race. arkd returns the signed checkpoints in randomized (Go map-iteration)
 * order, so the coinflip server MUST split them into house/player by the OUTPOINT each
 * checkpoint spends, not by array position. The old positional split handed the house
 * the player's checkpoint on any order-swap (~12.5% for a 1+1 co-fund) → the house
 * couldn't sign it → finalize rejected the unsigned checkpoint.
 *
 * This pins order-INVARIANCE: across EVERY permutation of the response, each checkpoint
 * lands in the correct bucket. Pure — no regtest, no arkd.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
export {}
import { base64, hex } from '@scure/base'
import { Transaction } from '@arkade-os/sdk'
const { splitCheckpointsByOutpoint } = require('arkade-coinflip')

/** A minimal PSBT whose input 0 spends {txid, vout} — all the demux reads. */
const P2TR = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x01)])
function mkCheckpoint(txidHex: string, vout: number): string {
  const tx = new Transaction()
  tx.addInput({ txid: hex.decode(txidHex), index: vout, witnessUtxo: { script: P2TR, amount: 1000n } })
  return base64.encode(tx.toPSBT())
}
/** The exact outpoint key the demux derives (production convention — matches Guard 0). */
function opOf(b64: string): string {
  const in0 = Transaction.fromPSBT(base64.decode(b64)).getInput(0)
  return `${in0?.txid ? hex.encode(in0.txid) : ''}:${in0?.index}`
}
/** All orderings of an array (small n — the co-fund has ≤ a handful of checkpoints). */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr]
  return arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]))
}

const T = (b: number) => new Uint8Array(32).fill(b)
const H = hex.encode

describe('splitCheckpointsByOutpoint — order-invariant checkpoint demux', () => {
  it('routes the 1+1 co-fund correctly for BOTH response orders (the ~12.5% swap)', () => {
    const cpPlayer = mkCheckpoint(H(T(0x11)), 0)
    const cpHouse = mkCheckpoint(H(T(0x22)), 1)
    const houseOutpoints = new Set([opOf(cpHouse)])
    for (const order of [[cpPlayer, cpHouse], [cpHouse, cpPlayer]]) {
      const { houseCheckpoints, playerCheckpoints } = splitCheckpointsByOutpoint(order, houseOutpoints)
      expect(houseCheckpoints).toEqual([cpHouse]) // never the player's, regardless of order
      expect(playerCheckpoints).toEqual([cpPlayer])
    }
  })

  it('routes a k=2 player + m=1 house co-fund for EVERY one of the 6 response orders', () => {
    const cpP1 = mkCheckpoint(H(T(0xa1)), 0)
    const cpP2 = mkCheckpoint(H(T(0xa2)), 3)
    const cpHouse = mkCheckpoint(H(T(0xbb)), 0)
    const houseOutpoints = new Set([opOf(cpHouse)])
    for (const order of permutations([cpP1, cpP2, cpHouse])) {
      const { houseCheckpoints, playerCheckpoints } = splitCheckpointsByOutpoint(order, houseOutpoints)
      expect(houseCheckpoints).toEqual([cpHouse])
      expect(new Set(playerCheckpoints)).toEqual(new Set([cpP1, cpP2])) // both player cps, either order
      expect(playerCheckpoints).toHaveLength(2)
    }
  })

  it('routes m=2 house inputs (same txid, different vout) correctly', () => {
    const txid = H(T(0xcc))
    const cpH0 = mkCheckpoint(txid, 0)
    const cpH1 = mkCheckpoint(txid, 1)
    const cpPlayer = mkCheckpoint(H(T(0xdd)), 0)
    const houseOutpoints = new Set([opOf(cpH0), opOf(cpH1)])
    for (const order of permutations([cpH0, cpH1, cpPlayer])) {
      const { houseCheckpoints, playerCheckpoints } = splitCheckpointsByOutpoint(order, houseOutpoints)
      expect(new Set(houseCheckpoints)).toEqual(new Set([cpH0, cpH1]))
      expect(playerCheckpoints).toEqual([cpPlayer]) // vout distinguishes same-txid outpoints
    }
  })
})
