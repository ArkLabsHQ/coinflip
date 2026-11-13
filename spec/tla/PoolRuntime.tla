---- MODULE PoolRuntime ----
EXTENDS Integers, FiniteSets, Sequences

\* Kernel: PoolGameVault canonical control coin and authenticated state.
\* Arm/Bootstrap: pool/repository.ts claimOperation/authorizeGame/beginBootstrap.
\* Broadcast/RecoverProof: pool/service.ts submit/reconcileOperation and relay proof hooks.
CONSTANTS Clients, Workers, Scenario, MaxRequests, MaxAttempts, MaxCrashes, MaxLosses,
          MaxMissing, InitialNAV, Reserve, Deposit, PlayerStake, HouseStake,
          FeeDivisor, BreakCas, BreakIntent, BreakRetry, BreakRebuild,
          BreakAdmission, BreakFeeHurdle, BreakFeePayout, BreakRecoveryCap,
          BreakMissingRetired, BreakBootstrap

VARIABLES chain, db, local, durable, held, network, wire, accepted,
          broadcasts, events, crashes, losses, missing, bootstrapWire, bootstrapCount
vars == <<chain, db, local, durable, held, network, wire, accepted,
          broadcasts, events, crashes, losses, missing, bootstrapWire, bootstrapCount>>

Kinds == {"deposit", "redeem", "open", "settle", "refund", "recover", "collect"}
Terminal == {"settle", "refund", "recover"}
Phases == {"uninitialized", "idle", "busy", "retired"}
MaxHead == 1 + Cardinality(Workers) * MaxRequests
RequestIds == Workers \X (1..MaxRequests)
Zero == [w \in Workers |-> 0]
NoTx == [id |-> <<0, 0>>, head |-> 0, kind |-> "none", client |-> 0,
         game |-> 0, fee |-> 0, payout |-> 0, amount |-> 0, result |-> "none"]
Max(a, b) == IF a > b THEN a ELSE b
RECURSIVE Sum(_)
Sum(f) == IF DOMAIN f = {} THEN 0 ELSE
          LET key == CHOOSE x \in DOMAIN f : TRUE
          IN f[key] + Sum([x \in DOMAIN f \ {key} |-> f[x]])
ClientOf(w) == 1 + ((w - 1) % Cardinality(Clients))
Id(w) == <<w, local[w].issued>>
LiveIntents == {w \in Workers : durable[w] # NoTx}
View(c) == IF c.phase = "retired" THEN "retired"
           ELSE IF c.phase = "busy" THEN "busy" ELSE "ready"
Pnl(c, k, payout) == IF k = "recover" THEN PlayerStake - payout
                    ELSE IF k = "settle"
                         THEN IF c.outcome = "house" THEN PlayerStake ELSE -HouseStake
                         ELSE 0
Fee(c, pnl) == Max(pnl - c.loss, 0) \div FeeDivisor
Payout(c, k, client) ==
    CASE k = "redeem" -> (c.shares[client] * c.nav) \div c.supply
      [] k = "collect" -> c.accrued
      [] k = "recover" -> PlayerStake + HouseStake
      [] k = "refund" -> PlayerStake
      [] k = "settle" -> IF c.outcome = "player" THEN PlayerStake + HouseStake ELSE 0
      [] OTHER -> 0
Snapshot(c) == [head |-> c.head, phase |-> c.phase, nav |-> c.nav,
                supply |-> c.supply, shares |-> c.shares, accrued |-> c.accrued,
                loss |-> c.loss, outcome |-> c.outcome, game |-> c.game,
                physical |-> c.physical]
EmptyLocal == [pc |-> "idle", issued |-> 0, attempts |-> 0,
               version |-> 0, seen |-> NoTx, kind |-> "none", tx |-> NoTx]

Init ==
    /\ chain = [phase |-> "uninitialized", head |-> 0, nav |-> 0, supply |-> 0,
        shares |-> [c \in Clients |-> 0], reserve |-> 0, accrued |-> 0, loss |-> 0,
        physical |-> 0, game |-> 0, player |-> 0, outcome |-> "none", mature |-> FALSE,
        terminalCount |-> [g \in 0..MaxHead |-> 0], feeCount |-> [g \in 0..MaxHead |-> 0],
        deposited |-> 0, memberPaid |-> 0, playerIn |-> 0, playerPaid |-> 0,
        earned |-> 0, operatorPaid |-> 0, reservePaid |-> 0, pnl |-> 0]
    /\ db = [version |-> 0, head |-> 0, serving |-> TRUE,
              view |-> "unconfigured", viewHead |-> 0, retirementProof |-> FALSE,
              bootstrap |-> "none"]
    /\ local = [w \in Workers |-> EmptyLocal]
    /\ durable = [w \in Workers |-> NoTx]
    /\ held = [w \in Workers |-> FALSE]
    /\ network = [w \in Workers |-> "none"]
    /\ wire = [w \in Workers |-> NoTx]
    /\ accepted = {}
    /\ broadcasts = [withoutIntent |-> FALSE, changedIdentity |-> FALSE]
    /\ events = [capitalDuringGame |-> FALSE, badFee |-> FALSE, wholePoolForfeit |-> FALSE]
    /\ crashes = 0 /\ losses = 0 /\ missing = 0
    /\ bootstrapWire = "none" /\ bootstrapCount = 0

ArmBootstrap ==
    /\ db.serving
    /\ db.bootstrap = "none" \/ (BreakBootstrap /\ db.bootstrap = "unknown")
    /\ db' = [db EXCEPT !.bootstrap = "intent"]
    /\ bootstrapWire' = "armed"
    /\ UNCHANGED <<chain, local, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, missing, bootstrapCount>>

BroadcastBootstrap ==
    /\ db.serving /\ bootstrapWire = "armed" /\ db.bootstrap = "intent"
    /\ bootstrapWire' = "queued"
    /\ UNCHANGED <<chain, db, local, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, missing, bootstrapCount>>

Genesis ==
    /\ bootstrapWire = "queued"
    /\ chain' = [chain EXCEPT !.phase = "idle", !.head = 1,
          !.nav = InitialNAV, !.supply = InitialNAV,
          !.shares = [c \in Clients |-> InitialNAV \div Cardinality(Clients)],
          !.reserve = Reserve, !.physical = InitialNAV + Reserve]
    /\ bootstrapWire' = "accepted" /\ bootstrapCount' = bootstrapCount + 1
    /\ UNCHANGED <<db, local, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, missing>>

ObserveBootstrap ==
    /\ db.serving /\ bootstrapWire = "accepted"
    /\ db' = [db EXCEPT !.bootstrap = "confirmed", !.head = chain.head,
          !.view = "ready", !.viewHead = chain.head]
    /\ bootstrapWire' = "none"
    /\ UNCHANGED <<chain, local, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, missing, bootstrapCount>>

LoseBootstrap ==
    /\ db.serving /\ bootstrapWire = "accepted" /\ losses < MaxLosses
    /\ db' = [db EXCEPT !.bootstrap = "unknown", !.view = "unknown"]
    /\ bootstrapWire' = "none" /\ losses' = losses + 1
    /\ UNCHANGED <<chain, local, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, missing, bootstrapCount>>

RecoverBootstrapProof ==
    /\ db.serving /\ db.bootstrap \in {"intent", "unknown"}
    /\ bootstrapCount = 1 /\ chain.phase = "idle"
    /\ db' = [db EXCEPT !.bootstrap = "confirmed", !.head = chain.head,
          !.view = "ready", !.viewHead = chain.head]
    /\ bootstrapWire' = "none"
    /\ UNCHANGED <<chain, local, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, missing, bootstrapCount>>

Read(w, k) ==
    /\ db.serving /\ db.bootstrap = "confirmed"
    /\ local[w].pc = "idle" /\ local[w].issued < MaxRequests
    /\ chain.phase \in {"idle", "busy"} /\ k \in Kinds
    /\ (k \in {"deposit", "redeem"} => Scenario = "capital" \/
          (BreakAdmission /\ chain.phase = "busy") \/ Scenario = "all")
    /\ (k \notin {"deposit", "redeem"} => Scenario \in {"game", "all"})
    /\ (k \in {"deposit", "redeem", "open", "collect"} =>
          chain.phase = "idle" \/ (BreakAdmission /\ k \in {"deposit", "redeem"}))
    /\ (k \in Terminal => chain.phase = "busy")
    /\ k = "redeem" => chain.shares[ClientOf(w)] > 0
    /\ k = "collect" => chain.accrued > 0
    /\ k = "open" => HouseStake <= chain.nav \div 5
    /\ local' = [local EXCEPT ![w] = [@ EXCEPT !.pc = "read",
          !.issued = @ + 1, !.attempts = 0, !.version = db.version,
          !.seen = Snapshot(chain), !.kind = k, !.tx = NoTx]]
    /\ UNCHANGED <<chain, db, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, missing, bootstrapWire, bootstrapCount>>

Build(w, fee, payout, result) ==
    /\ db.serving /\ local[w].pc = "read"
    /\ LET c == local[w].seen
           k == local[w].kind
           expectedPayout == Payout(c, k, ClientOf(w))
           expectedFee == IF k \in Terminal THEN Fee(c, Pnl(c, k, expectedPayout)) ELSE 0
       IN /\ fee \in IF k \in Terminal THEN {expectedFee, expectedFee + 1} ELSE {0}
          /\ payout \in IF k = "recover" THEN {expectedPayout, c.physical}
                         ELSE IF k = "collect" THEN {expectedPayout, expectedPayout + 1}
                         ELSE {expectedPayout}
          /\ result \in IF k = "open" THEN {"house", "player"} ELSE {"none"}
          /\ local' = [local EXCEPT ![w].pc = "built", ![w].tx =
               [id |-> Id(w), head |-> c.head, kind |-> k, client |-> ClientOf(w),
                game |-> c.game, fee |-> fee, payout |-> payout,
                amount |-> IF k = "redeem" THEN c.shares[ClientOf(w)] ELSE Deposit,
                result |-> result]]
    /\ UNCHANGED <<chain, db, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, missing, bootstrapWire, bootstrapCount>>

Fresh(w) == local[w].version = db.version /\ local[w].tx.head = db.head /\ LiveIntents = {}
Arm(w) ==
    /\ db.serving /\ local[w].pc = "built"
    /\ BreakCas \/ Fresh(w)
    /\ durable' = [durable EXCEPT ![w] = local[w].tx]
    /\ held' = [held EXCEPT ![w] = TRUE]
    /\ db' = [db EXCEPT !.version = @ + 1]
    /\ local' = [local EXCEPT ![w].pc = "armed"]
    /\ UNCHANGED <<chain, network, wire, accepted, broadcasts, events,
                    crashes, losses, missing, bootstrapWire, bootstrapCount>>

DiscardQuote(w) ==
    /\ db.serving /\ local[w].pc = "built" /\ ~Fresh(w)
    /\ local' = [local EXCEPT ![w] = [EmptyLocal EXCEPT !.issued = local[w].issued]]
    /\ UNCHANGED <<chain, db, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, missing, bootstrapWire, bootstrapCount>>

Broadcast(w) ==
    /\ db.serving /\ local[w].attempts < MaxAttempts
    /\ local[w].pc = "armed" \/ (BreakIntent /\ local[w].pc = "built")
    /\ LET committed == IF durable[w] = NoTx THEN local[w].tx ELSE durable[w]
           sent == IF BreakRetry /\ local[w].attempts > 0
                   THEN [committed EXCEPT !.head = chain.head] ELSE committed
       IN /\ wire' = [wire EXCEPT ![w] = sent]
          /\ broadcasts' = [broadcasts EXCEPT
                !.withoutIntent = @ \/ durable[w] = NoTx,
                !.changedIdentity = @ \/ sent.head # committed.head]
    /\ network' = [network EXCEPT ![w] = "queued"]
    /\ local' = [local EXCEPT ![w].pc = "submitted", ![w].attempts = @ + 1]
    /\ UNCHANGED <<chain, db, durable, held, accepted, events, crashes, losses, missing, bootstrapWire, bootstrapCount>>

Valid(t, c) ==
    /\ t.head = c.head /\ c.phase \in {"idle", "busy"}
    /\ CASE t.kind \in {"deposit", "redeem"} -> c.phase = "idle" \/ BreakAdmission
         [] t.kind \in {"open", "collect"} -> c.phase = "idle"
         [] OTHER -> c.phase = "busy"
    /\ t.kind = "redeem" => /\ t.amount > 0 /\ t.amount <= c.shares[t.client]
          /\ t.payout = (t.amount * c.nav) \div c.supply /\ t.payout > 0
          /\ (t.amount = c.supply \/ c.nav - t.payout > 0)
    /\ t.kind = "deposit" => (Deposit * c.supply) \div c.nav > 0
    /\ t.kind = "open" => HouseStake <= c.nav \div 5
    /\ t.kind \in {"refund", "recover"} => c.mature
    /\ t.kind = "collect" => c.accrued > 0 /\ (BreakFeePayout \/ t.payout = c.accrued)
    /\ t.kind = "recover" => BreakRecoveryCap \/ t.payout = PlayerStake + HouseStake
    /\ t.kind \in Terminal => BreakFeeHurdle \/ t.fee = Fee(c, Pnl(c, t.kind, t.payout))

Advance(c, t) ==
    LET base == [c EXCEPT !.head = @ + 1]
        units == IF t.kind = "deposit" THEN (Deposit * c.supply) \div c.nav ELSE 0
        pnl == Pnl(c, t.kind, t.payout)
        expectedFee == Fee(c, pnl)
    IN CASE t.kind = "deposit" -> [base EXCEPT !.nav = @ + Deposit,
          !.physical = @ + Deposit, !.supply = @ + units,
          !.shares[t.client] = @ + units, !.deposited = @ + Deposit]
      [] t.kind = "redeem" ->
          IF t.amount = c.supply THEN [base EXCEPT !.phase = "retired", !.nav = 0,
            !.supply = 0, !.shares[t.client] = @ - t.amount, !.physical = 0,
            !.memberPaid = @ + t.payout, !.operatorPaid = @ + c.accrued,
            !.reservePaid = @ + c.reserve, !.reserve = 0, !.accrued = 0]
          ELSE [base EXCEPT !.nav = @ - t.payout, !.physical = @ - t.payout,
            !.supply = @ - t.amount, !.shares[t.client] = @ - t.amount,
            !.memberPaid = @ + t.payout,
            !.loss = (c.loss * (c.supply - t.amount) + c.supply - 1) \div c.supply]
      [] t.kind = "open" -> [base EXCEPT !.phase = "busy", !.physical = @ + PlayerStake,
          !.playerIn = @ + PlayerStake, !.game = @ + 1, !.player = t.client,
          !.outcome = t.result, !.mature = FALSE]
      [] t.kind = "collect" -> [base EXCEPT !.physical = @ - t.payout,
          !.nav = @ - (t.payout - c.accrued), !.accrued = 0,
          !.operatorPaid = @ + t.payout]
      [] OTHER -> [base EXCEPT !.phase = "idle", !.nav = @ + pnl - t.fee,
          !.physical = @ - t.payout, !.playerPaid = @ + t.payout,
          !.loss = Max(c.loss - pnl, 0), !.accrued = @ + t.fee,
          !.earned = @ + expectedFee, !.pnl = @ + pnl,
          !.terminalCount[c.game] = @ + 1, !.feeCount[c.game] = @ + 1]

Apply(w) ==
    /\ network[w] = "queued"
    /\ LET t == wire[w]
           replay == t.id \in accepted
           valid == replay \/ Valid(t, chain)
       IN /\ chain' = IF valid /\ ~replay THEN Advance(chain, t) ELSE chain
          /\ accepted' = IF valid THEN accepted \cup {t.id} ELSE accepted
          /\ network' = [network EXCEPT ![w] = IF valid THEN "accepted" ELSE "rejected"]
          /\ events' = IF valid /\ ~replay THEN [events EXCEPT
               !.capitalDuringGame = @ \/ (t.kind \in {"deposit", "redeem"} /\ chain.phase # "idle"),
               !.badFee = @ \/ (t.kind \in Terminal /\ t.fee # Fee(chain, Pnl(chain, t.kind, t.payout))),
               !.wholePoolForfeit = @ \/ (t.kind = "recover" /\ t.payout > PlayerStake + HouseStake)] ELSE events
    /\ UNCHANGED <<db, local, durable, held, wire, broadcasts, crashes, losses, missing, bootstrapWire, bootstrapCount>>

Observed(w) ==
    /\ db.serving /\ network[w] \in {"accepted", "rejected"}
    /\ durable' = [durable EXCEPT ![w] = NoTx]
    /\ held' = [held EXCEPT ![w] = FALSE]
    /\ network' = [network EXCEPT ![w] = "none"]
    /\ db' = [db EXCEPT !.head = chain.head, !.version = @ + 1,
          !.view = View(chain), !.viewHead = chain.head,
          !.retirementProof = chain.phase = "retired"]
    /\ local' = [local EXCEPT ![w] = [EmptyLocal EXCEPT !.issued = local[w].issued]]
    /\ wire' = [wire EXCEPT ![w] = NoTx]
    /\ UNCHANGED <<chain, accepted, broadcasts, events, crashes, losses, missing, bootstrapWire, bootstrapCount>>

LoseResponse(w) ==
    /\ db.serving /\ network[w] \in {"accepted", "rejected"} /\ losses < MaxLosses
    /\ network' = [network EXCEPT ![w] = "none"]
    /\ local' = [local EXCEPT ![w].pc = "armed"]
    /\ losses' = losses + 1
    /\ UNCHANGED <<chain, db, durable, held, wire, accepted, broadcasts,
                    events, crashes, missing, bootstrapWire, bootstrapCount>>

RecoverProof(w) ==
    /\ db.serving /\ durable[w] # NoTx /\ durable[w].id \in accepted
    /\ network[w] = "none"
    /\ network' = [network EXCEPT ![w] = "accepted"]
    /\ UNCHANGED <<chain, db, local, durable, held, wire, accepted,
                    broadcasts, events, crashes, losses, missing, bootstrapWire, bootstrapCount>>

Crash ==
    /\ db.serving /\ crashes < MaxCrashes
    /\ db' = [db EXCEPT !.serving = FALSE, !.view = "unknown", !.retirementProof = FALSE,
          !.bootstrap = IF @ = "intent" THEN "unknown" ELSE @]
    /\ held' = [w \in Workers |-> FALSE]
    /\ local' = [w \in Workers |-> IF durable[w] = NoTx
          THEN [EmptyLocal EXCEPT !.issued = local[w].issued]
          ELSE [local[w] EXCEPT !.pc = "paused"]]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<chain, durable, network, wire, accepted, broadcasts, events, losses, missing, bootstrapWire, bootstrapCount>>

Restart ==
    /\ ~db.serving
    /\ db' = [db EXCEPT !.serving = TRUE]
    /\ held' = [w \in Workers |-> durable[w] # NoTx /\ ~BreakRebuild]
    /\ local' = [w \in Workers |-> [local[w] EXCEPT
          !.pc = IF durable[w] = NoTx THEN "idle" ELSE "armed"]]
    /\ UNCHANGED <<chain, durable, network, wire, accepted, broadcasts,
                    events, crashes, losses, missing, bootstrapWire, bootstrapCount>>

Mature ==
    /\ chain.phase = "busy" /\ ~chain.mature
    /\ chain' = [chain EXCEPT !.mature = TRUE]
    /\ UNCHANGED <<db, local, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, missing, bootstrapWire, bootstrapCount>>

IndexerMissing ==
    /\ db.serving /\ chain.phase # "uninitialized" /\ missing < MaxMissing
    /\ db' = [db EXCEPT !.view = IF BreakMissingRetired THEN "retired" ELSE "unknown",
          !.retirementProof = FALSE]
    /\ missing' = missing + 1
    /\ UNCHANGED <<chain, local, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, bootstrapWire, bootstrapCount>>

IndexerProof ==
    /\ db.serving /\ db.bootstrap = "confirmed" /\ chain.phase # "uninitialized"
    /\ db.view # View(chain) \/ db.viewHead # chain.head
    /\ db' = [db EXCEPT !.view = View(chain), !.viewHead = chain.head,
          !.retirementProof = chain.phase = "retired"]
    /\ UNCHANGED <<chain, local, durable, held, network, wire, accepted,
                    broadcasts, events, crashes, losses, missing, bootstrapWire, bootstrapCount>>

BuildAny(w) ==
    IF local[w].pc = "read" THEN
      LET c == local[w].seen
          k == local[w].kind
          payout == Payout(c, k, ClientOf(w))
          fee == IF k \in Terminal THEN Fee(c, Pnl(c, k, payout)) ELSE 0
          fees == IF k \in Terminal THEN {fee, fee + 1} ELSE {0}
          payouts == IF k = "recover" THEN {payout, c.physical}
                     ELSE IF k = "collect" THEN {payout, payout + 1} ELSE {payout}
          results == IF k = "open" THEN {"house", "player"} ELSE {"none"}
      IN \E f \in fees, p \in payouts, r \in results : Build(w, f, p, r)
    ELSE FALSE

Next == ArmBootstrap \/ BroadcastBootstrap \/ Genesis \/ ObserveBootstrap \/
    LoseBootstrap \/ RecoverBootstrapProof \/ Crash \/ Restart \/ Mature \/ IndexerMissing \/ IndexerProof \/
    (\E w \in Workers :
      (\E k \in Kinds : Read(w, k)) \/
      BuildAny(w) \/
      Arm(w) \/ DiscardQuote(w) \/ Broadcast(w) \/ Apply(w) \/ Observed(w) \/ LoseResponse(w) \/ RecoverProof(w))
Spec == Init /\ [][Next]_vars

NoBroadcastWithoutIntent == ~broadcasts.withoutIntent
ExactRetry == ~broadcasts.changedIdentity
SingleCoordinatorIntent == Cardinality(LiveIntents) <= 1
HeldWhileServing == db.serving => \A w \in LiveIntents : held[w]
NoCapitalDuringGame == ~events.capitalDuringGame
FeeOnlyRecoveredProfit == ~events.badFee
OperatorFeeConserved == chain.operatorPaid + chain.accrued = chain.earned
NoWholePoolForfeit == ~events.wholePoolForfeit
RetiredOnlyWithProof == db.view = "retired" => db.retirementProof /\ chain.phase = "retired"
NoDuplicateGameSettlement == \A g \in 0..MaxHead : chain.terminalCount[g] <= 1 /\ chain.feeCount[g] <= 1
SingletonBootstrap == bootstrapCount <= 1
SharesConserved == chain.supply = Sum(chain.shares)
PhysicalValue == chain.physical = chain.reserve + chain.nav + chain.accrued +
    IF chain.phase = "busy" THEN PlayerStake ELSE 0
ValueConserved == chain.phase # "uninitialized" =>
    chain.physical + chain.memberPaid + chain.playerPaid + chain.operatorPaid + chain.reservePaid =
    InitialNAV + Reserve + chain.deposited + chain.playerIn
RetirementClearsClaims == chain.phase = "retired" =>
    chain.nav = 0 /\ chain.supply = 0 /\ chain.accrued = 0 /\ chain.reserve = 0 /\ chain.physical = 0
TypeOK ==
    /\ chain.phase \in Phases /\ chain.head \in 0..MaxHead
    /\ chain.nav \in 0..1000 /\ chain.supply \in 0..1000
    /\ chain.shares \in [Clients -> 0..1000]
    /\ chain.reserve \in {0, Reserve} /\ chain.accrued \in 0..1000
    /\ chain.loss \in 0..1000 /\ chain.physical \in 0..2000
    /\ chain.game \in 0..MaxHead /\ chain.player \in Clients \cup {0}
    /\ chain.outcome \in {"none", "house", "player"} /\ chain.mature \in BOOLEAN
    /\ chain.terminalCount \in [0..MaxHead -> 0..1]
    /\ chain.feeCount \in [0..MaxHead -> 0..1]
    /\ db.serving \in BOOLEAN /\ db.head \in 0..MaxHead /\ db.version \in 0..(MaxHead * 3)
    /\ db.view \in {"unconfigured", "ready", "busy", "unknown", "retired"}
    /\ db.retirementProof \in BOOLEAN /\ db.viewHead \in 0..MaxHead
    /\ db.bootstrap \in {"none", "intent", "unknown", "confirmed"}
    /\ bootstrapWire \in {"none", "armed", "queued", "accepted"} /\ bootstrapCount \in 0..1
    /\ DOMAIN local = Workers /\ DOMAIN durable = Workers /\ DOMAIN wire = Workers
    /\ held \in [Workers -> BOOLEAN]
    /\ network \in [Workers -> {"none", "queued", "accepted", "rejected"}]
    /\ \A w \in Workers :
        /\ local[w].pc \in {"idle", "read", "built", "armed", "submitted", "paused"}
        /\ local[w].issued \in 0..MaxRequests /\ local[w].attempts \in 0..MaxAttempts
    /\ accepted \subseteq RequestIds
    /\ crashes \in 0..MaxCrashes /\ losses \in 0..MaxLosses /\ missing \in 0..MaxMissing

====
