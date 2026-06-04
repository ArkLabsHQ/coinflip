# CoinFlip

A trustless, provably-fair Bitcoin coin-flip game built on [Arkade](https://arkadeos.com). Players flip against the house; the outcome is decided by a two-party commit–reveal scheme, and the stakes are escrowed on-chain in an **Arkade Script covenant** so neither side can cheat, withhold, or walk off with the pot.

> Want the full picture? The running app has an in-app **How It Works** page (`/how-it-works`) that walks through Arkade, Arkade Script, commit–reveal, and every escrow leaf down to its opcodes.

## How it works

Each round has two participants — the **house** (the server) and the **player**. Both **commit** to `SHA256(secret)` up front, then **reveal**; the two secrets together decide the winner. Every secret is drawn from a CSPRNG, and the committed hash binds each side to its choice before anyone reveals — so neither party learns the other's secret before committing, and neither can change their mind after.

The secret's **byte length encodes the call**:

- **Coin (50/50):** 15 bytes = heads, 16 bytes = tails. Same length → **player wins**, different length → **house wins**.
- **Variable odds (slot / dice / roulette / rocket):** the secret also carries a digit; the roll is `(digit_house + digit_player) mod n`, and the player wins iff it lands in the chosen band `[lo, target)`. The win rate — and, for rocket, the multiplier — is simply how wide that band is.

Because each side picks independently at random, the flip is provably fair.

### Settlement — the Arkade Script covenant

Funds live on **Arkade**, a programmable Bitcoin execution layer where coins are held off-chain as self-custodial VTXOs that can be locked with any valid Tapscript and unilaterally exited to the chain.

Settlement is **per-party**: the house funds the house escrow and the player funds the player escrow, both into the same contract, so neither side can abort and steal the other's stake. Each escrow is a Taproot output with **eight tapscript leaves** — four **collaborative covenant** paths (win / forfeit / refund, settled by the operator together with the emulator co-signer) and four **unilateral-exit** mirrors (the same outcomes, claimable on-chain with no operator involved).

A covenant leaf is an ordinary multisig whose emulator pubkey is *tweaked* by a tagged hash of an Arkade Script. The emulator produces that tweaked signature **only after running the script** and checking the spend does exactly what the covenant says (e.g. "pay the whole pot to the winner") — so the signature itself is the proof the covenant held. The winner sweeps both stakes through their win leaf.

- **Collaborative path** — once both secrets are revealed, the operator and the emulator settle the winner immediately. Fast and cheap.
- **Unilateral fallback** — if the operator or the counterparty disappears, the affected party still claims, forfeits, or refunds on-chain through the exit leaves. This is what makes the game non-custodial.

## Repository layout

This is a monorepo:

| Path | Package | What it is |
|------|---------|------------|
| `packages/lib` | `arkade-coinflip` | Transport-agnostic protocol library: game state machine, commit–reveal, Arkade-Script/Taproot escrow construction, and transaction building. |
| `packages/contract-workflows-prototype` | `@arklabshq/contract-workflows-prototype` | Incubator for the arkade-script contract primitives the escrow is built from — covenants, predicates, and the emulator handoff (tweaked-key + `EmulatorPacket` helpers). |
| `packages/server` | `arkade-coinflip-server` | House-mode server. Public game API (`/api/play`, `/api/game/:id/commit`, `/api/game/:id/refund`, `/api/game/:id/forfeit`, `/api/tiers`, `/api/network`) + an admin dashboard. Holds the house wallet, drives the emulator covenant settlement, manages VTXO concurrency/liability, and persists state to SQLite (`better-sqlite3`, WAL). |
| `src/` (root) | web client | Vue 3 single-page app: an Arkade wallet (`@arkade-os/sdk`), Lightning / on-chain / Arkade cash-in & cash-out via Boltz swaps (`@arkade-os/boltz-swap`), pluggable UI **skins** (coin / slot / dice / roulette / rocket — all variable-odds), and a wallet drawer. The client follows whatever network the server reports. |
| `packages/e2e` | tests | Jest unit + integration/e2e tests (protocol units, server HTTP API, full game lifecycles, covenant settlement with forfeit/refund recovery, and Lightning rails). |

## Running locally

The full stack runs against a local Arkade regtest, vendored as the **`arkade-regtest`** git submodule (a Node-orchestrated Docker Compose stack — no `nigiri`/WSL dependency). Initialise submodules, bring the regtest (and its bundled arkade-script emulator) up, then start the app:

```bash
git submodule update --init --recursive
node arkade-regtest/regtest.mjs start   # local Arkade regtest + emulator
docker compose up --build               # server + client join the regtest network
```

- client → http://localhost:8080
- admin dashboard → http://localhost:3002

`docker-compose.yml` already wires the server to the regtest's emulator (`EMULATOR_URL`), so trustless play works out of the box locally. Tear the regtest down with `node arkade-regtest/regtest.mjs clean`.

To work on just the web client against an existing API:

```bash
npm install
npm run serve   # http://localhost:8080
```

### All-in-one bundle

`Dockerfile.bundle` / `docker-compose.bundle.yml` build a single image that serves the built client **and** the public API on one port, with the admin dashboard on another — no separate client container:

```bash
docker compose -f docker-compose.bundle.yml up --build
# user (client + /api) → http://localhost:3000
# admin dashboard      → http://localhost:3002
```

## Configuration

The network is the **server's** choice (set once via env), and the client asks the server for it via `/api/network` — there is no client-side network switch.

Key server env vars:

| Var | Default | Notes |
|-----|---------|-------|
| `ARK_SERVER_URL` | `https://mutinynet.arkade.sh` | Arkade server to connect to. The detected network (regtest / mutinynet / …) flows from here. |
| `ESPLORA_URL` | *(unset → SDK auto-default)* | Optional. Leave unset to let the SDK pick the network's default esplora; set it for regtest/docker where the host differs. |
| `EMULATOR_URL` | *(unset)* | The arkade-script emulator the server uses to co-sign covenant settlements. Required for trustless play — without it `/api/play` returns an error. |
| `EMULATOR_PUBLIC_URL` | *(= `EMULATOR_URL`)* | Emulator URL advertised to the browser via `/api/network` (set this when the server reaches the emulator under a different host than the browser does). |
| `PUBLIC_PORT` | `3001` | Player-facing game API — also serves the client when `CLIENT_DIR` is set. |
| `ADMIN_PORT` | `3002` | Admin dashboard + config API. |
| `ADMIN_HOST` | `127.0.0.1` | Set `0.0.0.0` to expose the admin port behind a reverse proxy. |
| `CLIENT_DIR` | *(unset)* | Point at a built client to have the server serve it on `PUBLIC_PORT` (used by the all-in-one bundle). |
| `DATA_DIR` | `./data` | Where the SQLite DB (house wallet + games) lives. |

## License

MIT — see [LICENSE](LICENSE).
