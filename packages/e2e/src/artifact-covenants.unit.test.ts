import { readFileSync } from 'fs'
import { resolve } from 'path'
import { CoinflipJointPotScript, coinflipProgram, contestProgram } from 'arkade-coinflip'
import { contractOptions, toHex } from './test-helpers/coinflip-fixture'

describe('compiler artifact provenance and continuation', () => {
  it.each(['coinflip', 'contest'])('%s artifact carries the exact current source bundle', name => {
    const artifact = JSON.parse(readFileSync(resolve(__dirname, '../../lib/src/artifact', `${name}.json`), 'utf8'))
    expect(artifact.compiler).toEqual({ name: 'arkadec', version: '0.1.0-rc.1', options: { optimize: true } })
    expect(artifact.source.entry).toBe(`${name}.ark`)
    for (const [path, source] of Object.entries(artifact.source.files)) {
      expect(source).toBe(readFileSync(resolve(__dirname, '../../..', 'contracts', path), 'utf8').replace(/\r\n/g, '\n'))
    }
  })

  it('binds exactly one compiled contest continuation before the pot is funded', () => {
    const pot = new CoinflipJointPotScript(contractOptions())
    const childFields = (coinflipProgram.params ?? []).filter(p => p.name.startsWith('contract_'))
    expect(childFields).toHaveLength(1)
    expect(toHex(pot.args[childFields[0].name] as Uint8Array)).toBe(toHex(pot.stageTwo.tweakedPublicKey))
    expect(pot.stageTwo.program).toBe(contestProgram)
    expect(pot.stageTwo.args.playerHash).toEqual(pot.options.playerHash)
    expect(pot.stageTwo.args.houseHash).toEqual(pot.options.creatorHash)
    expect(pot.stageTwo.args.playerStake).toBe(pot.options.playerStake)
    expect(pot.stageTwo.args.houseStake).toBe(pot.options.houseStake)
  })

  it('keeps the terminal winner and timeout payouts in the contest program', () => {
    expect(Object.keys(contestProgram.functions).sort()).toEqual(['creatorWin', 'playerTakeAll', 'playerWin'])
    expect(Object.keys(coinflipProgram.functions).sort()).toEqual([
      'cooperativeSpend', 'cooperativeSpendExit', 'creatorWin', 'creatorWinExit',
      'playerForfeitExit', 'playerReveal', 'playerWin', 'playerWinExit',
    ])
  })
})
