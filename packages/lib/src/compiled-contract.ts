import { arkade, timelockToSequence, type TapLeafScript } from '@arkade-os/sdk'
import { hex } from '@scure/base'

export interface GameContractOptions {
  creatorPubkey: Uint8Array
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  emulatorPubkey: Uint8Array
  creatorHash: Uint8Array
  playerHash: Uint8Array
  finalExpiration: bigint
  oddsN: number
  oddsTarget: number
  oddsLo: number
  playerPayoutPkScript: Uint8Array
  housePayoutPkScript: Uint8Array
  playerStake: bigint
  houseStake: bigint
}

const MAX_MONEY = 2_100_000_000_000_000n
type Program = ReturnType<typeof arkade.programFromArtifact>
type ConstructorValue = Uint8Array | bigint | number

export function contractArgs(program: Program, options: GameContractOptions, extra: Record<string, ConstructorValue> = {}): Record<string, ConstructorValue> {
  for (const name of ['creatorPubkey', 'playerPubkey', 'serverPubkey', 'emulatorPubkey', 'creatorHash', 'playerHash'] as const) {
    if (options[name].length !== 32) throw new Error(`${name} must contain 32 bytes`)
  }
  for (const name of ['playerPayoutPkScript', 'housePayoutPkScript'] as const) {
    const script = options[name]
    if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) throw new Error(`${name} must be P2TR`)
  }
  if (options.playerStake < 330n || options.houseStake < 330n || options.playerStake + options.houseStake > MAX_MONEY) {
    throw new Error('Stakes must fund viable outputs within the Bitcoin supply limit')
  }
  if (!Number.isInteger(options.oddsN) || options.oddsN < 2 || options.oddsN > 128 ||
    !Number.isInteger(options.oddsLo) || !Number.isInteger(options.oddsTarget) ||
    options.oddsLo < 0 || options.oddsLo >= options.oddsTarget || options.oddsTarget > options.oddsN) {
    throw new Error('Odds require 2 <= n <= 128 and 0 <= lo < target <= n')
  }
  if (options.finalExpiration < 500_000_000n || options.finalExpiration > 0xffff_ffffn) {
    throw new Error('finalExpiration must be a Unix-second CLTV timestamp')
  }
  const values: Record<string, ConstructorValue> = {
    player: options.playerPubkey, house: options.creatorPubkey, server: options.serverPubkey,
    playerHash: options.playerHash, houseHash: options.creatorHash,
    'playerPayout.program': options.playerPayoutPkScript.slice(2), 'playerPayout.version': 1n,
    'housePayout.program': options.housePayoutPkScript.slice(2), 'housePayout.version': 1n,
    playerStake: options.playerStake, houseStake: options.houseStake,
    oddsN: options.oddsN, oddsLo: options.oddsLo, oddsTarget: options.oddsTarget,
    finalExpiration: options.finalExpiration, ...extra,
  }
  return Object.fromEntries((program.params ?? []).map(({ name }) => {
    if (values[name] === undefined) throw new Error(`Unbound compiler constructor field ${name}`)
    return [name, values[name]]
  }))
}

export function exitSequence(seconds: bigint): bigint {
  if (seconds < 512n || seconds % 512n !== 0n || seconds > 65_535n * 512n) {
    throw new Error('exitDelay must be a BIP68 duration in multiples of 512 seconds')
  }
  return BigInt(timelockToSequence({ value: seconds, type: 'seconds' }))
}

export class CompiledCoinflipScript extends arkade.ArkadeProgramScript {
  protected leafHex(name: string): string {
    const fn = this.functionByName(name)
    if (!fn) throw new Error(`Missing compiled spending path ${name}`)
    return hex.encode(fn.leafScript)
  }

  protected leaf(name: string): TapLeafScript {
    const fn = this.functionByName(name)
    if (!fn) throw new Error(`Missing compiled spending path ${name}`)
    return fn.tapLeafScript
  }

  protected covenant(name: string): Uint8Array {
    const script = this.functionByName(name)?.arkadeScript
    if (!script) throw new Error(`Missing compiled covenant ${name}`)
    return script
  }
}
