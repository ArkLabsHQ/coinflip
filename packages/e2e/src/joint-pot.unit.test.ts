/**
 * v4 CoinflipJointPotScript — pure unit test (no regtest).
 * Proves the joint-pot taptree derives deterministically and all 8 leaves
 * resolve. The live settle is exercised by the regtest probe separately.
 */
import { CoinflipJointPotScript } from 'arkade-coinflip'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { schnorr } = require('@noble/curves/secp256k1.js')

const xonly = (seed: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(seed))
const h = (seed: number): Uint8Array => new Uint8Array(32).fill(seed)
// p2tr scriptPubKey: OP_1 (0x51) <32-byte push (0x20)> <key>
const p2tr = (seed: number): Uint8Array => new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(seed)])

function build(): CoinflipJointPotScript {
  return new CoinflipJointPotScript({
    creatorPubkey: xonly(1), playerPubkey: xonly(2), serverPubkey: xonly(3),
    creatorHash: h(0xaa), playerHash: h(0xbb),
    finalExpiration: 1_900_000_000n, exitDelay: 86_528n,
    oddsN: 2, oddsTarget: 1, oddsLo: 0,
    emulatorPubkey: xonly(4),
    playerPayoutPkScript: p2tr(0x10), housePayoutPkScript: p2tr(0x20),
    playerStake: 1000n, houseStake: 1000n,
  })
}

describe('CoinflipJointPotScript', () => {
  it('derives a deterministic 34-byte p2tr pkScript', () => {
    const a = build()
    const b = build()
    expect(a.pkScript.length).toBe(34)
    expect(a.pkScript[0]).toBe(0x51) // OP_1
    expect(a.pkScript[1]).toBe(0x20) // 32-byte push
    expect(Buffer.from(a.pkScript).toString('hex')).toBe(Buffer.from(b.pkScript).toString('hex'))
  })

  it('exposes all 8 leaves via findLeaf', () => {
    const s = build()
    const leaves = [
      s.playerWinCovenant(), s.creatorWinCovenant(), s.playerForfeit(), s.cooperativeSpend(),
      s.playerWinExit(), s.creatorWinExit(), s.playerForfeitExit(), s.cooperativeSpendExit(),
    ]
    for (const leaf of leaves) expect(leaf).toBeDefined()
    // All 8 leaf script-hexes are distinct.
    const hexes = [
      s.playerWinCovenantScriptHex, s.creatorWinCovenantScriptHex, s.playerForfeitScriptHex,
      s.cooperativeSpendScriptHex, s.playerWinExitScriptHex, s.creatorWinExitScriptHex,
      s.playerForfeitExitScriptHex, s.cooperativeSpendExitScriptHex,
    ]
    expect(new Set(hexes).size).toBe(8)
  })

  it('player vs creator win covenants differ (predicate negation + payout)', () => {
    const s = build()
    expect(s.playerWinCovenantScriptHex).not.toBe(s.creatorWinCovenantScriptHex)
    expect(Buffer.from(s.playerWinFullArkadeScript).toString('hex'))
      .not.toBe(Buffer.from(s.creatorWinFullArkadeScript).toString('hex'))
  })

  it('changing odds changes the pot pkScript (predicate is bound into the tapkey)', () => {
    const base = build()
    const other = new CoinflipJointPotScript({
      creatorPubkey: xonly(1), playerPubkey: xonly(2), serverPubkey: xonly(3),
      creatorHash: h(0xaa), playerHash: h(0xbb),
      finalExpiration: 1_900_000_000n, exitDelay: 86_528n,
      oddsN: 6, oddsTarget: 3, oddsLo: 0, // different odds
      emulatorPubkey: xonly(4),
      playerPayoutPkScript: p2tr(0x10), housePayoutPkScript: p2tr(0x20),
      playerStake: 1000n, houseStake: 1000n,
    })
    expect(Buffer.from(base.pkScript).toString('hex')).not.toBe(Buffer.from(other.pkScript).toString('hex'))
  })
})
