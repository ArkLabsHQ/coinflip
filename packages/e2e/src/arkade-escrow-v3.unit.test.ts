/**
 * Tests for CoinflipEscrowScriptV3 — the 10-leaf v0.3 taptree.
 *
 *   - taptree has 10 distinct leaves
 *   - leaves 3, 4, 7, 8 are byte-identical to v0.2.x given identical inputs
 *     (forfeit / refund / playerForfeitExit / refundExit don't depend on
 *     the win predicate, only on `playerHash`)
 *   - leaves 1, 2, 5, 6 differ from v2 (the predicate moved into arkade-script
 *     so the surrounding closure dropped its ConditionMultisig)
 *   - leaves 9 (cooperativeSpend) and 10 (cooperativeSpendExit) are NEW
 *   - the taptree's tap-key matches what arkd's btcd-style algorithm
 *     derives (achieved via `assembleBtcdTaprootTree` overriding the
 *     parent VtxoScript's Huffman tree builder)
 */

// Mark this file as a module so its top-level identifiers are file-scoped
// (other *.unit.test.ts files also `require()` `schnorr` / declare the same
// names — without this each script's globals would clash under ts-jest's
// shared program in single-process mode).
export {}

/* eslint-disable @typescript-eslint/no-require-imports */
const { hex } = require('@scure/base')
const { schnorr } = require('@noble/curves/secp256k1.js')
const {
  CoinflipEscrowScript,
  CoinflipEscrowScriptV3,
  computeArkadeScriptPublicKey,
  digitHash,
} = require('arkade-coinflip')

function pk(seed: number) {
  return schnorr.getPublicKey(new Uint8Array(32).fill(seed))
}

const CREATOR = pk(0x10)
const PLAYER = pk(0x20)
const SERVER = pk(0x30)
const EMU = pk(0x40)
const FINAL_EXP = 2_000_000_000n
const EXIT = 86_528n

// Use the v3 commit shape — SHA256(digit ‖ salt) — so v2 and v3 see the same
// hash bytes. (v2 doesn't care HOW the hash was produced; both implementations
// just feed `playerHash` / `creatorHash` into their respective leaf builders.)
const CREATOR_DIGIT = { digit: 0, salt: new Uint8Array(16).fill(0xaa) }
const PLAYER_DIGIT = { digit: 1, salt: new Uint8Array(16).fill(0xbb) }
const C_HASH = digitHash(CREATOR_DIGIT)
const P_HASH = digitHash(PLAYER_DIGIT)

const PLAYER_PAYOUT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x77)])
const HOUSE_PAYOUT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x88)])

const baseOpts = {
  creatorPubkey: CREATOR,
  playerPubkey: PLAYER,
  serverPubkey: SERVER,
  creatorHash: C_HASH,
  playerHash: P_HASH,
  finalExpiration: FINAL_EXP,
  refundPubkey: PLAYER, // player's escrow
  exitDelay: EXIT,
  oddsN: 2,
  oddsTarget: 1,
  oddsLo: 0,
  arkadeForfeit: {
    emulatorPubkey: EMU,
    playerPayoutPkScript: PLAYER_PAYOUT,
    housePayoutPkScript: HOUSE_PAYOUT,
    playerStake: 50_000n,
    houseStake: 30_000n,
  },
}

describe('CoinflipEscrowScriptV3 — taptree shape', () => {
  it('exposes 10 distinct leaves', () => {
    const s = new CoinflipEscrowScriptV3(baseOpts)
    const leafHexes = [
      hex.encode(s.playerWinCovenant()[1]),
      hex.encode(s.creatorWinCovenant()[1]),
      hex.encode(s.playerForfeit()[1]),
      hex.encode(s.refund()[1]),
      hex.encode(s.playerWinExit()[1]),
      hex.encode(s.creatorWinExit()[1]),
      hex.encode(s.playerForfeitExit()[1]),
      hex.encode(s.refundExit()[1]),
      hex.encode(s.cooperativeSpend()[1]),
      hex.encode(s.cooperativeSpendExit()[1]),
    ]
    expect(new Set(leafHexes).size).toBe(10)
  })

  it('cooperativeSpend is Multisig[player, creator, server] — passive server co-sig for arkd validation', () => {
    const s = new CoinflipEscrowScriptV3(baseOpts)
    const body = hex.encode(s.cooperativeSpend()[1])
    expect(body.includes(hex.encode(PLAYER))).toBe(true)
    expect(body.includes(hex.encode(CREATOR))).toBe(true)
    expect(body.includes(hex.encode(SERVER))).toBe(true)
    expect(body.includes(hex.encode(EMU))).toBe(false)
    expect(body.includes('b2')).toBe(false)
  })

  it('cooperativeSpendExit is the CSV-gated mirror — pure player+creator 2-of-2', () => {
    const s = new CoinflipEscrowScriptV3(baseOpts)
    const body = hex.encode(s.cooperativeSpendExit()[1])
    expect(body.includes(hex.encode(PLAYER))).toBe(true)
    expect(body.includes(hex.encode(CREATOR))).toBe(true)
    expect(body.includes(hex.encode(EMU))).toBe(false)
    expect(body.includes('b2')).toBe(true)
  })

  it('forfeit/refund/playerForfeitExit/refundExit are byte-identical to v2 given matching inputs', () => {
    const v2 = new CoinflipEscrowScript(baseOpts)
    const v3 = new CoinflipEscrowScriptV3(baseOpts)
    expect(hex.encode(v3.playerForfeit()[1])).toBe(hex.encode(v2.playerForfeit()[1]))
    expect(hex.encode(v3.refund()[1])).toBe(hex.encode(v2.refund()[1]))
    expect(hex.encode(v3.playerForfeitExit()[1])).toBe(hex.encode(v2.playerForfeitExit()[1]))
    expect(hex.encode(v3.refundExit()[1])).toBe(hex.encode(v2.refundExit()[1]))
  })

  it('win-leaves (1, 2, 5, 6) differ from v2 (predicate moved into arkade-script)', () => {
    const v2 = new CoinflipEscrowScript(baseOpts)
    const v3 = new CoinflipEscrowScriptV3(baseOpts)
    expect(hex.encode(v3.playerWinCovenant()[1])).not.toBe(hex.encode(v2.playerWinCovenant()[1]))
    expect(hex.encode(v3.creatorWinCovenant()[1])).not.toBe(hex.encode(v2.creatorWinCovenant()[1]))
    expect(hex.encode(v3.playerWinExit()[1])).not.toBe(hex.encode(v2.playerWinExit()[1]))
    expect(hex.encode(v3.creatorWinExit()[1])).not.toBe(hex.encode(v2.creatorWinExit()[1]))
  })

  it('house-side escrow (refundPubkey = creator) produces the mirror taptree', () => {
    const houseOpts = { ...baseOpts, refundPubkey: CREATOR }
    const houseEscrow = new CoinflipEscrowScriptV3(houseOpts)
    const playerEscrow = new CoinflipEscrowScriptV3(baseOpts)
    // The cooperative leaves are funder-independent — same on both escrows.
    expect(hex.encode(houseEscrow.cooperativeSpend()[1]))
      .toBe(hex.encode(playerEscrow.cooperativeSpend()[1]))
    // The win-leaves differ because each pins the OTHER party's stake in the
    // covenant's INSPECTINPUTVALUE check (atomicSweep semantics).
    expect(hex.encode(houseEscrow.playerWinCovenant()[1]))
      .not.toBe(hex.encode(playerEscrow.playerWinCovenant()[1]))
  })

  it('forfeit() (SDK annotation helper) resolves to the refund leaf', () => {
    const s = new CoinflipEscrowScriptV3(baseOpts)
    expect(hex.encode(s.forfeit()[1])).toBe(hex.encode(s.refund()[1]))
  })

  it('determinism — same options → byte-identical full taptree', () => {
    const a = new CoinflipEscrowScriptV3(baseOpts)
    const b = new CoinflipEscrowScriptV3(baseOpts)
    expect(a.playerWinCovenantScriptHex).toBe(b.playerWinCovenantScriptHex)
    expect(a.cooperativeSpendScriptHex).toBe(b.cooperativeSpendScriptHex)
  })

  it('emu-tweaked key is consistent: playerWinFullArkadeScript hashes to the same tweak each time', () => {
    const a = new CoinflipEscrowScriptV3(baseOpts)
    const expected = computeArkadeScriptPublicKey(EMU, a.playerWinFullArkadeScript)
    // Body contains the tweaked key — sanity check it's the one we computed.
    expect(hex.encode(a.playerWinCovenant()[1]).includes(hex.encode(expected))).toBe(true)
  })
})
