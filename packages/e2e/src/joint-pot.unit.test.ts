import { arkade, decodeTapscript, scriptFromTapLeafScript } from '@arkade-os/sdk'
import { Script } from '@scure/btc-signer'
import { CoinflipJointPotScript, type CoinflipJointPotOptions } from 'arkade-coinflip'
import { contractOptions, toHex } from './test-helpers/coinflip-fixture'

describe('compiled game spending paths', () => {
  const options = contractOptions()
  const pot = new CoinflipJointPotScript(options)
  const fn = (name: string) => pot.functionByName(name)!
  const decoded = (name: string) => decodeTapscript(fn(name).leafScript)
  const emulatorKey = (name: string) => arkade.computeArkadeScriptPublicKey(options.emulatorPubkey, fn(name).arkadeScript!)

  it.each(['playerWin', 'creatorWin'])('%s requires the operator and the covenant-bound emulator', name => {
    expect(decoded(name).type).toBe('multisig')
    expect(decoded(name).params.pubkeys.map(toHex)).toEqual([toHex(options.serverPubkey), toHex(emulatorKey(name))])
  })

  it.each([
    ['playerWinExit', 'playerWin', 'playerPubkey'],
    ['creatorWinExit', 'creatorWin', 'creatorPubkey'],
  ])('%s preserves its winner covenant after the CSV delay', (exit, winner, owner) => {
    const leaf = decoded(exit)
    expect(leaf.type).toBe('csv-multisig')
    expect(leaf.params.timelock).toEqual({ type: 'seconds', value: options.exitDelay })
    expect(leaf.params.pubkeys.map(toHex)).toEqual([
      toHex(options[owner as 'playerPubkey' | 'creatorPubkey']), toHex(emulatorKey(winner)),
    ])
    expect(toHex(fn(exit).arkadeScript!)).toBe(toHex(fn(winner).arkadeScript!))
  })

  it('requires the player reveal preimage and player signature to enter the contest', () => {
    const leaf = decoded('playerReveal')
    expect(leaf.type).toBe('condition-multisig')
    expect(Script.decode(leaf.params.conditionScript)).toEqual(['SHA256', options.playerHash, 'EQUAL'])
    expect(leaf.params.pubkeys.map(toHex)).toEqual([
      toHex(options.playerPubkey), toHex(options.serverPubkey), toHex(emulatorKey('playerReveal')),
    ])
  })

  it('gates the split-back by its committed CLTV and split covenant', () => {
    const leaf = decoded('cooperativeSpend')
    expect(leaf.type).toBe('cltv-multisig')
    expect(leaf.params.absoluteTimelock).toBe(options.cancelDelay)
    expect(leaf.params.pubkeys.map(toHex)).toEqual([toHex(options.serverPubkey), toHex(emulatorKey('cooperativeSpend'))])
  })

  it('keeps the forfeit hashlock, player signature and covenant after unroll', () => {
    const leaf = decoded('playerForfeitExit')
    expect(leaf.type).toBe('condition-csv-multisig')
    expect(leaf.params.timelock).toEqual({ type: 'seconds', value: options.exitDelay })
    expect(Script.decode(leaf.params.conditionScript)).toEqual(['SHA256', options.playerHash, 'EQUAL'])
    expect(leaf.params.pubkeys.map(toHex)).toEqual([toHex(options.playerPubkey), toHex(emulatorKey('playerForfeitExit'))])
  })

  it('requires both funders for the emulator-independent cooperative exit', () => {
    const leaf = decoded('cooperativeSpendExit')
    expect(leaf.type).toBe('csv-multisig')
    expect(leaf.params.timelock).toEqual({ type: 'seconds', value: options.exitDelay })
    expect(leaf.params.pubkeys.map(toHex)).toEqual([toHex(options.playerPubkey), toHex(options.creatorPubkey)])
    expect(fn('cooperativeSpendExit').arkadeScript).toBeUndefined()
  })

  it('gates the contest timeout with the player, operator, emulator and final CLTV', () => {
    const take = pot.stageTwo.functionByName('playerTakeAll')!
    const leaf = decodeTapscript(take.leafScript)
    expect(leaf.type).toBe('cltv-multisig')
    expect(leaf.params.absoluteTimelock).toBe(options.finalExpiration)
    expect(leaf.params.pubkeys.map(toHex)).toEqual([
      toHex(options.playerPubkey), toHex(options.serverPubkey),
      toHex(arkade.computeArkadeScriptPublicKey(options.emulatorPubkey, take.arkadeScript!)),
    ])
  })

  it('separates raw script hex from SDK leaf-version transport bytes', () => {
    const leaves = [
      [pot.playerWinCovenant(), pot.playerWinCovenantScriptHex],
      [pot.playerReveal(), pot.playerRevealScriptHex],
      [pot.cooperativeSpendExit(), pot.cooperativeSpendExitScriptHex],
      [pot.stageTwo.playerTakeAll(), pot.stageTwo.playerTakeAllScriptHex],
    ] as const
    for (const [leaf, rawHex] of leaves) {
      expect(toHex(scriptFromTapLeafScript(leaf))).toBe(rawHex)
      expect(leaf[1][leaf[1].length - 1]).toBe(0xc0)
    }
  })
})

describe('compiled game constructor validation', () => {
  const invalid: [string, Partial<CoinflipJointPotOptions>][] = [
    ['unsupported odds', { oddsN: 129 }], ['fractional odds', { oddsN: 2.5 }],
    ['empty interval', { oddsLo: 1, oddsTarget: 1 }], ['negative interval', { oddsLo: -1 }],
    ['oversized interval', { oddsTarget: 3 }], ['dust stake', { playerStake: 329n }],
    ['negative stake', { houseStake: -1n }], ['pot overflow', { houseStake: 2_100_000_000_000_000n }],
    ['key length', { playerPubkey: new Uint8Array(33) }], ['hash length', { creatorHash: new Uint8Array(31) }],
    ['payout script', { playerPayoutPkScript: new Uint8Array([0, 20, ...new Uint8Array(20)]) }],
    ['refund order', { cancelDelay: 1_900_000_000n }], ['block timestamp', { finalExpiration: 499_999_999n }],
    ['CSV units', { exitDelay: 86_400n }], ['CSV zero', { exitDelay: 0n }],
  ]
  it.each(invalid)('rejects %s before an address can be funded', (_label, change) => {
    expect(() => new CoinflipJointPotScript(contractOptions(change))).toThrow()
  })
})
