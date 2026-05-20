import type {
  HouseWalletRepository,
  HouseWalletRow,
  SQLExecutor,
} from './types'

export class SQLiteHouseWalletRepository implements HouseWalletRepository {
  constructor(private readonly db: SQLExecutor) {}

  async get(): Promise<HouseWalletRow | undefined> {
    return this.db.get<HouseWalletRow>('SELECT * FROM house_wallet WHERE id = 1')
  }

  async set(privateKeyHex: string, publicKeyHex: string): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO house_wallet (id, private_key_hex, public_key_hex) VALUES (1, ?, ?)',
      [privateKeyHex, publicKeyHex],
    )
  }
}
