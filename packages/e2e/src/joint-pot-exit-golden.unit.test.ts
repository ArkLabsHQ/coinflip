/**
 * Golden byte-vectors + guards for buildCooperativeSpendExitTx (leaf-7 on-chain
 * exit). Freezes the UNSIGNED split-back tx (PSBT) for the same two representative
 * games as joint-pot-golden — a byte drift here means the exit construction
 * changed (review as a protocol change). The construction was spike-validated
 * end-to-end on regtest (the built tx, signed player+creator, confirmed on-chain).
 */

/* eslint-disable @typescript-eslint/no-require-imports */
export {} // module scope: avoid TS2451 cross-file const redeclare under CI's fresh ts-jest compile
const { CoinflipJointPotScript, buildCooperativeSpendExitTx } = require('arkade-coinflip')
const { schnorr } = require('@noble/curves/secp256k1.js')
const { hex } = require('@scure/base')

const xonly = (b: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(b))
const h = (b: number): Uint8Array => new Uint8Array(32).fill(b)
// Real P2TR (valid on-curve x-only key) — btc-signer's addOutput validates the
// taproot key, and production payout scripts are real taproot addresses.
const p2tr = (b: number): Uint8Array => new Uint8Array([0x51, 0x20, ...xonly(b)])
const toHex = (u8: Uint8Array): string => Buffer.from(u8).toString('hex')

function optsFor(oddsN: number, oddsTarget: number, oddsLo: number) {
  return {
    creatorPubkey: xonly(1), playerPubkey: xonly(2), serverPubkey: xonly(3),
    creatorHash: h(0xc0), playerHash: h(0xd0),
    finalExpiration: 1_900_000_000n, cancelDelay: 1_800_000_000n, exitDelay: 86_528n,
    oddsN, oddsTarget, oddsLo, emulatorPubkey: xonly(4),
    playerPayoutPkScript: p2tr(0xa0), housePayoutPkScript: p2tr(0xb0),
    playerStake: 50_000n, houseStake: 50_000n,
  }
}

// The unrolled pot UTXO: value = playerStake + houseStake, a fixed outpoint.
const POT_ONCHAIN = { txid: 'aa'.repeat(32), vout: 0, value: 100_000 }
const FEE = 1_000n

function buildFor(oddsN: number, oddsTarget: number, oddsLo: number) {
  const o = optsFor(oddsN, oddsTarget, oddsLo)
  const pot = new CoinflipJointPotScript(o)
  const { tx } = buildCooperativeSpendExitTx({
    pot, potOnchain: POT_ONCHAIN, playerStake: o.playerStake, houseStake: o.houseStake,
    playerPayoutPkScript: o.playerPayoutPkScript, housePayoutPkScript: o.housePayoutPkScript,
    exitDelay: o.exitDelay, feeSats: FEE,
  })
  return { pot, tx }
}

// Frozen PSBT hex — captured from the spike-validated build (fill after first run).
const GOLDEN_PSBT: Record<string, string> = {
  coin: '70736274ff0100890200000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000a9004000025cc1000000000000225120d54cd37930b0c5587333d55bf4841843a922a5af7546818ba8ac2c5cfa2cf93d5cc1000000000000225120ad1d02fb804c18df3434bb8e259694120512c64136d877390d9eb46707fddec2000000000001012ba08601000000000022512034adf717a33b247b9b973e9450b4c39167e34c8035b3c65dbfea5d1b2b09923f8215c050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac00e00fb0065dd788246f1d645d3e958af1616d7a63fe51f419a0ff9fa82d0e404f94e1b40ed0424259342ef79d715f7f354853582047885d314392ae180a6f10e8c995f890cd6ce28493654b27deaee17cfc91c541883180a975d9e27c0a6e7774b03a90040b275204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad201b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078facc0000000',
  vodds: '70736274ff0100890200000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000a9004000025cc1000000000000225120d54cd37930b0c5587333d55bf4841843a922a5af7546818ba8ac2c5cfa2cf93d5cc1000000000000225120ad1d02fb804c18df3434bb8e259694120512c64136d877390d9eb46707fddec2000000000001012ba086010000000000225120ac131512771941c427ea6b093e8e7c92f373bebbb426e145c46d0255c8c6da278215c150929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac00e00fb0065dd788246f1d645d3e958af1616d7a63fe51f419a0ff9fa82d0e404774895b5558d63e777caf4619ecc941d5d5e1a5c63e4dc30b19a500e1205febb75520d84b96b0e28ca831019cdfd55e5c78ec40a85ca01eb4d895271d1a9888e4b03a90040b275204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad201b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078facc0000000',
}

describe('buildCooperativeSpendExitTx: golden + guards', () => {
  it('coin: frozen split-back PSBT', () => {
    const { tx } = buildFor(2, 1, 0)
    expect(toHex(tx.toPSBT())).toBe(GOLDEN_PSBT.coin)
  })
  it('vodds: frozen split-back PSBT', () => {
    const { tx } = buildFor(100, 55, 0)
    expect(toHex(tx.toPSBT())).toBe(GOLDEN_PSBT.vodds)
  })

  it('splits the pot back to both payout scripts minus half the fee each', () => {
    const { tx } = buildFor(2, 1, 0)
    expect(tx.outputsLength).toBe(2)
    expect(tx.getOutput(0).amount).toBe(50_000n - 500n) // player stake − fee/2
    expect(tx.getOutput(1).amount).toBe(50_000n - 500n) // house stake − fee/2
    expect(toHex(tx.getOutput(0).script)).toBe(toHex(p2tr(0xa0)))
    expect(toHex(tx.getOutput(1).script)).toBe(toHex(p2tr(0xb0)))
  })

  it('sets the exit CSV sequence (86528s → 0x4000a9, time-based)', () => {
    const { tx } = buildFor(2, 1, 0)
    expect(tx.getInput(0).sequence).toBe(0x4000a9)
  })

  it('rejects stakes that do not sum to the pot value', () => {
    const o = optsFor(2, 1, 0)
    expect(() => buildCooperativeSpendExitTx({
      pot: new CoinflipJointPotScript(o), potOnchain: POT_ONCHAIN,
      playerStake: 40_000n, houseStake: 50_000n, // 90k ≠ 100k
      playerPayoutPkScript: o.playerPayoutPkScript, housePayoutPkScript: o.housePayoutPkScript,
      exitDelay: o.exitDelay, feeSats: FEE,
    })).toThrow(/must equal the pot value/)
  })

  it('rejects a non-positive fee and a fee that exceeds a stake', () => {
    const o = optsFor(2, 1, 0)
    const base = {
      pot: new CoinflipJointPotScript(o), potOnchain: POT_ONCHAIN,
      playerStake: o.playerStake, houseStake: o.houseStake,
      playerPayoutPkScript: o.playerPayoutPkScript, housePayoutPkScript: o.housePayoutPkScript,
      exitDelay: o.exitDelay,
    }
    expect(() => buildCooperativeSpendExitTx({ ...base, feeSats: 0n })).toThrow(/feeSats must be positive/)
    expect(() => buildCooperativeSpendExitTx({ ...base, feeSats: 200_000n })).toThrow(/fee exceeds a funder stake/)
  })
})
