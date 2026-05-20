/**
 * Coinflip contract handlers — register coinflip as a first-class contract
 * type with the @arkade-os/sdk contract registry.
 *
 * Two contract types are registered:
 *   - coinflip-setup : the joint output funded by both players' bets.
 *                      Spent collaboratively (creator reveals secret) into
 *                      the final output, or unilaterally aborted after
 *                      `setupExpiration` by player + server.
 *   - coinflip-final : the post-reveal output that carries both hashes.
 *                      Spent collaboratively into creatorWin or playerWin
 *                      based on secret sizes, or unilaterally aborted
 *                      after `finalExpiration` by creator + server.
 *
 * Once `registerCoinflipContracts()` has been called, both types can be
 * encoded/decoded as `arkcontract=...` strings, watched by `ContractWatcher`,
 * and managed by `ContractManager` exactly like the SDK's built-in
 * `default` / `vhtlc` types.
 */

import { hex } from '@scure/base'
import {
  contractHandlers,
  type ContractHandler,
  type PathSelection,
} from '@arkade-os/sdk'

import {
  CoinflipSetupScript,
  CoinflipFinalScript,
  type CoinflipSetupOptions,
  type CoinflipFinalOptions,
} from './script'
import { determineWinner } from './transactions'

export const COINFLIP_SETUP_TYPE = 'coinflip-setup'
export const COINFLIP_FINAL_TYPE = 'coinflip-final'

// BIP65 threshold: <500_000_000 = block height, >=500_000_000 = unix seconds.
const CLTV_HEIGHT_THRESHOLD = 500_000_000n

function isCltvSatisfied(
  context: { currentTime: number; blockHeight?: number },
  locktime: bigint,
): boolean {
  if (locktime < CLTV_HEIGHT_THRESHOLD) {
    if (context.blockHeight === undefined) return false
    return BigInt(context.blockHeight) >= locktime
  }
  return BigInt(Math.floor(context.currentTime / 1000)) >= locktime
}

export const CoinflipSetupContractHandler: ContractHandler<
  CoinflipSetupOptions,
  CoinflipSetupScript
> = {
  type: COINFLIP_SETUP_TYPE,

  createScript(params) {
    return new CoinflipSetupScript(this.deserializeParams(params))
  },

  serializeParams(p) {
    return {
      creator: hex.encode(p.creatorPubkey),
      player: hex.encode(p.playerPubkey),
      server: hex.encode(p.serverPubkey),
      creatorHash: hex.encode(p.creatorHash),
      setupExpiration: p.setupExpiration.toString(),
    }
  },

  deserializeParams(p) {
    return {
      creatorPubkey: hex.decode(p.creator),
      playerPubkey: hex.decode(p.player),
      serverPubkey: hex.decode(p.server),
      creatorHash: hex.decode(p.creatorHash),
      setupExpiration: BigInt(p.setupExpiration),
    }
  },

  selectPath(script, contract, context) {
    const setupExpiration = BigInt(contract.params.setupExpiration)
    const creatorSecret = contract.params.creatorSecret

    // Collaborative reveal: requires the creator's secret in the witness
    // plus a 3-of-3 signature from player+creator+server.
    if (context.collaborative && creatorSecret) {
      return {
        leaf: script.reveal(),
        extraWitness: [hex.decode(creatorSecret)],
      }
    }

    // Unilateral abort: player+server can reclaim after setupExpiration.
    if (isCltvSatisfied(context, setupExpiration)) {
      return { leaf: script.abort() }
    }

    return null
  },

  getAllSpendingPaths(script) {
    return [{ leaf: script.reveal() }, { leaf: script.abort() }]
  },

  getSpendablePaths(script, contract, context) {
    const paths: PathSelection[] = []
    const creatorSecret = contract.params.creatorSecret
    if (context.collaborative && creatorSecret) {
      paths.push({
        leaf: script.reveal(),
        extraWitness: [hex.decode(creatorSecret)],
      })
    }
    if (isCltvSatisfied(context, BigInt(contract.params.setupExpiration))) {
      paths.push({ leaf: script.abort() })
    }
    return paths
  },
}

export const CoinflipFinalContractHandler: ContractHandler<
  CoinflipFinalOptions,
  CoinflipFinalScript
> = {
  type: COINFLIP_FINAL_TYPE,

  createScript(params) {
    return new CoinflipFinalScript(this.deserializeParams(params))
  },

  serializeParams(p) {
    return {
      creator: hex.encode(p.creatorPubkey),
      player: hex.encode(p.playerPubkey),
      server: hex.encode(p.serverPubkey),
      creatorHash: hex.encode(p.creatorHash),
      playerHash: hex.encode(p.playerHash),
      finalExpiration: p.finalExpiration.toString(),
    }
  },

  deserializeParams(p) {
    return {
      creatorPubkey: hex.decode(p.creator),
      playerPubkey: hex.decode(p.player),
      serverPubkey: hex.decode(p.server),
      creatorHash: hex.decode(p.creatorHash),
      playerHash: hex.decode(p.playerHash),
      finalExpiration: BigInt(p.finalExpiration),
    }
  },

  selectPath(script, contract, context) {
    const finalExpiration = BigInt(contract.params.finalExpiration)
    const creatorSecret = contract.params.creatorSecret
    const playerSecret = contract.params.playerSecret

    // Collaborative win: both secrets known, pick the leaf the result demands.
    // Stack expected by the condition script is "<creatorSecret> <playerSecret>"
    // (playerSecret on top), so witness order matches.
    if (context.collaborative && creatorSecret && playerSecret) {
      const cs = hex.decode(creatorSecret)
      const ps = hex.decode(playerSecret)
      const winner = determineWinner(cs, ps)
      return {
        leaf: winner === 'creator' ? script.creatorWin() : script.playerWin(),
        extraWitness: [cs, ps],
      }
    }

    // Unilateral abort: creator+server can reclaim after finalExpiration
    // (used when the player never reveals their secret).
    if (isCltvSatisfied(context, finalExpiration)) {
      return { leaf: script.abort() }
    }

    return null
  },

  getAllSpendingPaths(script) {
    return [
      { leaf: script.creatorWin() },
      { leaf: script.playerWin() },
      { leaf: script.abort() },
    ]
  },

  getSpendablePaths(script, contract, context) {
    const paths: PathSelection[] = []
    const cs = contract.params.creatorSecret
    const ps = contract.params.playerSecret
    if (context.collaborative && cs && ps) {
      const csBytes = hex.decode(cs)
      const psBytes = hex.decode(ps)
      const winner = determineWinner(csBytes, psBytes)
      paths.push({
        leaf: winner === 'creator' ? script.creatorWin() : script.playerWin(),
        extraWitness: [csBytes, psBytes],
      })
    }
    if (isCltvSatisfied(context, BigInt(contract.params.finalExpiration))) {
      paths.push({ leaf: script.abort() })
    }
    return paths
  },
}

/**
 * Register the coinflip setup + final contract handlers with the SDK's
 * global `contractHandlers` registry. Safe to call multiple times; subsequent
 * calls are no-ops because the registry rejects double-registration.
 *
 * Call once at startup on both server and any client that needs to
 * resolve coinflip contracts through the SDK contract system.
 */
export function registerCoinflipContracts(): void {
  if (!contractHandlers.has(COINFLIP_SETUP_TYPE)) {
    contractHandlers.register(CoinflipSetupContractHandler)
  }
  if (!contractHandlers.has(COINFLIP_FINAL_TYPE)) {
    contractHandlers.register(CoinflipFinalContractHandler)
  }
}
