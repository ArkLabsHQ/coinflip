/**
 * SQLite (sql.js / WASM) bootstrap and a driver-agnostic SQLExecutor
 * adapter for repositories.
 *
 * Schema lives here; data access lives in `./repositories/*`. Callers
 * receive a `Repos` bundle via `makeRepos(getSqlExecutor())` after
 * `initDb()` has run.
 */

import initSqlJs, { Database } from 'sql.js'
import fs from 'fs'
import path from 'path'
import type { SQLExecutor } from './repositories/types.js'

const DATA_DIR = process.env.DATA_DIR || './data'
const DB_PATH = path.join(DATA_DIR, 'coinflip.db')

let db: Database

function saveDb(): void {
  const data = db.export()
  const buffer = Buffer.from(data)
  fs.writeFileSync(DB_PATH, buffer)
}

export async function initDb(): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  const SQL = await initSqlJs()

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(fileBuffer)
  } else {
    db = new SQL.Database()
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS house_wallet (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      private_key_hex TEXT NOT NULL,
      public_key_hex TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      tier INTEGER NOT NULL,
      player_pubkey TEXT NOT NULL,
      player_choice TEXT NOT NULL,
      player_hash TEXT NOT NULL,
      player_change_address TEXT,
      house_secret_hex TEXT NOT NULL,
      player_secret_hex TEXT,
      winner TEXT,
      rake_amount INTEGER NOT NULL DEFAULT 0,
      payout_amount INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      setup_tx_hex TEXT,
      final_tx_hex TEXT,
      setup_script_hex TEXT,
      final_script_hex TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    )
  `)
  // Backfill columns for pre-existing DBs that predate the contract-subsystem
  // wiring. sql.js raises a parse error for ALTER TABLE on a missing column;
  // swallow if it already exists.
  for (const col of ['setup_script_hex', 'final_script_hex']) {
    try { db.run(`ALTER TABLE games ADD COLUMN ${col} TEXT`) } catch { /* already there */ }
  }

  // Seed default config
  const seedSql = 'INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)'
  db.run(seedSql, ['rake_type', 'percentage'])
  db.run(seedSql, ['rake_value', '2'])
  db.run(seedSql, ['tiers', JSON.stringify([1000, 5000, 10000, 50000])])
  db.run(seedSql, ['min_house_balance', '100000'])

  saveDb()
}

/**
 * SQLExecutor adapter for the Ark SDK's `SQLiteWalletRepository` /
 * `SQLiteContractRepository` and our own `repositories/*` impls.
 * Wraps sql.js (WASM) to match the SDK's driver-agnostic interface.
 */
export function getSqlExecutor(): SQLExecutor {
  return {
    run: async (sql: string, params?: unknown[]): Promise<void> => {
      db.run(sql, params as (string | number | null | Uint8Array)[])
      saveDb()
    },
    get: async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> => {
      const stmt = db.prepare(sql)
      if (params) stmt.bind(params as (string | number | null | Uint8Array)[])
      if (stmt.step()) {
        const row = stmt.getAsObject() as T
        stmt.free()
        return row
      }
      stmt.free()
      return undefined
    },
    all: async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      const results: T[] = []
      const stmt = db.prepare(sql)
      if (params) stmt.bind(params as (string | number | null | Uint8Array)[])
      while (stmt.step()) {
        results.push(stmt.getAsObject() as T)
      }
      stmt.free()
      return results
    },
  }
}
