export * from './types'
export { SQLiteGameRepository } from './gameRepository'
export { SQLiteHouseWalletRepository } from './houseWalletRepository'
export { SQLiteConfigRepository } from './configRepository'

import type { Repos, SQLExecutor } from './types'
import { SQLiteGameRepository } from './gameRepository'
import { SQLiteHouseWalletRepository } from './houseWalletRepository'
import { SQLiteConfigRepository } from './configRepository'

/** Build the three SQLite-backed repos from a shared SQLExecutor. */
export function makeRepos(db: SQLExecutor): Repos {
  return {
    games: new SQLiteGameRepository(db),
    houseWallet: new SQLiteHouseWalletRepository(db),
    config: new SQLiteConfigRepository(db),
  }
}
