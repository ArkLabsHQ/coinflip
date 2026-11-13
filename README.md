# CoinFlip

Bitcoin games on [Arkade](https://arkadeos.com), with two-party commit–reveal and payouts checked by compiled Arkade Script contracts. Coin, dice, slot, roulette and rocket are different presentations of the same joint-pot game.

**Play** uses the casino's normal house bankroll. **Bankroll**, beside it at `/bankroll`, supports shared capital, issued shares, pool-backed wagers, loss carryforward, operator fees and redemptions through a separate compiled vault. Exact previews cover share issuance/burns and any additional transaction needed to return spendable wallet change. The wallet keeps pool equity separate from spendable Bitcoin. Practice and read-only capital-vault inspection remain separate tabs.

New pool contributions and wagers are closed by default while fairness assumptions are unresolved. Commit–reveal does not protect shareholders against an operator colluding with a bettor; explicitly selecting `honest-operator` enables that trust model, not independent randomness. Existing usable shares can be redeemed and accrued fees collected without enabling new admission. There is no unilateral shareholder Bitcoin exit if the Arkade operator disappears. See [docs/BANKROLL.md](docs/BANKROLL.md) for accounting, cash release, recovery and the remaining trust limits.

## Game flow

1. The player and house commit to `SHA256(digit || salt)` before revealing either secret. The odds, stakes and payout scripts are fixed in the contract.
2. Both parties sign one cofund transaction that puts their stakes into a single pot. Each signs its own inputs and checkpoints.
3. The revealed digits determine `(houseDigit + playerDigit) mod n`. The player wins when the result is in `[lo, target)`; the compiled covenant pays the complete pot to the committed winner destination.
4. An unrevealed pot can return the original stakes after its refund deadline. A player can instead publish a reveal into the contest contract, where the house must settle the actual result or the player can claim after the contest deadline.

The game house, Arkade operator and emulator have distinct roles. The house supplies bankroll and its committed secret. The Arkade operator cosigns collaborative transactions; the emulator checks covenant rules. Offchain recovery needs those services. Onchain exits require unrolling, waiting for CSV maturity and satisfying the chosen leaf: winner exits retain an emulator signature, while the emulator-free cooperative exit requires both player and house signatures. This is not an unconditional unilateral refund if every counterparty disappears.

See [the protocol](docs/PROTOCOL.md) for exact paths and [the demo](DEMO.md) for local operation.

## Source layout

| Path | Responsibility |
| --- | --- |
| `contracts/` | Normal pot/contest, community pool and capital-only contracts in `.ark` |
| `packages/lib/` | Generated artifacts, SDK program adapters, transaction builders, shared game types and pool accounting |
| `packages/server/` | House wallet, public game API, admin UI, SQLite state and denomination planning |
| `src/` | Vue client, SDK wallet, swaps, LNURL, funded community pool, practice and read-only vault observation |
| `packages/e2e/` | Package unit tests and live game/payment integration tests |
| `spec/tla/` | Bounded funding and community-bankroll coordination models and guard mutations |

The app uses `@arkade-os/sdk` 0.5.4, `@arkade-os/swap` 0.1.4 and `@arkade-os/lnurl-client` 0.9.2. SDK VTXO holds protect game funding from concurrent wallet sends and renewal. The application retains its denomination planner and game-liability accounting, and reconstructs unresolved holds from durable games on startup. Before broadcast, an atomic database claim records the cofund transaction identity; an ambiguous response preserves its holds and expiry protection. The client can retry that same transaction. There is no automatic worker that resolves every ambiguous submission, so capacity can remain held pending client or operator recovery.

Community-pool inputs use an authenticated staging covenant and recovery margins derived from the operator's time-based CSV delay. Pool renewal requires the pool operator, Arkade operator and emulator together. Bounded event replay cannot recover every interrupted signing session; missing registration or aggregate data can retain funds and holds pending operator recovery. See [BANKROLL.md](docs/BANKROLL.md) for the renewal proofs and outage limits.

## Install and build

Use Node 22.12 or newer. Install once from the repository root; npm workspaces and one root lockfile cover the client, library, server and tests.

```sh
npm ci --include=dev
npm run build
```

The frontend build first builds the library and server, including the server types used by the retained live fixtures. Use `npm run build:server` for a server-only build.

This rewrite assumes a fresh installation. The new SQLite schema and compiled contract addresses are not a migration path for existing databases, funded games or browser recovery records. Use a new `DATA_DIR` and keep any old installation available until its funds and games are resolved.

The client uses Vite. For development, run the API on port 3001 and the client in a second terminal:

```sh
npm run start -w arkade-coinflip-server
npm run serve
```

The client runs at `http://localhost:8080`; Vite proxies `/api` to `http://localhost:3001`. The house and player wallets need funds before normal play.

## Local regtest

Docker is required. The wrapper checks out a pinned `ArkLabsHQ/arkade-regtest` revision under ignored `.research/regtest`; it does not use or change the older `arkade-regtest/` submodule.

```sh
npm run regtest -- start --profile ark --profile emulator

docker compose up --build
```

The container client is at `http://localhost:8080`; the admin UI is at `http://localhost:3002`. The admin port is bound to host loopback by default. `docker-compose.yml` joins the regtest network; `REGTEST_NETWORK` can override its name.

`.env.regtest` pins the test operator/emulator and uses consistent time-based locktimes. Its zero-fee operator is for exact-payout integration fixtures, not production fee behavior. `REGTEST_ENV` selects an alternative env file, including separate project names and ports for isolated stacks.

Lightning integration needs a solver and its Lightning/relay dependencies:

```sh
npm run regtest -- start --profile intent-solver
node scripts/regtest-relay.mjs
```

The relay helper recreates only that test project's solver in Nostr relay mode, preserving its funded wallet volume. The stack's default HTTP `serve` mode does not listen for Nostr RFQs. The browser uses the swap package's solver discovery; a running local solver is not automatically a public discovery entry, so local payment tests supply its live signed card. LNURL receiving additionally requires a compatible LNURL service.

Stop containers while preserving data with `npm run regtest -- stop`. `npm run regtest -- clean` removes that test project's volumes.

## Contract artifacts

The checked-in JSON files are compiler output, loaded with the SDK's `programFromArtifact`. The generation script pins compiler commit `5ff97f8f04a77163e21426db59259a80e3ae400a`. Rust and Git are needed only to regenerate or check the artifacts:

```sh
npm run contracts:build
npm run contracts:check
```

Change `.ark` sources, regenerate their artifacts, and review the resulting programs together. Hand editing artifact JSON is not supported. The source bundle in each artifact preserves its imported `.ark` files.

## Validation

```sh
npm run lint
npm run test:unit
npm run test:packages:unit
npm run build:server
npm run build
npm run contracts:check
```

Package integration tests require the services above. Clock-sensitive recovery tests must run on their own fresh regtest stack because advancing Bitcoin median time cannot be undone by resetting mocktime. CI discovers every retained integration file and gives it a separate stack; the cooperative onchain exit runs with `EXIT_PROBE=1`.

CI also discovers every `src/**/*.live.spec.ts` frontend integration and runs each on its own fresh stack with unhandled errors treated as failures. For one local frontend file after starting regtest and building the server:

```sh
npm run test:live -- --run src/services/fundedPoolRuntime.live.spec.ts
```

`REGTEST_ENV`, `ARK_SERVER_URL`, `ESPLORA_URL` and `EMULATOR_URL` select a local stack. The funded runtime test checks the Compose project and regtest network before creating isolated test wallets and data.

Local pinned-regtest validation on 2026-11-12 passed canonical-pool renewal, wallet-input renewal, the funded HTTP lifecycle and the strict frontend-runtime lifecycle. Both renewal paths resumed with a recreated wallet after persisted aggregate-nonce state, preserving shares and verifying a new commitment with longer expiry. These are tested recovery points, not public-readiness or indefinite-outage guarantees.

Only the cooperative-exit job uses a 180-block tree and five-block operator exit delays, allowing actual unroll maturity to be mined within the test. It separately advances chain time to prove the pot's 86,528-second CSV. The exact isolated settings are in `.github/workflows/e2e.yml`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ARK_SERVER_URL` | Operator URL; defaults to Mutinynet |
| `ARK_SERVER_PUBLIC_URL` | Operator URL advertised to the browser when the server uses an internal hostname |
| `ESPLORA_URL` | Optional onchain provider override |
| `ESPLORA_PUBLIC_URL` | Browser-reachable onchain provider URL when the backend URL is internal |
| `EMULATOR_URL` | Emulator reached by the server; required to create games |
| `EMULATOR_PUBLIC_URL` | Emulator URL reached by the browser; defaults to `EMULATOR_URL` |
| `PUBLIC_PORT` | Public API port, default 3001 |
| `ADMIN_PORT` / `ADMIN_HOST` | Admin listener, default `127.0.0.1:3002` |
| `DATA_DIR` | Fresh SQLite/wallet data directory |
| `CLIENT_DIR` | Built client directory served by the API, used by the bundle image |
| `VUE_APP_API_URL` | Optional client API origin at build time |
| `VUE_APP_LNURL_SERVER_URL` | Optional client LNURL service at build time |
| `VUE_APP_EMULATOR_PUBKEY` | Trusted emulator signing-key override at build time; otherwise the SDK's network pin is used |
| `VUE_APP_COOPERATIVE_EXIT_ENABLED` | Enables the client cooperative exit integration; requires both parties' signatures |

The bundled image serves the client and API on port 3000:

```sh
docker compose -f docker-compose.bundle.yml up --build
```

The image includes both modes. Pool setup and its explicit fairness policy remain separate admin actions; deployment alone does not open community admission.

## License

MIT — see [LICENSE](LICENSE).
