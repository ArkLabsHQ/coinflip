/**
 * Structural unit test for buildPenaltyTransaction — no regtest, no signing.
 *
 * Verifies that the builder (now a clean mirror of buildSweepTransaction
 * because the playerPenalty leaf is a recognised ConditionCSVMultisigTapscript):
 *   - creates a tx with 2 inputs, each using the playerPenalty() leaf
 *   - creates exactly 1 non-anchor output for the full pot (no rake split)
 *   - the output value equals the sum of escrow values
 *   - the output script equals the decoded payoutAddress.pkScript
 *   - returns a non-empty checkpoints array
 *
 * STRUCTURAL ONLY: spend validity (CSV gating, witness, arkd cosign) is
 * verified separately in the regtest task (currently gated).
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { CoinflipEscrowScript } = require('arkade-coinflip')
const { buildPenaltyTransaction } = require('arkade-coinflip')
const { ArkAddress } = require('@arkade-os/sdk')
const { hex } = require('@scure/base')

// ---------------------------------------------------------------------------
// Deterministic x-only pubkeys derived from known private keys via secp256k1.
// These are real curve points so VtxoScript / ArkAddress accept them without
// "wrong pubkey" errors. The private keys are chosen to avoid the trivial
// scalar 1 (which maps to the secp256k1 generator).
// ---------------------------------------------------------------------------
const secp = require('@noble/secp256k1')

function xOnly(privHex: string): Uint8Array {
  const pub = secp.getPublicKey(hex.decode(privHex), true) as Uint8Array
  return pub.slice(1) // 32-byte x-only
}

// Private keys: minimal non-trivial scalars with distinct values.
const PRIV_PLAYER  = '0101010101010101010101010101010101010101010101010101010101010101'
const PRIV_CREATOR = '0202020202020202020202020202020202020202020202020202020202020202'
const PRIV_SERVER  = '0303030303030303030303030303030303030303030303030303030303030303'
const PRIV_PAYOUT  = '0404040404040404040404040404040404040404040404040404040404040404'

const playerPubkey  = xOnly(PRIV_PLAYER)
const creatorPubkey = xOnly(PRIV_CREATOR)
const serverPubkey  = xOnly(PRIV_SERVER)
const payoutPubkey  = xOnly(PRIV_PAYOUT)

// 32-byte hashes — content doesn't matter for structural tests.
const playerHash  = new Uint8Array(32).fill(0x44)
const creatorHash = new Uint8Array(32).fill(0x55)

const penaltyTimelockSeconds = 1024n
const finalExpiration        = 1800n

// ---------------------------------------------------------------------------
// A valid mock arkInfo.checkpointTapscript: a CSVMultisigTapscript(144 blocks,
// [serverPubkey, payoutPubkey]) encoded as hex. We re-encode at runtime so it
// stays consistent with the actual pubkeys.
// ---------------------------------------------------------------------------
const { CSVMultisigTapscript } = require('@arkade-os/sdk')
const checkpointTapscript: string = hex.encode(
  (CSVMultisigTapscript.encode({
    timelock: { type: 'blocks', value: 144 },
    pubkeys: [serverPubkey, payoutPubkey],
  }) as { script: Uint8Array }).script,
)

const arkInfo = { checkpointTapscript } as { checkpointTapscript: string }

// ---------------------------------------------------------------------------
// Ark address for the payout output.
// DefaultVtxo uses pubKey + serverPubKey to build a p2tr script; it MUST be a
// valid curve point or the SDK throws "wrong pubkey".
// ---------------------------------------------------------------------------
const { DefaultVtxo } = require('@arkade-os/sdk')
const payoutScript = new DefaultVtxo.Script({ pubKey: payoutPubkey, serverPubKey: serverPubkey })
const payoutAddress: string = payoutScript.address('rark', serverPubkey).encode()

// ---------------------------------------------------------------------------
// CoinflipEscrowScript fixtures.
// Two escrows share the same win/penalty leaves (same keys & hashes) but differ
// ONLY in refundPubkey (player for player-escrow, creator for house-escrow).
// ---------------------------------------------------------------------------
const sharedOpts = {
  creatorPubkey,
  playerPubkey,
  serverPubkey,
  creatorHash,
  playerHash,
  finalExpiration,
  penaltyTimelockSeconds,
  oddsN: 300,
  oddsTarget: 300,
  oddsLo: 100,
}

const playerEscrowScript = new CoinflipEscrowScript({ ...sharedOpts, refundPubkey: playerPubkey })
const houseEscrowScript  = new CoinflipEscrowScript({ ...sharedOpts, refundPubkey: creatorPubkey })

// Two distinct txids (32 bytes, different fills)
const txid1 = 'a'.repeat(64) // represents player escrow
const txid2 = 'b'.repeat(64) // represents house escrow

const playerEscrow = { script: playerEscrowScript, txid: txid1, vout: 0, value: 1000 }
const houseEscrow  = { script: houseEscrowScript,  txid: txid2, vout: 0, value: 970  }
const pot = playerEscrow.value + houseEscrow.value // 1970

describe('buildPenaltyTransaction (R1 forfeit, structural)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any

  beforeAll(() => {
    result = buildPenaltyTransaction(arkInfo, 'rark', {
      escrows: [houseEscrow, playerEscrow],
      payoutAddress,
    })
  })

  it('returns an arkTx with exactly 2 inputs', () => {
    expect(result.arkTx.inputsLength).toBe(2)
  })

  it('each input uses the playerPenalty() leaf (not playerWin/creatorWin/refund)', () => {
    const penaltyLeafPlayer  = playerEscrowScript.playerPenalty()
    const penaltyLeafHouse   = houseEscrowScript.playerPenalty()

    // Input 0 → houseEscrow (first in the escrows array passed to builder)
    const in0Leaf  = result.arkTx.getInput(0).tapLeafScript[0]
    const in0Bytes = in0Leaf[1] as Uint8Array
    expect(hex.encode(in0Bytes)).toBe(hex.encode(penaltyLeafHouse[1] as Uint8Array))

    // Input 1 → playerEscrow (second in the escrows array)
    const in1Leaf  = result.arkTx.getInput(1).tapLeafScript[0]
    const in1Bytes = in1Leaf[1] as Uint8Array
    expect(hex.encode(in1Bytes)).toBe(hex.encode(penaltyLeafPlayer[1] as Uint8Array))

    // Neither leaf is playerWin, creatorWin, or refund.
    expect(hex.encode(in0Bytes)).not.toBe(hex.encode(houseEscrowScript.playerWin()[1] as Uint8Array))
    expect(hex.encode(in0Bytes)).not.toBe(hex.encode(houseEscrowScript.creatorWin()[1] as Uint8Array))
    expect(hex.encode(in0Bytes)).not.toBe(hex.encode(houseEscrowScript.refund()[1] as Uint8Array))
  })

  it('has exactly 1 non-anchor output (the full pot, no rake split)', () => {
    // buildOffchainTx adds a P2A anchor output (amount === 0n) — that does
    // NOT count as a payout output. Assert that only one non-zero output exists
    // (the payout; no rake split).
    let nonAnchorCount = 0
    for (let i = 0; i < result.arkTx.outputsLength; i++) {
      const amt = result.arkTx.getOutput(i).amount as bigint
      if (amt > 0n) nonAnchorCount++
    }
    expect(nonAnchorCount).toBe(1)
  })

  it('the non-anchor output value equals the sum of both escrow values', () => {
    // Find the single non-anchor output and check its value.
    let payoutAmount: bigint | undefined
    for (let i = 0; i < result.arkTx.outputsLength; i++) {
      const amt = result.arkTx.getOutput(i).amount as bigint
      if (amt > 0n) {
        payoutAmount = amt
        break
      }
    }
    expect(payoutAmount).toBe(BigInt(pot))
  })

  it('the non-anchor output script equals ArkAddress.decode(payoutAddress).pkScript', () => {
    const expectedScript = ArkAddress.decode(payoutAddress).pkScript as Uint8Array
    let actualScript: Uint8Array | undefined
    for (let i = 0; i < result.arkTx.outputsLength; i++) {
      const amt = result.arkTx.getOutput(i).amount as bigint
      if (amt > 0n) {
        actualScript = result.arkTx.getOutput(i).script as Uint8Array
        break
      }
    }
    expect(actualScript).toBeDefined()
    expect(hex.encode(actualScript!)).toBe(hex.encode(expectedScript))
  })

  it('returns a non-empty checkpoints array', () => {
    expect(Array.isArray(result.checkpoints)).toBe(true)
    expect(result.checkpoints.length).toBeGreaterThanOrEqual(1)
  })
})

// Force TypeScript to treat this file as a module so top-level `const`
// declarations don't conflict with identically-named constants in
// script-structural.test.ts (which shares some fixture names).
export {}
