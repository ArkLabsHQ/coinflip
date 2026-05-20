import type { ConfigRepository, SQLExecutor } from './types'

export class SQLiteConfigRepository implements ConfigRepository {
  constructor(private readonly db: SQLExecutor) {}

  async get(key: string): Promise<string | undefined> {
    const row = await this.db.get<{ value: string }>(
      'SELECT value FROM config WHERE key = ?',
      [key],
    )
    return row?.value
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)',
      [key, value],
    )
  }

  async all(): Promise<Record<string, string>> {
    const rows = await this.db.all<{ key: string; value: string }>('SELECT key, value FROM config')
    const out: Record<string, string> = {}
    for (const r of rows) out[r.key] = r.value
    return out
  }
}
