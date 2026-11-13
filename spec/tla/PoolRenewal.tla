--------------------------- MODULE PoolRenewal ---------------------------
EXTENDS Naturals, FiniteSets, TLC

(* Anchors: Claim/Save -> pool/repository.ts; Hold/Send/Recover -> pool/renewal.ts. *)
CONSTANTS Workers, BreakCAS, BreakIntent, BreakHold, BreakUnknown
VARIABLES owner, phase, journal, proof, firstProof, possible, held, session, head,
          normalActive, sentWithoutIntent, sentWithoutHold
vars == <<owner, phase, journal, proof, firstProof, possible, held, session, head,
          normalActive, sentWithoutIntent, sentWithoutHold>>

Init == /\ owner = "none" /\ phase = [w \in Workers |-> "idle"]
        /\ journal = "none" /\ proof = 0 /\ firstProof = 0
        /\ possible = {} /\ held = FALSE /\ session = TRUE /\ head = 0
        /\ normalActive = FALSE /\ sentWithoutIntent = FALSE /\ sentWithoutHold = FALSE

Claim(w) == /\ phase[w] = "idle" /\ head = 0
            /\ (owner = "none" \/ BreakCAS)
            /\ owner' = "renewal" /\ phase' = [phase EXCEPT ![w] = "claimed"]
            /\ UNCHANGED <<journal, proof, firstProof, possible, held, session, head,
                           normalActive, sentWithoutIntent, sentWithoutHold>>
Hold(w) == /\ phase[w] = "claimed" /\ held' = TRUE
           /\ phase' = [phase EXCEPT ![w] = "held"]
           /\ UNCHANGED <<owner, journal, proof, firstProof, possible, session, head,
                          normalActive, sentWithoutIntent, sentWithoutHold>>
Save(w) == /\ (phase[w] = "held" \/ (BreakHold /\ phase[w] = "claimed")) /\ journal = "none"
           /\ journal' = "prepared" /\ proof' = w
           /\ phase' = [phase EXCEPT ![w] = "saved"]
           /\ UNCHANGED <<owner, firstProof, possible, held, session, head,
                          normalActive, sentWithoutIntent, sentWithoutHold>>
Send(w) == /\ phase[w] \in {"claimed", "held", "saved"} /\ head = 0
           /\ (phase[w] = "saved" \/ BreakIntent)
           /\ (held \/ BreakHold)
           /\ possible' = possible \cup {IF proof = 0 THEN w ELSE proof}
           /\ firstProof' = IF firstProof = 0 THEN (IF proof = 0 THEN w ELSE proof) ELSE firstProof
           /\ sentWithoutIntent' = (sentWithoutIntent \/ journal = "none")
           /\ sentWithoutHold' = (sentWithoutHold \/ ~held)
           /\ phase' = [phase EXCEPT ![w] = "sent"]
           /\ UNCHANGED <<owner, journal, proof, held, session, head, normalActive>>
Ack(w) == /\ phase[w] = "sent" /\ journal' = "registered"
          /\ phase' = [phase EXCEPT ![w] = "waiting"]
          /\ UNCHANGED <<owner, proof, firstProof, possible, held, session, head,
                         normalActive, sentWithoutIntent, sentWithoutHold>>
Crash(w) == /\ phase[w] \in {"claimed", "held", "saved", "sent", "waiting"}
            /\ phase' = [phase EXCEPT ![w] = "crashed"] /\ session' = FALSE
            /\ owner' = IF BreakUnknown /\ possible # {} THEN "none" ELSE owner
            /\ UNCHANGED <<journal, proof, firstProof, possible, held, head,
                           normalActive, sentWithoutIntent, sentWithoutHold>>
Recover(w) == /\ phase[w] = "crashed" /\ journal # "none"
              /\ phase' = [phase EXCEPT ![w] = "recovery"] /\ held' = TRUE
              /\ UNCHANGED <<owner, journal, proof, firstProof, possible, session, head,
                             normalActive, sentWithoutIntent, sentWithoutHold>>
RejectUnsigned(w) == /\ phase[w] = "crashed" /\ journal = "none" /\ possible = {}
                     /\ phase' = [phase EXCEPT ![w] = "rejected"] /\ owner' = "none"
                     /\ held' = FALSE
                     /\ UNCHANGED <<journal, proof, firstProof, possible, session, head,
                                    normalActive, sentWithoutIntent, sentWithoutHold>>
Confirm == /\ possible # {} /\ head = 0
           /\ journal' = "confirmed" /\ head' = 1 /\ owner' = "none" /\ held' = FALSE
           /\ phase' = [w \in Workers |-> IF phase[w] \in {"sent", "waiting", "recovery", "crashed"} THEN "done" ELSE phase[w]]
           /\ UNCHANGED <<proof, firstProof, possible, session, normalActive,
                          sentWithoutIntent, sentWithoutHold>>
NormalClaim == /\ ~normalActive /\ head = 0 /\ (owner = "none" \/ BreakCAS)
               /\ normalActive' = TRUE /\ owner' = "normal"
               /\ UNCHANGED <<phase, journal, proof, firstProof, possible, held, session, head,
                              sentWithoutIntent, sentWithoutHold>>
NormalComplete == /\ normalActive /\ head = 0 /\ head' = 1 /\ owner' = "none"
                  /\ normalActive' = FALSE
                  /\ UNCHANGED <<phase, journal, proof, firstProof, possible, held, session,
                                 sentWithoutIntent, sentWithoutHold>>

Next == (\E w \in Workers : Claim(w) \/ Hold(w) \/ Save(w) \/ Send(w) \/ Ack(w) \/ Crash(w) \/ Recover(w) \/ RejectUnsigned(w))
        \/ Confirm \/ NormalClaim \/ NormalComplete
TypeOK == /\ owner \in {"none", "renewal", "normal"} /\ journal \in {"none", "prepared", "registered", "confirmed"}
          /\ head \in 0..1 /\ proof \in Workers \cup {0} /\ firstProof \in Workers \cup {0}
          /\ possible \subseteq Workers /\ held \in BOOLEAN /\ session \in BOOLEAN /\ normalActive \in BOOLEAN
NoConcurrentClaims == ~(normalActive /\ owner = "renewal")
DurableBeforeSend == ~sentWithoutIntent
HeldBeforeSend == ~sentWithoutHold
UnknownRemainsClaimed == (possible # {} /\ head = 0) => owner = "renewal"
Spec == Init /\ [][Next]_vars
=============================================================================
