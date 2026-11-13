---- MODULE Bankroll ----
EXTENDS Naturals, FiniteSets

\* ReserveRead/ReserveWrite -> reserveWager + persistence compare-and-swap.
\* Fund/Release/SettleWrite -> fundWager/releaseWager/settleWager.
\* BeginClose/Close/Admit -> beginClose/closeEpoch/subscribe or redeem.
CONSTANTS Workers, Wagers, Budget, Stake, BreakReserveCas,
          BreakAdmissionGuard, BreakCloseGuard, BreakSettleOnce
VARIABLES phase, status, settled, version, pc, target, seenVersion,
          seenExposure, opened, admissions, unsafeAdmission
vars == <<phase, status, settled, version, pc, target, seenVersion,
          seenExposure, opened, admissions, unsafeAdmission>>

Exposure == Cardinality({g \in Wagers : status[g] \in {"reserved", "funded"}}) * Stake

Init == /\ phase = "admission"
        /\ status = [g \in Wagers |-> "idle"]
        /\ settled = [g \in Wagers |-> 0]
        /\ version = 0
        /\ pc = [w \in Workers |-> "idle"]
        /\ target = [w \in Workers |-> "none"]
        /\ seenVersion = [w \in Workers |-> 0]
        /\ seenExposure = [w \in Workers |-> 0]
        /\ opened = FALSE
        /\ admissions = 0
        /\ unsafeAdmission = FALSE

Open == /\ phase = "admission" /\ ~opened
        /\ phase' = "open" /\ opened' = TRUE /\ version' = version + 1
        /\ UNCHANGED <<status, settled, pc, target, seenVersion, seenExposure,
                        admissions, unsafeAdmission>>

ReserveRead(w, g) == /\ phase = "open" /\ pc[w] = "idle" /\ status[g] = "idle"
                     /\ pc' = [pc EXCEPT ![w] = "reserve"]
                     /\ target' = [target EXCEPT ![w] = g]
                     /\ seenVersion' = [seenVersion EXCEPT ![w] = version]
                     /\ seenExposure' = [seenExposure EXCEPT ![w] = Exposure]
                     /\ UNCHANGED <<phase, status, settled, version, opened,
                                     admissions, unsafeAdmission>>

ReserveWrite(w) == /\ pc[w] = "reserve"
                   /\ IF phase = "open" /\ status[target[w]] = "idle"
                         /\ seenExposure[w] + Stake <= Budget
                         /\ (BreakReserveCas \/ seenVersion[w] = version)
                      THEN /\ status' = [status EXCEPT ![target[w]] = "reserved"]
                           /\ version' = version + 1
                      ELSE UNCHANGED <<status, version>>
                   /\ pc' = [pc EXCEPT ![w] = "idle"]
                   /\ UNCHANGED <<phase, settled, target, seenVersion, seenExposure,
                                   opened, admissions, unsafeAdmission>>

Fund(g) == /\ phase \in {"open", "closing"} /\ status[g] = "reserved"
           /\ status' = [status EXCEPT ![g] = "funded"] /\ version' = version + 1
           /\ UNCHANGED <<phase, settled, pc, target, seenVersion, seenExposure,
                           opened, admissions, unsafeAdmission>>

Release(g) == /\ status[g] = "reserved"
              /\ status' = [status EXCEPT ![g] = "released"] /\ version' = version + 1
              /\ UNCHANGED <<phase, settled, pc, target, seenVersion, seenExposure,
                              opened, admissions, unsafeAdmission>>

SettleRead(w, g) == /\ phase \in {"open", "closing"}
                    /\ pc[w] = "idle" /\ status[g] = "funded"
                    /\ pc' = [pc EXCEPT ![w] = "settle"]
                    /\ target' = [target EXCEPT ![w] = g]
                    /\ seenVersion' = [seenVersion EXCEPT ![w] = version]
                    /\ UNCHANGED <<phase, status, settled, version, seenExposure,
                                    opened, admissions, unsafeAdmission>>

SettleWrite(w) == /\ pc[w] = "settle"
                  /\ IF BreakSettleOnce \/ (seenVersion[w] = version /\ status[target[w]] = "funded")
                     THEN /\ status' = [status EXCEPT ![target[w]] = "done"]
                          /\ settled' = [settled EXCEPT ![target[w]] = @ + 1]
                          /\ version' = version + 1
                     ELSE UNCHANGED <<status, settled, version>>
                  /\ pc' = [pc EXCEPT ![w] = "idle"]
                  /\ UNCHANGED <<phase, target, seenVersion, seenExposure,
                                  opened, admissions, unsafeAdmission>>

Crash(w) == /\ pc[w] # "idle" /\ pc' = [pc EXCEPT ![w] = "idle"]
            /\ UNCHANGED <<phase, status, settled, version, target, seenVersion,
                            seenExposure, opened, admissions, unsafeAdmission>>

BeginClose == /\ phase = "open" /\ phase' = "closing" /\ version' = version + 1
              /\ UNCHANGED <<status, settled, pc, target, seenVersion, seenExposure,
                              opened, admissions, unsafeAdmission>>

Close == /\ phase = "closing" /\ (BreakCloseGuard \/ Exposure = 0)
         /\ phase' = "admission" /\ version' = version + 1
         /\ UNCHANGED <<status, settled, pc, target, seenVersion, seenExposure,
                         opened, admissions, unsafeAdmission>>

Admit == /\ admissions = 0 /\ (BreakAdmissionGuard \/ phase = "admission")
         /\ admissions' = admissions + 1 /\ unsafeAdmission' = (Exposure > 0)
         /\ version' = version + 1
         /\ UNCHANGED <<phase, status, settled, pc, target, seenVersion,
                         seenExposure, opened>>

Next == Open \/ BeginClose \/ Close \/ Admit
        \/ (\E g \in Wagers : Fund(g) \/ Release(g))
        \/ (\E w \in Workers : ReserveWrite(w) \/ SettleWrite(w) \/ Crash(w)
              \/ (\E g \in Wagers : ReserveRead(w, g) \/ SettleRead(w, g)))
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"admission", "open", "closing"}
          /\ status \in [Wagers -> {"idle", "reserved", "funded", "done", "released"}]
          /\ settled \in [Wagers -> Nat] /\ version \in Nat
          /\ pc \in [Workers -> {"idle", "reserve", "settle"}]
          /\ target \in [Workers -> Wagers \cup {"none"}]
          /\ seenVersion \in [Workers -> Nat] /\ seenExposure \in [Workers -> Nat]
          /\ opened \in BOOLEAN /\ admissions \in 0..1 /\ unsafeAdmission \in BOOLEAN
NoOvercommit == Exposure <= Budget
NoDoubleSettlement == \A g \in Wagers : settled[g] <= 1
NoClosedExposure == (phase = "admission") => (Exposure = 0)
NoUnsafeAdmission == ~unsafeAdmission
====
