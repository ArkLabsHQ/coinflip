# CoinFlip

A trustless, provably-fair Bitcoin coin-flip game built on [Ark](https://arkadeos.com). Players flip against the house; the outcome is decided by a two-party commit-reveal scheme, and funds are protected on-chain by Taproot scripts so neither side can cheat or withhold.

## How it works

Each round has two participants — the **house** (the server) and the **player**. Both commit to `SHA256(secret)` up front, where the secret's byte length encodes their call (**15 bytes = heads, 16 bytes = tails**). After both reveal:

- **same length → player wins**, **different length → house wins**

Because each side picks independently at random, the flip is a fair 50/50, and neither party learns the other's secret before committing.

Two settlement paths back every game:

- **Happy path** — once both secrets are revealed, the server determines the winner and pays the winner with a normal Ark payment. Fast and cheap.
- **Trustless fallback** — the round is also bound to pre-signed Ark/Taproot transactions (a *setup* and a *final* VTXO with reveal / win / timeout leaves). If either party disappears, the other can still claim or refund on-chain via these scripts. This is what makes the game non-custodial.

## Repository layout

This is a monorepo:

| Path | Package | What it is |
|------|---------|------------|
| `packages/lib` | `arkade-coinflip` | Transport-agnostic protocol library: game state machine, Taproot script construction, transaction building, and SDK contract handlers. |
| `packages/server` | `arkade-coinflip-server` | House-mode server. Public game API (`/api/play`, `/api/game/:id/sign`, `/api/tiers`, `/api/network`) + an admin dashboard. Holds the house wallet, manages VTXO concurrency/liability, and persists state to SQLite (`better-sqlite3`, WAL). |
| `src/` (root) | web client | Vue 3 single-page app: an Ark wallet (`@arkade-os/sdk`), Lightning / on-chain / Ark cash-in & cash-out via Boltz swaps (`@arkade-os/boltz-swap`), pluggable UI **skins** (coin / slot / dice), and a wallet drawer. The client follows whatever network the server reports. |
| `packages/e2e` | tests | Jest integration + end-to-end tests (lib unit tests, server HTTP API, full game lifecycles, trustless-fallback, and Lightning rails). |

## Running locally

The full stack runs against a local Ark regtest provided by the
[arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest) submodule. Bring up the
regtest stack first (a zero-dependency Node CLI, Node >= 18), then start the app — the
`docker-compose.yml` here joins the regtest project's `arkade-regtest_default` network and
reaches `arkd` / `mempool_web` by service name:

```bash
git submodule update --init --recursive
node arkade-regtest/regtest.mjs start --env .env.regtest   # boots Bitcoin Core + Fulcrum + mempool + arkd + …
docker compose up --build
```

Tear the regtest stack down with `node arkade-regtest/regtest.mjs stop` (or `clean` to also
remove volumes). Fund an address with `node arkade-regtest/regtest.mjs faucet <addr> <btc> --confirm`
(the `--confirm` flag mines a block so the send confirms immediately).

- client → http://localhost:8080
- admin dashboard → http://localhost:3002

To work on just the web client against an existing API:

```bash
npm install
npm run serve   # http://localhost:8080
```

## Configuration

The network is the **server's** choice (set once via env), and the client asks the server for it via `/api/network` — there is no client-side network switch.

Key server env vars:

| Var | Default | Notes |
|-----|---------|-------|
| `ARK_SERVER_URL` | `https://mutinynet.arkade.sh` | Ark server to connect to. The detected network (regtest / mutinynet / …) flows from here. |
| `ESPLORA_URL` | *(unset → SDK auto-default)* | Optional. Leave unset to let the SDK pick the network's default esplora; set it for regtest/docker where the host differs. For arkade-regtest the Esplora REST API is mempool's `/api` (host: `http://localhost:3000/api`, in-network: `http://mempool_web/api`). |
| `PUBLIC_PORT` | `3001` | Player-facing game API. |
| `ADMIN_PORT` | `3002` | Admin dashboard + config API. |
| `ADMIN_HOST` | `127.0.0.1` | Set `0.0.0.0` to expose the admin port behind a reverse proxy. |
| `DATA_DIR` | `./data` | Where the SQLite DB (house wallet + games) lives. |

## License

MIT — see [LICENSE](LICENSE).
