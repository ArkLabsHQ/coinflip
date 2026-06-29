/**
 * Unit tests for SQLiteGameRepository.listForPlayer — the "restore my games"
 * read. Runs against a REAL in-memory better-sqlite3 (resolved via the server
 * package, which owns the dep) so the actual SQL is exercised: the
 * player_pubkey filter, the optional status filter, newest-first ordering, and
 * the hard limit cap (LIST_FOR_PLAYER_MAX). No regtest.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { createRequire } from 'module'
const {
  SQLiteGameRepository,
  LIST_FOR_PLAYER_MAX,
  LIST_FOR_PLAYER_DEFAULT,
} = require('arkade-coinflip-server/dist/repositories/gameRepository.js')

// better-sqlite3 lives in the server package's node_modules; resolve it there.
const reqFromServer = createRequire(require.resolve('arkade-coinflip-server/package.json'))
const Database = reqFromServer('better-sqlite3')

/** Minimal SQLExecutor over an in-memory better-sqlite3 (mirrors db.ts's). */
function makeExecutor() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE games (
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
      house_vtxos_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_games_player ON games(player_pubkey)')
  const exec = {
    run: async (sql: string, params: any[] = []) => { db.prepare(sql).run(...params) },
    get: async (sql: string, params: any[] = []) => db.prepare(sql).get(...params),
    all: async (sql: string, params: any[] = []) => db.prepare(sql).all(...params),
  }
  return { db, exec }
}

/** Insert a game row with an explicit created_at so ordering is deterministic. */
function insert(db: any, row: Partial<any> & { id: string; player_pubkey: string; created_at: string }) {
  db.prepare(`
    INSERT INTO games (id, tier, player_pubkey, player_choice, player_hash, house_secret_hex, status, house_vtxos_json, winner, rake_amount, payout_amount, created_at, resolved_at)
    VALUES (@id, @tier, @player_pubkey, @player_choice, @player_hash, @house_secret_hex, @status, @house_vtxos_json, @winner, @rake_amount, @payout_amount, @created_at, @resolved_at)
  `).run({
    tier: 1000, player_choice: 'trustless-v4', player_hash: 'hh', house_secret_hex: 'hs',
    status: 'pending', house_vtxos_json: null, winner: null, rake_amount: 0, payout_amount: null,
    resolved_at: null, ...row,
  })
}

const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)

describe('SQLiteGameRepository.listForPlayer', () => {
  it('returns only the requested player\'s games, newest-first', async () => {
    const { db, exec } = makeExecutor()
    insert(db, { id: 'a1', player_pubkey: PK_A, created_at: '2026-01-01T00:00:00Z' })
    insert(db, { id: 'a2', player_pubkey: PK_A, created_at: '2026-01-03T00:00:00Z' })
    insert(db, { id: 'a3', player_pubkey: PK_A, created_at: '2026-01-02T00:00:00Z' })
    insert(db, { id: 'b1', player_pubkey: PK_B, created_at: '2026-01-05T00:00:00Z' })
    const repo = new SQLiteGameRepository(exec)
    const rows = await repo.listForPlayer(PK_A)
    expect(rows.map((r: any) => r.id)).toEqual(['a2', 'a3', 'a1']) // DESC by created_at, B excluded
  })

  it('filters by status when given', async () => {
    const { db, exec } = makeExecutor()
    insert(db, { id: 'p1', player_pubkey: PK_A, status: 'pending', created_at: '2026-01-01T00:00:00Z' })
    insert(db, { id: 'r1', player_pubkey: PK_A, status: 'resolved', created_at: '2026-01-02T00:00:00Z' })
    insert(db, { id: 'e1', player_pubkey: PK_A, status: 'expired', created_at: '2026-01-03T00:00:00Z' })
    const repo = new SQLiteGameRepository(exec)
    expect((await repo.listForPlayer(PK_A, { status: 'pending' })).map((r: any) => r.id)).toEqual(['p1'])
    expect((await repo.listForPlayer(PK_A, { status: 'resolved' })).map((r: any) => r.id)).toEqual(['r1'])
  })

  it('returns an empty array for an unknown pubkey', async () => {
    const { exec } = makeExecutor()
    const repo = new SQLiteGameRepository(exec)
    expect(await repo.listForPlayer('f'.repeat(64))).toEqual([])
  })

  it('caps the limit at LIST_FOR_PLAYER_MAX even when a larger value is asked for', async () => {
    const { db, exec } = makeExecutor()
    for (let i = 0; i < LIST_FOR_PLAYER_MAX + 25; i++) {
      insert(db, { id: `g${i}`, player_pubkey: PK_A, created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` })
    }
    const repo = new SQLiteGameRepository(exec)
    expect((await repo.listForPlayer(PK_A, { limit: 10_000 })).length).toBe(LIST_FOR_PLAYER_MAX)
    expect((await repo.listForPlayer(PK_A, { limit: 5 })).length).toBe(5) // honours a smaller limit
  })

  it('falls back to the default page size for missing/invalid limits', async () => {
    const { db, exec } = makeExecutor()
    for (let i = 0; i < LIST_FOR_PLAYER_DEFAULT + 10; i++) {
      insert(db, { id: `g${i}`, player_pubkey: PK_A, created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` })
    }
    const repo = new SQLiteGameRepository(exec)
    expect((await repo.listForPlayer(PK_A)).length).toBe(LIST_FOR_PLAYER_DEFAULT)
    expect((await repo.listForPlayer(PK_A, { limit: 0 })).length).toBe(LIST_FOR_PLAYER_DEFAULT)
    expect((await repo.listForPlayer(PK_A, { limit: -3 })).length).toBe(LIST_FOR_PLAYER_DEFAULT)
    expect((await repo.listForPlayer(PK_A, { limit: NaN })).length).toBe(LIST_FOR_PLAYER_DEFAULT)
  })

  it('applies offset for paging (newest-first)', async () => {
    const { db, exec } = makeExecutor()
    insert(db, { id: 'a1', player_pubkey: PK_A, created_at: '2026-01-01T00:00:00Z' })
    insert(db, { id: 'a2', player_pubkey: PK_A, created_at: '2026-01-02T00:00:00Z' })
    insert(db, { id: 'a3', player_pubkey: PK_A, created_at: '2026-01-03T00:00:00Z' })
    const repo = new SQLiteGameRepository(exec)
    expect((await repo.listForPlayer(PK_A, { limit: 1, offset: 1 })).map((r: any) => r.id)).toEqual(['a2'])
  })
})

export {}
