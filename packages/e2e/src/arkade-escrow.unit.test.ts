/**
 * Tests for the single-path, covenant-only `CoinflipEscrowScript`.
 *
 * Four leaves, all required: playerWinCovenant, creatorWinCovenant,
 * playerForfeit, refund. No optional arkadeForfeit, no legacy fallback.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { hex } = require('@scure/base')
const { schnorr } = require('@noble/curves/secp256k1.js')
const { decodeTapscript } = require('@arkade-os/sdk')
const { CoinflipEscrowScript, computeArkadeScriptPublicKey } = require('arkade-coinflip')

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
const PLAYER_PAYOUT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x77)])
const HOUSE_PAYOUT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x88)])
const PLAYER_STAKE = 50_000n
const HOUSE_STAKE = 30_000n

function makeEscrow(refundPubkey: Uint8Array = PLAYER_PK) {
  return new CoinflipEscrowScript({
    creatorPubkey: CREATOR_PK,
    playerPubkey: PLAYER_PK,
    serverPubkey: SERVER_PK,
    creatorHash: CREATOR_HASH,
    playerHash: PLAYER_HASH,
    finalExpiration: FINAL_EXP,
    refundPubkey,
    arkadeForfeit: {
      emulatorPubkey: EMULATOR_PK,
      playerPayoutPkScript: PLAYER_PAYOUT,
      housePayoutPkScript: HOUSE_PAYOUT,
      playerStake: PLAYER_STAKE,
      houseStake: HOUSE_STAKE,
    },
  })
}

describe('CoinflipEscrowScript: 4 leaves, all covenant-bound', () => {
  it('exposes the four required leaf accessors', () => {
    const s = makeEscrow()
    s.playerWinCovenant()
    s.creatorWinCovenant()
    s.playerForfeit()
    s.refund()
  })

  it('all three covenant arkade scripts are defined', () => {
    const s = makeEscrow()
    expect(s.playerWinCovenantArkadeScript).toBeDefined()
    expect(s.creatorWinCovenantArkadeScript).toBeDefined()
    expect(s.forfeitArkadeScript).toBeDefined()
  })

  it('playerWinCovenant + creatorWinCovenant are ConditionMultisig[server, emu_tweaked]', () => {
    const s = makeEscrow()
    const pwc = decodeTapscript(hex.decode(s.playerWinCovenantScriptHex))
    const cwc = decodeTapscript(hex.decode(s.creatorWinCovenantScriptHex))
    expect(pwc.type).toBe('condition-multisig')
    expect(cwc.type).toBe('condition-multisig')
    // Multisig is [server, emulator_tweaked] — no winner key required.
    expect(pwc.params.pubkeys).toHaveLength(2)
    expect(cwc.params.pubkeys).toHaveLength(2)
    expect(hex.encode(pwc.params.pubkeys[0])).toBe(hex.encode(SERVER_PK))
    expect(hex.encode(cwc.params.pubkeys[0])).toBe(hex.encode(SERVER_PK))
    // The emulator-tweaked key in slot 1 differs per leaf (different arkade scripts).
    expect(hex.encode(pwc.params.pubkeys[1])).not.toBe(hex.encode(cwc.params.pubkeys[1]))
    // And matches what computeArkadeScriptPublicKey produces.
    expect(hex.encode(pwc.params.pubkeys[1])).toBe(
      hex.encode(computeArkadeScriptPublicKey(EMULATOR_PK, s.playerWinCovenantArkadeScript)),
    )
    expect(hex.encode(cwc.params.pubkeys[1])).toBe(
      hex.encode(computeArkadeScriptPublicKey(EMULATOR_PK, s.creatorWinCovenantArkadeScript)),
    )
  })

  it('playerForfeit is CLTVMultisig[player, server, emu_tweaked] at finalExpiration', () => {
    const s = makeEscrow()
    const f = decodeTapscript(hex.decode(s.playerForfeitScriptHex))
    expect(f.type).toBe('cltv-multisig')
    expect(f.params.absoluteTimelock).toBe(FINAL_EXP)
    expect(f.params.pubkeys).toHaveLength(3)
    expect(hex.encode(f.params.pubkeys[0])).toBe(hex.encode(PLAYER_PK))
    expect(hex.encode(f.params.pubkeys[1])).toBe(hex.encode(SERVER_PK))
    expect(hex.encode(f.params.pubkeys[2])).toBe(
      hex.encode(computeArkadeScriptPublicKey(EMULATOR_PK, s.forfeitArkadeScript)),
    )
  })

  it('refund is CLTVMultisig[funder, server] at finalExpiration', () => {
    const playerEscrow = makeEscrow(PLAYER_PK)
    const houseEscrow = makeEscrow(CREATOR_PK)
    const pr = decodeTapscript(hex.decode(playerEscrow.refundScriptHex))
    const hr = decodeTapscript(hex.decode(houseEscrow.refundScriptHex))
    expect(pr.type).toBe('cltv-multisig')
    expect(hr.type).toBe('cltv-multisig')
    expect(pr.params.pubkeys).toHaveLength(2)
    expect(hex.encode(pr.params.pubkeys[0])).toBe(hex.encode(PLAYER_PK))
    expect(hex.encode(hr.params.pubkeys[0])).toBe(hex.encode(CREATOR_PK))
  })

  it('player vs house escrow taproot addresses differ (owner-scoped refund leaf)', () => {
    const pl = makeEscrow(PLAYER_PK)
    const ho = makeEscrow(CREATOR_PK)
    expect(pl.address(REGTEST_HRP, SERVER_PK).encode()).not.toBe(
      ho.address(REGTEST_HRP, SERVER_PK).encode(),
    )
  })

  it('covenant arkade scripts all start with INSPECTINPUTVALUE (atomic-sweep)', () => {
    const s = makeEscrow()
    const ARKADE_INSPECTINPUTVALUE = 0xc9
    expect(s.playerWinCovenantArkadeScript[0]).toBe(ARKADE_INSPECTINPUTVALUE)
    expect(s.creatorWinCovenantArkadeScript[0]).toBe(ARKADE_INSPECTINPUTVALUE)
    expect(s.forfeitArkadeScript[0]).toBe(ARKADE_INSPECTINPUTVALUE)
  })

  it('playerWin + playerForfeit covenants both bind PLAYER_PAYOUT; creatorWin binds HOUSE_PAYOUT', () => {
    const s = makeEscrow()
    // Easiest signal: scripts that bind the SAME destination are byte-equal
    // when their other-stake matches (both pin pot + same other-stake).
    expect(hex.encode(s.playerWinCovenantArkadeScript)).toBe(
      hex.encode(s.forfeitArkadeScript),
    )
    expect(hex.encode(s.creatorWinCovenantArkadeScript)).not.toBe(
      hex.encode(s.playerWinCovenantArkadeScript),
    )
  })
})
