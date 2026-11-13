import { Transaction } from '@arkade-os/sdk'
import { CoinflipJointPotScript, buildCooperativeSpendExitTx } from 'arkade-coinflip'
import { contractOptions, secretKey, toHex } from './test-helpers/coinflip-fixture'
const { schnorr } = require('@noble/curves/secp256k1.js')

const outpoint = { txid: 'aa'.repeat(32), vout: 0, value: 100_000 }

function build(oddsN = 2, oddsTarget = 1, feeSats = 1000n) {
  const options = contractOptions({ oddsN, oddsTarget })
  const pot = new CoinflipJointPotScript(options)
  const args = {
    pot, potOnchain: outpoint, playerStake: options.playerStake, houseStake: options.houseStake,
    playerPayoutPkScript: options.playerPayoutPkScript, housePayoutPkScript: options.housePayoutPkScript,
    exitDelay: options.exitDelay, feeSats,
  }
  return { ...buildCooperativeSpendExitTx(args), pot, args, options }
}

describe('compiled cooperative exit transaction', () => {
  it.each([[2, 1], [100, 55]])('binds the actual compiled pot for odds %s/%s', (n, target) => {
    const { tx, pot } = build(n, target)
    expect(toHex(tx.getInput(0).witnessUtxo!.script)).toBe(toHex(pot.pkScript))
    expect(tx.getInput(0).witnessUtxo!.amount).toBe(100_000n)
    expect(tx.getInput(0).tapLeafScript).toEqual([pot.cooperativeSpendExit()])
    expect(tx.getInput(0).sequence).toBe(0x4000a9)
    expect(tx.toPSBT()).toEqual(build(n, target).tx.toPSBT())
  })

  it('splits both stakes and assigns the odd fee sat to the house', () => {
    const { tx, options } = build(2, 1, 1001n)
    expect(tx.outputsLength).toBe(2)
    expect(tx.getOutput(0).amount).toBe(49_500n)
    expect(tx.getOutput(1).amount).toBe(49_499n)
    expect(toHex(tx.getOutput(0).script!)).toBe(toHex(options.playerPayoutPkScript))
    expect(toHex(tx.getOutput(1).script!)).toBe(toHex(options.housePayoutPkScript))
  })

  it('requires both actual funder signatures and commits them to the payout transaction', () => {
    const { tx, pot, options } = build()
    tx.signIdx(secretKey(2), 0)
    const oneSignature = Transaction.fromPSBT(tx.toPSBT())
    oneSignature.finalize()
    expect(oneSignature.getInput(0).finalScriptWitness).toHaveLength(3)
    tx.signIdx(secretKey(1), 0)
    const digest = tx.preimageWitnessV1(0, [pot.pkScript], 0, [100_000n], undefined,
      pot.functionByName('cooperativeSpendExit')!.leafScript, 0xc0)
    const signatures = tx.getInput(0).tapScriptSig!
    expect(signatures).toHaveLength(2)
    for (const [key, signature] of signatures) {
      expect(schnorr.verify(signature, digest, key.pubKey)).toBe(true)
      expect([toHex(options.playerPubkey), toHex(options.creatorPubkey)]).toContain(toHex(key.pubKey))
    }
    tx.finalize()
    expect(tx.isFinal).toBe(true)
    expect(tx.getInput(0).finalScriptWitness).toHaveLength(4)
    expect(tx.hex.length).toBeGreaterThan(0)
  })

  it('rejects stakes that do not sum to the unrolled value', () => {
    const { args } = build()
    expect(() => buildCooperativeSpendExitTx({ ...args, playerStake: 40_000n })).toThrow(/must equal the pot value/)
  })

  it('rejects non-positive fees and fees consuming either stake', () => {
    const { args } = build()
    expect(() => buildCooperativeSpendExitTx({ ...args, feeSats: 0n })).toThrow(/feeSats must be positive/)
    expect(() => buildCooperativeSpendExitTx({ ...args, feeSats: 200_000n })).toThrow(/fee exceeds a funder stake/)
  })
})
