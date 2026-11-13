/**
 * SQLite bootstrap (better-sqlite3, real on-disk) and a driver-agnostic
 * SQLExecutor adapter for repositories.
 *
 * Schema lives here; data access lives in `./repositories/*`. Callers
 * receive a `Repos` bundle via `makeRepos(getSqlExecutor())` after
 * `initDb()` has run. WAL mode gives durable, atomic writes without the
 * whole-file rewrite the old sql.js (WASM, in-memory) path needed.
 */

import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import type { SQLExecutor } from './repositories/types.js'
import { POOL_SCHEMA } from './pool/repository.js'

const DATA_DIR = process.env.DATA_DIR || './data'
const DB_PATH = path.join(DATA_DIR, 'coinflip.db')

let db: Database.Database

export async function initDb(): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS house_wallet (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      private_key_hex TEXT NOT NULL,
      public_key_hex TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      tier INTEGER NOT NULL CHECK (tier > 0),
      player_pubkey TEXT NOT NULL,
      player_hash TEXT NOT NULL,
      player_change_address TEXT,
      house_secret_hex TEXT NOT NULL,
      player_secret_hex TEXT,
      winner TEXT,
      payout_amount INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'expired')),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    )
  `)
  // Index the player-pubkey lookups (countPendingForPlayer / listForPlayer —
  // the "restore my games" path). Additive and idempotent, same IF-NOT-EXISTS
  // bootstrap style as the tables above (no migration framework here).
  db.exec('CREATE INDEX IF NOT EXISTS idx_games_player ON games(player_pubkey)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_games_status ON games(status, created_at)')
  db.exec(POOL_SCHEMA)
  const poolBootstrapColumns = db.prepare('PRAGMA table_info(pool_bootstrap)').all() as { name: string }[]
  if (!poolBootstrapColumns.some(column => column.name === 'journal_json')) db.exec('ALTER TABLE pool_bootstrap ADD COLUMN journal_json TEXT')
  const poolOperationColumns = db.prepare('PRAGMA table_info(pool_operations)').all() as { name: string }[]
  if (!poolOperationColumns.some(column => column.name === 'operator_request_json')) db.exec('ALTER TABLE pool_operations ADD COLUMN operator_request_json TEXT')
  for (const [name, definition] of [['operation_kind', "TEXT NOT NULL DEFAULT 'transaction'"], ['renewal_journal_json', 'TEXT'],
    ['renewal_session_json', 'TEXT'], ['renewal_receipt_json', 'TEXT'], ['operator_stage_json', 'TEXT'], ['renewal_replay_json', 'TEXT']]) {
    if (!poolOperationColumns.some(column => column.name === name)) db.exec(`ALTER TABLE pool_operations ADD COLUMN ${name} ${definition}`)
  }

  // Seed default config
  const seed = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)')
  seed.run('variable_odds_edge_bps', '300')
  seed.run('max_bet_fraction_bps', '2500')
  seed.run('tiers', JSON.stringify([1000, 5000, 10000, 50000]))
  seed.run('min_house_balance', '100000')
}

/**
 * SQLExecutor adapter for the Ark SDK's `SQLiteWalletRepository` /
 * `SQLiteContractRepository` and our own `repositories/*` impls.
 * better-sqlite3 is synchronous; we wrap each call in a resolved Promise to
 * satisfy the SDK's async interface. Uint8Array params are converted to
 * Buffer (better-sqlite3 binds Buffer/number/string/bigint/null only).
 */
function bindParams(params?: unknown[]): unknown[] {
  if (!params) return []
  return params.map((p) =>
    p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p) : p,
  )
}

/**
 * Close the database on graceful shutdown. better-sqlite3 checkpoints the WAL
 * into the main file on close, so a `docker stop` (SIGTERM) leaves a clean,
 * fully-merged coinflip.db rather than a growing -wal sidecar. Safe to call
 * more than once.
 */
export function closeDb(): void {
  if (db && db.open) db.close()
}

export function getSqlExecutor(): SQLExecutor {
  return {
    run: async (sql: string, params?: unknown[]): Promise<void> => {
      db.prepare(sql).run(...bindParams(params))
    },
    get: async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> => {
      return db.prepare(sql).get(...bindParams(params)) as T | undefined
    },
    all: async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      return db.prepare(sql).all(...bindParams(params)) as T[]
    },
  }
}
