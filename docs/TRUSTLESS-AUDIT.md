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

### ✅ FIXED — 1+2. Abort-theft vector + player refund
`CoinflipEscrowScript` + per-party wiring (`5a622fc`) + verified refund. The
player funds `PlayerEscrow` (refundable only by the player), the house funds
`HouseEscrow` (refundable only by the house); the winner sweeps both via the
shared win leaves. The house has no spendable path on the player's escrow except
`creatorWin`-when-house-wins → **theft is unrepresentable**. And the player can
reclaim a stalled escrow via the owner-only CLTV refund leaf (e2e verified:
escrow → refund → funds back; CLTV spends offchain without an explicit
nLockTime).

**Now wired end-to-end (`40b760a`, `cd4a7bd`):** the player no longer needs to
hand-craft that refund. `POST /api/game/:id/refund` builds the unsigned refund
tx (server can't redirect it — pays the player's address, needs the player's
key), and the client fetches + stashes it right after escrowing, BEFORE
revealing. If the game then stalls, `StalledBets.vue` surfaces a "Reclaim"
action that signs + submits the stashed refund once the CLTV lifts — so a
stalled/crashed/malicious server can never strand the player's stake. The house
side is covered by the recovery job in #4. Original analysis kept below.

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

### 🟠 4. Crash recovery / pending-escrow reconciliation (partial)
**Done (`fad35d0`+):** `rebuildReservations` now restores in-flight liability
for trustless per-party games on boot. It previously parsed `house_vtxos_json`
only as the legacy `string[]` and silently skipped the `TrustlessState` object,
so the house could over-commit after a restart. Covered deterministically by
`packages/e2e/src/vtxo-pool.unit.test.ts` (trustless object + legacy array +
malformed/null/empty).

**Done — orphaned house-escrow reclaim:** `recoverOrphanedHouseEscrows` +
`startEscrowRecoveryTimer` reclaim the HOUSE's escrow on stalled (expired) games
once the refund CLTV matures, so abandoned games don't slowly lock up house
funds. It runs at boot + on a 2-min timer, is idempotent via a persisted
`houseRefundTxid`, and respects the timing gotcha (it fires on the
`finalExpiration` CLTV cadence, NOT the 5-min `expirePending` sweep). This is the
house-side counterpart to the player's client reclaim (see #2). e2e-verified in
`escrow-recovery.test.ts` (reclaims a matured escrow with a real refund txid;
skips not-yet-matured games; idempotent on a second pass).

**Still open (folded into #3 — needs on-chain escrow watching):** the
crash-mid-sweep window noted in #7 (house-win sweep submitted, status not yet
persisted) — boot reconciliation should detect the already-spent escrow and mark
the game resolved. Narrow window; lower priority than the fund-leak reclaim above.

### 🟠 5. Concurrency & VTXO pool for thousands of players (partial)
**Done:** concurrent plays now escrow in PARALLEL without colliding. Liability
check + VTXO pick + reservation are atomic under `selectionMutex` (fast, no
network), and each play reserves its CHOSEN VTXO's outpoint — so even before the
spend propagates to `getVtxos()`, no other play can select it. This closes a
latent double-spend-under-lag window: the reservation previously held no
outpoints, and `escrowHouseStake` had a `?? all.find()` fallback that could pick
a *reserved* VTXO. That fallback is gone (pool exhaustion → retryable
`HouseBusyError`), and the escrow SEND now runs OUTSIDE the mutex so
distinct-VTXO escrows proceed concurrently. The in-flight liability ledger
(restored on boot per #4) gates over-commitment. e2e-verified
(`trustless-api.test.ts`): with a pre-split pool, **4 concurrent plays → 4 ok, 0
busy, all on distinct house VTXOs, zero double-spend failures**.

**Still open:** split/merge pool maintenance under SUSTAINED load (current
`ensureHouseVtxoPool` tops up on a 120s timer + on boot; needs back-pressure /
on-demand split when bursts outrun the pool), and production VTXO sizing + merge
to bound fragmentation.

### 🟠 6. Real fee handling (clarified + dust-guarded; renewal still open)
**Finding:** offchain Ark txs are FEELESS at the VTXO layer. `buildOffchainTx`
emits outputs summing to the inputs plus a single zero-value P2A anchor
(`ANCHOR_VALUE = 0n`); the on-chain cost is paid via that anchor (CPFP) by
whoever settles/unrolls. So escrow/sweep/refund need NO per-tx fee budgeting —
`outputs = inputs` is correct, on mainnet too. The original worry was misframed.

**What actually matters on mainnet:**
- **Dust on every output.** Sweep/refund outputs and the per-party escrows are
  dust-safe for the configured tiers (all ≥ 1000 > dust). The one gap was the
  escrow CHANGE output (`vtxo.value − tier`), which could be sub-dust and get
  rejected. Fixed: `pickEscrowVtxo` selects only a house VTXO whose change is
  zero or ≥ `arkInfo.dust` (best-fit smallest), else surfaces a retryable busy.
  Unit-tested in `vtxo-pool.unit.test.ts`.
- **Settlement / renewal fees (still open).** The real recurring cost is the
  per-intent batch fee when settling/renewing VTXOs (~5k sats), not the offchain
  game txs. The per-poll drain is already fixed (`settlementConfig:false` + a
  manual boarding settle). Still to do: a mainnet renewal strategy that settles
  boarding on fund and renews only near VTXO expiry.

### ✅ FIXED — 7. `/commit` idempotency & race safety
Concurrent commits for the same game are serialized through a per-game
`KeyedMutex` (refcounted, auto-dropped when idle → bounded under thousands of
games; `vtxo-pool.ts`), and a resolved game **replays** its original result
instead of erroring or re-resolving. At resolve we persist the player's escrow
outpoint + (on a house win) the sweep txid in `TrustlessState`, so a retried
`/commit` rebuilds the same outcome from the record alone: a house win returns
the persisted txid (no re-submit of the already-spent escrows); a player win
rebuilds the sweep PSBTs the client still needs — so a lost response no longer
strands a winner's payout until the refund timeout. e2e-verified on regtest
(`trustless-api.test.ts`): a retried commit returns the same result (not a "not
pending" error), and **4 concurrent commits on a house win** resolved exactly
once with no double-spend rejection.

Remaining edge (tracked under #4): a crash *between* the house-win sweep submit
and the status persist leaves the game `pending` with escrows already spent; a
retry then hits an arkd double-spend rejection. Boot-time reconciliation must
detect the spent escrow and mark the game resolved.

### 🟡 8. Variable-odds trustless settlement (on-chain condition DONE; wiring next)
**Done — the hard part:** the win condition is generalized from the coin's
equal/different-length check to a mod-N `roll < target` predicate, enforced
ON-CHAIN. Each party's secret LENGTH encodes a digit in [0, n) (committed before
reveal → fair); `roll = (digitC + digitP) mod n`, player wins iff `roll < target`
(probability `target/n`). OP_MOD is disabled in Script, so the mod is a single
conditional `OP_SUB` (sum ∈ [0, 2n-2] ⇒ one `-n`). Out-of-range secrets make
their submitter LOSE (not void the game), mirroring the coin's invalid-size
handling, so a sure-loser can't grief a refund. `CoinflipEscrowScript` takes
optional `oddsN`/`oddsTarget` and otherwise reuses the whole per-party escrow
(leaves, refund, sweep). Off-chain mirror: `determineVariableWinner` +
`generateVariableSecret`. **Proven on regtest** (`variable-odds.test.ts`): the
winner — and only the winner — sweeps across player/house wins, both mod
wraparounds, and the `roll == target` boundary; the loser's leaf is rejected.

**Done — server wiring (house-edge model):** `/play` accepts `oddsN`/`oddsTarget`;
the player stakes `tier` while the house stakes a HOUSE-EDGED multiple
(`computeHouseStake = floor(tier·(n−target)/target·(1−edge))`, edge configurable
via `variable_odds_edge_bps`, default 3%), so payouts reflect the odds and the
edge is the house's cut (no rake on variable-odds — it would double-charge).
Odds are persisted in `TrustlessState` so commit/refund/recovery rebuild the
SAME escrow script; commit resolves via `determineVariableWinner`. Liability,
dust-safe VTXO pick, concurrency, idempotency, player refund + house recovery
all apply unchanged. Verified: `odds-math.unit.test.ts` (stake math) +
`trustless-api.test.ts` variable-odds case (asymmetric stakes, pot = player +
house stake, winner sweeps the full pot, rake 0).

**Still open:** client odds-picker UI (pick win probability → payout multiple;
generate a variable-length secret in-browser; pass `oddsN`/`oddsTarget`).

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
2. ✅ lib: `CoinflipEscrowScript` (refund-pubkey-parameterized) + tests — shared win
   leaves (winner sweeps both), owner-scoped refund (player vs house escrow
   addresses differ → no cross-theft). `script.ts`, proven in `coinflip.test.ts`.
3. server/client: escrow into the two addresses; sweep across both; refund flow.
4. e2e: griefing test (house stalls → player refunds; player can't be robbed).
5. contract registration + watching + crash reconciliation.
6. concurrency/pool + fees + idempotency.
7. variable-odds trustless generalization.
