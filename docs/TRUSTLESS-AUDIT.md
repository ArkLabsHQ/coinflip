# Trustless Coin Settlement — Security Audit

A phase-by-phase analysis of the per-party trustless settlement: what each party
can do **maliciously**, and where the protocol can **fail liveness** (a party
gets stuck or is denied an outcome it earned), between the **player** and the
**counterparty (house)**.

> Re-audited on the `feat/trustless-coin` branch. The previous prioritized
> hardening log is condensed into **§9 Hardening status**; this rewrite leads
> with the malice/liveness walkthrough that the per-phase view makes clearest.

---

## 1. Parties & trust model

| Party | Role | Keys / secrets it holds |
|-------|------|--------------------------|
| **Player** | the bettor (browser client) | player key; player secret (revealed at commit) |
| **House** | the coinflip operator (server backend) | house key; house secret; resolves games, builds sweeps |
| **arkd** | the Ark server — neutral L2 infra | the `server` co-signing key (`arkInfo.signerPubkey`) |

Every escrow leaf co-signs with **arkd**, not the house (`buildGame`,
`trustless-game.ts:200`). arkd is the standard Ark trust root: it co-signs every
VTXO spend, so it can **censor** (refuse to co-sign → funds wait for a timelock)
but can **never redirect** funds. The **house and arkd are distinct entities** —
this matters below, because some attacks need house cooperation and others need
arkd's, and they don't collude by default.

**Money model.** Player stakes `tier`; house stakes a house-edged multiple
(`computeHouseStake = floor(tier·(n−win)·(1−edge)/win)`, `win = target−lo`,
`trustless-game.ts:222`). The pot = both stakes; the winner sweeps it. The edge
is the house's cut, so variable-odds games take **no rake** (it would
double-charge).

---

## 2. The escrow primitive

Each party funds a **different** escrow address from the same
`CoinflipEscrowScript`, with four leaves baseline (five when the operator runs
the emulator):

| Leaf | Signers | Extra condition | Timelock | Bucket |
|------|---------|-----------------|----------|--------|
| `creatorWin` | house + arkd | both secrets, roll **∉** `[lo,target)` | none | execution |
| `playerWin` | player + arkd | both secrets, roll **∈** `[lo,target)` | none | execution |
| `refund` | **funder** + arkd | — | CLTV @ `finalExpiration` | execution |
| `playerPenalty` | player + arkd | HASH160(playerSecret) | CSV ~17 min | **exit** |
| `playerForfeit` *(opt-in)* | player + arkd + emulator-tweaked | arkade-script covenant pins `(payoutPkScript, perEscrowValue)` | CLTV @ `finalExpiration` | execution |

`playerPenalty` and `playerForfeit` are R1 backstops (see Phase 4). The first
is always present; the second is added when `EMULATOR_URL` is configured.

The two escrows share the win leaves (winner sweeps **both** VTXOs) but each
`refund` leaf is scoped to **its own funder** (`refundPubkey`, script.ts:386).
That scoping is the **abort-theft fix**: the house's refund leaf cannot touch the
player's escrow, so cross-party theft is *unrepresentable in script*. On a stall,
each side reclaims **only its own** stake.

The win condition is enforced **on-chain** (`buildVariableOddsConditionScript`,
script.ts:182): each secret's **byte length** encodes a digit in `[0,n)`;
`roll = (digitC+digitP) mod n`; player wins iff `lo ≤ roll < target`. An
**out-of-range secret makes its submitter lose** (not void the game), so a
sure-loser can't grief their way to a refund.

---

## 3. Protocol phases

```
0. config/odds  →  1. /play (house escrows)  →  2. player escrows
                →  3. stash refund (pre-reveal)  →  4. /commit (reveal+resolve)
                →  5. winner sweep  →  6. recovery (stall paths)
```

---

## 4. Phase-by-phase malice & liveness

### Phase 1 — `/play`: house escrows its stake
Server validates the tier + odds (`n≥2`, `0≤lo<target≤n`, dust-safe house stake;
`trustless-game.ts:313`), commits `houseHash`, picks+reserves a house VTXO under
`selectionMutex`, escrows the house stake into `HouseEscrow`, persists `pending`.

- **Malicious house:** commits `houseHash` *before* the player reveals, and never
  learns the player's secret here → **cannot bias the roll** (commit-reveal). It
  knows only the player's *hash*. ✓
- **Malicious player:** can spam `/play` to make the house escrow (lock) liquidity
  without ever funding the player side. Capped at **3 pending per pubkey**
  (`countPendingForPlayer`), but a Sybil (many pubkeys) can still tie up house
  liquidity until each `finalExpiration`. → **liquidity-griefing DoS** (no fund
  loss; house recovers via §6). *Residual (R3).*
- **Liveness:** if the house's escrow send fails, the reservation is released and
  the player simply never sees an escrow address — no stuck state.

### Phase 2 — player escrows its stake
Client funds `PlayerEscrow` with a single-party offchain send.

- **Malicious player:** funds nothing / a wrong amount → the game can't resolve in
  their favor; their own (unfunded) side just doesn't exist. House's stake is
  recovered in §6. No house loss.
- **Liveness:** if the player escrows then disappears, the house's stake is locked
  until `finalExpiration`, then reclaimed (§6). House liveness cost only.

### Phase 3 — stash the refund (before revealing)
Client calls `/refund`; the server returns the **unsigned** `PlayerEscrow` refund
tx (pays the player's own address, needs the player's key, CLTV-locked); the
client stashes it **before** revealing (`playTrustlessGame`, step 2b).

- **Why before reveal:** so a server that stalls at commit can never strand the
  player's principal — the player already holds a self-submittable refund.
- **Malicious house:** the refund tx pays the player's address and is CLTV+player
  scoped, so the server **cannot redirect** it. ✓

### Phase 4 — `/commit`: reveal + resolve  ⚠ central caveat (R1 mitigated)
Player sends `playerSecret`; server verifies the hash, resolves via
`determineVariableWinner`, and:
- **house win** → server signs + submits the `creatorWin` sweep (it holds both
  secrets), persists `resolved` + sweep txid;
- **player win** → server returns the `playerWin` sweep PSBTs **+ the house
  secret** for the client to sign and submit.

- **Malicious player:** reveal ≠ committed hash → rejected
  (`"does not match committed hash"`). Out-of-range secret → player loses
  (cheat-penalty). Can't cheat the roll. ✓
- **Malicious house — the original R1 finding:** the player reveals **first**
  (in the request); the house learns the outcome and only **then** decides what to
  return. On a **player win**, a malicious house can **withhold its secret /
  stall the response**. The player needs **both** secrets to satisfy the
  win-leaf condition witness, so without the house secret the player cannot
  sweep the pot via `playerWin` directly. Two forfeit paths now backstop this:

  1. **CSV `playerPenalty` leaf (legacy fallback).** A
     `ConditionCSVMultisigTapscript` leaf on each escrow gated by
     HASH160(playerHash) + relative CSV (~17 min). After CSV maturity the
     player can sweep both escrows with only its own secret — punishes the
     house with the loss of its stake. **Architectural caveat:** lives in
     arkd's *ExitClosures* bucket, so the spend forces a unilateral on-chain
     exit. Standing rule: *"CSV is for unilateral exit, CLTV is for execution
     paths"* — so CSV here is correct-by-script-rules but weaker
     architecturally than the new path.

  2. **Arkade-script `playerForfeit` leaf (new, opt-in).** When the operator
     sets `EMULATOR_URL`, new games are minted with a 5-leaf escrow whose 5th
     leaf is `CLTVMultisigTapscript(finalExpiration, [player, server,
     emulator_tweaked])` wrapping an arkade-script covenant that pins
     `(playerPayoutPkScript, perEscrowValue)`. arkd enforces the CLTV in its
     *ForfeitClosures* (execution) bucket; the emulator
     ([arkade-os/emulator](https://github.com/arkade-os/emulator)) enforces
     the covenant before co-signing the tweaked slot. Once CLTV opens, the
     player builds the forfeit-claim through `POST /api/game/:id/forfeit` and
     submits it to the emulator's `/v1/tx`. **No unilateral exit needed; the
     forfeit lives alongside the win-resolution paths.** Trust assumption:
     the emulator is liveness-only — it cannot redirect funds, only refuse
     to co-sign (which still leaves the CSV path available). See
     `docs/superpowers/specs/2026-05-28-r1-via-arkade-script-research.md`.

  Either path closes R1 cryptographically: a withholding house loses **both**
  its stake (the CSV penalty) and any future plays (player base). The
  arkade-script path is the architecturally clean version; the CSV path is
  retained for clients that don't trust the operator's emulator.

  **Cross-input atomicity (FIXED).** The arkade-script playerForfeit leaf
  now uses an **atomic-sweep covenant**: each escrow's covenant additionally
  pins the OTHER escrow's stake value via `OP_INSPECTINPUTVALUE` on a
  witness-supplied input index. A forfeit-claim that tries to spend ONE
  escrow alone fails the value check (no other input → script aborts);
  the only valid claim shape is a 2-input tx with one output paying the
  full pot. The two leaves are symmetric — each pins the other's stake
  — so they cannot be spent inconsistently. This replaces the earlier
  per-escrow-independent covenant we had on this branch.

  **Note on arkd#1085**: when we first prototyped R1 we filed an arkd
  issue requesting `ConditionCLTVMultisigClosure`. Arkade-script made it
  unnecessary — the covenant + CLTV combination is now expressible
  inside the existing `CLTVMultisigTapscript` closure (arkade-script
  enforces the covenant, arkd enforces the CLTV). The issue is left
  open as a useful protocol cleanup but is no longer blocking us.

### Phase 5 — winner sweeps the pot
Winner spends **both** escrow VTXOs via the matching win leaf, paying the pot
(minus rake on coin player-wins; variable-odds rake = 0) to the winner. arkd
co-signs.

- **arkd censorship:** arkd refusing to co-sign blocks the sweep → winner falls
  back to refund (principal). arkd cannot redirect. Standard Ark trust.
- **Indexing race (R2 — FIXED):** the player-win sweep spends the player escrow
  **finalized milliseconds earlier**, and arkd indexes new VTXOs asynchronously,
  so the submit could 404 `VTXO_NOT_FOUND` and (pre-fix) dump the *winner* into the
  refund path — denied winnings on a transient error. **Fixed:** the client retries
  the sweep on `VTXO_NOT_FOUND` (re-parsing fresh each attempt; the bet is already
  resolved server-side so re-submit is safe). Verified on regtest: sweep submit
  `404 → retry → 200 → finalize`.

### Phase 6 — recovery (stall paths)
- **Player refund** (`reclaimStalledBet`): signs+submits the stashed refund after
  the CLTV. **Gated on chain block time** (R4 below).
- **House refund** (`recoverOrphanedHouseEscrows` + `startEscrowRecoveryTimer`):
  reclaims the house escrow on expired games once the CLTV matures; idempotent via
  `houseRefundTxid`.
- **Crash-mid-sweep** (`reconcilePendingSweeps`): a crash after a house-win sweep
  but before the resolve-write leaves a `pending` game with a spent house escrow →
  reconciled to a house win via an indexer `isSpent` check.
- **Idempotent `/commit`** (per-game `KeyedMutex` + persisted replay): a retried
  commit rebuilds the same result — a house win returns the persisted txid, a
  player win rebuilds the sweep PSBTs, so a lost response never strands a winner.

---

## 5. Liveness summary (who can get stuck, and the floor)

| Failure | Who is harmed | Worst case | Floor guarantee |
|---------|---------------|-----------|-----------------|
| House stalls before player escrows | house | house stake locked to CLTV | house reclaims (§6) |
| Player abandons after escrowing | house | house stake locked to CLTV | house reclaims (§6) |
| **House withholds secret on player win (R1)** | **player** | denied immediate win sweep | **CSV `playerPenalty` (always) or CLTV arkade-script `playerForfeit` (opt-in): player takes BOTH stakes** |
| arkd refuses to co-sign | winner | sweep blocked | refund principal at CLTV |
| Emulator refuses to co-sign (arkade path only) | player | arkade forfeit blocked | fall back to CSV `playerPenalty` |
| Sweep races arkd indexing (R2) | winner | (was) denied winnings | **fixed** (retry) |
| Chain block time lags the CLTV | reclaiming party | refund delayed | matures as blocks advance |

**Invariant that always holds:** no party can ever lose its **principal** — each
stake is recoverable by its funder alone (per-party CLTV refund). The protocol is
**principal-trustless**; it is **not win-liveness-trustless** against a malicious
house (R1).

---

## 6. Cooperative paths vs. timelocks

There is an immediate, no-timelock cooperative path **only at resolution** — the
winner sweep (`creatorWin`/`playerWin`: winner + arkd + both revealed secrets).
**Every pre-resolution failure** (counterparty abandons, server stalls before the
secret exchange) has exactly one exit: the **CLTV-locked `refund` leaf**.

There is **no mutual "abort now" leaf** (e.g. funder + counterparty + arkd, no
CLTV) that would let both sides unwind early without waiting. That's by design:
the refund leaf is funder-scoped (the abort-theft fix), so no single joint
signature can move both escrows. Adding a coop-abort leaf would only help when
**both** parties cooperate — exactly the case that doesn't need protection, since
a hostile/absent counterparty simply won't sign it. **The CLTV timelock is the
trustless backstop for the non-cooperative case; cooperation is already the fast
path via the normal win sweep.**

---

## 7. Chain & infrastructure liveness

- **Refund readiness must follow chain time (R4 — FIXED).** arkd enforces the
  refund CLTV against the chain's **block time (BIP113 median-time-past)**, which
  lags wall-clock when blocks are sparse. The reclaim UI previously gated on
  `Date.now()` → showed *"Reclaimable now"* and invited a click arkd rejected with
  `FORFEIT_CLOSURE_LOCKED`. **Fixed:** `getChainTipTime` (tip `mediantime` via the
  SDK onchain provider) now drives both the readiness check (`reclaimStalledBet`)
  and the StalledBets countdown; a residual `FORFEIT_CLOSURE_LOCKED` is caught and
  surfaced as *"wait for the next block"* (the stash is kept for retry). Verified
  on a lagging regtest: the button correctly stays disabled with a *"~N min (chain
  time)"* countdown instead of falsely enabling.

- **Settlement of preconfirmed sweeps (R5 — OPEN).** In a regtest round whose
  block time was frozen ~20h behind wall-clock, a player-win sweep returned `200`
  on submit+finalize and the server marked it `resolved`, but the player escrow
  remained **unspent on-chain** and the winnings VTXO never materialized at the
  player's script. Could not be disambiguated (chain-not-progressing vs. a
  finalize-that-200s-without-settling) without advancing the chain. **To confirm:
  reproduce on a normally-progressing network (mutinynet/signet) or a regtest with
  an active miner.** Principal is unaffected (the unspent escrow is still
  refundable). *Open verification item.*

---

## 8. Crash game (Bustabit variant)

A **client-only** skin over the *unchanged* variable-odds engine
(`src/crash.ts`, `src/views/CrashView.vue`): "reach M×" maps to the band
`win = floor(n/M)`, `lo = n − win`, `target = n = 300`. Inherits the entire trust
& liveness profile above (including R1) — it is the same `playTrustlessGame` path.

Verified properties (node + on-chain):
- `n = 300` is **secret-length-safe**: the digit is the secret's byte length
  (`16 + digit`), and the script push limit forces `16 + n − 1 ≤ 520` ⇒ `n ≤ 505`
  (`script.ts:193`). 300 ⇒ max 315-byte secret; divisible by every ladder
  multiplier ⇒ exact `P(win)=1/M` at each stop.
- **On-chain ≡ reveal:** using `floor` (not `round`) makes the chain's
  `roll ≥ lo` and the revealed crash point `C = n/(n−roll) ≥ M` agree at **every**
  roll (verified by brute force). The committed band is built from the integer
  `win` directly (never round-tripped through a float multiplier), so the locked
  cash-out the player sees is byte-identical to what settles.
- Settled end-to-end on regtest (player win at 1.2×, `n=300`).

---

## 9. Hardening status (prior findings, condensed)

✅ **Abort-theft + player refund** — per-party `CoinflipEscrowScript`, owner-scoped
refund leaf, `/refund` + StalledBets reclaim wired pre-reveal.
✅ **Crash recovery** — `rebuildReservations`, `recoverOrphanedHouseEscrows`,
`reconcilePendingSweeps` (all e2e-tested).
✅ **Concurrency** — atomic liability + VTXO pick + outpoint reservation under
`selectionMutex`; parallel escrows; no double-spend (4-concurrent test).
✅ **`/commit` idempotency** — per-game `KeyedMutex` + persisted replay.
✅ **Fees** — offchain Ark txs feeless (P2A anchor); dust-guarded change; renewal
gated (`settlementConfig:false` + `startRenewalTimer`).
✅ **Variable-odds** — on-chain mod-N condition, house-edge stakes, client picker.
✅ **Reveal-ordering (pre-reveal)** — house commits its hash first, can't precompute.
🟠 **Pool maintenance under sustained load** — top-up is timer-based; needs
back-pressure / on-demand split for bursts.

### New this session
✅ **R2** player-win sweep `VTXO_NOT_FOUND` retry (indexing race).
✅ **R4** refund readiness gated on chain block time (BIP113 MTP), not wall-clock.
🟡 **R5** confirm preconfirmed-sweep settlement on a progressing chain (open).
✅ **R1 (CSV path)** `playerPenalty` `ConditionCSVMultisigTapscript` leaf added
   to each escrow; player sweeps both with own secret after ~17-min CSV.
✅ **R1 (arkade-script path, opt-in)** `playerForfeit` `CLTVMultisigTapscript`
   leaf + **atomic-sweep arkade-script covenant** (single output pays
   the full pot; cross-input `INSPECTINPUTVALUE` check guarantees both
   escrows are spent in the same tx) + emulator co-signer when
   `EMULATOR_URL` is set; execution-bucket forfeit without unilateral
   exit. See
   `docs/superpowers/specs/2026-05-28-r1-via-arkade-script-research.md`.
✅ **arkd#1085 dropped.** arkade-script makes the requested
   `ConditionCLTVMultisigClosure` unnecessary — the same expressiveness
   lives in the existing `CLTVMultisigTapscript` closure with arkade-
   script enforcing the covenant + condition. Issue stays open as a
   cleanup but is no longer a blocker.

---

## 10. Residual risks & recommendations

- **R1 — house can refuse to lose** (fully mitigated, two paths):
  - **CSV `playerPenalty` (default, all clients).** Player sweeps both
    escrows with its own secret after ~17-min CSV; lives in arkd's exit
    bucket so requires unilateral exit. Always available.
  - **Arkade-script `playerForfeit` (opt-in via `EMULATOR_URL`).** Same
    economic outcome, but in arkd's execution bucket via a CLTV closure +
    **atomic-sweep arkade-script covenant** (cross-input value check —
    single tx, single output paying the full pot) validated by the
    [emulator service](https://github.com/arkade-os/emulator). No exit
    required. Trust assumption: emulator is liveness-only (cannot redirect
    funds, only refuse to co-sign — at which point the CSV path still works).
- **R3 — Sybil `/play` liquidity DoS.** Per-pubkey pending cap doesn't bound
  per-IP/Sybil; consider rate-limiting `/play` or requiring the player escrow
  before the house commits its stake.
- **R5 — settlement confirmation** on a non-frozen chain (see §7).
- **Pool sizing/merge** under sustained production load (§9).

**Bottom line:** funds are safe by construction (no party takes another's
principal), the cooperative happy path is sound, and R1 win-liveness now has
two cryptographic backstops — the universally-available CSV penalty and the
architecturally cleaner arkade-script forfeit (when the operator runs the
emulator). The house **cannot refuse to lose** any more: withholding burns
its stake either way.
