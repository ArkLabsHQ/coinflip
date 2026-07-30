/**
 * House profit (24h) must be computed from the REAL per-game stakes.
 *
 * The operator's report was blunt: "the profit one DEFINITELY ISNT [accurate]".
 * The old formula was
 *
 *   winner='house'  -> tier
 *   winner='player' -> rake_amount - tier
 *
 * which is wrong twice for v4:
 *
 *   * v4 is VARIABLE-ODDS. At a 95% win chance the house stakes ~19x the
 *     player's, so a player win costs `houseStake`, not `tier` — booking it as
 *     `-tier` understated losses by up to ~19x and inflated profit.
 *   * `rake_amount` is never written by v4; the edge is in the odds, and
 *     `buildJointPotSettleTx` pays the WHOLE pot to the winner, so there is no
 *     rake to add.
 *
 * Runs against a REAL in-memory better-sqlite3 (same pattern as
 * restore-games-repo.unit.test.ts), so the actual SQL is exercised — which also
 * proves `json_valid` / `json_extract` exist in this driver's SQLite build. The
 * fix depends on that, and assuming it would have been silent.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { createRequire } from 'module'
const { SQLiteGameRepository } = require('arkade-coinflip-server/dist/repositories/gameRepository.js')

const reqFromServer = createRequire(require.resolve('arkade-coinflip-server/package.json'))
const Database = reqFromServer('better-sqlite3')

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
  const exec = {
    run: async (sql: string, params: any[] = []) => { db.prepare(sql).run(...params) },
    get: async (sql: string, params: any[] = []) => db.prepare(sql).get(...params),
    all: async (sql: string, params: any[] = []) => db.prepare(sql).all(...params),
  }
  return { db, exec }
}

/** Resolved today, so it lands inside the 24h window. */
function insert(db: any, row: Partial<any> & { id: string }) {
  db.prepare(`
    INSERT INTO games (id, tier, player_pubkey, player_choice, player_hash, house_secret_hex, status, house_vtxos_json, winner, rake_amount, payout_amount, created_at, resolved_at)
    VALUES (@id, @tier, @player_pubkey, @player_choice, @player_hash, @house_secret_hex, @status, @house_vtxos_json, @winner, @rake_amount, @payout_amount, datetime('now'), @resolved_at)
  `).run({
    tier: 1000, player_pubkey: 'a'.repeat(64), player_choice: 'trustless-v4',
    player_hash: 'hh', house_secret_hex: 'hs', status: 'resolved',
    house_vtxos_json: null, winner: null, rake_amount: 0, payout_amount: null,
    resolved_at: null, ...row,
  })
}

/** A v4 state blob as /play persists it — only the fields stats() reads. */
const v4State = (pot: number, houseStake: number) =>
  JSON.stringify({
    protocolVersion: 'v4', pot, houseStake,
    covenant: { playerStake: pot - houseStake, houseStake },
  })

const profitOf = async (rows: Array<Partial<any> & { id: string }>) => {
  const { db, exec } = makeExecutor()
  for (const r of rows) insert(db, r)
  const { profit24h } = await new SQLiteGameRepository(exec).stats()
  return profit24h
}

describe('house profit (24h) uses real stakes, not tier', () => {
  it('the driver supports json_valid / json_extract at all', () => {
    const db = new Database(':memory:')
    const blob = v4State(20_000, 19_000)
    const row = db.prepare(
      `SELECT json_valid(?) AS ok, json_extract(?, '$.houseStake') AS hs`,
    ).get(blob, blob)
    expect(row.ok).toBe(1)
    expect(row.hs).toBe(19_000)
  })

  // The headline case.
  it('a player win costs the FULL house stake, not the tier', async () => {
    // ~95%: player stakes 1,000, house stakes 19,000, pot 20,000.
    const profit = await profitOf([
      { id: 'g1', tier: 1_000, winner: 'player', house_vtxos_json: v4State(20_000, 19_000) },
    ])
    expect(profit).toBe(-19_000) // the old formula gave -1,000
  })

  it('a house win gains the PLAYER stake (pot minus house stake)', async () => {
    const profit = await profitOf([
      { id: 'g1', tier: 1_000, winner: 'house', house_vtxos_json: v4State(20_000, 19_000) },
    ])
    expect(profit).toBe(1_000)
  })

  it('nets a mixed book correctly', async () => {
    // 19 house wins at +1,000 against one player win at -19,000 is break-even —
    // exactly the point of a 95% rung. The old formula scored this +18,000,
    // which is how a break-even book could read as clear profit.
    const rows = [
      ...Array.from({ length: 19 }, (_v, i) => ({
        id: `w${i}`, tier: 1_000, winner: 'house', house_vtxos_json: v4State(20_000, 19_000),
      })),
      { id: 'l1', tier: 1_000, winner: 'player', house_vtxos_json: v4State(20_000, 19_000) },
    ]
    expect(await profitOf(rows)).toBe(0)
  })

  it('an even-money game still works (the low-odds case is unchanged)', async () => {
    const profit = await profitOf([
      { id: 'g1', tier: 1_000, winner: 'house', house_vtxos_json: v4State(2_000, 1_000) },
      { id: 'g2', tier: 1_000, winner: 'player', house_vtxos_json: v4State(2_000, 1_000) },
    ])
    expect(profit).toBe(0)
  })

  it('falls back to tier for legacy rows, which really were even-money', async () => {
    // Pre-v4 stored a plain string[] of outpoints — valid JSON, but no $.pot.
    const profit = await profitOf([
      { id: 'g1', tier: 5_000, winner: 'house', house_vtxos_json: JSON.stringify(['abcd:0']) },
      { id: 'g2', tier: 5_000, winner: 'player', house_vtxos_json: JSON.stringify(['efgh:1']) },
    ])
    expect(profit).toBe(0)
  })

  it('a NULL or malformed blob cannot blank the dashboard', async () => {
    const profit = await profitOf([
      { id: 'g1', tier: 3_000, winner: 'house', house_vtxos_json: null },
      { id: 'g2', tier: 3_000, winner: 'house', house_vtxos_json: 'not json at all {{{' },
    ])
    expect(profit).toBe(6_000)
  })

  it('ignores unresolved games and resolved ones with no winner (refunds)', async () => {
    const profit = await profitOf([
      { id: 'p1', tier: 1_000, winner: null, status: 'pending', house_vtxos_json: v4State(20_000, 19_000) },
      { id: 'r1', tier: 1_000, winner: null, status: 'resolved', house_vtxos_json: v4State(20_000, 19_000) },
    ])
    expect(profit).toBe(0)
  })

  it('the 24h window excludes older resolved games', async () => {
    const { db, exec } = makeExecutor()
    // Two days ago — outside the window, so it must not move the number.
    db.prepare(`
      INSERT INTO games (id, tier, player_pubkey, player_choice, player_hash, house_secret_hex, status, house_vtxos_json, winner, rake_amount, payout_amount, created_at, resolved_at)
      VALUES ('old', 1000, 'a', 'trustless-v4', 'h', 's', 'resolved', ?, 'player', 0, NULL, datetime('now','-2 days'), NULL)
    `).run(v4State(20_000, 19_000))
    insert(db, { id: 'new', tier: 1_000, winner: 'house', house_vtxos_json: v4State(20_000, 19_000) })

    const { profit24h } = await new SQLiteGameRepository(exec).stats()
    expect(profit24h).toBe(1_000) // only the new one
  })

  it('rake_amount is not added — v4 never writes it', async () => {
    // Even with a stale rake on the row, profit must not move: the whole pot
    // goes to the winner, so there is no rake to collect.
    const profit = await profitOf([
      {
        id: 'g1', tier: 1_000, winner: 'player', rake_amount: 500,
        house_vtxos_json: v4State(20_000, 19_000),
      },
    ])
    expect(profit).toBe(-19_000) // not -18,500
  })
})
