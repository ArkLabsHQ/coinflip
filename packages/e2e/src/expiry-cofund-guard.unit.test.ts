/**
 * `expirePending` must NEVER expire a CO-FUNDED v4 game. Such a game has both stakes
 * live on-chain in a pot VTXO; the v4 refund/stage-2 reconcilers only act on
 * non-resolved games, so flipping it to 'expired' at T+5min stranded both stakes AND
 * opened a theft — a stalling player could sweep the whole pot via the unconditional
 * playerTakeAll leaf at finalExpiration (T+30). This pins the guard: co-funded games
 * survive expiry; pre-cofund abandoned games still expire (to free their reservation).
 * Real in-memory better-sqlite3 (resolved via the server pkg). No regtest.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { createRequire } from 'module'
const {
  SQLiteGameRepository,
  isCofundedGame,
} = require('arkade-coinflip-server/dist/repositories/gameRepository.js')

const reqFromServer = createRequire(require.resolve('arkade-coinflip-server/package.json'))
const Database = reqFromServer('better-sqlite3')

function makeExecutor() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE games (
      id TEXT PRIMARY KEY, tier INTEGER NOT NULL, player_pubkey TEXT NOT NULL,
      player_choice TEXT NOT NULL, player_hash TEXT NOT NULL, player_change_address TEXT,
      house_secret_hex TEXT NOT NULL, player_secret_hex TEXT, winner TEXT,
      rake_amount INTEGER NOT NULL DEFAULT 0, payout_amount INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', house_vtxos_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
    )`)
  const exec = {
    run: async (sql: string, params: any[] = []) => { db.prepare(sql).run(...params) },
    get: async (sql: string, params: any[] = []) => db.prepare(sql).get(...params),
    all: async (sql: string, params: any[] = []) => db.prepare(sql).all(...params),
  }
  return { db, exec }
}
function insert(db: any, id: string, houseVtxosJson: string | null) {
  db.prepare(`INSERT INTO games (id, tier, player_pubkey, player_choice, player_hash, house_secret_hex, status, house_vtxos_json, created_at)
    VALUES (?, 1000, 'aa', 'trustless-v4', 'hh', 'hs', 'pending', ?, datetime('now'))`).run(id, houseVtxosJson)
}

describe('isCofundedGame', () => {
  it('true when the persisted state carries a cofund txid (submit or finalize)', () => {
    expect(isCofundedGame(JSON.stringify({ cofundArkTxid: 'abc' }))).toBe(true)
    expect(isCofundedGame(JSON.stringify({ cofundTxid: 'def' }))).toBe(true)
  })
  it('false for a played-but-not-co-funded game, null, or malformed JSON', () => {
    expect(isCofundedGame(JSON.stringify({ potAddress: 'p', houseInputs: [] }))).toBe(false)
    expect(isCofundedGame(null)).toBe(false)
    expect(isCofundedGame(undefined)).toBe(false)
    expect(isCofundedGame('not json')).toBe(false)
  })
})

describe('expirePending — co-funded games are never expired', () => {
  it('expires a played-only aged game but leaves a co-funded aged game pending', async () => {
    const { db, exec } = makeExecutor()
    const repo = new SQLiteGameRepository(exec)
    insert(db, 'played-only', JSON.stringify({ potAddress: 'p', houseInputs: [] })) // no cofund → expirable
    insert(db, 'cofunded-submit', JSON.stringify({ cofundArkTxid: 'abc' }))         // co-funded → protected
    insert(db, 'cofunded-final', JSON.stringify({ cofundTxid: 'def' }))             // co-funded → protected
    // age all three past the 5-min window
    db.prepare("UPDATE games SET created_at = datetime('now','-10 minutes')").run()

    const { expired, rows } = await repo.expirePending(5)

    expect(expired).toBe(1)
    expect(rows.map((r: any) => r.id)).toEqual(['played-only'])
    expect((await repo.get('played-only')).status).toBe('expired')
    expect((await repo.get('cofunded-submit')).status).toBe('pending')
    expect((await repo.get('cofunded-final')).status).toBe('pending')
  })

  it('does not touch a fresh (< maxAge) co-funded or played game', async () => {
    const { db, exec } = makeExecutor()
    const repo = new SQLiteGameRepository(exec)
    insert(db, 'fresh-played', null)
    insert(db, 'fresh-cofunded', JSON.stringify({ cofundArkTxid: 'abc' }))
    const { expired } = await repo.expirePending(5)
    expect(expired).toBe(0)
    expect((await repo.get('fresh-played')).status).toBe('pending')
  })
})
