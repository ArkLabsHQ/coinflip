/**
 * Application dependency container.
 *
 * Built up in stages during boot — repositories first, then the house
 * wallet (which needs HouseWalletRepository + ConfigRepository), then
 * the ContractManager (which needs the Wallet). Consumers downstream
 * (route handlers, game-engine, contract-manager, auto-claim) take
 * a fully-populated `AppDeps` rather than reaching for module-level
 * singletons.
 */

import type { ArkInfo, ContractManager, Identity, Wallet } from '@arkade-os/sdk'
import type { Repos } from './repositories/types'

export interface AppDeps {
  repos: Repos
  wallet: Wallet
  identity: Identity
  arkInfo: ArkInfo
  contractManager: ContractManager
}

/** Subset of AppDeps available before the wallet boots — used by initHouseWallet. */
export interface BootDeps {
  repos: Repos
}
