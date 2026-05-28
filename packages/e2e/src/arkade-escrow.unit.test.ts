/**
 * Encoding-level tests for the arkade-script-augmented CoinflipEscrowScript.
 *
 * Verifies (without regtest):
 *  - 4-leaf layout when no `arkadeForfeit` config is passed (backwards compat).
 *  - 5-leaf layout + new `playerForfeit()` leaf when config is supplied.
 *  - Adding the 5th leaf produces a DIFFERENT taptree (different escrow
 *    address) — confirms the leaf actually lands in the tree.
 *  - The 5th leaf is a `CLTVMultisigTapscript` over `[player, server,
 *    emulator_tweaked]` — execution bucket, the architectural point of
 *    the whole exercise.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { hex } = require('@scure/base')
const { schnorr } = require('@noble/curves/secp256k1.js')
const { decodeTapscript } = require('@arkade-os/sdk')
const {
  CoinflipEscrowScript,
  computeArkadeScriptPublicKey,
  buildForfeitArkadeScript,
} = require('arkade-coinflip')

const REGTEST_HRP = 'tark'

function newKey(seed: number): Uint8Array {
  return schnorr.getPublicKey(new Uint8Array(32).fill(seed))
}

const CREATOR_PK = newKey(0x10)
const PLAYER_PK = newKey(0x20)
const SERVER_PK = newKey(0x30)
const EMULATOR_PK = newKey(0x40)
const CREATOR_HASH = new Uint8Array(32).fill(0xaa)
const PLAYER_HASH = new Uint8Array(32).fill(0xbb)
const FINAL_EXP = 2_000_000_000n
const PAY_PKSCRIPT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x77)])

function baseOpts() {
  return {
    creatorPubkey: CREATOR_PK,
    playerPubkey: PLAYER_PK,
    serverPubkey: SERVER_PK,
    creatorHash: CREATOR_HASH,
    playerHash: PLAYER_HASH,
    finalExpiration: FINAL_EXP,
    penaltyTimelockSeconds: 1024n,
    refundPubkey: PLAYER_PK,
  }
}

describe('CoinflipEscrowScript: backwards compatibility (no arkadeForfeit)', () => {
  it('exposes the legacy 4 leaves; playerForfeit() throws', () => {
    const s = new CoinflipEscrowScript(baseOpts())
    expect(s.playerForfeitScriptHex).toBeUndefined()
    expect(s.forfeitArkadeScript).toBeUndefined()
    // Calling these does not throw.
    s.creatorWin()
    s.playerWin()
    s.refund()
    s.playerPenalty()
    expect(() => s.playerForfeit()).toThrow(/arkadeForfeit/)
  })
})

describe('CoinflipEscrowScript: with arkadeForfeit config', () => {
  it('adds a 5th playerForfeit leaf and changes the address', () => {
    const without = new CoinflipEscrowScript(baseOpts())
    const withCfg = new CoinflipEscrowScript({
      ...baseOpts(),
      arkadeForfeit: {
        emulatorPubkey: EMULATOR_PK,
        forfeitDestPkScript: PAY_PKSCRIPT,
        forfeitDestValue: 50_000n,
      },
    })

    expect(withCfg.playerForfeitScriptHex).toBeDefined()
    expect(withCfg.forfeitArkadeScript).toBeDefined()

    // Addresses differ — confirms the 5th leaf actually lands in the tree.
    const a1 = without.address(REGTEST_HRP, SERVER_PK).encode()
    const a2 = withCfg.address(REGTEST_HRP, SERVER_PK).encode()
    expect(a2).not.toBe(a1)
  })

  it('forfeit leaf is CLTVMultisig over [player, server, emulator_tweaked]', () => {
    const s = new CoinflipEscrowScript({
      ...baseOpts(),
      arkadeForfeit: {
        emulatorPubkey: EMULATOR_PK,
        forfeitDestPkScript: PAY_PKSCRIPT,
        forfeitDestValue: 50_000n,
      },
    })

    const tweaked = computeArkadeScriptPublicKey(EMULATOR_PK, s.forfeitArkadeScript)
    const leafBytes = hex.decode(s.playerForfeitScriptHex)
    const decoded = decodeTapscript(leafBytes)

    // CLTVMultisigTapscript — the execution-bucket closure. This is the
    // entire architectural point of the arkade-script approach.
    expect(decoded.type).toBe('cltv-multisig')
    expect(decoded.params.absoluteTimelock).toBe(FINAL_EXP)
    const pubkeyHexes = decoded.params.pubkeys.map((pk: Uint8Array) => hex.encode(pk))
    expect(pubkeyHexes).toEqual([
      hex.encode(PLAYER_PK),
      hex.encode(SERVER_PK),
      hex.encode(tweaked),
    ])
  })

  it('arkade script is the canonical enforcePayTo for (destPkScript, destValue)', () => {
    const s = new CoinflipEscrowScript({
      ...baseOpts(),
      arkadeForfeit: {
        emulatorPubkey: EMULATOR_PK,
        forfeitDestPkScript: PAY_PKSCRIPT,
        forfeitDestValue: 50_000n,
      },
    })
    const expected = buildForfeitArkadeScript(PAY_PKSCRIPT, 50_000n)
    expect(hex.encode(s.forfeitArkadeScript)).toBe(hex.encode(expected))
  })

  it('changing destValue or destPkScript reshapes the tree (covenant binding)', () => {
    const s1 = new CoinflipEscrowScript({
      ...baseOpts(),
      arkadeForfeit: {
        emulatorPubkey: EMULATOR_PK,
        forfeitDestPkScript: PAY_PKSCRIPT,
        forfeitDestValue: 50_000n,
      },
    })
    const s2 = new CoinflipEscrowScript({
      ...baseOpts(),
      arkadeForfeit: {
        emulatorPubkey: EMULATOR_PK,
        forfeitDestPkScript: PAY_PKSCRIPT,
        forfeitDestValue: 60_000n,
      },
    })
    const s3 = new CoinflipEscrowScript({
      ...baseOpts(),
      arkadeForfeit: {
        emulatorPubkey: EMULATOR_PK,
        forfeitDestPkScript: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x88)]),
        forfeitDestValue: 50_000n,
      },
    })
    const a1 = s1.address(REGTEST_HRP, SERVER_PK).encode()
    const a2 = s2.address(REGTEST_HRP, SERVER_PK).encode()
    const a3 = s3.address(REGTEST_HRP, SERVER_PK).encode()
    expect(a1).not.toBe(a2)
    expect(a1).not.toBe(a3)
    expect(a2).not.toBe(a3)
  })

  it('legacy playerPenalty CSV leaf remains alongside the new forfeit leaf', () => {
    const s = new CoinflipEscrowScript({
      ...baseOpts(),
      arkadeForfeit: {
        emulatorPubkey: EMULATOR_PK,
        forfeitDestPkScript: PAY_PKSCRIPT,
        forfeitDestValue: 50_000n,
      },
    })
    // playerPenalty (CSV) must still be findable so the fallback path is
    // available — clients without emulator support keep working.
    const csvLeaf = decodeTapscript(hex.decode(s.playerPenaltyScriptHex))
    expect(csvLeaf.type).toBe('condition-csv-multisig')
  })
})
