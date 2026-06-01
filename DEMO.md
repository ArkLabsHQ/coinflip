# Coinflip demo (covenant-resolved, R1-safe)

End-to-end demo of the trustless coinflip on Ark with arkade-script
covenants. The server settles **both win and house win via covenant** —
the player never signs anything after `/commit`. R1 forfeit + unilateral
exits are the safety nets when the server (or arkd, or both) misbehaves.

Branch: `feat/r1-via-arkade-script`. Last verified: `86d09fd`.

## Stack

| Service | Port | Image |
|---------|------|-------|
| Coinflip client (nginx + Vue) | `:8080` | built locally |
| Coinflip server (admin) | `:3002` | built locally |
| Coinflip server (public, proxied) | via `:8080/api/...` | built locally |
| Emulator | `:7073` | `ghcr.io/arkade-os/emulator:v0.0.1` |
| arkd | `:7070` | `ghcr.io/arkade-os/arkd:v0.9.5` |
| Esplora | `:3000` | from the arkade-regtest stack |
| Bitcoin Core | `:18443` | from the arkade-regtest stack |

The emulator + arkd come from the `arkade-regtest` submodule, currently
tracking PR
[ArkLabsHQ/arkade-regtest#27](https://github.com/ArkLabsHQ/arkade-regtest/pull/27)
which replaces the old nigiri + shell scripts with a pure-Node
orchestrator (no Go toolchain, no WSL — runs the same on
Windows / macOS / Linux).

## Bring it up

```bash
# 1. Start arkade-regtest + emulator (one-time, from the submodule).
#    Replaced the old shell/nigiri scripts — pure Node, no Go/WSL.
node arkade-regtest/regtest.mjs start

# 2. Build + start the coinflip stack
docker compose build server client
docker compose up -d server client

# 3. Wait for server to boot (look for `[emulator] connected at ...`)
docker logs -f coinflip-server-1
```

The server probes the emulator at boot. If you don't see
`[emulator] connected at http://emulator:7073 (vv0.0.1, signer=...)`,
the `/play` endpoint will refuse to mint games — single-path, emulator
is required.

## Fund the house wallet

Fresh DB → house has zero balance. Top it up from nigiri's faucet, then
settle into the operator's Ark wallet:

```bash
# 1. Faucet the house boarding address (printed in server boot logs)
HOUSE_BOARDING=$(curl -s http://localhost:3002/api/wallet | jq -r .boardingAddress)
curl -s -X POST http://localhost:3000/faucet \
  -H 'Content-Type: application/json' \
  -d "{\"address\":\"$HOUSE_BOARDING\",\"amount\":0.5}"

# 2. Settle the boarding UTXO into Ark VTXOs
curl -s -X POST http://localhost:3002/api/wallet/settle

# 3. Fragment into small VTXOs so concurrent plays have outpoints to reserve
curl -s -X POST http://localhost:3002/api/wallet/fragment \
  -H 'Content-Type: application/json' \
  -d '{"pieceSize":1000000,"targetCount":15}'

# 4. Verify
curl -s http://localhost:8080/api/tiers | jq
# → {"tiers":[1000,5000,10000,50000], "houseReady":true, ...}
```

## Verify the demo end-to-end (one command)

```bash
cd packages/e2e
EMULATOR_URL=http://localhost:7073 \
ARK_SERVER_URL=http://localhost:7070 \
ESPLORA_URL=http://localhost:3000 \
COINFLIP_API_URL=http://localhost:8080/api \
  npx jest src/arkade-forfeit-integration.test.ts
```

All four cases should pass:
- **5-leaf escrow**: server returns a covenant-pinned address per player
- **Covenant-bound PSBT**: `/forfeit` builds a 2-input/1-output atomic
  sweep paying the full pot
- **Full flow**: `/play → escrow → /commit` settles via covenant, server
  returns a txid, no PSBT for the client to sign
- **Route wiring**: unknown gameId → 404

## Play it in the browser

1. Open `http://localhost:8080`
2. Create a wallet (the Vue UI generates an Ark address, faucets it,
   settles it).
3. Pick a tier or variable-odds bet.
4. The server escrows house stake, the client escrows player stake,
   reveal → resolve. On a player win, the server posts to the
   emulator's `/v1/tx`, the emulator co-signs the covenant, arkd
   finalizes, txid returned. **You did not sign anything after
   `/commit`.**

## Architecture in one diagram

```
                        ┌─────────────┐
                        │   Player    │
                        │  (browser)  │
                        └──────┬──────┘
                               │ /play, /commit, /forfeit
                               ▼
                        ┌─────────────┐
                        │   Server    │
                        │ (coinflip-  │
                        │  server-1)  │
                        └──┬──┬───────┘
                           │  │ /v1/tx (covenant sweep)
                           │  └──────────┐
                           │ /v1/submitTx▼
                           │      ┌────────────┐
                           │      │  Emulator  │
                           │      │ (arkade-os/│
                           │      │  emulator) │
                           │      └─────┬──────┘
                           ▼            │ runs covenant
                        ┌──────┐        │ + signs tweaked
                        │ arkd │◄───────┘ + forwards
                        └──────┘
```

The split between arkd and the emulator is the architectural unlock:
arkd handles standard Ark closures (multisig, CLTV, CSV) while the
emulator runs arkade-script covenants on top. Together they let the
server settle every game with a covenant binding destination + amount
— no client signature on the win path.

## Escrow leaf catalog (per game, 8 leaves)

```
Collab (execution bucket, arkd cosigns, fires during game window):
  playerWinCovenant    [server, emu_tweaked]                 + covenant → player payout
  creatorWinCovenant   [server, emu_tweaked]                 + covenant → house payout
  playerForfeit        [player, server, emu_tweaked]  + CLTV + covenant → player payout
  refund               [funder, server]               + CLTV  (no covenant)

Unilateral exits (exit bucket, user alone after CSV exit_delay):
  playerWinExit        [player, emu_tweaked]          + CSV  + covenant → player payout
  creatorWinExit       [creator, emu_tweaked]         + CSV  + covenant → house payout
  playerForfeitExit    [player, emu_tweaked]          + CSV  + covenant → player payout
  refundExit           [funder]                       + CSV  (no covenant)
```

Every collab path has a CSV-gated mirror so funds are never strandable
by arkd censorship. The win/forfeit exits keep the covenant + emu_tweaked
key so atomicity + destination binding survive arkd going dark.
`refundExit` is the lone non-covenant exit — last resort if both arkd
**and** the emulator are unavailable.

## Where to look

- `packages/lib/src/script.ts` — `CoinflipEscrowScript` (the 8-leaf
  taptree)
- `packages/lib/src/arkade-forfeit.ts` — covenant builders (thin
  wrappers over `@arklabshq/contract-workflows-prototype`)
- `packages/contract-workflows-prototype/` — covenant + emulator
  primitives (the framework incubator)
- `packages/server/src/trustless-game.ts` — `/play`, `/commit`,
  `/forfeit`, recovery; emulator-required at boot
- `docs/TRUSTLESS-AUDIT.md` — security analysis incl. R1 mitigation
- `docs/superpowers/specs/2026-05-28-r1-via-arkade-script-research.md`
  — original arkade-script research + design

## Known limitations

- Coin (50/50 odds) is now break-even — no rake; configure house edge
  via variable-odds parameters (`oddsN`, `oddsTarget`, `oddsLo`).
- The demo currently uses a 30-min `finalExpiration` and ~24h
  `exit_delay`. For longer games adjust the server.
- Restoring from a DB backed up before this branch will fail — the
  `arkadeForfeit` pin format changed.
