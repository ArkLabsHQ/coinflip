export * from './types.js'
export { SQLiteGameRepository } from './gameRepository.js'
export { SQLiteHouseWalletRepository } from './houseWalletRepository.js'
export { SQLiteConfigRepository } from './configRepository.js'

import type { Repos, SQLExecutor } from './types.js'
import { SQLiteGameRepository } from './gameRepository.js'
import { SQLiteHouseWalletRepository } from './houseWalletRepository.js'
import { SQLiteConfigRepository } from './configRepository.js'

/** Build the three SQLite-backed repos from a shared SQLExecutor. */
export function makeRepos(db: SQLExecutor): Repos {
  return {
    games: new SQLiteGameRepository(db),
    houseWallet: new SQLiteHouseWalletRepository(db),
    config: new SQLiteConfigRepository(db),
  }
}
