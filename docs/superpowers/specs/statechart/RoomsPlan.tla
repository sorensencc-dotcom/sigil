---- MODULE RoomsPlan ----
EXTENDS Naturals
CONSTANTS HoldDelivered, Cursor, Cap

VARIABLES inv, turns, cardShown, fold, capPosted,
          rows, relayAck, shown, localMark, divider, staleNew,
          relayKey, sigBy, pinned, mark

vars == <<inv, turns, cardShown, fold, capPosted, rows, relayAck, shown,
          localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>

Devices == {"A", "B"}
Max(a, b) == IF a > b THEN a ELSE b

Init ==
  /\ inv = "idle" /\ turns = 0 /\ cardShown = FALSE /\ fold = "open" /\ capPosted = FALSE
  /\ rows = 0 /\ relayAck = 0
  /\ shown = [d \in Devices |-> 0] /\ localMark = [d \in Devices |-> 0]
  /\ divider = [d \in Devices |-> 0] /\ staleNew = FALSE
  /\ relayKey \in {"T", "X"} /\ sigBy = relayKey /\ pinned \in {"none", "T"}
  /\ mark = "attested"

\* Invocation lifecycle (relay today) with the plan's status line and cards.
YouSend ==
  /\ inv \in {"idle", "replied", "failed", "stopped", "capped"}
  /\ inv' = "queued" /\ turns' = 0
  /\ UNCHANGED <<cardShown, fold, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>
AgentStarts ==
  /\ inv = "queued" /\ inv' = "running"
  /\ UNCHANGED <<turns, cardShown, fold, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>
AgentReplies ==
  /\ inv = "running" /\ turns' = turns + 1
  /\ IF turns + 1 >= Cap
       THEN inv' = "capped" /\ capPosted' = TRUE
       ELSE inv' = "replied" /\ capPosted' = capPosted
  /\ UNCHANGED <<cardShown, fold, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>
AgentWakesAgent ==
  /\ inv = "replied" /\ inv' = "queued"
  /\ UNCHANGED <<turns, cardShown, fold, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>
AgentNeedsApproval ==
  /\ inv = "running" /\ inv' = "held" /\ cardShown' = HoldDelivered
  /\ UNCHANGED <<turns, fold, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>
OwnerApproves ==
  /\ inv = "held" /\ inv' = "running" /\ cardShown' = FALSE
  /\ UNCHANGED <<turns, fold, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>
AgentFails ==
  /\ inv = "running" /\ inv' = "failed"
  /\ UNCHANGED <<turns, cardShown, fold, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>
YouStop ==
  /\ inv \in {"queued", "running"} /\ inv' = "stopped"
  /\ UNCHANGED <<turns, cardShown, fold, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>

\* Plan rule: fold only a stretch with no hold and no cap event. Later rows join it.
YouFold ==
  /\ fold = "open" /\ inv \in {"queued", "running", "replied"} /\ ~cardShown /\ ~capPosted
  /\ fold' = "folded"
  /\ UNCHANGED <<inv, turns, cardShown, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>
YouUnfold ==
  /\ fold = "folded" /\ fold' = "open"
  /\ UNCHANGED <<inv, turns, cardShown, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>

\* Unread: New divider and ack.
RowArrives ==
  /\ rows < 2 /\ rows' = rows + 1
  /\ UNCHANGED <<inv, turns, cardShown, fold, capPosted, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned, mark>>
OpenRoom(d) ==
  /\ shown' = [shown EXCEPT ![d] = rows]
  /\ divider' = [divider EXCEPT ![d] = IF Cursor = "relay" THEN relayAck ELSE localMark[d]]
  /\ staleNew' = (staleNew \/ ((IF Cursor = "relay" THEN relayAck ELSE localMark[d]) < relayAck))
  /\ UNCHANGED <<inv, turns, cardShown, fold, capPosted, rows, relayAck, localMark, relayKey, sigBy, pinned, mark>>
ReadRoom(d) ==
  /\ shown[d] > localMark[d] \/ shown[d] > relayAck
  /\ localMark' = [localMark EXCEPT ![d] = shown[d]]
  /\ relayAck' = Max(relayAck, shown[d])
  /\ UNCHANGED <<inv, turns, cardShown, fold, capPosted, rows, shown, divider, staleNew, relayKey, sigBy, pinned, mark>>

\* Trust mark: the plan names two anchors and gives no precedence.
VerifyWithRelayKey ==
  /\ mark = "attested" /\ mark' = "relayMatch"
  /\ UNCHANGED <<inv, turns, cardShown, fold, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned>>
VerifyWithPin ==
  /\ mark = "attested" /\ pinned = "T"
  /\ mark' = IF sigBy = "T" THEN "pinMatch" ELSE "mismatch"
  /\ UNCHANGED <<inv, turns, cardShown, fold, capPosted, rows, relayAck, shown, localMark, divider, staleNew, relayKey, sigBy, pinned>>

Next == YouSend \/ AgentStarts \/ AgentReplies \/ AgentWakesAgent \/ AgentNeedsApproval
        \/ OwnerApproves \/ AgentFails \/ YouStop \/ YouFold \/ YouUnfold \/ RowArrives
        \/ (\E d \in Devices : OpenRoom(d)) \/ (\E d \in Devices : ReadRoom(d))
        \/ VerifyWithRelayKey \/ VerifyWithPin
        \/ (rows = 2 /\ mark /= "attested" /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

\* Rules, as the reader sees them.
HoldReachesApprover == inv = "held" => cardShown
HoldNeverHidden == cardShown => fold = "open"
CapNeverHidden == capPosted => fold = "open"
NeverReadAgainAsNew == ~staleNew
ForgeryNeverLooksTrusted == (sigBy = "X" /\ pinned = "T") => mark \notin {"relayMatch", "pinMatch"}
PinMarkOnlyWhenPinMatches == mark = "pinMatch" => (pinned = "T" /\ sigBy = "T")
CapStopsAgents == turns <= Cap
====
