/**
 * Application dependency container.
 *
 * Built up in stages during boot — repositories first, then the house
 * wallet (which needs HouseWalletRepository + ConfigRepository).
 * Consumers downstream (route handlers, game-engine, trustless-game)
 * take a fully-populated `AppDeps` rather than reaching for module-level
 * singletons.
 */

import type { ArkInfo, Identity, Wallet } from '@arkade-os/sdk'
import type { Repos } from './repositories/types.js'

export interface AppDeps {
  repos: Repos
  wallet: Wallet
  identity: Identity
  arkInfo: ArkInfo
}

/** Subset of AppDeps available before the wallet boots — used by initHouseWallet. */
export interface BootDeps {
  repos: Repos
}
