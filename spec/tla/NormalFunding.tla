---- MODULE NormalFunding ----
EXTENDS Naturals, FiniteSets

\* Arm -> GameRepository.beginCofundSubmission; Broadcast/Observe -> handleV4CofundInner.
\* ExpireWrite -> GameRepository.expirePending; Restart -> rebuildReservations.
\* OfferWrite -> SDK-held house input selection; every offer names the same one coin.
CONSTANTS Workers, Offers, FirstOffer, MaxCrashes, MaxAttempts,
          BreakIntentGuard, BreakPendingCas, BreakExpiryGuard, BreakRebuildGuard, BreakReuseGuard
VARIABLES status, intent, confirmed, network, result, attempts, owner,
          running, crashes, due, pc, target, seenIntent, seenConfirmed
vars == <<status, intent, confirmed, network, result, attempts, owner,
          running, crashes, due, pc, target, seenIntent, seenConfirmed>>

KnownSpent == \E g \in Offers : confirmed[g]
UnconfirmedClaims == {g \in Offers : status[g] = "pending" /\ ~confirmed[g]}
RebuildClaims == {g \in UnconfirmedClaims : ~BreakRebuildGuard \/ ~intent[g]}

Init ==
    /\ status = [g \in Offers |-> IF g = FirstOffer THEN "pending" ELSE "absent"]
    /\ intent = [g \in Offers |-> FALSE]
    /\ confirmed = [g \in Offers |-> FALSE]
    /\ network = [g \in Offers |-> "none"]
    /\ result = [g \in Offers |-> "none"]
    /\ attempts = [g \in Offers |-> 0]
    /\ owner = FirstOffer /\ running = TRUE /\ crashes = 0 /\ due = FALSE
    /\ pc = [w \in Workers |-> "idle"]
    /\ target = [w \in Workers |-> FirstOffer]
    /\ seenIntent = [w \in Workers |-> FALSE]
    /\ seenConfirmed = [w \in Workers |-> FALSE]

OfferRead(w, g) ==
    /\ running /\ pc[w] = "idle" /\ status[g] = "absent"
    /\ ~KnownSpent /\ (owner = "none" \/ BreakReuseGuard)
    /\ pc' = [pc EXCEPT ![w] = "offer"] /\ target' = [target EXCEPT ![w] = g]
    /\ UNCHANGED <<status, intent, confirmed, network, result, attempts, owner,
                    running, crashes, due, seenIntent, seenConfirmed>>

OfferWrite(w) ==
    /\ running /\ pc[w] = "offer"
    /\ IF status[target[w]] = "absent" /\ ~KnownSpent
          /\ (owner = "none" \/ BreakReuseGuard)
       THEN /\ status' = [status EXCEPT ![target[w]] = "pending"] /\ owner' = target[w]
       ELSE UNCHANGED <<status, owner>>
    /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ UNCHANGED <<intent, confirmed, network, result, attempts,
                    running, crashes, due, target, seenIntent, seenConfirmed>>

SubmissionRead(w, g) ==
    /\ running /\ pc[w] = "idle" /\ status[g] = "pending" /\ ~confirmed[g]
    /\ attempts[g] < MaxAttempts
    /\ pc' = [pc EXCEPT ![w] = "prepare"] /\ target' = [target EXCEPT ![w] = g]
    /\ UNCHANGED <<status, intent, confirmed, network, result, attempts, owner,
                    running, crashes, due, seenIntent, seenConfirmed>>

Arm(w) ==
    /\ running /\ pc[w] = "prepare"
    /\ IF ~confirmed[target[w]] /\ (BreakPendingCas \/ status[target[w]] = "pending")
       THEN /\ intent' = IF BreakIntentGuard THEN intent ELSE [intent EXCEPT ![target[w]] = TRUE]
            /\ pc' = [pc EXCEPT ![w] = "armed"]
       ELSE /\ UNCHANGED intent /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ UNCHANGED <<status, confirmed, network, result, attempts, owner,
                    running, crashes, due, target, seenIntent, seenConfirmed>>

Broadcast(w) ==
    /\ running /\ pc[w] = "armed" /\ attempts[target[w]] < MaxAttempts
    /\ (intent[target[w]] \/ BreakIntentGuard)
    /\ attempts' = [attempts EXCEPT ![target[w]] = @ + 1]
    /\ network' = [network EXCEPT ![target[w]] = IF @ = "accepted" THEN @ ELSE "inflight"]
    /\ pc' = [pc EXCEPT ![w] = "waiting"]
    /\ UNCHANGED <<status, intent, confirmed, result, owner,
                    running, crashes, due, target, seenIntent, seenConfirmed>>

NetworkAccept(g) ==
    /\ network[g] = "inflight" /\ network' = [network EXCEPT ![g] = "accepted"]
    /\ UNCHANGED <<status, intent, confirmed, result, attempts, owner,
                    running, crashes, due, pc, target, seenIntent, seenConfirmed>>

NetworkReject(g) ==
    /\ network[g] = "inflight" /\ network' = [network EXCEPT ![g] = "rejected"]
    /\ UNCHANGED <<status, intent, confirmed, result, attempts, owner,
                    running, crashes, due, pc, target, seenIntent, seenConfirmed>>

ObserveSuccess(w) ==
    /\ running /\ pc[w] = "waiting" /\ network[target[w]] = "accepted"
    /\ confirmed' = [confirmed EXCEPT ![target[w]] = TRUE]
    /\ result' = [result EXCEPT ![target[w]] = "confirmed"]
    /\ owner' = "none" /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ UNCHANGED <<status, intent, network, attempts, running, crashes,
                    due, target, seenIntent, seenConfirmed>>

ObserveRejection(w) ==
    /\ running /\ pc[w] = "waiting" /\ network[target[w]] = "rejected"
    /\ result' = [result EXCEPT ![target[w]] = "rejected"]
    /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ UNCHANGED <<status, intent, confirmed, network, attempts, owner,
                    running, crashes, due, target, seenIntent, seenConfirmed>>

ObserveAmbiguity(w) ==
    /\ running /\ pc[w] = "waiting"
    /\ result' = [result EXCEPT ![target[w]] = "ambiguous"]
    /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ UNCHANGED <<status, intent, confirmed, network, attempts, owner,
                    running, crashes, due, target, seenIntent, seenConfirmed>>

Tick ==
    /\ ~due /\ due' = TRUE
    /\ UNCHANGED <<status, intent, confirmed, network, result, attempts, owner,
                    running, crashes, pc, target, seenIntent, seenConfirmed>>

ExpireRead(w, g) ==
    /\ running /\ due /\ pc[w] = "idle" /\ status[g] = "pending"
    /\ pc' = [pc EXCEPT ![w] = "expire"] /\ target' = [target EXCEPT ![w] = g]
    /\ seenIntent' = [seenIntent EXCEPT ![w] = intent[g]]
    /\ seenConfirmed' = [seenConfirmed EXCEPT ![w] = confirmed[g]]
    /\ UNCHANGED <<status, intent, confirmed, network, result, attempts, owner,
                    running, crashes, due>>

ExpireWrite(w) ==
    /\ running /\ pc[w] = "expire"
    /\ IF ~seenIntent[w] /\ ~seenConfirmed[w]
          /\ status[target[w]] = "pending" /\ ~confirmed[target[w]]
          /\ (BreakExpiryGuard \/ ~intent[target[w]])
       THEN /\ status' = [status EXCEPT ![target[w]] = "expired"]
            /\ owner' = IF owner = target[w] THEN "none" ELSE owner
       ELSE UNCHANGED <<status, owner>>
    /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ UNCHANGED <<intent, confirmed, network, result, attempts,
                    running, crashes, due, target, seenIntent, seenConfirmed>>

Crash ==
    /\ running /\ crashes < MaxCrashes /\ crashes' = crashes + 1
    /\ running' = FALSE /\ owner' = "none" /\ pc' = [w \in Workers |-> "idle"]
    /\ UNCHANGED <<status, intent, confirmed, network, result, attempts,
                    due, target, seenIntent, seenConfirmed>>

Restart ==
    /\ ~running /\ running' = TRUE
    /\ owner' = IF RebuildClaims = {} THEN "none" ELSE CHOOSE g \in RebuildClaims : TRUE
    /\ UNCHANGED <<status, intent, confirmed, network, result, attempts,
                    crashes, due, pc, target, seenIntent, seenConfirmed>>

Next == Tick \/ Crash \/ Restart
        \/ (\E g \in Offers : NetworkAccept(g) \/ NetworkReject(g))
        \/ (\E w \in Workers : OfferWrite(w) \/ Arm(w) \/ Broadcast(w)
               \/ ObserveSuccess(w) \/ ObserveRejection(w) \/ ObserveAmbiguity(w) \/ ExpireWrite(w)
               \/ (\E g \in Offers : OfferRead(w, g) \/ SubmissionRead(w, g) \/ ExpireRead(w, g)))
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ status \in [Offers -> {"absent", "pending", "expired"}]
    /\ intent \in [Offers -> BOOLEAN] /\ confirmed \in [Offers -> BOOLEAN]
    /\ network \in [Offers -> {"none", "inflight", "accepted", "rejected"}]
    /\ result \in [Offers -> {"none", "ambiguous", "rejected", "confirmed"}]
    /\ attempts \in [Offers -> 0..MaxAttempts] /\ owner \in Offers \cup {"none"}
    /\ running \in BOOLEAN /\ crashes \in 0..MaxCrashes /\ due \in BOOLEAN
    /\ pc \in [Workers -> {"idle", "offer", "prepare", "armed", "waiting", "expire"}]
    /\ target \in [Workers -> Offers]
    /\ seenIntent \in [Workers -> BOOLEAN] /\ seenConfirmed \in [Workers -> BOOLEAN]

NoBroadcastWithoutIntent == \A g \in Offers : attempts[g] > 0 => intent[g]
NoUnsafeExpiry == \A g \in Offers : (intent[g] \/ confirmed[g] \/ network[g] \in {"inflight", "accepted"}) => status[g] = "pending"
NoAmbiguousHoldLoss == \A g \in Offers : running /\ intent[g] /\ ~confirmed[g] => owner = g
NoDuplicateInputReuse == Cardinality(UnconfirmedClaims \cup {g \in Offers : network[g] \in {"inflight", "accepted"}}) <= 1
====
