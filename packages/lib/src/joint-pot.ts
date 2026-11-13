import { arkade, type TapLeafScript } from '@arkade-os/sdk'
import artifact from './artifact/coinflip.json'
import { CompiledCoinflipScript, contractArgs, exitSequence, type GameContractOptions } from './compiled-contract'
import { StageTwoScript } from './joint-pot-stage2'

export interface CoinflipJointPotOptions extends GameContractOptions {
  cancelDelay: bigint
  exitDelay: bigint
}

export const coinflipProgram = arkade.programFromArtifact(artifact)

export class CoinflipJointPotScript extends CompiledCoinflipScript {
  readonly stageTwo: StageTwoScript

  constructor(readonly options: CoinflipJointPotOptions) {
    if (options.cancelDelay < 500_000_000n || options.cancelDelay >= options.finalExpiration) {
      throw new Error('cancelDelay must be a Unix-second timestamp before finalExpiration')
    }
    const stageTwo = new StageTwoScript(options)
    const children = (coinflipProgram.params ?? []).filter(({ name }) => name.startsWith('contract_'))
    if (children.length !== 1) throw new Error('Coinflip artifact must pin exactly one contest continuation')
    const args = contractArgs(coinflipProgram, options, {
      cancelDelay: options.cancelDelay,
      SERVER_EXIT_DELAY: exitSequence(options.exitDelay),
      [children[0].name]: stageTwo.tweakedPublicKey,
    })
    super(coinflipProgram, args, { serverKey: options.serverPubkey, emulatorKey: options.emulatorPubkey })
    this.stageTwo = stageTwo
  }

  get playerWinCovenantScriptHex(): string { return this.leafHex('playerWin') }
  get creatorWinCovenantScriptHex(): string { return this.leafHex('creatorWin') }
  get playerRevealScriptHex(): string { return this.leafHex('playerReveal') }
  get cooperativeSpendScriptHex(): string { return this.leafHex('cooperativeSpend') }
  get playerWinExitScriptHex(): string { return this.leafHex('playerWinExit') }
  get creatorWinExitScriptHex(): string { return this.leafHex('creatorWinExit') }
  get playerForfeitExitScriptHex(): string { return this.leafHex('playerForfeitExit') }
  get cooperativeSpendExitScriptHex(): string { return this.leafHex('cooperativeSpendExit') }
  get playerWinFullArkadeScript(): Uint8Array { return this.covenant('playerWin') }
  get creatorWinFullArkadeScript(): Uint8Array { return this.covenant('creatorWin') }
  get forfeitArkadeScript(): Uint8Array { return this.covenant('playerForfeitExit') }
  get splitArkadeScript(): Uint8Array { return this.covenant('cooperativeSpend') }
  get revealArkadeScript(): Uint8Array { return this.covenant('playerReveal') }
  playerWinCovenant(): TapLeafScript { return this.leaf('playerWin') }
  creatorWinCovenant(): TapLeafScript { return this.leaf('creatorWin') }
  playerReveal(): TapLeafScript { return this.leaf('playerReveal') }
  cooperativeSpend(): TapLeafScript { return this.leaf('cooperativeSpend') }
  playerWinExit(): TapLeafScript { return this.leaf('playerWinExit') }
  creatorWinExit(): TapLeafScript { return this.leaf('creatorWinExit') }
  playerForfeitExit(): TapLeafScript { return this.leaf('playerForfeitExit') }
  cooperativeSpendExit(): TapLeafScript { return this.leaf('cooperativeSpendExit') }
  forfeit(): TapLeafScript { return this.cooperativeSpend() }
}
