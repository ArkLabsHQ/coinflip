/**
 * Repository interfaces shared by all storage backends.
 *
 * The free functions that used to live in db.ts have moved here so the
 * data-access surface is a single thing you can mock for tests, swap for
 * a different backend (Postgres, IndexedDB, etc.), or grep against to
 * find every read/write of a given table.
 */

/**
 * Driver-agnostic SQL execution interface. Mirrors `SQLExecutor` from
 * `@arkade-os/sdk/repositories/sqlite` (inlined here because the server
 * tsconfig uses legacy `moduleResolution: "node"`, which doesn't honor
 * subpath `exports` fields — the SDK reaches the interface anyway at
 * runtime because both impls share the same structural shape).
 */
export interface SQLExecutor {
  run(sql: string, params?: unknown[]): Promise<void>
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

// ── Game ──────────────────────────────────────────────────────────────────

export interface GameRow {
  id: string
  tier: number
  player_pubkey: string
  player_choice: string
  player_hash: string
  player_change_address: string | null
  house_secret_hex: string
  player_secret_hex: string | null
  winner: string | null
  rake_amount: number
  payout_amount: number | null
  status: string
  setup_tx_hex: string | null
  final_tx_hex: string | null
  setup_script_hex: string | null
  final_script_hex: string | null
  created_at: string
  resolved_at: string | null
}

export interface NewGame {
  id: string
  tier: number
  playerPubkey: string
  playerChoice: string
  playerHash: string
  playerChangeAddress?: string
  houseSecretHex: string
  setupTxHex?: string
  finalTxHex?: string
  setupScriptHex?: string
  finalScriptHex?: string
}

export interface GameUpdate {
  playerSecretHex?: string
  winner?: string
  rakeAmount?: number
  payoutAmount?: number
  status?: string
}

export interface GameFilter {
  status?: string
  limit?: number
  offset?: number
}

export interface GameStats {
  gamesToday: number
  profit24h: number
  totalGames: number
}

export interface GameRepository {
  save(game: NewGame): Promise<void>
  update(id: string, updates: GameUpdate): Promise<void>
  get(id: string): Promise<GameRow | undefined>
  list(filter?: GameFilter): Promise<GameRow[]>
  findByContractScript(scriptHex: string): Promise<GameRow | undefined>
  countPendingForPlayer(playerPubkey: string): Promise<number>
  expirePending(maxAgeMinutes: number): Promise<{ expired: number; rows: GameRow[] }>
  stats(): Promise<GameStats>
}

// ── House wallet ──────────────────────────────────────────────────────────

export interface HouseWalletRow {
  id: number
  private_key_hex: string
  public_key_hex: string
  created_at: string
}

export interface HouseWalletRepository {
  get(): Promise<HouseWalletRow | undefined>
  set(privateKeyHex: string, publicKeyHex: string): Promise<void>
}

// ── Config ────────────────────────────────────────────────────────────────

export interface ConfigRepository {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  all(): Promise<Record<string, string>>
}

// ── Container ─────────────────────────────────────────────────────────────

export interface Repos {
  games: GameRepository
  houseWallet: HouseWalletRepository
  config: ConfigRepository
}
