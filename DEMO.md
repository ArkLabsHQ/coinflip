# Local CoinFlip demo

This demo uses a fresh database and the current compiled joint-pot game. Do not attach a data volume from an older installation with unresolved funds or games.

## Start the services

Install Node 22.12 or newer and Docker, then run from the repository root:

```sh
npm ci --include=dev
npm run regtest -- start --profile ark --profile emulator
docker compose up --build
```

| Service | URL |
| --- | --- |
| Game | `http://localhost:8080` |
| Admin UI | `http://localhost:3002` |
| Arkade operator | `http://localhost:7070` |
| Emulator | `http://localhost:7073` |
| Esplora | `http://localhost:3000/api` |

The regtest wrapper fetches a pinned stack into `.research/regtest`. Server startup probes the emulator; new games are refused if it is unavailable. The zero-fee test operator and disposable test keys are for regtest only.

## Fund the house

Open the admin UI and copy its boarding address. Fund it using the wrapper:

```sh
npm run regtest -- faucet <house-boarding-address> 0.01 --confirm
```

Use the admin settle action to create offchain funds. Pool maintenance prepares free denomination pieces for concurrent games; the admin wallet and `/api/tiers` report readiness and capacity.

## Play the normal game

1. Open the game and create a wallet. Keep its backup.
2. Copy the player's boarding address from the wallet drawer and fund it with the same faucet command.
3. Wait for the wallet to detect and settle the deposit.
4. Select a skin, stake and winning band, then play.
5. Open game details to inspect both commitments, the revealed digits, roll, stakes and transaction links.

The player and house sign one cofund transaction. The compiled covenant then pays the pot to the committed winner destination. The UI's visual skin does not change this protocol.

For a stalled game, the wallet's recovery list offers the path supported by the saved secret and funded state. A refund returns original stakes after the deadline; a published player reveal advances to a contest. Onchain exit is a separate flow with CSV maturity, signing and fee requirements. See [PROTOCOL.md](docs/PROTOCOL.md).

## Explore the separate bankroll mode

Open `/bankroll`. The simulator lets you join a modeled pool, reserve/fund wagers, choose simulated outcomes, close an epoch, inspect the operator's profit fee and redeem modeled shares. It uses the same pure accounting module as the tests.

It accepts no real deposits, creates no pool address and issues no share asset. [BANKROLL.md](docs/BANKROLL.md) describes the recursive-vault proposal and the unresolved redemption/outage-exit work.

## Check the build and contracts

```sh
npm run build:server
npm run build
npm run test:unit
npm run test:packages:unit
npm run contracts:check
```

The last command requires Rust and Git. Integration tests need a live stack; CI gives each retained integration file a fresh stack so chain-time recovery probes cannot age another test's coins. Lightning tests use `@arkade-os/swap` with an intent solver, not Boltz. To start its dependencies:

```sh
npm run regtest -- start --profile intent-solver
node scripts/regtest-relay.mjs
```

The helper switches only this test project's funded solver from HTTP hosting to Nostr relay mode. Local clients also need its explicitly supplied discovery card. LNURL receiving requires its own compatible service. The normal game does not depend on either payment rail.

## Stop

```sh
docker compose down
npm run regtest -- stop
```

These preserve data. `npm run regtest -- clean` removes the selected regtest project's volumes; `docker compose down --volumes` removes this demo's house data volume.
