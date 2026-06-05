/**
 * Coinflip contract handler — register the per-party coinflip ESCROW as a
 * first-class contract type with the @arkade-os/sdk contract registry.
 *
 * One contract type is registered:
 *   - coinflip-escrow : the per-funder escrow VTXO behind the 8-leaf taptree
 *                       (four arkd-cosigned covenant paths + four CSV-gated
 *                       unilateral exit mirrors). See `CoinflipEscrowScript`.
 *
 * Once `registerCoinflipContracts()` has been called, the type can be
 * encoded/decoded as an `arkcontract=...` string, watched by `ContractWatcher`,
 * and tracked by `ContractManager` exactly like the SDK's built-in
 * `default` / `vhtlc` types — so each game's escrow emits `vtxo_received` /
 * `vtxo_spent` events.
 */

import { hex } from '@scure/base'
import {
  contractHandlers,
  type ContractHandler,
  type PathSelection,
} from '@arkade-os/sdk'

import {
  CoinflipEscrowScript,
  type CoinflipEscrowOptions,
} from './script'

import {
  CoinflipEscrowScriptV3,
  type CoinflipEscrowOptionsV3,
} from './script-v3'

export const COINFLIP_ESCROW_TYPE = 'coinflip-escrow'

/** All eight leaves of the escrow taptree, in tree order. */
function allEscrowPaths(script: CoinflipEscrowScript): PathSelection[] {
  return [
    { leaf: script.playerWinCovenant() },
    { leaf: script.creatorWinCovenant() },
    { leaf: script.playerForfeit() },
    { leaf: script.refund() },
    { leaf: script.playerWinExit() },
    { leaf: script.creatorWinExit() },
    { leaf: script.playerForfeitExit() },
    { leaf: script.refundExit() },
  ]
}

export const CoinflipEscrowContractHandler: ContractHandler<
  CoinflipEscrowOptions,
  CoinflipEscrowScript
> = {
  type: COINFLIP_ESCROW_TYPE,

  createScript(params) {
    return new CoinflipEscrowScript(this.deserializeParams(params))
  },

  serializeParams(p) {
    const out: Record<string, string> = {
      creator: hex.encode(p.creatorPubkey),
      player: hex.encode(p.playerPubkey),
      server: hex.encode(p.serverPubkey),
      creatorHash: hex.encode(p.creatorHash),
      playerHash: hex.encode(p.playerHash),
      finalExpiration: p.finalExpiration.toString(),
      refund: hex.encode(p.refundPubkey),
      exitDelay: p.exitDelay.toString(),
      // arkadeForfeit — flattened with an `af_` prefix.
      af_emulator: hex.encode(p.arkadeForfeit.emulatorPubkey),
      af_playerPayout: hex.encode(p.arkadeForfeit.playerPayoutPkScript),
      af_housePayout: hex.encode(p.arkadeForfeit.housePayoutPkScript),
      af_playerStake: p.arkadeForfeit.playerStake.toString(),
      af_houseStake: p.arkadeForfeit.houseStake.toString(),
    }
    // Variable-odds params are optional: only serialize when present so the
    // coin (no odds) round-trips back to `undefined`, not `0`.
    if (p.oddsN !== undefined) out.oddsN = p.oddsN.toString()
    if (p.oddsTarget !== undefined) out.oddsTarget = p.oddsTarget.toString()
    if (p.oddsLo !== undefined) out.oddsLo = p.oddsLo.toString()
    return out
  },

  deserializeParams(p) {
    const opts: CoinflipEscrowOptions = {
      creatorPubkey: hex.decode(p.creator),
      playerPubkey: hex.decode(p.player),
      serverPubkey: hex.decode(p.server),
      creatorHash: hex.decode(p.creatorHash),
      playerHash: hex.decode(p.playerHash),
      finalExpiration: BigInt(p.finalExpiration),
      refundPubkey: hex.decode(p.refund),
      exitDelay: BigInt(p.exitDelay),
      arkadeForfeit: {
        emulatorPubkey: hex.decode(p.af_emulator),
        playerPayoutPkScript: hex.decode(p.af_playerPayout),
        housePayoutPkScript: hex.decode(p.af_housePayout),
        playerStake: BigInt(p.af_playerStake),
        houseStake: BigInt(p.af_houseStake),
      },
    }
    // Omit absent odds fields entirely so `createScript` reproduces the
    // identical coin script (the script builder branches on `=== undefined`).
    if (p.oddsN !== undefined) opts.oddsN = Number(p.oddsN)
    if (p.oddsTarget !== undefined) opts.oddsTarget = Number(p.oddsTarget)
    if (p.oddsLo !== undefined) opts.oddsLo = Number(p.oddsLo)
    return opts
  },

  selectPath() {
    // The coinflip flow never asks the ContractManager to select a spend
    // path: every spend (covenant win, refund, R1 forfeit) is built
    // DIRECTLY by transactions.ts. We only register the escrow so the
    // ContractManager/ContractWatcher can TRACK it and emit
    // vtxo_received / vtxo_spent. No path is auto-selected here.
    return null
  },

  getAllSpendingPaths(script) {
    return allEscrowPaths(script)
  },

  getSpendablePaths(script) {
    // The coinflip flow builds its sweeps DIRECTLY
    // (buildCovenantSweepTransaction / buildRefundTransaction /
    // buildForfeitClaimTransaction in transactions.ts), so the
    // ContractManager is NOT used to select spend paths. Return every leaf
    // rather than reimplementing timelock filtering for a path nothing
    // consumes.
    return allEscrowPaths(script)
  },
}

/**
 * Minimal registry shape — `register` + `has` — so consumers can register
 * the coinflip handler against ANY ContractHandlerRegistry instance, not
 * just the one inside the lib's own SDK copy. In a multi-package install
 * each package typically gets its own `@arkade-os/sdk` under
 * `node_modules`, with its own module-scoped `contractHandlers` singleton;
 * the caller must pass the registry from its own SDK to make the handler
 * visible to the ContractManager it later constructs.
 */
export interface CoinflipContractRegistry {
  register(handler: unknown): void
  has(type: string): boolean
}

/**
 * Register the coinflip escrow contract handler with an SDK
 * `contractHandlers` registry. Defaults to the lib's own SDK registry,
 * but accepts any registry-shaped object so multi-package installs can
 * register against the right singleton.
 *
 * Idempotent: safe to call multiple times against the same registry.
 *
 * @example
 * ```ts
 * // From a consumer that has its own @arkade-os/sdk copy:
 * import { contractHandlers } from '@arkade-os/sdk'
 * import { registerCoinflipContracts } from 'arkade-coinflip'
 * registerCoinflipContracts(contractHandlers)
 * ```
 */
export function registerCoinflipContracts(
  registry: CoinflipContractRegistry = contractHandlers as unknown as CoinflipContractRegistry,
): void {
  if (!registry.has(COINFLIP_ESCROW_TYPE)) {
    registry.register(CoinflipEscrowContractHandler)
  }
  if (!registry.has(COINFLIP_ESCROW_V3_TYPE)) {
    registry.register(CoinflipEscrowV3ContractHandler)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// v0.3 escrow contract handler — packet-borne reveals, 10-leaf taptree.
// ─────────────────────────────────────────────────────────────────────────

export const COINFLIP_ESCROW_V3_TYPE = 'coinflip-escrow-v3'

export const CoinflipEscrowV3ContractHandler: ContractHandler<
  CoinflipEscrowOptionsV3,
  CoinflipEscrowScriptV3
> = {
  type: COINFLIP_ESCROW_V3_TYPE,

  createScript(params) {
    return new CoinflipEscrowScriptV3(this.deserializeParams(params))
  },

  serializeParams(p) {
    // v3 has mandatory variable-odds (n=2 is the coin special case),
    // so oddsN/oddsTarget/oddsLo are always present (not flagged optional
    // like v0.2.x's CoinflipEscrowOptions).
    return {
      creator: hex.encode(p.creatorPubkey),
      player: hex.encode(p.playerPubkey),
      server: hex.encode(p.serverPubkey),
      creatorHash: hex.encode(p.creatorHash),
      playerHash: hex.encode(p.playerHash),
      finalExpiration: p.finalExpiration.toString(),
      refund: hex.encode(p.refundPubkey),
      exitDelay: p.exitDelay.toString(),
      oddsN: p.oddsN.toString(),
      oddsTarget: p.oddsTarget.toString(),
      oddsLo: p.oddsLo.toString(),
      af_emulator: hex.encode(p.arkadeForfeit.emulatorPubkey),
      af_playerPayout: hex.encode(p.arkadeForfeit.playerPayoutPkScript),
      af_housePayout: hex.encode(p.arkadeForfeit.housePayoutPkScript),
      af_playerStake: p.arkadeForfeit.playerStake.toString(),
      af_houseStake: p.arkadeForfeit.houseStake.toString(),
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
      refundPubkey: hex.decode(p.refund),
      exitDelay: BigInt(p.exitDelay),
      oddsN: Number(p.oddsN),
      oddsTarget: Number(p.oddsTarget),
      oddsLo: Number(p.oddsLo),
      arkadeForfeit: {
        emulatorPubkey: hex.decode(p.af_emulator),
        playerPayoutPkScript: hex.decode(p.af_playerPayout),
        housePayoutPkScript: hex.decode(p.af_housePayout),
        playerStake: BigInt(p.af_playerStake),
        houseStake: BigInt(p.af_houseStake),
      },
    }
  },

  selectPath() {
    // Same rationale as v0.2.x: every spend (covenant win, refund, R1 forfeit,
    // cooperative spend) is built directly in transactions.ts. We register the
    // escrow only so the ContractManager/ContractWatcher can TRACK it and emit
    // vtxo_received / vtxo_spent.
    return null
  },

  getAllSpendingPaths(script) {
    return [
      { leaf: script.playerWinCovenant() },
      { leaf: script.creatorWinCovenant() },
      { leaf: script.playerForfeit() },
      { leaf: script.refund() },
      { leaf: script.playerWinExit() },
      { leaf: script.creatorWinExit() },
      { leaf: script.playerForfeitExit() },
      { leaf: script.refundExit() },
    ]
  },

  getSpendablePaths(script) {
    // Same as getAllSpendingPaths — coinflip's flow builds spends directly,
    // so we never use this to gate on timelocks; just return every leaf.
    return [
      { leaf: script.playerWinCovenant() },
      { leaf: script.creatorWinCovenant() },
      { leaf: script.playerForfeit() },
      { leaf: script.refund() },
      { leaf: script.playerWinExit() },
      { leaf: script.creatorWinExit() },
      { leaf: script.playerForfeitExit() },
      { leaf: script.refundExit() },
    ]
  },
}
