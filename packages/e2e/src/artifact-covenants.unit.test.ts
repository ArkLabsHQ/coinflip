/**
 * Parity tests for the artifact-JSON covenant fragments (v4 migration).
 *
 * Proves that expressing coinflip's v4 covenant bodies as artifact
 * `asm`-token arrays — resolved through the SDK's own `arkade.resolveAsm`
 * (the encoder that `arkade.contract()` uses) — reproduces the exact bytes
 * of the current, emulator-proven builders in
 * `@arklabshq/contract-workflows-prototype`. Byte-equality against proven
 * code is our correctness anchor: no regtest, no emulator needed.
 *
 * See docs/superpowers/specs — v4 artifact adoption (ts-sdk PR #319).
 */

/* eslint-disable @typescript-eslint/no-require-imports */
export {} // module scope: avoid TS2451 cross-file const redeclare under CI's fresh ts-jest compile
const { hex } = require('@scure/base')
const { schnorr } = require('@noble/curves/secp256k1.js')
const { arkade } = require('@arkade-os/sdk')
const { covenants } = require('@arklabshq/contract-workflows-prototype')
const {
  payToAsm,
  winPredicateAsm,
  splitAsm,
  fullWinAsm,
  buildVariableOddsWinPredicate,
  buildJointPotArtifactContract,
  CoinflipJointPotScript,
} = require('arkade-coinflip')

// Fixed P2TR pkScript (v1 witness, 32-byte program) — same style as
// arkade-forfeit.unit.test.ts so vectors line up across the suite.
const RECIPIENT_WP = new Uint8Array(Array.from({ length: 32 }, (_, i) => 0x40 + i))
const RECIPIENT_PKSCRIPT = new Uint8Array([0x51, 0x20, ...RECIPIENT_WP])

describe('artifact covenants: payTo parity', () => {
  it('payToAsm resolves to the emulator-proven covenants.payTo bytes (amount 50_000)', () => {
    const amount = 50_000n
    const resolved = arkade.resolveAsm(payToAsm('$receiver', '$amount'), {
      receiver: RECIPIENT_WP,
      amount,
    })
    const current = covenants.payTo(RECIPIENT_PKSCRIPT, amount)
    expect(hex.encode(resolved)).toBe(hex.encode(current))
  })

  // Realistic coinflip amounts are always thousands of sats. Across the
  // sign-pad and multi-byte boundaries the artifact encoding matches the
  // legacy builder byte-for-byte — proving `arkade.resolveAsm`'s BigNum
  // encoding agrees with `encodeMinBigInt` for every value coinflip uses.
  it('payToAsm parity holds across realistic amount encodings', () => {
    for (const amount of [17n, 100n, 128n, 255n, 256n, 10_000n, 100_000n, 1_000_000n, 4_294_967_296n]) {
      const resolved = arkade.resolveAsm(payToAsm('$receiver', '$amount'), {
        receiver: RECIPIENT_WP,
        amount,
      })
      const current = covenants.payTo(RECIPIENT_PKSCRIPT, amount)
      expect(hex.encode(resolved)).toBe(hex.encode(current))
    }
  })

  // Documented, intentional divergence: for values 1..16 the artifact form is
  // MINIMALDATA-canonical (OP_1..OP_16) where the legacy builder data-pushed.
  // This never affects coinflip (pot/stake amounts are always > 16 sats) and
  // the artifact form is the one the arkade VM / emulator expects.
  it('artifact payTo uses MINIMALDATA (OP_N) for values <= 16 (canonical, differs from legacy)', () => {
    const resolved = arkade.resolveAsm(payToAsm('$receiver', '$amount'), {
      receiver: RECIPIENT_WP,
      amount: 16n,
    })
    // ...INSPECTOUTPUTVALUE (cf) OP_16 (60) EQUAL (87)
    expect(hex.encode(resolved).endsWith('cf6087')).toBe(true)
    const legacy = covenants.payTo(RECIPIENT_PKSCRIPT, 16n)
    expect(hex.encode(legacy).endsWith('cf011087')).toBe(true)
  })
})

describe('artifact covenants: variable-odds win-predicate parity', () => {
  const creatorHash = new Uint8Array(32).fill(0xaa)
  const playerHash = new Uint8Array(32).fill(0xbb)
  // Spans small (OP_N) and large (data-push) odds params, incl. the coin case.
  const cases = [
    { n: 2, lo: 0, target: 1 }, // 50/50 coin
    { n: 6, lo: 0, target: 1 }, // 1-in-6
    { n: 16, lo: 0, target: 8 }, // OP_16 boundary
    { n: 100, lo: 0, target: 55 }, // variable odds > 16
    { n: 128, lo: 10, target: 120 }, // max n
  ]
  for (const { n, lo, target } of cases) {
    it(`player-win predicate matches buildVariableOddsWinPredicate (n=${n}, lo=${lo}, target=${target})`, () => {
      const resolved = arkade.resolveAsm(winPredicateAsm(true), {
        creatorHash,
        playerHash,
        oddsN: n,
        oddsLo: lo,
        oddsTarget: target,
      })
      const current = buildVariableOddsWinPredicate(creatorHash, playerHash, n, target, lo, true)
      expect(hex.encode(resolved)).toBe(hex.encode(current))
    })
    it(`creator-win predicate matches buildVariableOddsWinPredicate (n=${n}, lo=${lo}, target=${target})`, () => {
      const resolved = arkade.resolveAsm(winPredicateAsm(false), {
        creatorHash,
        playerHash,
        oddsN: n,
        oddsLo: lo,
        oddsTarget: target,
      })
      const current = buildVariableOddsWinPredicate(creatorHash, playerHash, n, target, lo, false)
      expect(hex.encode(resolved)).toBe(hex.encode(current))
    })
  }
})

describe('artifact covenants: composite arkade-scripts match CoinflipJointPotScript', () => {
  // A fully-specified v4 game fixture. Keys are x-only (32B); payouts are P2TR.
  const xonly = (b: number) => schnorr.getPublicKey(new Uint8Array(32).fill(b))
  const h = (b: number) => new Uint8Array(32).fill(b)
  const p2tr = (b: number) => new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(b)])
  const opts = {
    creatorPubkey: xonly(0x01),
    playerPubkey: xonly(0x02),
    serverPubkey: xonly(0x03),
    creatorHash: h(0xc0),
    playerHash: h(0xd0),
    finalExpiration: 1_900_000_000n,
    cancelDelay: 1_800_000_000n,
    exitDelay: 86_528n,
    oddsN: 100,
    oddsTarget: 55,
    oddsLo: 0,
    emulatorPubkey: xonly(0x04),
    playerPayoutPkScript: p2tr(0xa0),
    housePayoutPkScript: p2tr(0xb0),
    playerStake: 50_000n,
    houseStake: 50_000n,
  }
  const pot = opts.playerStake + opts.houseStake
  const current = new CoinflipJointPotScript(opts)

  // Shared bind map for resolving the artifact asm templates.
  const args = {
    creatorHash: opts.creatorHash,
    playerHash: opts.playerHash,
    oddsN: opts.oddsN,
    oddsLo: opts.oddsLo,
    oddsTarget: opts.oddsTarget,
    playerWp: opts.playerPayoutPkScript.slice(2),
    houseWp: opts.housePayoutPkScript.slice(2),
    stageTwoWp: current.stageTwo.pkScript.slice(2),
    pot,
    playerStake: opts.playerStake,
    houseStake: opts.houseStake,
  }

  it('player-win full arkade-script (predicate + VERIFY + payTo player)', () => {
    const resolved = arkade.resolveAsm(fullWinAsm(true, '$playerWp', '$pot'), args)
    expect(hex.encode(resolved)).toBe(hex.encode(current.playerWinFullArkadeScript))
  })

  it('creator-win full arkade-script (predicate + VERIFY + payTo house)', () => {
    const resolved = arkade.resolveAsm(fullWinAsm(false, '$houseWp', '$pot'), args)
    expect(hex.encode(resolved)).toBe(hex.encode(current.creatorWinFullArkadeScript))
  })

  it('refund-split arkade-script (payTo house VERIFY payTo player)', () => {
    const resolved = arkade.resolveAsm(
      splitAsm('$playerWp', '$playerStake', '$houseWp', '$houseStake'),
      args,
    )
    expect(hex.encode(resolved)).toBe(hex.encode(current.splitArkadeScript))
  })

  it('player-reveal arkade-script (payTo StageTwo pot)', () => {
    const resolved = arkade.resolveAsm(payToAsm('$stageTwoWp', '$pot'), args)
    expect(hex.encode(resolved)).toBe(hex.encode(current.revealArkadeScript))
  })
})

describe('artifact joint-pot contract: byte-identical to CoinflipJointPotScript', () => {
  const xonly = (b: number) => schnorr.getPublicKey(new Uint8Array(32).fill(b))
  const h = (b: number) => new Uint8Array(32).fill(b)
  const p2tr = (b: number) => new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(b)])
  // Two distinct game shapes: a 50/50 coin and a variable-odds game.
  const shapes = [
    { label: '50/50 coin', oddsN: 2, oddsTarget: 1, oddsLo: 0 },
    { label: 'variable odds', oddsN: 100, oddsTarget: 55, oddsLo: 0 },
  ]
  for (const shape of shapes) {
    const opts = {
      creatorPubkey: xonly(0x01),
      playerPubkey: xonly(0x02),
      serverPubkey: xonly(0x03),
      creatorHash: h(0xc0),
      playerHash: h(0xd0),
      finalExpiration: 1_900_000_000n,
      cancelDelay: 1_800_000_000n,
      exitDelay: 86_528n,
      oddsN: shape.oddsN,
      oddsTarget: shape.oddsTarget,
      oddsLo: shape.oddsLo,
      emulatorPubkey: xonly(0x04),
      playerPayoutPkScript: p2tr(0xa0),
      housePayoutPkScript: p2tr(0xb0),
      playerStake: 50_000n,
      houseStake: 50_000n,
    }
    it(`reproduces the exact pkScript (${shape.label})`, () => {
      const current = new CoinflipJointPotScript(opts)
      const artifact = buildJointPotArtifactContract(opts)
      expect(hex.encode(artifact.pkScript)).toBe(hex.encode(current.pkScript))
    })
    it(`reproduces all 8 leaf scripts in order (${shape.label})`, () => {
      const current = new CoinflipJointPotScript(opts)
      const artifact = buildJointPotArtifactContract(opts)
      const currentLeaves = [
        current.playerWinCovenantScriptHex,
        current.creatorWinCovenantScriptHex,
        current.playerRevealScriptHex,
        current.cooperativeSpendScriptHex,
        current.playerWinExitScriptHex,
        current.creatorWinExitScriptHex,
        current.playerForfeitExitScriptHex,
        current.cooperativeSpendExitScriptHex,
      ]
      expect(artifact.leafScriptsHex).toEqual(currentLeaves)
    })
  }
})
