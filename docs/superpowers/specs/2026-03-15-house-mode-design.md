# Coinflip House Mode — Design Spec

## Overview

Transform the coinflip server into a casino-style house that acts as the counterparty for every game. Players bet against the house instantly — no waiting for opponents. The server manages its own Ark wallet, applies a configurable rake, and exposes an admin dashboard on an internal-only port.

## Decisions

| Decision | Choice |
|----------|--------|
| House wallet funding | Manual deposits via admin UI |
| House cut | Configurable (% or flat), admin-adjustable |
| Game matching | House-only — every game is player vs house |
| Bet amounts | Preset tiers, admin-configurable |
| Admin auth | No auth, network/localhost isolation only |
| Architecture | Monolith, two ports (public + admin) |

## Architecture

### Docker Compose

```yaml
services:
  server:
    build: ./packages/server
    ports:
      - "3001:3001"    # Public game API
      # 3002 NOT exposed — admin only reachable internally
    volumes:
      - server-data:/app/data    # SQLite persistence
    environment:
      - ARK_SERVER_URL=https://mutinynet.arkade.sh
      - ESPLORA_URL=https://mutinynet.arkade.sh/esplora
      - PUBLIC_PORT=3001
      - ADMIN_PORT=3002

  client:
    build: .    # Root Dockerfile (Vue app)
    ports:
      - "8080:8080"
    environment:
      - VITE_API_URL=http://localhost:3001

volumes:
  server-data:
```

### Server Process

Single Express app, two listeners:

- **Port 3001 (public):** Player-facing game API
- **Port 3002 (admin):** Dashboard + config API, never exposed outside Docker network

### Persistence (SQLite)

One database file at `/app/data/coinflip.db` with tables:

```sql
-- House wallet identity (generated on first boot, persisted)
CREATE TABLE house_wallet (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  private_key_hex TEXT NOT NULL,
  public_key_hex TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin-configurable settings
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: rake_type ('percentage'|'flat'), rake_value ('2'|'500'),
--        tiers ('[1000,5000,10000,50000]'),
--        min_house_balance ('100000')

-- Game history for accounting
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  tier INTEGER NOT NULL,
  player_pubkey TEXT NOT NULL,
  player_choice TEXT NOT NULL,       -- 'heads' | 'tails'
  house_secret_hex TEXT NOT NULL,
  player_secret_hex TEXT,            -- NULL until resolved
  winner TEXT,                       -- 'house' | 'player' | NULL
  rake_amount INTEGER NOT NULL DEFAULT 0,
  payout_amount INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | signed | resolved | expired
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
```

### Default Config (seeded on first boot)

| Key | Default Value | Notes |
|-----|---------------|-------|
| `rake_type` | `percentage` | `percentage` or `flat` |
| `rake_value` | `2` | 2% or 2 sats depending on type |
| `tiers` | `[1000,5000,10000,50000]` | JSON array of sats |
| `min_house_balance` | `100000` | Sats — below this, `houseReady` is false |

### SQLite Library

Use `better-sqlite3` — synchronous, fast, no native compilation issues in Docker (Alpine-compatible).

### Security Note

The house private key is stored in plaintext in SQLite. The Docker volume containing `/app/data` must be treated as sensitive. At-rest encryption is out of scope for MVP but should be considered for production deployments.

## House Wallet

### Role Mapping

The house always assumes the **creator** role in the lib's `Game` model. The lib's `determineWinner()` returns `'creator' | 'player'` — the server maps `'creator'` → `'house'` in API responses and database storage.

### Lifecycle

1. **First boot:** Generate new keypair, store in `house_wallet` table. Create SDK `Wallet` instance.
2. **Subsequent boots:** Load keypair from SQLite, restore wallet.
3. **Storage:** Use SDK's `InMemoryWalletRepository` + `InMemoryContractRepository` for VTXO state (refreshed from Ark server on boot). Private key persisted in SQLite only.
4. **Balance:** Fetched from Ark server via SDK (`wallet.getBalance()`). Cached, refreshed after each game.

### Deposit Flow

- Admin UI shows the house Ark address + QR code
- Admin sends VTXOs to that address from any Ark wallet
- Server detects new balance on next refresh (or admin clicks "Refresh Balance")
- No withdrawal from admin UI (security — admin moves funds via external wallet if needed)

## Game Flow

### Public API

#### `GET /api/tiers`

Returns available bet tiers and house readiness:

```json
{
  "tiers": [1000, 5000, 10000, 50000],
  "maxAvailable": 50000,
  "houseReady": true
}
```

Tiers where `tier > houseBalance / 2` are returned but marked unavailable (client grays them out). `houseReady` is false if balance below `min_house_balance` config.

#### `POST /api/play`

Request:
```json
{
  "tier": 10000,
  "choice": "heads",
  "playerPubkey": "hex...",
  "playerHash": "hex...",
  "playerVtxos": [
    {
      "outpoint": { "txid": "hex...", "vout": 0 },
      "amount": 15000,
      "tapscripts": ["hex..."],
      "leaf": "hex..."
    }
  ],
  "playerChangeAddress": "ark1..."
}
```

Response:
```json
{
  "gameId": "uuid",
  "housePubkey": "hex...",
  "houseHash": "hex...",
  "setupTx": "hex...",
  "finalTx": "hex...",
  "houseSetupSignatures": ["hex..."],
  "houseFinalSignature": "hex..."
}
```

The `playerHash` field is the SHA-256 hash of the player's secret. The player generates their secret client-side (using `generateSecret('heads'|'tails')` from the lib), sends only the hash here, and reveals the actual secret in `/api/game/:id/sign`. The `choice` field is informational for display — the actual game outcome is determined by comparing secret byte sizes (15 = heads, 16 = tails).

The `playerVtxos` array uses the `VtxoInput` shape from `packages/lib/src/types.ts`. The house wallet's own VTXOs (standard Ark VTXOs from the SDK) are adapted to `VtxoInput` format by extracting `outpoint`, `amount`, and tapscript data from the SDK's `VirtualCoin` objects.

Server-side steps:
1. Validate tier exists and house can cover it
2. Generate house secret (15 bytes = heads, 16 bytes = tails — random choice)
3. Hash the secret
4. Select house VTXOs via `coinSelect()` (SDK VTXOs adapted to `VtxoInput` format)
5. Fetch `ArkInfo` from the Ark server (`GET /v1/info` — cached on startup, refreshed periodically)
6. Build setup + final transactions using lib's `buildGameTransactions()`
7. Sign house side of both transactions
8. Store game in SQLite as `pending`
9. Return partial transactions for player to counter-sign

#### `POST /api/game/:id/sign`

Request:
```json
{
  "playerSetupSignatures": ["hex..."],
  "playerFinalSignature": "hex...",
  "playerSecretHex": "hex..."
}
```

Response:
```json
{
  "winner": "player",
  "houseSecret": "hex...",
  "playerSecret": "hex...",
  "houseSecretSize": 15,
  "playerSecretSize": 15,
  "payout": 19600,
  "rake": 400,
  "proof": "Both secrets are 15 bytes (heads). Player chose heads. Player wins."
}
```

Server-side steps:
1. Load game from SQLite
2. Validate player secret matches their committed hash
3. Apply player signatures to setup + final txs
4. Submit setup tx to Ark server
5. Determine winner via `determineWinner(houseSecret, playerSecret)`
6. Calculate rake: `rake = floor(potAmount * rakePercent / 100)` (or flat amount)
7. If rake would push payout below dust, waive rake
8. Execute the winning final tx path (see Rake Implementation below)
9. Update game in SQLite: winner, payout, rake, resolved_at
10. Return result with full cryptographic proof

### Rake Implementation

The rake is applied **after** the final transaction resolves, not embedded in the transaction itself. The existing `CoinflipFinalScript` pays the full pot to the winner's address — we don't modify this.

- **House wins:** The house claims the full pot via the `creatorWin` spending path. The rake is purely an accounting entry — the house already holds the funds.
- **Player wins:** The player claims the full pot via the `playerWin` spending path. The rake is deducted by building the final tx output as `potAmount - rake` to the player and `rake` to a house change address. This requires modifying `buildGameTransactions()` to accept an optional `rake` parameter that adds a second output to the final tx winner paths.

If modifying the final tx proves too complex for MVP, fallback: the rake is accounting-only (tracked in SQLite for reporting) and the winner always gets the full pot. The house edge comes from the statistical 50/50 over time.

### House Fund Redemption

When the house wins, the pot is locked in the `creatorWin` leaf of the `CoinflipFinalScript`. The server redeems it by:

1. Revealing both secrets (proves the condition: different sizes = creator wins)
2. Signing with the house key + requesting Ark server co-signature
3. Submitting the final tx to the Ark server
4. The redeemed VTXOs appear in the house wallet's balance on next refresh

### Game Expiry & Cleanup

Pending games (player called `/api/play` but never `/api/game/:id/sign`) lock house VTXOs. To prevent DoS:

- **TTL:** Pending games expire after 5 minutes (matching the existing `setupExpiration` logic).
- **Cleanup:** A periodic timer (every 60 seconds) scans for expired pending games, marks them `expired` in SQLite, and releases the locked house VTXOs back to the available pool.
- **Rate limiting:** Max 3 concurrent pending games per player pubkey. Additional `/api/play` calls are rejected with `429 Too Many Requests`.
- **Locked balance tracking:** House maintains a `lockedBalance` counter (sum of tiers in pending games). Available balance for new games = `totalBalance - lockedBalance`.

### Fairness

The house commits to its secret hash *before* seeing the player's secret. The player commits to their choice *before* seeing the house's secret. Neither side can cheat because:

- House secret is hash-locked in the setup transaction
- Player choice is committed in the `/api/play` call
- Winner is determined by comparing secret sizes (15 vs 16 bytes) — deterministic, verifiable
- Both secrets are revealed in the result for independent verification

## Admin Dashboard

### Served on port 3002

Single HTML page with inline CSS/JS. No framework — lightweight and fast.

### Layout

**Header:** "COINFLIP HOUSE" branding

**Stats row (3 cards):**
- House Balance (sats)
- Games Today (count)
- Profit 24h (sats, net of payouts)

**Deposit section:**
- House Ark address (text + copy button)
- QR code (generated client-side)
- "Refresh Balance" button

**Config section:**
- Rake: input + radio (percentage / flat) + save button
- Tiers: editable list with add/remove
- Min house balance: input + save

**Recent games table:**
- Columns: ID (truncated), Tier, Winner, Rake, Time
- Paginated, most recent first
- Color-coded: green for house wins, red for losses

### Admin API (port 3002)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serve dashboard HTML |
| GET | `/api/status` | Balance, game count, profit stats |
| GET | `/api/config` | Current rake, tiers, min balance |
| POST | `/api/config` | Update rake, tiers, min balance |
| GET | `/api/games` | Paginated game history |
| GET | `/api/wallet` | Deposit address, balance, VTXO count |

## Player-Facing Client

### Casino aesthetic

- Dark background (#0a0a0f), neon accent colors (electric blue, gold)
- Card-based layouts with subtle glow/shadow effects
- Monospace font for amounts, sans-serif for UI text
- Animated coin flip on result
- Responsive — works on mobile

### Screens

**1. Play screen (`/`)**
- Animated coin centerpiece
- Tier selector: horizontal row of chip-styled buttons
- Side selector: two large HEADS / TAILS buttons
- "FLIP IT" CTA button (disabled until tier + side selected)
- Bottom bar: balance display + wallet link
- Disabled state: if player has no wallet, redirect to setup; if balance too low, show deposit prompt

**2. Result overlay (modal)**
- Coin flip animation (CSS)
- Win/loss announcement with payout amount
- Rake shown transparently
- Cryptographic proof section (expandable): both secrets, sizes, winner logic
- "PLAY AGAIN" and "HISTORY" buttons

**3. Wallet screen (`/wallet`)**
- Casino-styled dark card layout
- Deposit: Ark address + QR code
- Balance display (sats + BTC)
- Withdraw: input + send to Ark address
- Game history: list of past games with results
- "Back Up Key" / "Delete Wallet" in settings section

**4. Setup screen (`/setup`)**
- Create new wallet or restore from nsec
- Same flow as current, restyled to match casino theme
- Redirects to play screen after wallet creation

### Removed from current client

**Components:**
- Nostr relay integration (all relay code, RelaySettings component)
- P2P game creation (CreateGameModal)
- Game list / game view (GameList, GameView components)
- About / HowItWorks views (can be linked externally)
- ArkSettings component (server URL comes from env/build config)

**Vuex store modules:**
- Remove all Nostr relay state, actions, mutations from `store/index.ts` (relay URL, subscriptions, NIP-04 encryption, event kinds 400000/4, `pushGameEvent`, `subscribeToGames`, `emittedEvents`, `deletedGames`)
- Remove `gameEvents` state and all game-event-related getters
- Keep `wallet` module as-is
- Keep `ark` module but remove direct Ark server URL configuration (use `VITE_API_URL` env var pointing to game server; the game server proxies Ark operations)

### New in client

- Tier selector component
- Coin flip animation component
- Result overlay component
- Game history list (fetched from server, not Nostr)
- API service layer (replaces Nostr transport)

## File Structure (after changes)

```
packages/
  server/
    src/
      index.ts           # Express app, two listeners
      house-wallet.ts     # SDK wallet management
      game-engine.ts      # Game creation, signing, resolution
      db.ts               # SQLite setup + queries
      admin/
        routes.ts         # Admin API routes
        dashboard.html    # Single-file admin dashboard
      public/
        routes.ts         # Player-facing API routes
    Dockerfile
    package.json

src/                       # Vue client (restyled)
  App.vue
  main.ts
  router/index.ts
  store/
    index.ts              # Simplified — wallet + ark only
    modules/
      wallet.ts           # Keep as-is (Nostr keygen)
      ark/ark.ts          # Keep, point to server API
  views/
    PlayView.vue          # New — tier + side selection
    WalletView.vue        # Restyled
    SetupView.vue         # Restyled
    HistoryView.vue       # New — game history
  components/
    CoinFlip.vue          # New — animated coin
    TierSelector.vue      # New — bet tier chips
    ResultOverlay.vue     # New — win/loss modal
    GameHistoryList.vue   # New — past games table
  services/
    api.ts                # New — HTTP client for server
  assets/
    casino-theme.scss     # New — dark casino styles

Dockerfile                 # Client container
docker-compose.yml         # Root — orchestrates both
```

## Environment Variables

### Server
| Var | Default | Purpose |
|-----|---------|---------|
| `ARK_SERVER_URL` | `https://mutinynet.arkade.sh` | Ark protocol server |
| `ESPLORA_URL` | `https://mutinynet.arkade.sh/esplora` | Block explorer for tx verification |
| `PUBLIC_PORT` | `3001` | Player-facing API port |
| `ADMIN_PORT` | `3002` | Admin dashboard port |
| `DATA_DIR` | `/app/data` | SQLite database directory |

### Client
| Var | Default | Purpose |
|-----|---------|---------|
| `VITE_API_URL` | `http://localhost:3001` | Server API base URL |
