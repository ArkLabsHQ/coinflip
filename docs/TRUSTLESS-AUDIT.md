# Trustless Coin Settlement — Security Audit & Hardening Roadmap

Living document driving the `feat/trustless-coin` hardening loop. Each iteration
audits, fixes the highest-priority gap, e2e-tests on regtest, and commits.

**Status legend:** 🔴 critical (fund-loss / not trustless) · 🟠 high (robustness) · 🟡 medium · ✅ done

## Current state (verified)

The per-party happy path works end-to-end on regtest, both directions, and
through the real Vue client (loss debits the player, win pays the pot):
- `/api/play` → house escrows its stake into a shared `CoinflipFinal` address.
- client escrows the player stake into the same address (single-party send).
- `/api/game/:id/commit` → reveal + winner sweeps both escrow VTXOs.

This is economically correct on the **happy path**, but **not yet trustless
under adversarial conditions**. Gaps below.

## Findings (prioritized)

### 🔴 1. Escrow `abort` leaf lets the house steal the player's stake
The shared escrow is `CoinflipFinalScript`, whose `abort` leaf is
`CLTV(finalExpiration) + creator(house) + server`. Both parties' escrow VTXOs
sit at this **one** address, so after `finalExpiration` the house can spend the
**player's** escrow VTXO via `abort`. A malicious (or crashed-then-recovered)
house can accept escrows, never `/commit`, and abort-claim every player's stake
after timeout. **Players lose funds with no game played.**

**Fix (target design): per-party escrow with owner-specific refunds.** Two
escrow scripts that share the `creatorWin`/`playerWin` leaves but differ only in
the refund leaf:
- `PlayerEscrow` = `creatorWin(house+server+secrets)` | `playerWin(player+server+secrets)` | `refund(CLTV, player+server)`
- `HouseEscrow`  = `creatorWin(house+server+secrets)` | `playerWin(player+server+secrets)` | `refund(CLTV, house+server)`

The player funds `PlayerEscrow`; the house funds `HouseEscrow`. The only non-game
way to move a VTXO is its **funder's** refund leaf → no cross-party theft. The
winner sweeps both via `creatorWin`/`playerWin` (needs both secrets + the win
condition). On a stall each side reclaims **only its own** escrow after the
timeout.

### 🔴 2. No player refund path on house/server grief
Consequence of #1: between the player's escrow and a successful `/commit`, a
stalled/crashed server leaves the player with no way to reclaim. The `refund`
leaf in #2's `PlayerEscrow` fixes this; the client (or a recovery job) must
broadcast it after `finalExpiration`.

### 🟠 3. Escrows are not registered/watched; no dispute/auto-recovery
`handleTrustlessPlay` does not register the escrow contracts with the SDK
`ContractManager`, so the server can't detect a player exercising a refund or a
stuck game. Register `PlayerEscrow`/`HouseEscrow` per game; watch + reconcile.

### 🟠 4. Crash recovery / pending-escrow reconciliation
A server crash between escrowing the house stake and resolving must, on boot:
reconcile pending games, reclaim orphaned house escrows via `refund` after
timeout, and release reservations. Extend `rebuildReservations`.

### 🟠 5. Concurrency & VTXO pool for thousands of players
- House VTXO pool: enough distinct VTXOs to escrow many concurrent games without
  collisions; split/merge maintenance under load.
- Reservation ledger must cover in-flight escrow liability (per-game house stake).
- Parallel escrow sends must not double-spend a house VTXO (mutex coverage).

### 🟠 6. Real fee handling
Regtest runs `txFeeRate=0`. Production escrow/sweep/refund txs need fee budgeting
(deduct from change / pot) and must stay above dust for every output.

### 🟡 7. `/commit` idempotency & replay protection
A retried `/commit` (network flake) must not double-sweep or mis-resolve. Resolve
is gated on `status === 'pending'`; verify it's race-safe + idempotent.

### 🟡 8. Variable-odds trustless settlement
`feat/variable-odds` is Phase-1 (server-resolved, no escrow). Generalize this
per-party model to the mod-N `roll < target` condition once the coin is solid.

### 🟡 9. Rake accounting
Sub-dust rake is currently waived. Define production rake (which output, dust
handling, reporting) once fees (#6) are real.

### ✅ FIXED — SDK settlement poll-loop drained ~5k sats/flip
The client `Wallet.create` left the SDK's settlement poll loop on. It finalized
the game's *preconfirmed* VTXOs (escrow change, sweep payout) into batch rounds
every poll, paying the per-intent fee (~4,950) each cycle — a measured ~5–9k
sats/flip leak on top of the bet (the on-chain balance fell far faster than the
game P&L). Fixed: `settlementConfig: false` + a guarded manual boarding-settle
in `refreshBalance`. Browser-verified: losses now debit **exactly −1,000**, no
churn, zero console noise. (Open follow-up 🟡: a mainnet renewal strategy that
avoids both this leak and VTXO-expiry — settle boarding on fund + renew only
near expiry, not per-poll.)

## Reveal-ordering (audited — OK)
The house commits `houseHash` at `/play` (before the player escrows) and reveals
`creatorSecret` only at `/commit`. The house knows the player's *hash*, never the
player's *secret*, so it cannot compute the outcome before the player reveals →
no selective-stall advantage. Fair.

## Iteration plan
1. ✅ Audit (this doc).
2. lib: per-party escrow scripts (`PlayerEscrow`/`HouseEscrow`) with owner refunds + tests.
3. server/client: escrow into the two addresses; sweep across both; refund flow.
4. e2e: griefing test (house stalls → player refunds; player can't be robbed).
5. contract registration + watching + crash reconciliation.
6. concurrency/pool + fees + idempotency.
7. variable-odds trustless generalization.
