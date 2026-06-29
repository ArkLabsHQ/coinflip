import type {
  GameFilter,
  GameRepository,
  GameRow,
  GameStats,
  GameUpdate,
  NewGame,
  PlayerGamesFilter,
  SQLExecutor,
} from './types.js'

/** Hard ceiling on `listForPlayer` page size — clamps a caller-supplied limit
 *  so a "restore my games" request can't ask for an unbounded scan. */
export const LIST_FOR_PLAYER_MAX = 100
/** Default page size when the caller doesn't specify one. */
export const LIST_FOR_PLAYER_DEFAULT = 50

export class SQLiteGameRepository implements GameRepository {
  constructor(private readonly db: SQLExecutor) {}

  async save(game: NewGame): Promise<void> {
    await this.db.run(
      `INSERT INTO games (
         id, tier, player_pubkey, player_choice, player_hash,
         player_change_address, house_secret_hex, house_vtxos_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        game.id,
        game.tier,
        game.playerPubkey,
        game.playerChoice,
        game.playerHash,
        game.playerChangeAddress || null,
        game.houseSecretHex,
        game.houseVtxosJson || null,
      ],
    )
  }

  async update(id: string, updates: GameUpdate): Promise<void> {
    const sets: string[] = []
    const values: (string | number)[] = []

    if (updates.playerSecretHex !== undefined) { sets.push('player_secret_hex = ?'); values.push(updates.playerSecretHex) }
    if (updates.winner !== undefined) { sets.push('winner = ?'); values.push(updates.winner) }
    if (updates.rakeAmount !== undefined) { sets.push('rake_amount = ?'); values.push(updates.rakeAmount) }
    if (updates.payoutAmount !== undefined) { sets.push('payout_amount = ?'); values.push(updates.payoutAmount) }
    if (updates.houseVtxosJson !== undefined) { sets.push('house_vtxos_json = ?'); values.push(updates.houseVtxosJson) }
    if (updates.status !== undefined) {
      sets.push('status = ?')
      values.push(updates.status)
      if (updates.status === 'resolved') {
        sets.push("resolved_at = datetime('now')")
      }
    }

    if (sets.length === 0) return
    values.push(id)
    await this.db.run(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`, values)
  }

  async get(id: string): Promise<GameRow | undefined> {
    return this.db.get<GameRow>('SELECT * FROM games WHERE id = ?', [id])
  }

  async list(filter: GameFilter = {}): Promise<GameRow[]> {
    const { limit = 50, offset = 0, status } = filter
    if (status) {
      return this.db.all<GameRow>(
        'SELECT * FROM games WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [status, limit, offset],
      )
    }
    return this.db.all<GameRow>(
      'SELECT * FROM games ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset],
    )
  }

  async countPendingForPlayer(playerPubkey: string): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM games WHERE player_pubkey = ? AND status = 'pending'",
      [playerPubkey],
    )
    return row?.count ?? 0
  }

  async listForPlayer(playerPubkey: string, opts: PlayerGamesFilter = {}): Promise<GameRow[]> {
    // Clamp the page size to [1, LIST_FOR_PLAYER_MAX] (NaN/≤0 → default) so a
    // restore request can't request an unbounded scan; floor a non-negative
    // offset. Backed by idx_games_player (see db.ts initDb).
    const rawLimit = opts.limit
    const limit = Number.isFinite(rawLimit) && (rawLimit as number) > 0
      ? Math.min(Math.floor(rawLimit as number), LIST_FOR_PLAYER_MAX)
      : LIST_FOR_PLAYER_DEFAULT
    const offset = Number.isFinite(opts.offset) && (opts.offset as number) > 0 ? Math.floor(opts.offset as number) : 0
    if (opts.status) {
      return this.db.all<GameRow>(
        'SELECT * FROM games WHERE player_pubkey = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [playerPubkey, opts.status, limit, offset],
      )
    }
    return this.db.all<GameRow>(
      'SELECT * FROM games WHERE player_pubkey = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [playerPubkey, limit, offset],
    )
  }

  async expirePending(maxAgeMinutes: number): Promise<{ expired: number; rows: GameRow[] }> {
    // Snapshot the rows that are about to flip so callers can drive
    // side-effects (e.g. inactivating contract records) against the
    // same set the UPDATE will touch.
    const rows = await this.db.all<GameRow>(
      `SELECT * FROM games WHERE status = 'pending'
       AND created_at < datetime('now', '-' || ? || ' minutes')`,
      [maxAgeMinutes],
    )
    if (rows.length === 0) return { expired: 0, rows: [] }
    await this.db.run(
      `UPDATE games SET status = 'expired'
       WHERE status = 'pending'
       AND created_at < datetime('now', '-' || ? || ' minutes')`,
      [maxAgeMinutes],
    )
    return { expired: rows.length, rows }
  }

  async stats(): Promise<GameStats> {
    const today = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM games WHERE status = 'resolved' AND date(created_at) = date('now')",
    )
    const profit = await this.db.get<{ profit: number }>(`
      SELECT COALESCE(SUM(
        CASE WHEN winner = 'house' THEN tier
             WHEN winner = 'player' THEN rake_amount - tier
             ELSE 0 END
      ), 0) as profit FROM games
      WHERE status = 'resolved' AND created_at > datetime('now', '-1 day')
    `)
    const total = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM games WHERE status = 'resolved'",
    )
    return {
      gamesToday: today?.count ?? 0,
      profit24h: profit?.profit ?? 0,
      totalGames: total?.count ?? 0,
    }
  }
}
