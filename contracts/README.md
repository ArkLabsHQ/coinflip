# Coinflip contracts

The normal game funds one pot atomically from the player and house. Both sides commit a secret digit before funding; revealing both secrets fixes the outcome. The compiled covenant pays the entire pot to that winner. The player may instead reveal into a contest, where the house settles honestly or the player claims the pot after the deadline. A timed refund returns both original stakes if no reveal advances the pot.

```mermaid
flowchart LR
  Player[Player stake] --> Pot[Joint pot]
  House[House stake] --> Pot
  Pot -->|Both reveals: player wins| PW[Player payout]
  Pot -->|Both reveals: house wins| HW[House payout]
  Pot -->|Player signs and reveals| Contest[Contest pot]
  Contest -->|Both reveals| Winner[Committed winner]
  Contest -->|Deadline and player signature| PW
  Pot -->|Refund deadline| Refund[Original stakes returned]
  Pot -->|Unroll, CSV and both signatures| Split[Cooperative onchain split]
  Pot -.->|Rejected: duplicate pot inputs or different payee| Rejected[No spend]
```

`rules.ark` binds the reveal packets, odds and exact payout amounts. Every covenant requires the pot at input zero, preventing a second pot from sharing its payout while allowing separately signed inputs to pay onchain fees. Constructor destinations are full typed scripts. The player reveal continuation is a compiled `CoinflipContest` instance; clients derive it before funding.

Collaborative paths require the Arkade Service and covenant emulator. Refund and contest timeout paths use Bitcoin CLTV leaves. The SDK preserves their deadlines in both virtual transactions and checkpoints, and the Arkade Service refuses those collaborative paths until its chain-tip timestamp reaches the deadline. CSV leaves require an aged onchain output after unroll; the counter does not start when a virtual coin is created. The cooperative exit requires both funders, and winner/forfeit exits still require the emulator. The contest has no independent operator-down exit; this matches the existing recovery model and is not a guarantee of unilateral recovery from every state.

Run `npm run contracts:build` to generate the artifacts, or `npm run contracts:check` to reproduce and compare them. `scripts/compile-contracts.mjs` pins the compiler commit and Cargo lockfile; `ARKADEC_SOURCE` may point to a clean checkout at that exact commit. The script omits `updatedAt` and normalizes embedded source line endings for reproducibility across Windows and Linux. Source, artifacts and this story must change together. Fresh installs use these contracts; previously funded scripts need their original application version.

## Experimental bankroll capital

`bankroll_vault.ark` preserves one control-bearing position. Its supply is authenticated transaction packet 32; its asset IDs are immutable constructor fields. Physical NAV is the entire vault coin. Public admission stays disabled.

```mermaid
flowchart LR
  Vault["vault input 0<br/>control asset: 1<br/>NAV, issued supply"] --> Subscribe["subscribe<br/>mint = deposit × issued / NAV, rounded down"]
  Member["member input 1<br/>signed funding coin"] --> Subscribe
  Subscribe --> Next["same-script vault<br/>NAV + deposit<br/>control asset: 1"]
  Subscribe --> Shares["input 1 script<br/>minted shares + member change"]
```

The member signs their own funding input; the covenant checks the price, supply packet and exact destinations.

```mermaid
flowchart LR
  Sender["sender"] --> Direct["direct send"] --> Other["second coin at the same address<br/>no control token"]
  Position["control-bearing coin"] --> Continue["verified transition"] --> Canonical["canonical continuation<br/>updated NAV and supply"]
```

A direct send does not buy shares, update NAV or become the tracked position.

```mermaid
flowchart LR
  Input["vault + signed member input"] --> Reject["rejected<br/>member destination / exact mint / next supply"]
  Reject --> Wrong["operator payout, extra shares<br/>or a forged supply counter"]
```

The transaction is refused when the output script differs from the member input, minted shares exceed the quote or packet 32 records another supply.

```mermaid
flowchart LR
  Signs["who signs<br/>member spends their input"]
  Builds["who can build<br/>any submitter<br/>Arkade operator + function-tweaked emulator"]
```

A `require` checks the transaction; it does not identify who may move the member's input.

Enforced: proportional subscription/redemption, preserved member carriers, exact control/share movement, stable-script continuation and full retirement. Partial redemption leaves at least 330 sats; final redemption burns control and pays all remaining NAV to the member's input script.

Not claimed: an honest unverified bootstrap, funded wagers, operator-fee enforcement, nonzero transaction fees or holder-specific recovery without the operator/emulator. See [the capital milestone](../docs/BANKROLL.md#experimental-capital-vault).

## Funded pool renewal and rescue

`pool_game_vault.ark` renews its single control-bearing head through a batch, as an unchanged continuation: same script and value, one control unit, and copied state packets. The casino renews with `renew` at any time. `rescue` has no casino key, so anyone can submit it, but only after the contract has closed new operations.

```mermaid
flowchart LR
  Fresh["fresh head<br/>operations open"] -->|"expiry − minTTL"| Window["rescue window<br/>operations refused"]
  Window -->|"casino: renew<br/>(operator + Arkade + emulator)"| Next["renewed head<br/>same script, value, control, packets<br/>new expiry"]
  Window -->|"anyone: rescue<br/>(Arkade + emulator:rescue)"| Next
  Window -->|"expiry passes"| Swept["expired or swept head<br/>still renewable, no forfeit"] --> Next
```

A rescue before the window is refused by the emulator because `checkTime(this.expiry - minimumTTL())` is false. A rescue that changes the value, drops the control unit or edits a state packet is refused by the same checks that `renew` uses.

```mermaid
flowchart LR
  Signs["who signs<br/>casino: operator key on renew<br/>rescuer: only its own fee sponsor"]
  Builds["who can build<br/>renew: the casino<br/>rescue: any submitter, Arkade operator + function-tweaked emulator"]
```

Not claimed: renewal without the Arkade operator and emulator, or a shareholder Bitcoin exit.
