import { arkade, type TapLeafScript } from '@arkade-os/sdk'
import artifact from './artifact/contest.json'
import { CompiledCoinflipScript, contractArgs, type GameContractOptions } from './compiled-contract'

export type StageTwoOptions = GameContractOptions
export const contestProgram = arkade.programFromArtifact(artifact)

export class StageTwoScript extends CompiledCoinflipScript {
  constructor(readonly options: StageTwoOptions) {
    super(contestProgram, contractArgs(contestProgram, options), {
      serverKey: options.serverPubkey,
      emulatorKey: options.emulatorPubkey,
    })
  }

  get playerWinCovenantScriptHex(): string { return this.leafHex('playerWin') }
  get creatorWinCovenantScriptHex(): string { return this.leafHex('creatorWin') }
  get playerTakeAllScriptHex(): string { return this.leafHex('playerTakeAll') }
  get playerWinFullArkadeScript(): Uint8Array { return this.covenant('playerWin') }
  get creatorWinFullArkadeScript(): Uint8Array { return this.covenant('creatorWin') }
  get takeAllArkadeScript(): Uint8Array { return this.covenant('playerTakeAll') }
  playerWinCovenant(): TapLeafScript { return this.leaf('playerWin') }
  creatorWinCovenant(): TapLeafScript { return this.leaf('creatorWin') }
  playerTakeAll(): TapLeafScript { return this.leaf('playerTakeAll') }
  forfeit(): TapLeafScript { return this.playerTakeAll() }
}
