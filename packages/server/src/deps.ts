/**
 * Application dependency container.
 *
 * Built up in stages during boot — repositories first, then the house
 * wallet (which needs HouseWalletRepository + ConfigRepository).
 * Consumers downstream (route handlers, game-engine, trustless-game)
 * take a fully-populated `AppDeps` rather than reaching for module-level
 * singletons.
 */

import type { ArkInfo, Identity, IContractManager, Wallet } from '@arkade-os/sdk'
import type { Repos } from './repositories/types.js'

export interface AppDeps {
  repos: Repos
  wallet: Wallet
  identity: Identity
  arkInfo: ArkInfo
  /**
   * The wallet's SDK ContractManager. Optional so test bootstraps that skip it
   * still typecheck; populated best-effort in `bootstrapDeps`. When present,
   * trustless settlement registers each game's house escrow as an `active`
   * contract and watches its `vtxo_spent` event to reconcile eagerly — the
   * 120s failsafe reconcile still guarantees correctness if it's absent.
   */
  contractManager?: IContractManager
}

/** Subset of AppDeps available before the wallet boots — used by initHouseWallet. */
export interface BootDeps {
  repos: Repos
}
