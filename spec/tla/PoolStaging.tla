--------------------------- MODULE PoolStaging ---------------------------
EXTENDS Naturals, TLC
CONSTANTS BreakBothPlans, BreakConflictHold, BreakRefundProof
VARIABLES phase, stageSaved, finalSaved, claim, held, posted, funded, spent,
          headFree, terminalProof, unsafeSend
vars == <<phase, stageSaved, finalSaved, claim, held, posted, funded, spent,
          headFree, terminalProof, unsafeSend>>
Init == /\ phase = "idle" /\ stageSaved = FALSE /\ finalSaved = FALSE
        /\ claim = FALSE /\ held = FALSE /\ posted = FALSE /\ funded = FALSE
        /\ spent = FALSE /\ headFree = TRUE /\ terminalProof = FALSE /\ unsafeSend = FALSE
Arm == /\ phase = "idle" /\ phase' = "preparing" /\ claim' = TRUE /\ held' = TRUE
       /\ UNCHANGED <<stageSaved, finalSaved, posted, funded, spent, headFree, terminalProof, unsafeSend>>
SaveStage == /\ phase = "preparing" /\ claim /\ stageSaved' = TRUE /\ phase' = "stageSaved"
             /\ UNCHANGED <<finalSaved, claim, held, posted, funded, spent, headFree, terminalProof, unsafeSend>>
SaveFinal == /\ phase = "stageSaved" /\ claim /\ finalSaved' = TRUE /\ phase' = "armed"
             /\ UNCHANGED <<stageSaved, claim, held, posted, funded, spent, headFree, terminalProof, unsafeSend>>
SendStage == /\ phase \in {"stageSaved", "armed"} /\ claim /\ held /\ stageSaved
             /\ (finalSaved \/ BreakBothPlans) /\ posted' = TRUE /\ phase' = "unknownStage"
             /\ unsafeSend' = ~finalSaved
             /\ UNCHANGED <<stageSaved, finalSaved, claim, held, funded, spent, headFree, terminalProof>>
AcceptStage == /\ posted /\ ~funded /\ funded' = TRUE /\ phase' = IF headFree THEN "funded" ELSE "conflict"
               /\ UNCHANGED <<stageSaved, finalSaved, claim, held, posted, spent, headFree, terminalProof, unsafeSend>>
LoseResponse == /\ phase = "funded" /\ phase' = "unknownStage"
                /\ UNCHANGED <<stageSaved, finalSaved, claim, held, posted, funded, spent, headFree, terminalProof, unsafeSend>>
SendFinal == /\ funded /\ ~spent /\ headFree /\ claim /\ finalSaved /\ phase' = "finalPosted"
             /\ UNCHANGED <<stageSaved, finalSaved, claim, held, posted, funded, spent, headFree, terminalProof, unsafeSend>>
AcceptFinal == /\ phase = "finalPosted" /\ headFree /\ spent' = TRUE /\ headFree' = FALSE /\ phase' = "finalObserved"
               /\ UNCHANGED <<stageSaved, finalSaved, claim, held, posted, funded, terminalProof, unsafeSend>>
ConfirmFinal == /\ phase = "finalObserved" /\ spent /\ terminalProof' = TRUE /\ claim' = FALSE /\ held' = FALSE /\ phase' = "complete"
                /\ UNCHANGED <<stageSaved, finalSaved, posted, funded, spent, headFree, unsafeSend>>
Conflict == /\ phase # "idle" /\ phase # "complete" /\ headFree /\ ~spent /\ headFree' = FALSE /\ phase' = "conflict"
            /\ claim' = IF BreakConflictHold THEN FALSE ELSE claim
            /\ held' = IF BreakConflictHold THEN FALSE ELSE held
            /\ UNCHANGED <<stageSaved, finalSaved, posted, funded, spent, terminalProof, unsafeSend>>
Refund == /\ funded /\ ~spent /\ ~headFree /\ claim /\ phase' = "refundPosted"
          /\ UNCHANGED <<stageSaved, finalSaved, claim, held, posted, funded, spent, headFree, terminalProof, unsafeSend>>
AcceptRefund == /\ phase = "refundPosted" /\ spent' = TRUE /\ phase' = "refundObserved"
                /\ UNCHANGED <<stageSaved, finalSaved, claim, held, posted, funded, headFree, terminalProof, unsafeSend>>
ConfirmRefund == /\ (phase = "refundObserved" \/ (BreakRefundProof /\ phase = "refundPosted"))
                 /\ terminalProof' = spent /\ claim' = FALSE /\ held' = FALSE /\ phase' = "complete"
                 /\ UNCHANGED <<stageSaved, finalSaved, posted, funded, spent, headFree, unsafeSend>>
CancelUnsent == /\ phase # "idle" /\ phase # "complete" /\ ~posted /\ claim' = FALSE /\ held' = FALSE /\ phase' = "complete"
                /\ UNCHANGED <<stageSaved, finalSaved, posted, funded, spent, headFree, terminalProof, unsafeSend>>
Next == Arm \/ SaveStage \/ SaveFinal \/ SendStage \/ AcceptStage \/ LoseResponse \/ SendFinal \/ AcceptFinal \/ ConfirmFinal
        \/ Conflict \/ Refund \/ AcceptRefund \/ ConfirmRefund \/ CancelUnsent
TypeOK == /\ phase \in {"idle", "preparing", "stageSaved", "armed", "unknownStage", "funded", "finalPosted", "finalObserved", "conflict", "refundPosted", "refundObserved", "complete"}
          /\ stageSaved \in BOOLEAN /\ finalSaved \in BOOLEAN /\ claim \in BOOLEAN /\ held \in BOOLEAN
          /\ posted \in BOOLEAN /\ funded \in BOOLEAN /\ spent \in BOOLEAN /\ headFree \in BOOLEAN /\ terminalProof \in BOOLEAN /\ unsafeSend \in BOOLEAN
BothPlansBeforeFunding == ~unsafeSend
UnknownRetainsClaim == (posted /\ ~terminalProof) => claim
StagedFundsHeld == (funded /\ ~spent) => held
ReleaseRequiresProof == (posted /\ ~claim) => terminalProof
Spec == Init /\ [][Next]_vars
=============================================================================
