# Community bankroll

**Play** and **Bankroll** are adjacent modes with separate funds and contracts. Play uses the casino's normal joint pots. `/bankroll` opens the community pool, where members hold issued shares and a pool-backed wager changes their redemption value. Practice and read-only vault inspection remain separate tabs.

New pool contributions and wagers are disabled by default while the fairness policy is unresolved. Two-party commit–reveal protects a bettor against an operator changing its committed secret; it does not protect shareholders against an operator colluding with that bettor. The current contract enforces payouts, supply and accounting, not independent randomness. The admin policy can explicitly select `honest-operator` for a private software proof; that setting does not solve collusion or establish suitability for public deposits. Existing usable idle shares and accrued fees can be redeemed without enabling new admission.

## Authoritative position

[pool_game_vault.ark](../contracts/pool_game_vault.ark), its generated artifact and [SDK adapter](../packages/lib/src/pool-game-vault.ts) implement one control-bearing continuation. A singleton control asset authorizes the fungible share asset. Immutable constructor terms bind those assets, the operator key and payout, performance fee, minimum effective house edge and stake limit. Authenticated previous-transaction packets carry supply, losses, fees and game state.

The canonical vault coin is the position. Another coin sent to the same script does not purchase shares or increase NAV. Net member NAV excludes the 330-sat operator output reserve, accrued operator fees and any unsettled player's principal. Pool NAV is shared capital, not the connected wallet's balance. Wallet-owned shares and currently spendable shares are counted separately; estimated equity is `floor(memberShares * NAV / supply)`.

The implementation bounds NAV to 1,000,000 sats and supply to 10¹² units. Bootstrap starts at 1,000,000 share units per sat. Genesis control/share authority, activation checkpoints, script, amounts and starting supply are verified before accepting a pool. The durable bootstrap journal binds every issuance/activation step; an unknown result cannot silently start a second control series.

## Contributions, redemptions and spendable cash

The pool contract requires a separate [FreshPoolInput](../contracts/fresh_pool_input.ark) staging coin for member capital and game funding. Its authenticated metadata fixes the owner and original payout. The owner signs the complete transaction, authorization deadline and required lifetime; a plain wallet coin cannot replace this input. The SDK derives `recoveryMargin = max(2400, nativeExitDelaySeconds + 300)` and `minInputTTL = max(6000, recoveryMargin + 3600)`. Both pool and staged inputs enforce that lifetime, and both must cover `finalAt + recoveryMargin` for a new game. Unsupported block-based operator delays are rejected before issuing pool assets. An unused stage has an owner-authorized refund returning its complete value and any pool shares. Staging is a separate transaction and retains the live operator/emulator dependencies.

At an idle boundary, a contribution `D` mints `floor(D * supply / NAV)` units. Burning `B` shares returns `floor(B * NAV / supply)` sats. Member minimums pin the accepted result. Rounding benefits remaining holders, and zero-share or zero-sat results fail. Final redemption burns the remaining shares and control asset; the operator reserve and any accrued fees go to their fixed operator destination.

Share coins need Bitcoin carriers. The client previews the complete transaction sequence, including a separate signed change transaction when unused cash would otherwise remain attached to shares. Confirmed shares normally retain a 330-sat carrier and excess value becomes ordinary spendable wallet change. A redemption across several share coins executes an explicitly reviewed sequence of burns. Completed steps remain completed if a later step needs recovery; it is not one atomic transaction. The UI reports the transaction count and cash release before signing.

The wallet's Bankroll tab keeps member equity separate from spendable Bitcoin. Loading, failed verification and changed wallet/network/operator context clear stale values to unknown rather than displaying zero. No indexed canonical coin is absence, not proof of retirement. Expired or swept positions are renewed through a batch before any new operation; unrolled positions require onchain recovery. Setup started from the community pool returns to `/bankroll?view=pool`; the independent watch flow retains `/bankroll?view=watch`.

## Wagers, losses and fees

Only one pool game can be outstanding. Its commitments, odds, stakes, deadlines and player destination are fixed before funding. Capital changes wait until the game is terminal. Player winnings are limited to the committed wager; unrelated pool capital continues under the vault covenant. Settlement derives the actual outcome from the committed reveals. A refund returns player principal; reveal/timeout paths handle an unfinished game.

A pool win adds the player's stake to NAV. A player win removes the pool's committed stake. Performance fees apply only to profit above carried losses:

```
fee = floor(max(0, profit - carriedLoss) * operatorFeeBps / 10000)
nextLoss = max(0, carriedLoss - profit)
```

Accrued fees are excluded from member NAV before the operator collects them, so collection does not charge members twice. Contributions create no profit and do not reset the absolute loss hurdle. Redemptions remove its proportional share, rounded up for remaining holders. This is a pool-level hurdle, not a separate high-water mark for each investor.

Quotes show exact economics after integer rounding. The configured stake discount is not itself the effective house edge: a 300-bps discount produces a 150-bps expected edge at symmetric 50% odds. The contract's minimum margin and maximum stake remain binding.

## Coordinator and operator actions

The public API exposes pool state, prepared wagers, member-signed submissions, operation receipts and reveals. The coordinator claims a canonical head atomically, saves the exact authorized relay before posting, and reconciles against indexed transaction/checkpoint evidence. A response or timeout alone is not proof of settlement. Retries retain the operation ID, transaction and signed checkpoints; another transaction cannot replace that intent. Input holds survive restart through durable state.

The browser journals approved plans and signed intents before relay. Refresh reconciles existing work; recovery requiring a new signature is an explicit user action. Cached, previously verified pool/network information can support direct redemption when the casino's HTTP coordinator is down, while the Arkade operator and emulator remain available and the idle canonical pool still has sufficient lifetime. Once its remaining lifetime falls below the contract's admission window, capital redemption also needs a pool renewal. Any member can submit that renewal from the Bankroll tab (**Renew pool now**) without the casino; see the rescue path below. This is a bounded outage path, rather than an indefinite independent withdrawal guarantee.

The admin interface can seed the pool, inspect founder share coins, collect fees and fully redeem a selected founder share coin. Collection requires at least 330 sats of accrued fees. Full-coin redemption releases its carrier plus proportional equity as ordinary Bitcoin, while other members' shares remain intact. The admin API records these operations under the same durable head and receipt rules. It does not require enabling new wagers or deposits.

For a fresh local installation, fund the normal house wallet, open the private admin dashboard's **Community Bankroll** section, set the initial equity and immutable fee/risk terms, and use **Review and seed pool**. Seeding allocates separate pool capital and issues founder shares. New member contributions and games remain closed until an admission policy is explicitly selected under **New contributions / games** and reviewed. The available **Enable with operator-fairness disclosure** choice adopts the operator trust assumption described above. Players then connect their wallet at `/bankroll`, review a contribution, and can later redeem their shares or place a separate pool-backed wager. Normal Play continues to use its own house funds.

## Recovery limits

Offchain capital actions require the Arkade operator's asset ledger and the emulator. A bearer share asset is not a safe unilateral Bitcoin redemption proof: Bitcoin does not authenticate the Arkade asset's issuance lineage. The current pool has no shareholder capital redemption leaf for an operator outage. Game-specific CSV paths preserve committed game liabilities and still require emulator support, unrolling, maturity and Bitcoin fee funds; they do not provide general shareholder withdrawals.

The adapter includes batch-renewal helpers that preserve the canonical script, assets and state packets. The casino's `renew`/`renewSponsored` leaves require the pool operator, Arkade operator and emulator, and are valid at any time. The `rescue`/`rescueSponsored` leaves have no casino key: they need only the Arkade operator and the function-bound emulator, so any member, watchtower or the casino itself can submit them. The contract accepts them only once `checkTime(expiry - minimumTTL)` holds, which is exactly when it already refuses new contributions, redemptions and games. An outsider therefore cannot churn a head that is in use. A successful renewal resets the lifetime and closes the window again. Both paths enforce the same unchanged continuation: same script and value, the single control unit, and copied state packets, with any batch fee paid by a separate plain sponsor input. The casino supervisor renews earlier than the rescue window, so rescue only matters while the casino is offline. A self-send is not renewal.

Expired and swept heads remain renewable: the contract checks no remaining lifetime on renewal, and a swept input needs no forfeit. After a long outage, the coordinator renews the head when it restarts. A member can do the same through the rescue leaf, as long as the Arkade operator still indexes the swept coin and its control asset. Wallet-input renewal acceptance requires a maximum-fee quote (`feeEstimateOnly: false`), a fixed self output, and verification of the exact registration proof, session and events before posting. Its retained live lifecycle verifies unchanged share units, a separate spendable sponsor output, longer expiry and recovery with a recreated wallet.

The public event stream has bounded replay and no historical session query. Once a signing aggregate is captured and durably saved, recovery can resume that exact session. A crash after nonce acknowledgment but before aggregate capture, or loss of the registration UUID, leaves the session unresolved until its intent lapses. arkd keeps queued intents past `expire_at`, but a batch cannot finalize without the saved session's cosigner. Resumes refuse to sign after `expire_at`, and live joins are time-bounded. Ten minutes after `expire_at`, a saved renewal with no indexed batch outcome is abandoned: its holds are released and the next tick starts a fresh renewal with a new signing session. A renewal that did finish is still recognized by the control asset's proof lineage. Service availability and expiry checks can still close admission or require recovery. Run one active house process against a fresh wallet/database, preserve browser recovery data, and retain onchain fee funds for any supported exit.

## Practice and capital-only inspection

Practice uses the pure immutable `bigint` engine in [bankroll.ts](../packages/lib/src/bankroll.ts). It saves a replayable browser journal and supports exact quotes, partial redemptions, simulated wins/losses/refunds, fees and receipts. Storage failure is shown as session-only; invalid saved data requires an explicit reset. It never moves Bitcoin.

The Watch tab imports public connection JSON for the separate [capital-only vault](../contracts/bankroll_vault.ark). Bootstrap evidence and canonical control position are verified read-only; this view never signs or broadcasts. That artifact includes its carrier in NAV and has no wagers, performance-fee path or shareholder outage exit. Its limits must not be confused with the funded `PoolGameVault` above.

## Validation

- `packages/e2e/src/pool-game-vault.test.ts`: actual compiled contract lifecycle and malformed spends.
- `packages/e2e/src/pool-renewal.test.ts`: canonical batch renewal in idle, funded and contest phases, preserving accounting and commitments across fresh-wallet recovery.
- `packages/e2e/src/pool-input-renewal.test.ts`: wallet-owned share renewal without issuance, with a separate plain-Bitcoin sponsor return and durable session recovery.
- `packages/e2e/src/pool-rescue.test.ts`: a non-operator rescue is refused while admission is open, then accepted after admission closes. The test checks the identical continuation and its proof lineage, and that the casino can renew the rescued head afterwards. CI runs it on a 6656-second tree.
- `packages/e2e/src/pool-server.test.ts`: funded HTTP capital/game lifecycle, durable relay restart, normal play beside a busy pool, operator fee collection and full founder redemption.
- `src/services/fundedPoolRuntime.live.spec.ts`: actual frontend runtime, share-coin cash release, two contributions, durable reload recovery and aggregate member redemption.
- `src/store/modules/ark/ark-recovery.live.spec.ts`: recovery retains its secret and refuses a fabricated pot without its real parent.
- `spec/tla/PoolRuntime.tla`: bounded coordination and guard-mutation checks, with [assumptions and results](../spec/tla/README.md).

Local pinned-regtest runs on 2026-11-12 passed both renewal lifecycles, the funded HTTP lifecycle and the strict frontend-runtime lifecycle. The renewal tests recreated the wallet after a deliberately interrupted acknowledgment of persisted aggregate-nonce state, resumed the same proof/session, and verified the indexed commitment and extended expiry. The HTTP gate verified staged capital, exact relay recovery, ordinary play beside a busy pool, fees and full founder share-coin redemption. The frontend-runtime gate verified staged member contributions, spendable cash release, durable recovery and aggregate member redemption.

Desktop and mobile browser checks also completed wallet renewal, contribution, a settled pool wager, partial redemption, normal Play while retaining shares, and full direct redemption after stopping the casino coordinator and reloading. A new contribution completed after the coordinator restarted. The outage check retained live Arkade/emulator services and a sufficiently fresh idle pool.

CI discovers retained package integrations and frontend live files and gives each a fresh regtest stack. Live frontend errors are fatal; missing services do not become skips. Regenerated contract ABIs require new lifecycle runs; earlier kernel or renewal results do not validate a later artifact. These tests and bounded models do not establish independent randomness, production fee liveness or shareholder unilateral exits.
