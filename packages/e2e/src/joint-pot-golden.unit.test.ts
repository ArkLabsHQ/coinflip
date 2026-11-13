import { CoinflipJointPotScript, type CoinflipJointPotOptions } from 'arkade-coinflip'
import { contractOptions, payout, toHex, xonly } from './test-helpers/coinflip-fixture'

describe('compiled game constructor commitments', () => {
  const base = new CoinflipJointPotScript(contractOptions())
  const changes: [string, Partial<CoinflipJointPotOptions>][] = [
    ['player', { playerPubkey: xonly(7) }],
    ['house', { creatorPubkey: xonly(7) }],
    ['operator', { serverPubkey: xonly(7) }],
    ['emulator', { emulatorPubkey: xonly(7) }],
    ['player commitment', { playerHash: new Uint8Array(32).fill(1) }],
    ['house commitment', { creatorHash: new Uint8Array(32).fill(1) }],
    ['player payout', { playerPayoutPkScript: payout(7) }],
    ['house payout', { housePayoutPkScript: payout(7) }],
    ['player stake', { playerStake: 50_001n }],
    ['house stake', { houseStake: 50_001n }],
    ['odds denominator', { oddsN: 6 }],
    ['odds interval', { oddsN: 6, oddsLo: 2, oddsTarget: 3 }],
    ['refund deadline', { cancelDelay: 1_800_000_001n }],
    ['contest deadline', { finalExpiration: 1_900_000_001n }],
    ['exit delay', { exitDelay: 87_040n }],
  ]

  it.each(changes)('changing %s creates a different funded script', (_label, change) => {
    expect(toHex(new CoinflipJointPotScript(contractOptions(change)).pkScript)).not.toBe(toHex(base.pkScript))
  })

  it.each([
    { oddsN: 2, oddsLo: 0, oddsTarget: 1 },
    { oddsN: 6, oddsLo: 3, oddsTarget: 6 },
    { oddsN: 128, oddsLo: 10, oddsTarget: 120 },
  ])('independently instantiated games agree for odds %j', odds => {
    const a = new CoinflipJointPotScript(contractOptions(odds))
    const b = new CoinflipJointPotScript(contractOptions(odds))
    expect(toHex(a.pkScript)).toBe(toHex(b.pkScript))
    expect(toHex(a.stageTwo.pkScript)).toBe(toHex(b.stageTwo.pkScript))
    expect(a.encode()).toEqual(b.encode())
  })
})
