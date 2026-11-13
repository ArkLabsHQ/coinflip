---- MODULE BankrollCapital ----
EXTENDS Integers, FiniteSets, Sequences

\* Quote -> readBankrollVaultPosition in packages/lib/src/bankroll-vault.ts.
\* Build -> buildBankrollSubscription/buildBankrollRedemption in that module.
\* Apply -> contracts/bankroll_vault.ark: BankrollVault.subscribe/redeem + chain single-spend.
\* DirectSend -> discovery follows the control-NFT outpoint, not an address sum.
CONSTANTS Workers, InitialNAV, InitialShares, DepositAmounts, BurnAmounts,
          Dust, Carrier, MaxSupply, MaxAttempts, MaxLosses, MaxCrashes,
          MaxDirectSends, Intruder, BreakSingleSpend, BreakPreviousSupply,
          BreakMintPrice, BreakRedeemPrice, BreakSupplyDelta, BreakPayee,
          BreakIgnoreDirect
VARIABLES nav, supply, held, head, spent, pc, kind, amount, seenHead,
          seenNAV, seenSupply, claimedSupply, minted, claim, nextSupply,
          payee, attempts, response, losses, crashes, direct, deposited,
          paid, redeemCarriers, accepted
vars == <<nav, supply, held, head, spent, pc, kind, amount, seenHead,
          seenNAV, seenSupply, claimedSupply, minted, claim, nextSupply,
          payee, attempts, response, losses, crashes, direct, deposited,
          paid, redeemCarriers, accepted>>

MaxTransitions == Cardinality(Workers) * MaxAttempts
Recipients == Workers \cup {Intruder}
RECURSIVE Sum(_)
Sum(f) == IF DOMAIN f = {} THEN 0 ELSE
          LET k == CHOOSE x \in DOMAIN f : TRUE
          IN f[k] + Sum([x \in DOMAIN f \ {k} |-> f[x]])

Init == /\ nav = InitialNAV
        /\ supply = Cardinality(Workers) * InitialShares
        /\ held = [r \in Recipients |-> IF r \in Workers THEN InitialShares ELSE 0]
        /\ head = 0
        /\ spent = [h \in 0..MaxTransitions |-> 0]
        /\ pc = [w \in Workers |-> "idle"]
        /\ kind = [w \in Workers |-> "none"]
        /\ amount = [w \in Workers |-> 0]
        /\ seenHead = [w \in Workers |-> 0]
        /\ seenNAV = [w \in Workers |-> 0]
        /\ seenSupply = [w \in Workers |-> 0]
        /\ claimedSupply = [w \in Workers |-> 0]
        /\ minted = [w \in Workers |-> 0]
        /\ claim = [w \in Workers |-> 0]
        /\ nextSupply = [w \in Workers |-> 0]
        /\ payee = [w \in Workers |-> w]
        /\ attempts = [w \in Workers |-> 0]
        /\ response = [w \in Workers |-> "none"]
        /\ losses = 0 /\ crashes = 0 /\ direct = 0
        /\ deposited = [w \in Workers |-> 0]
        /\ paid = [r \in Recipients |-> 0]
        /\ redeemCarriers = 0 /\ accepted = <<>>

Quote(w, k, a) ==
    /\ pc[w] = "idle" /\ supply > 0
    /\ k \in {"deposit", "redeem"}
    /\ a \in IF k = "deposit" THEN DepositAmounts ELSE BurnAmounts
    /\ k = "redeem" => a <= held[w]
    /\ pc' = [pc EXCEPT ![w] = "quoted"]
    /\ kind' = [kind EXCEPT ![w] = k]
    /\ amount' = [amount EXCEPT ![w] = a]
    /\ seenHead' = [seenHead EXCEPT ![w] = head]
    /\ seenNAV' = [seenNAV EXCEPT ![w] = nav]
    /\ seenSupply' = [seenSupply EXCEPT ![w] = supply]
    /\ UNCHANGED <<nav, supply, held, head, spent, claimedSupply, minted,
                    claim, nextSupply, payee, attempts, response, losses,
                    crashes, direct, deposited, paid, redeemCarriers, accepted>>

Build(w, fault) ==
    /\ pc[w] = "quoted"
    /\ fault \in {"honest", "previous", "mint", "claim", "supply", "payee"}
    /\ fault = "mint" => kind[w] = "deposit"
    /\ fault = "claim" => kind[w] = "redeem"
    /\ LET old == IF fault = "previous" THEN seenSupply[w] + seenNAV[w]
                  ELSE seenSupply[w]
           issued == IF kind[w] = "deposit"
                     THEN (amount[w] * old) \div seenNAV[w] + IF fault = "mint" THEN 1 ELSE 0
                     ELSE 0
           payout == IF kind[w] = "redeem"
                     THEN (amount[w] * seenNAV[w]) \div old + IF fault = "claim" THEN 1 ELSE 0
                     ELSE 0
           after == IF kind[w] = "deposit" THEN old + issued ELSE old - amount[w]
       IN /\ claimedSupply' = [claimedSupply EXCEPT ![w] = old]
          /\ minted' = [minted EXCEPT ![w] = issued]
          /\ claim' = [claim EXCEPT ![w] = payout]
          /\ nextSupply' = [nextSupply EXCEPT ![w] = after + IF fault = "supply" THEN 1 ELSE 0]
    /\ payee' = [payee EXCEPT ![w] = IF fault = "payee" THEN Intruder ELSE w]
    /\ pc' = [pc EXCEPT ![w] = "built"]
    /\ UNCHANGED <<nav, supply, held, head, spent, kind, amount, seenHead,
                    seenNAV, seenSupply, attempts, response, losses, crashes,
                    direct, deposited, paid, redeemCarriers, accepted>>

Submit(w) ==
    /\ pc[w] = "built" /\ attempts[w] < MaxAttempts
    /\ attempts' = [attempts EXCEPT ![w] = @ + 1]
    /\ pc' = [pc EXCEPT ![w] = "sent"]
    /\ UNCHANGED <<nav, supply, held, head, spent, kind, amount, seenHead,
                    seenNAV, seenSupply, claimedSupply, minted, claim,
                    nextSupply, payee, response, losses, crashes, direct,
                    deposited, paid, redeemCarriers, accepted>>

Valid(w) ==
    /\ \A i \in 1..Len(accepted) : accepted[i].owner # w
    /\ BreakSingleSpend \/ (seenHead[w] = head /\ spent[seenHead[w]] = 0 /\ supply > 0)
    /\ BreakPreviousSupply \/ claimedSupply[w] = seenSupply[w]
    /\ BreakPayee \/ payee[w] = w
    /\ nextSupply[w] \in 0..MaxSupply
    /\ IF kind[w] = "deposit"
       THEN /\ minted[w] > 0
            /\ BreakMintPrice \/ minted[w] = (amount[w] * claimedSupply[w]) \div seenNAV[w]
            /\ BreakSupplyDelta \/ nextSupply[w] = claimedSupply[w] + minted[w]
       ELSE /\ amount[w] <= claimedSupply[w] /\ amount[w] <= held[w]
            /\ claim[w] > 0 /\ claim[w] <= seenNAV[w]
            /\ BreakRedeemPrice \/ claim[w] = (amount[w] * seenNAV[w]) \div claimedSupply[w]
            /\ BreakSupplyDelta \/ nextSupply[w] = claimedSupply[w] - amount[w]
            /\ amount[w] = claimedSupply[w] \/ seenNAV[w] - claim[w] >= Dust

Apply(w) ==
    /\ pc[w] = "sent"
    /\ IF Valid(w)
       THEN /\ nav' = IF kind[w] = "deposit" THEN seenNAV[w] + amount[w] ELSE seenNAV[w] - claim[w]
            /\ supply' = nextSupply[w]
            /\ held' = IF kind[w] = "deposit"
                       THEN [held EXCEPT ![payee[w]] = @ + minted[w]]
                       ELSE [held EXCEPT ![w] = @ - amount[w]]
            /\ head' = head + 1
            /\ spent' = [spent EXCEPT ![seenHead[w]] = @ + 1]
            /\ deposited' = [deposited EXCEPT ![w] = @ + IF kind[w] = "deposit" THEN amount[w] ELSE 0]
            /\ paid' = [paid EXCEPT ![payee[w]] = @ + IF kind[w] = "redeem" THEN claim[w] + Carrier ELSE 0]
            /\ redeemCarriers' = redeemCarriers + IF kind[w] = "redeem" THEN Carrier ELSE 0
            /\ accepted' = Append(accepted, [owner |-> w, input |-> seenHead[w],
                   oldNAV |-> seenNAV[w], oldSupply |-> seenSupply[w],
                   claimed |-> claimedSupply[w], operation |-> kind[w],
                   quantity |-> amount[w], minted |-> minted[w], payout |-> claim[w]])
            /\ response' = [response EXCEPT ![w] = "accepted"]
       ELSE /\ response' = [response EXCEPT ![w] = "rejected"]
            /\ UNCHANGED <<nav, supply, held, head, spent, deposited, paid,
                            redeemCarriers, accepted>>
    /\ pc' = [pc EXCEPT ![w] = "observed"]
    /\ UNCHANGED <<kind, amount, seenHead, seenNAV, seenSupply, claimedSupply,
                    minted, claim, nextSupply, payee, attempts, losses, crashes, direct>>

Observe(w) ==
    /\ pc[w] = "observed" /\ pc' = [pc EXCEPT ![w] = "done"]
    /\ UNCHANGED <<nav, supply, held, head, spent, kind, amount, seenHead,
                    seenNAV, seenSupply, claimedSupply, minted, claim,
                    nextSupply, payee, attempts, response, losses, crashes,
                    direct, deposited, paid, redeemCarriers, accepted>>

LoseResponse(w) ==
    /\ pc[w] = "observed" /\ losses < MaxLosses /\ attempts[w] < MaxAttempts
    /\ losses' = losses + 1 /\ pc' = [pc EXCEPT ![w] = "built"]
    /\ UNCHANGED <<nav, supply, held, head, spent, kind, amount, seenHead,
                    seenNAV, seenSupply, claimedSupply, minted, claim,
                    nextSupply, payee, attempts, response, crashes, direct,
                    deposited, paid, redeemCarriers, accepted>>

Crash(w) ==
    /\ pc[w] \in {"quoted", "built"} /\ attempts[w] = 0 /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1 /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ UNCHANGED <<nav, supply, held, head, spent, kind, amount, seenHead,
                    seenNAV, seenSupply, claimedSupply, minted, claim,
                    nextSupply, payee, attempts, response, losses, direct,
                    deposited, paid, redeemCarriers, accepted>>

DirectSend ==
    /\ direct < MaxDirectSends /\ direct' = direct + 1
    /\ nav' = nav + IF BreakIgnoreDirect THEN Dust ELSE 0
    /\ UNCHANGED <<supply, held, head, spent, pc, kind, amount, seenHead,
                    seenNAV, seenSupply, claimedSupply, minted, claim,
                    nextSupply, payee, attempts, response, losses, crashes,
                    deposited, paid, redeemCarriers, accepted>>

Next == DirectSend \/ (\E w \in Workers :
          Submit(w) \/ Apply(w) \/ Observe(w) \/ LoseResponse(w) \/ Crash(w)
          \/ (\E k \in {"deposit", "redeem"}, a \in DepositAmounts \cup BurnAmounts : Quote(w, k, a))
          \/ (\E fault \in {"honest", "previous", "mint", "claim", "supply", "payee"} : Build(w, fault)))
Spec == Init /\ [][Next]_vars

TypeOK == /\ nav \in Nat /\ supply \in 0..MaxSupply
          /\ held \in [Recipients -> Nat] /\ head \in 0..MaxTransitions
          /\ spent \in [0..MaxTransitions -> Nat]
          /\ pc \in [Workers -> {"idle", "quoted", "built", "sent", "observed", "done"}]
          /\ kind \in [Workers -> {"none", "deposit", "redeem"}]
          /\ amount \in [Workers -> Nat] /\ seenHead \in [Workers -> 0..MaxTransitions]
          /\ seenNAV \in [Workers -> Nat] /\ seenSupply \in [Workers -> Nat]
          /\ claimedSupply \in [Workers -> Nat] /\ minted \in [Workers -> Nat]
          /\ claim \in [Workers -> Nat] /\ nextSupply \in [Workers -> Int]
          /\ payee \in [Workers -> Recipients] /\ attempts \in [Workers -> 0..MaxAttempts]
          /\ response \in [Workers -> {"none", "accepted", "rejected"}]
          /\ losses \in 0..MaxLosses /\ crashes \in 0..MaxCrashes
          /\ direct \in 0..MaxDirectSends /\ deposited \in [Workers -> Nat]
          /\ paid \in [Recipients -> Nat] /\ redeemCarriers \in Nat
          /\ Len(accepted) <= MaxTransitions
SingleSpend == \A h \in DOMAIN spent : spent[h] <= 1
AuthenticatedPreviousSupply == \A i \in 1..Len(accepted) : accepted[i].claimed = accepted[i].oldSupply
MintProportion == \A i \in 1..Len(accepted) :
    accepted[i].operation = "deposit" =>
      accepted[i].minted = (accepted[i].quantity * accepted[i].oldSupply) \div accepted[i].oldNAV
RedeemProportion == \A i \in 1..Len(accepted) :
    accepted[i].operation = "redeem" =>
      accepted[i].payout = (accepted[i].quantity * accepted[i].oldNAV) \div accepted[i].oldSupply
SupplyConserved == supply = Sum(held)
NAVConserved == nav + Sum(paid) = InitialNAV + Sum(deposited) + redeemCarriers
AuthorizedPayout == paid[Intruder] = 0 /\ held[Intruder] = 0
Retirement == supply = 0 => nav = 0
DustFloor == nav = 0 \/ nav >= Dust
====
