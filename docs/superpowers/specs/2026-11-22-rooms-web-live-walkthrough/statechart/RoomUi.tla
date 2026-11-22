---- MODULE RoomUi ----
EXTENDS Naturals
CONSTANT MODE, CAP
VARIABLES inv, ui, turns, lastStop
vars == <<inv, ui, turns, lastStop>>

Idleish == {"idle", "replied", "failed", "stopped"}

Init == inv = "idle" /\ ui = "nothing" /\ turns = 0 /\ lastStop = FALSE

\* You post a message that mentions the agent.
YouMention ==
  /\ inv \in Idleish
  /\ inv' = "queued" /\ ui' = "nothing" /\ lastStop' = FALSE
  /\ UNCHANGED turns

\* The relay hands the message to the agent.
AgentStarts ==
  /\ inv = "queued"
  /\ inv' = "running" /\ lastStop' = FALSE
  /\ ui' = IF MODE = "plan" THEN "working" ELSE "nothing"
  /\ UNCHANGED turns

\* The agent cannot start (CLI_START_FAILED).
AgentFails ==
  /\ inv = "running"
  /\ inv' = "failed" /\ lastStop' = FALSE
  /\ ui' = IF MODE = "plan" THEN "failureSentence" ELSE "failureRaw"
  /\ UNCHANGED turns

\* The agent answers and stays under the turn cap.
AgentReplies ==
  /\ inv = "running" /\ turns + 1 < CAP
  /\ inv' = "replied" /\ turns' = turns + 1 /\ ui' = "nothing" /\ lastStop' = FALSE

\* The agent answers and uses the last turn: the relay posts the cap event.
AgentHitsCap ==
  /\ inv = "running" /\ turns + 1 = CAP
  /\ inv' = "capped" /\ turns' = CAP /\ lastStop' = FALSE
  /\ ui' = IF MODE = "plan" THEN "capBanner" ELSE "capRaw"

\* You press Stop while work is queued or running.
StopActive ==
  /\ inv \in {"queued", "running"}
  /\ inv' = "stopped" /\ lastStop' = TRUE
  /\ ui' = IF MODE = "plan" THEN "stopNote" ELSE "stopRaw"
  /\ UNCHANGED turns

\* You press Stop while nothing runs.
StopIdle ==
  /\ inv \in {"idle", "replied", "failed", "stopped", "capped"}
  /\ lastStop' = TRUE
  /\ ui' = IF MODE = "plan" THEN "nothingToStop" ELSE ui
  /\ UNCHANGED <<inv, turns>>

\* You press Continue after the cap.
YouContinue ==
  /\ inv = "capped"
  /\ inv' = "idle" /\ turns' = 0 /\ ui' = "nothing" /\ lastStop' = FALSE

Next == YouMention \/ AgentStarts \/ AgentFails \/ AgentReplies \/ AgentHitsCap
        \/ StopActive \/ StopIdle \/ YouContinue

Spec == Init /\ [][Next]_vars

WorkingVisible == inv = "running" => ui = "working"
StopFeedback == lastStop => ui \in {"stopNote", "nothingToStop"}
FailureExplained == inv = "failed" => ui = "failureSentence"
CapOffered == inv = "capped" => ui = "capBanner"
====
