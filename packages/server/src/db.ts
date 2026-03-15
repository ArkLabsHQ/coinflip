import initSqlJs, { Database } from 'sql.js'
import fs from 'fs'
import path from 'path'

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
      house_secret_hex TEXT NOT NULL,
      player_secret_hex TEXT,
      winner TEXT,
      rake_amount INTEGER NOT NULL DEFAULT 0,
      payout_amount INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      setup_tx_hex TEXT,
      final_tx_hex TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    )
  `)

  // Seed default config
  const seedSql = "INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)"
  db.run(seedSql, ['rake_type', 'percentage'])
  db.run(seedSql, ['rake_value', '2'])
  db.run(seedSql, ['tiers', JSON.stringify([1000, 5000, 10000, 50000])])
  db.run(seedSql, ['min_house_balance', '100000'])

  saveDb()
}

export function getDb(): Database {
  return db
}

// Config helpers
export function getConfig(key: string): string | undefined {
  const stmt = db.prepare("SELECT value FROM config WHERE key = ?")
  stmt.bind([key])
  if (stmt.step()) {
    const row = stmt.getAsObject()
    stmt.free()
    return row.value as string
  }
  stmt.free()
  return undefined
}

export function setConfig(key: string, value: string): void {
  db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [key, value])
  saveDb()
}

export function getAllConfig(): Record<string, string> {
  const result: Record<string, string> = {}
  const stmt = db.prepare("SELECT key, value FROM config")
  while (stmt.step()) {
    const row = stmt.getAsObject() as { key: string; value: string }
    result[row.key] = row.value
  }
  stmt.free()
  return result
}

// House wallet helpers
export interface HouseWalletRow {
  id: number
  private_key_hex: string
  public_key_hex: string
  created_at: string
}

export function getHouseWallet(): HouseWalletRow | undefined {
  const stmt = db.prepare("SELECT * FROM house_wallet WHERE id = 1")
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as HouseWalletRow
    stmt.free()
    return row
  }
  stmt.free()
  return undefined
}

export function setHouseWallet(privateKeyHex: string, publicKeyHex: string): void {
  db.run("INSERT OR REPLACE INTO house_wallet (id, private_key_hex, public_key_hex) VALUES (1, ?, ?)", [privateKeyHex, publicKeyHex])
  saveDb()
}

// Game helpers
export interface GameRow {
  id: string
  tier: number
  player_pubkey: string
  player_choice: string
  player_hash: string
  house_secret_hex: string
  player_secret_hex: string | null
  winner: string | null
  rake_amount: number
  payout_amount: number | null
  status: string
  setup_tx_hex: string | null
  final_tx_hex: string | null
  created_at: string
  resolved_at: string | null
}

export function createGame(game: {
  id: string
  tier: number
  playerPubkey: string
  playerChoice: string
  playerHash: string
  houseSecretHex: string
  setupTxHex?: string
  finalTxHex?: string
}): void {
  db.run(
    `INSERT INTO games (id, tier, player_pubkey, player_choice, player_hash, house_secret_hex, setup_tx_hex, final_tx_hex)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [game.id, game.tier, game.playerPubkey, game.playerChoice, game.playerHash, game.houseSecretHex, game.setupTxHex || null, game.finalTxHex || null]
  )
  saveDb()
}

export function updateGame(id: string, updates: Partial<{
  playerSecretHex: string
  winner: string
  rakeAmount: number
  payoutAmount: number
  status: string
}>): void {
  const sets: string[] = []
  const values: (string | number)[] = []

  if (updates.playerSecretHex !== undefined) { sets.push('player_secret_hex = ?'); values.push(updates.playerSecretHex) }
  if (updates.winner !== undefined) { sets.push('winner = ?'); values.push(updates.winner) }
  if (updates.rakeAmount !== undefined) { sets.push('rake_amount = ?'); values.push(updates.rakeAmount) }
  if (updates.payoutAmount !== undefined) { sets.push('payout_amount = ?'); values.push(updates.payoutAmount) }
  if (updates.status !== undefined) {
    sets.push('status = ?')
    values.push(updates.status)
    if (updates.status === 'resolved') {
      sets.push("resolved_at = datetime('now')")
    }
  }

  if (sets.length === 0) return
  values.push(id)
  db.run(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`, values)
  saveDb()
}

export function getGame(id: string): GameRow | undefined {
  const stmt = db.prepare("SELECT * FROM games WHERE id = ?")
  stmt.bind([id])
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as GameRow
    stmt.free()
    return row
  }
  stmt.free()
  return undefined
}

export function getGames(options: { limit?: number; offset?: number; status?: string } = {}): GameRow[] {
  const { limit = 50, offset = 0, status } = options
  const results: GameRow[] = []

  let stmt
  if (status) {
    stmt = db.prepare("SELECT * FROM games WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
    stmt.bind([status, limit, offset])
  } else {
    stmt = db.prepare("SELECT * FROM games ORDER BY created_at DESC LIMIT ? OFFSET ?")
    stmt.bind([limit, offset])
  }

  while (stmt.step()) {
    results.push(stmt.getAsObject() as unknown as GameRow)
  }
  stmt.free()
  return results
}

export function getPendingGamesCount(playerPubkey: string): number {
  const stmt = db.prepare("SELECT COUNT(*) as count FROM games WHERE player_pubkey = ? AND status = 'pending'")
  stmt.bind([playerPubkey])
  if (stmt.step()) {
    const row = stmt.getAsObject() as { count: number }
    stmt.free()
    return row.count
  }
  stmt.free()
  return 0
}

export function expirePendingGames(maxAgeMinutes: number = 5): number {
  db.run(
    `UPDATE games SET status = 'expired'
     WHERE status = 'pending'
     AND created_at < datetime('now', '-' || ? || ' minutes')`,
    [maxAgeMinutes]
  )
  const changes = db.getRowsModified()
  if (changes > 0) saveDb()
  return changes
}

export function getGameStats(): { gamesToday: number; profit24h: number; totalGames: number } {
  let gamesToday = 0
  let profit24h = 0
  let totalGames = 0

  let stmt = db.prepare("SELECT COUNT(*) as count FROM games WHERE status = 'resolved' AND date(created_at) = date('now')")
  if (stmt.step()) gamesToday = (stmt.getAsObject() as { count: number }).count
  stmt.free()

  stmt = db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN winner = 'house' THEN tier - rake_amount
           WHEN winner = 'player' THEN -tier + rake_amount
           ELSE 0 END
    ), 0) as profit FROM games
    WHERE status = 'resolved' AND created_at > datetime('now', '-1 day')
  `)
  if (stmt.step()) profit24h = (stmt.getAsObject() as { profit: number }).profit
  stmt.free()

  stmt = db.prepare("SELECT COUNT(*) as count FROM games WHERE status = 'resolved'")
  if (stmt.step()) totalGames = (stmt.getAsObject() as { count: number }).count
  stmt.free()

  return { gamesToday, profit24h, totalGames }
}
