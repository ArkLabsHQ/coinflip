/**
 * Structural unit tests for CoinflipEscrowScript's tapleaves — no regtest.
 *
 * Pins the bytewise shape of the `playerPenalty` leaf added for audit
 * finding R1 (the house's withholding penalty). The leaf is now a
 * recognised `ConditionCSVMultisigTapscript`:
 *
 *   <buildHashCheckScript(playerHash)> OP_VERIFY
 *     <sequence(penaltyTimelockSeconds)> OP_CSV OP_DROP
 *       <playerPubkey> CHECKSIGVERIFY <serverPubkey> CHECKSIG
 *
 * Asserting the whole leaf script byte-for-byte against the SDK encoder is a
 * stronger structural check than a split prefix/suffix match — it proves the
 * leaf is exactly what the SDK would have produced for these inputs (which
 * is also what makes `decodeTapscript` accept it and `buildOffchainTx` handle
 * spends through it).
 *
 * STRUCTURAL ONLY: spend validity (CSV gating, witness, arkd cosign) is
 * verified separately in the regtest task (currently gated).
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { OP } = require('@scure/btc-signer')
const { ConditionCSVMultisigTapscript } = require('@arkade-os/sdk')
const { CoinflipEscrowScript } = require('arkade-coinflip')

// 32-byte distinct test pubkeys/hashes — script structure doesn't validate the
// curve, this is byte-shape testing only.
const playerPubkey = new Uint8Array(32).fill(0x11)
const creatorPubkey = new Uint8Array(32).fill(0x22)
const serverPubkey = new Uint8Array(32).fill(0x33)
const playerHash = new Uint8Array(32).fill(0x44)
const creatorHash = new Uint8Array(32).fill(0x55)

const penaltyTimelockSeconds = 1024n
const finalExpiration = 1800n

describe('CoinflipEscrowScript.playerPenalty (R1 forfeit leaf)', () => {
  const s = new CoinflipEscrowScript({
    creatorPubkey,
    playerPubkey,
    serverPubkey,
    creatorHash,
    playerHash,
    finalExpiration,
    penaltyTimelockSeconds,
    refundPubkey: playerPubkey,
    oddsN: 300,
    oddsTarget: 300,
    oddsLo: 100,
  })

  // Helper: pull the raw script bytes (no leaf-version trailer) via the
  // ScriptHex accessor — that's the canonical script the leaf was built from,
  // before `findLeaf` appends the tapleaf version (0xc0) for TapLeafScript.
  const hexToBytes = (h: string): Uint8Array => {
    const out = new Uint8Array(h.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
    return out
  }

  it('exposes a playerPenalty() accessor returning a TapLeafScript', () => {
    const leaf = s.playerPenalty()
    expect(leaf).toBeDefined()
    // TapLeafScript is a 2-tuple [{version, internalKey, merklePath?}, scriptBytes]
    // in the SDK; sanity-check the tuple shape.
    expect(Array.isArray(leaf)).toBe(true)
    expect(leaf.length).toBe(2)
    expect(leaf[1]).toBeInstanceOf(Uint8Array)
    // playerPenaltyScriptHex (the source script, no leaf-version trailer) is
    // also exposed for downstream tx builders.
    expect(typeof s.playerPenaltyScriptHex).toBe('string')
    expect(s.playerPenaltyScriptHex.length).toBeGreaterThan(0)
  })

  it('produces a script distinct from playerWin/creatorWin/refund', () => {
    expect(s.playerPenaltyScriptHex).not.toBe(s.playerWinScriptHex)
    expect(s.playerPenaltyScriptHex).not.toBe(s.creatorWinScriptHex)
    expect(s.playerPenaltyScriptHex).not.toBe(s.refundScriptHex)
  })

  it('equals ConditionCSVMultisigTapscript.encode({hashCheck(playerHash), CSV(penaltyTimelockSeconds, "seconds"), [player, server]}).script', () => {
    // Reconstruct the expected leaf via the SDK encoder. The hash-check
    // condition is `OP_SHA256 0x20 <playerHash> OP_EQUAL` (no VERIFY — the
    // encoder appends its own VERIFY after the conditionScript).
    const conditionScript = new Uint8Array([
      OP.SHA256,
      0x20,
      ...playerHash,
      OP.EQUAL,
    ])
    const expected = ConditionCSVMultisigTapscript.encode({
      conditionScript,
      timelock: { value: penaltyTimelockSeconds, type: 'seconds' },
      pubkeys: [playerPubkey, serverPubkey],
    }).script as Uint8Array

    const actual = hexToBytes(s.playerPenaltyScriptHex)
    expect(actual.length).toBe(expected.length)
    // byte-by-byte comparison
    for (let i = 0; i < expected.length; i++) {
      expect(actual[i]).toBe(expected[i])
    }
  })
})
