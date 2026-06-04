# Coinflip protocol — a follow-through

Goal: explain the on-chain machinery of this coinflip — the escrow
contract, the game lifecycle, and the scripting primitives — at a level
where someone reading it cold can navigate from "what does `/commit`
actually do?" to the exact lines of code that do it.

This is documentation of the shipped reality. For the *next* design
step (decentralised house pool), see the local research note in
`docs/superpowers/specs/2026-05-30-decentralized-house-pool-research.md`
— that file is gitignored, ask if you don't have it.

## Trust model in one paragraph

The player and the house each commit to a hashed secret at `/play`, the
escrow VTXOs are minted with a taptree pinning both win-side payouts to
the right destinations via an arkade-script covenant, and at `/commit`
both secrets are revealed and the server settles via the covenant
leaves — the player signs nothing on the win path. The trust assumed
is **server liveness** (for graceful settlement), **emulator liveness**
(for covenant cosigning), and **arkd liveness** (for L2 throughput).
If any one stalls, the player has a covenant-bound forfeit path with a
chain-time CLTV, then a self-refund path with a later CLTV, then four
CSV-gated unilateral exit leaves on-chain as a final fallback.

## 1. The escrow contract

Source: `packages/lib/src/script.ts` — `CoinflipEscrowScript`.

Each game produces **two escrow VTXOs**, one funded by the player, one
funded by the house. Each is a P2TR with the same 8-leaf taptree
(differing only in the `refundPubkey` — the funder's key).

```
                     ┌────────────────────────────────┐
                     │   CoinflipEscrowScript          │
                     │   (per-party, 8 leaves)         │
                     └────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
  COLLAB BUCKET             EXIT BUCKET             (atomic-sweep
  (arkd cosigns,            (user alone after        covenant pins
   fires within             CSV exit_delay)          destination +
   game window)                                      amount on every
                                                     win-side leaf,
                                                     execution or
                                                     exit)
```

### The 8 leaves

| # | Leaf | Closure | Covenant? | Fires when |
|---|---|---|---|---|
| 1 | `playerWinCovenant` | `ConditionMultisig[server, emu_tweaked]` + variable-odds win condition | Yes — `atomicSweep` pinning player payout pkScript + full pot | Server settles a player win |
| 2 | `creatorWinCovenant` | `ConditionMultisig[server, emu_tweaked]` + variable-odds win condition (negated) | Yes — `atomicSweep` pinning house payout pkScript + full pot | Server settles a house win |
| 3 | `playerForfeit` | `CLTVMultisig[player, server, emu_tweaked]` | Yes — `atomicSweep` to player + full pot | Server stalled after player revealed; player sweeps both stakes after `finalExpiration` |
| 4 | `refund` | `CLTVMultisig[funder, server]` | No (single-party refund) | Game expired without commit; each funder reclaims own stake |
| 5 | `playerWinExit` | `ConditionCSVMultisig[player, emu_tweaked]` + win condition | Yes — same covenant as leaf 1 | arkd censors; player exits the L2 with covenant intact after `exitDelay` CSV |
| 6 | `creatorWinExit` | `ConditionCSVMultisig[creator, emu_tweaked]` + win condition (negated) | Yes — same covenant as leaf 2 | arkd censors; house exits with covenant intact after `exitDelay` |
| 7 | `playerForfeitExit` | `ConditionCSVMultisig[player, emu_tweaked]` + `SHA256(playerSecret)` check | Yes — same covenant as leaf 3 | arkd censors after stall; player forfeit-exits with covenant intact |
| 8 | `refundExit` | `CSVMultisig[funder]` | **No** | arkd AND emulator both unavailable; funder unilaterally reclaims own stake |

The collab/exit symmetry is the structural guarantee: every collab
leaf (arkd-cosigned, fires within the game window) has a CSV-gated
mirror so the user is never stranded by arkd censorship. The win and
forfeit exits keep the emulator-tweaked key so atomicity and
destination binding survive arkd going dark; only `refundExit` drops
the emulator — it's the final fallback when neither arkd nor the
emulator is available.

### Why `ConditionMultisig` on the win leaves

`ConditionMultisig` couples a multi-of-N signature with an arbitrary
script predicate that has to evaluate true on the witness stack. We
embed the variable-odds win condition there: the player wins iff
`(creatorDigit + playerDigit) mod n ∈ [lo, target)`, where each digit
is derived from the BYTE LENGTH of the revealed secret. So the *same
leaf* is gated on (a) the multisig signing, (b) the predicate
matching, and (c) the covenant accepting the destination + amount.

### The win-determination predicate

Source: `packages/lib/src/script.ts` —
`buildVariableOddsConditionScript`.

Stack on entry: `<creatorSecret> <playerSecret>`.
Result: pushes 1 if player wins, 0 if house wins.

```
SHA256 of player secret == playerHash  EQUALVERIFY
SHA256 of creator secret == creatorHash  EQUALVERIFY
SIZE of player secret ∈ [base, base+n)  → if false: push 0 (house wins, lengths invalid)
SIZE of creator secret ∈ [base, base+n) → if false: push 1 (player wins, opponent invalid)
roll = (creatorDigit + playerDigit) mod n
push roll ∈ [lo, target)
```

The "secret length encodes the digit" trick (`digit = length − base`)
is what makes commit-reveal of a uniform integer expressible with the
standard `SHA256 + EQUAL` predicate; we never need to publish the
digit separately because the chain reads it from `OP_SIZE`. `base =
VARIABLE_ODDS_BASE_LEN = 16` keeps the SHA256 commit
brute-force-resistant at the smallest digit (≥ 128 bits).

For the 50/50 coin, the equivalent shape is
`buildCoinflipConditionScript` — same skeleton, fixed `n=2`,
`target=1`, with an explicit valid-length check (`size ∈ {15, 16}`)
because the coin uses two specific lengths rather than a range. The
ROCKET game uses the variable-odds variant.

### What's covenant-pinned

Each win-side leaf carries a `ForfeitLeafSpec`
(`packages/lib/src/arkade-forfeit.ts`) that bundles:
- the arkade-script bytes (the actual covenant predicate)
- the BIP-340 tagged hash of that script (`scriptHash` with the
  `"ArkScriptHash"` tag)
- the emulator-tweaked pubkey: `emulator_pubkey + scriptHash · G`

The tweaked pubkey is the one that goes into the leaf's multisig
slot. The emulator holds the private key for the untweaked pubkey;
it derives the matching tweaked secret key for a specific arkade
script **only after running the script and confirming it passes**.
That's how the emulator's signature is functionally equivalent to
"the script's predicate evaluated true" — it can't sign that slot
without running the predicate.

The covenant predicate itself (for the win leaves) is
`covenants.atomicSweep(recipientPkScript, payAmount, otherInputValue)`
(`packages/contract-workflows-prototype/src/covenants.ts`) — see §3
below.

## 2. Game lifecycle

Source: `packages/server/src/trustless-game.ts`.

The persistent state lives in the `games` table. The status column
walks a small state machine:

```
                ┌──────────────────────────┐
   /play  ─────▶│ pending                  │
                │ (escrows funded, both    │
                │  hashes committed,        │
                │  awaiting reveal)         │
                └────────────┬─────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
         /commit                       finalExpiration
         (player reveals)              passes without /commit
              │                             │
              ▼                             ▼
     ┌────────────────┐         ┌──────────────────────┐
     │ resolved        │         │ expired               │
     │ winner=player   │         │ recovery: server      │
     │ or house        │         │ reclaims house        │
     │ swept on-chain  │         │ stake via refund leaf │
     │                 │         │ (player reclaims own  │
     │                 │         │  stake the same way)  │
     └────────────────┘         └──────────────────────┘
```

### `/play` — `handleTrustlessPlay`

1. Client posts `playerPubkey`, `playerHash`, `playerChangeAddress`,
   optional `(oddsN, oddsTarget, oddsLo)`.
2. Server generates its own `(creatorSecret, creatorHash)`. Secret
   length encodes a uniform digit in `[0, oddsN)` (or 15/16 for the
   50/50 coin).
3. Server computes `houseStake = computeHouseStake(playerStake,
   oddsN, oddsTarget, oddsLo, edgeBps)` and reserves a house VTXO
   covering it. (Reservation prevents two concurrent games from
   double-spending the same VTXO.)
4. Server builds the `CoinflipEscrowScript` taptree with both
   payouts pinned via covenant, escrows its own stake into it
   (`escrowHouseStakeFrom`), and returns the escrow address +
   per-game timelocks to the client. State → `pending`.
5. Client escrows its own stake into the same address from its own
   VTXO. Both escrows now sit at the same P2TR with the matching
   covenant leaves.

### `/commit` — `handleTrustlessCommit`

1. Client posts its `playerSecret`. Server verifies
   `SHA256(playerSecret) == playerHash` and the length is in range.
2. Server computes the winner from `(creatorDigit + playerDigit) mod
   n ∈ [lo, target)`.
3. Server builds the **covenant sweep** transaction
   (`buildCovenantSweepTransaction`): 2-input / 1-output Ark tx
   spending both escrows via the matching win-side covenant leaf,
   single output paying the full pot to the winner.
4. ConditionWitness `[creatorSecret, playerSecret]` is attached to
   both the Ark tx inputs **and** each checkpoint (the leaf is
   `ConditionMultisig`; arkd validates the predicate on every signed
   PSBT — checkpoint signatures fail without it).
5. EmulatorPacket attached to the Ark tx, one entry per input,
   carrying `[output_idx=0, other_input_idx=1−i]` as witness args
   for the atomic-sweep covenant.
6. `submitCovenantSweep` POSTs the unsigned PSBT to the emulator's
   `/v1/tx`. Operator's identity is **not** in the multisig
   (`[arkd_server, emu_tweaked]`) — the operator's job is to *submit*
   the unsigned PSBT, not sign it. Emulator runs the covenant,
   signs the emu_tweaked slot, forwards to arkd for final
   co-signature, returns the txid.
7. State → `resolved`; commit response includes `winner`, `payout`,
   `rake`, and the settled `arkTxid`. The client signs nothing on
   the win path.

### `/forfeit` (R1) — `handleTrustlessForfeit`

Called by the client at `/play` time to **pre-build** a forfeit-sweep
PSBT and stash it in the client's localStorage. If the server stalls
after the player has revealed (the R1 failure mode), the client can
submit this PSBT directly to the emulator (no server round-trip),
sweeping both escrows to the player via the `playerForfeit` leaf
after the leaf's absolute CLTV (`forfeitClaimableAt`) matures.

The store action `ark/claimForfeit` in
`src/store/modules/ark/ark.ts` is what consumes the stash. The
background poll `runAutoClaim` (added in `c30281d`) auto-fires it
when chain time crosses the CLTV.

### `/refund` — `handleTrustlessRefund`

Same pattern: pre-built per-escrow refund PSBT, stashed at `/play`
time, spendable via the `refund` leaf after `finalExpiration`. Each
side can reclaim only their own stake (the leaf is
`CLTVMultisig[funder, server]`).

### Server-side house recovery — `recoverOrphanedHouseEscrows`

A background timer (`startEscrowRecoveryTimer`, 120s interval) walks
expired games and submits the house's refund PSBT for any whose
`finalExpiration` has matured. Idempotent via persisted
`houseRefundTxid` on the game row.

### Server-side crash reconciliation — `reconcilePendingSweeps`

Same timer also walks pending games whose escrows have been spent
on-chain (queried via the indexer). If both inputs are spent, it
infers a house-win sweep that landed just before a server crash and
marks the game `resolved`. Catches the race where the covenant
sweep succeeded on-chain but the response never reached the server.

## 3. Scripting — arkade-script covenants

The arkade-script VM runs *inside the emulator* and is what actually
evaluates the covenant predicate before the emulator co-signs. The
opcode set is a superset of Bitcoin Script: it re-enables disabled
opcodes (`OP_CAT`, `OP_MUL`, `OP_DIV`, ...) and adds extension
opcodes for transaction inspection.

The full opcode catalog lives upstream in
`github.com/arkade-os/emulator`'s `pkg/arkade/opcode.go`. The
**handful we use in this codebase** are vendored as constants in
`packages/lib/src/arkade-forfeit.ts`:

| Opcode | Hex | What it does |
|---|---|---|
| `INSPECTINPUTVALUE` | 0xc9 | pop input index → push that input's sat value |
| `INSPECTOUTPUTVALUE` | 0xcf | pop output index → push that output's sat value |
| `INSPECTOUTPUTSCRIPTPUBKEY` | 0xd1 | pop output index → push (version, witness program) |
| `INSPECTNUMOUTPUTS` | 0xd5 | push the tx's output count |

### Two covenant shapes we build

Source: `packages/contract-workflows-prototype/src/covenants.ts`.

**`payTo(recipientPkScript, amount)`** — the canonical
"this spend's output `k` pays `recipientPkScript` exactly `amount`
sats" covenant. Witness: `[output_index]`. Used as the building
block for any single-destination pin.

```
Witness: [output_index]
Script:  DUP INSPECTOUTPUTSCRIPTPUBKEY 1 EQUALVERIFY
         <witness_program> EQUALVERIFY
         INSPECTOUTPUTVALUE <amount> EQUAL
```

**`atomicSweep(recipientPkScript, amount, otherInputValue)`** —
strengthens `payTo` with a cross-input value check: the spending tx
must also have *another* input at a witness-supplied index whose
value equals `otherInputValue`. Used by the coinflip escrows to bind
both escrows into the same settlement tx — each leaf pins the
*other* escrow's stake, so a single-input sweep can't satisfy both
covenants.

```
Witness: [output_index, other_input_index]   (other_input_index on top)
Script:  INSPECTINPUTVALUE <otherInputValue> EQUALVERIFY
         + payTo body
```

In the coinflip escrows, `amount = playerStake + houseStake` (the
full pot) on every covenant leaf, and `otherInputValue` is the
opposite party's stake. Both leaves pin the same `amount`, so both
covenants are satisfied by the same single-output sweep paying the
full pot to the winner.

### EmulatorPacket — how the script + witness reach the emulator

The arkade-script bytes are not part of the leaf's tapscript itself;
they're attached to the spending tx as an **EmulatorPacket** in an
OP_RETURN extension output. Source:
`packages/contract-workflows-prototype/src/emulator.ts` — `addPacket`.

The packet carries, per script-using input:
- `vin`: which input this script applies to
- `script`: the arkade-script bytes
- `witness`: the witness stack the emulator should push before
  running the script

The emulator sees the packet, identifies that input `vin` has an
emulator-tweaked key in its tapscript, runs the script with the
witness, and — if it evaluates true — derives the tweaked secret key
(`scriptHash(script) · G + emulator_secret`) and signs the slot.

`encodeWitness` serializes the witness stack in the format the
emulator's tx-parser expects (`varint(num_items) +
varint(item_len) + item_bytes` per item — same format as
`psbt.WriteTxWitness`). `encodeIndex` encodes integers as minimal-LE
script-num bytes (the form most introspection opcodes read).

### Where each leaf's covenant comes from

Inside `CoinflipEscrowScript` (`packages/lib/src/script.ts`):

- `playerWinCovenantArkadeScript = atomicSweep(playerPayoutPkScript,
  pot, otherStake)` — leaves 1 and 5.
- `creatorWinCovenantArkadeScript = atomicSweep(housePayoutPkScript,
  pot, otherStake)` — leaves 2 and 6.
- `forfeitArkadeScript = atomicSweep(playerPayoutPkScript, pot,
  otherStake)` — leaves 3 and 7.

Same `atomicSweep` covenant shape, three different destination pins.
Leaves 4 and 8 (refund + refundExit) carry no covenant — refund is a
single-party reclaim of the funder's own stake; no destination
pinning is needed because the funder picks their own payout address
at spend time.

## 4. What's running where

Quick map of which file owns which step:

| Step | File | Function |
|---|---|---|
| Escrow taptree shape | `packages/lib/src/script.ts` | `CoinflipEscrowScript` |
| Win-determination predicate | `packages/lib/src/script.ts` | `buildVariableOddsConditionScript`, `buildCoinflipConditionScript` |
| Covenant builders | `packages/contract-workflows-prototype/src/covenants.ts` | `payTo`, `atomicSweep` |
| Emulator-key tweak math | `packages/contract-workflows-prototype/src/emulator.ts` | `scriptHash`, `computeTweakedKey` |
| Covenant + emu glue in coinflip lib | `packages/lib/src/arkade-forfeit.ts` | `buildForfeitArkadeScript`, `buildForfeitLeafSpec` |
| Tx builders | `packages/lib/src/transactions.ts` | `buildCovenantSweepTransaction`, `buildForfeitClaimTransaction`, `buildRefundTransaction` |
| `/play` server flow | `packages/server/src/trustless-game.ts` | `handleTrustlessPlay`, `escrowHouseStakeFrom` |
| `/commit` server flow | `packages/server/src/trustless-game.ts` | `handleTrustlessCommit`, `submitCovenantSweep` |
| `/forfeit` and `/refund` server flow | `packages/server/src/trustless-game.ts` | `handleTrustlessForfeit`, `handleTrustlessRefund` |
| Client play action | `src/store/modules/ark/ark.ts` | `playTrustlessGame` |
| Client claim actions | `src/store/modules/ark/ark.ts` | `claimForfeit`, `reclaimStalledBet`, `runAutoClaim` |
| House recovery worker | `packages/server/src/trustless-game.ts` | `recoverOrphanedHouseEscrows`, `reconcilePendingSweeps`, `startEscrowRecoveryTimer` |
| Integration test | `packages/e2e/src/arkade-forfeit-integration.test.ts` | 4 cases (5-leaf escrow, covenant PSBT, full flow, route wiring) |

## 5. Trust assumptions, one more time

The shipped protocol assumes:

- **arkd liveness** for the game window (escrow funding, settle, refund).
  Unilateral CSV exits exist as a defensive fallback but are not yet
  consumed by client/server code.
- **emulator liveness** for any covenant-bound spend (every win path,
  every forfeit path, every win/forfeit exit). `refundExit` is the
  only path that survives a dead emulator.
- **server liveness** for the happy path and for graceful refund of
  expired games (house recovery worker). Player-side recovery
  (forfeit + refund) is independent of the server post-/play.
- **client tab open** for the player's auto-claim background poll
  (`runAutoClaim`). A closed tab can still recover manually next time
  the player opens the app, as long as the leaf's CLTV hasn't blown
  past the final expiration.

The auto-claim and `StalledBets` UI bridge the gap between "server
stalls" and "player loses funds" — covered in detail in
`docs/superpowers/specs/2026-05-30-decentralized-house-pool-research.md`
(yes, that doc covers the trust model too, mixed with the pool
research; not pulled out into its own doc yet).
