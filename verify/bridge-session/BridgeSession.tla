---- MODULE BridgeSession ----
\* One resume bridge, one room. Turn A (thread A) then turn B (thread B),
\* B is mentioned as soon as A's reply is visible in the room.
CONSTANT Serialize   \* TRUE = bridge finishes a turn (store write) before reading for the next
VARIABLES pc, storeSess, storeThreads, readSess
vars == <<pc, storeSess, storeThreads, readSess>>
Turns == {"A","B"}
Init == /\ pc = [t \in Turns |-> "idle"]
        /\ storeSess = "none" /\ storeThreads = {}
        /\ readSess = [t \in Turns |-> "unset"]
\* turn A starts at once; turn B starts when A's reply is visible
CanStart(t) == t = "A" \/ (pc["A"] \in {"replied","stored"} /\ (~Serialize \/ pc["A"] = "stored"))
ReadSession(t) == /\ pc[t] = "idle" /\ CanStart(t)
                  /\ pc' = [pc EXCEPT ![t] = "running"]
                  /\ readSess' = [readSess EXCEPT ![t] = storeSess]
                  /\ UNCHANGED <<storeSess, storeThreads>>
\* CLI answers; reply posted and visible in the room
PostReply(t) == /\ pc[t] = "running" /\ pc' = [pc EXCEPT ![t] = "replied"] /\ UNCHANGED <<storeSess, storeThreads, readSess>>
\* store write: keep old cursors only if session unchanged from what this turn read
StoreSession(t) == /\ pc[t] = "replied" /\ pc' = [pc EXCEPT ![t] = "stored"]
                   /\ storeSess' = "s1"
                   /\ storeThreads' = IF readSess[t] = "s1" /\ storeSess = "s1" THEN storeThreads \cup {t} ELSE {t}
                   /\ UNCHANGED readSess
Done == /\ \A t \in Turns : pc[t] = "stored" /\ UNCHANGED vars
Next == \E t \in Turns : ReadSession(t) \/ PostReply(t) \/ StoreSession(t)
Next2 == (\E t \in Turns : ReadSession(t)) \/ (\E t \in Turns : PostReply(t)) \/ (\E t \in Turns : StoreSession(t)) \/ Done
\* Rules
EveryTurnResumes == \A t \in Turns : (t = "B" /\ pc[t] # "idle") => readSess[t] = "s1"
NoThreadForgotten == (\A t \in Turns : pc[t] = "stored") => storeThreads = Turns
Spec == Init /\ [][Next2]_vars
====
