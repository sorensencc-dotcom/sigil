---------------------------- MODULE RoomDelivery ----------------------------
(* Sigil room delivery: one human, one agent (the Floor Warden bot, e.g. Chief),
   a few @mentions. Each action cites the code it models (paths from repo root).
   Mutation selects a deliberately broken variant; "none" is the real code. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Mentions,      \* trigger messages that @mention the agent
          Root,          \* Root[m] = thread root of m (threadRootOf, room-dispatch.mjs)
          MaxAttempts,   \* floor-warden-bridge.mjs maxAttempts
          MaxCrashes,    \* bridge process restarts allowed
          Mutation

VARIABLES posted,     \* mentions accepted by the relay
          inv,        \* room_invocations.status per trigger: none|queued|running|completed|failed
          dcount,     \* deliveries rows created for the agent per trigger
          acked,      \* delivery acknowledged by the daemon
          busy,       \* bridge: "idle" or the trigger it is handling
          phase,      \* bridge step inside handle(): "post" | "ok" (POST 2xx, not yet recorded)
          attempts,   \* session store floor_warden.attempts (persists across restart)
          forwards,   \* session store floor_warden.forwards (persists across restart)
          watch,      \* in-memory reply watch armed (arm())
          up, crashes,
          copies,     \* webhook POSTs the agent actually received, per trigger
          runs,       \* agent runs still able to reply, per trigger
          replies,    \* reply room.messages accepted with in_reply_to = m
          replyRoot,  \* thread root each reply was posted in
          completedBy \* trigger whose reply completed this invocation

vars == <<posted, inv, dcount, acked, busy, phase, attempts, forwards, watch, up, crashes, copies, runs, replies, replyRoot, completedBy>>

None == "none"
Running == {m \in Mentions : inv[m] = "running"}
Terminal == {"completed", "failed"}

Init ==
  /\ posted = {} /\ inv = [m \in Mentions |-> None] /\ dcount = [m \in Mentions |-> 0]
  /\ acked = [m \in Mentions |-> FALSE] /\ busy = "idle" /\ phase = "post"
  /\ attempts = [m \in Mentions |-> 0] /\ forwards = [m \in Mentions |-> FALSE]
  /\ watch = [m \in Mentions |-> FALSE] /\ up = TRUE /\ crashes = 0
  /\ copies = [m \in Mentions |-> 0] /\ runs = [m \in Mentions |-> 0]
  /\ replies = [m \in Mentions |-> 0] /\ replyRoot = [m \in Mentions |-> None]
  /\ completedBy = [m \in Mentions |-> None]

\* promoteNextInvocation (room-dispatch.mjs): oldest queued -> running + one delivery.
\* Runs inside the same accept / fail transaction as the step that frees the agent.
Promote(i, d, a) ==
  IF \E q \in Mentions : i[q] = "queued"
  THEN \E q \in {x \in Mentions : i[x] = "queued"} :
         /\ inv' = [i EXCEPT ![q] = "running"]
         /\ dcount' = [d EXCEPT ![q] = @ + 1]
         /\ acked' = [a EXCEPT ![q] = FALSE]
  ELSE inv' = i /\ dcount' = d /\ acked' = a

\* acceptEnvelope -> applyRoomDispatch -> dispatchToTarget (room-dispatch.mjs):
\* one transaction under the room lock. Busy agent -> queued row, no delivery.
HumanPostsMention(m) ==
  /\ m \notin posted
  /\ posted' = posted \cup {m}
  /\ IF Running = {}
     THEN inv' = [inv EXCEPT ![m] = "running"] /\ dcount' = [dcount EXCEPT ![m] = 1]
     ELSE inv' = [inv EXCEPT ![m] = "queued"]
          /\ dcount' = [dcount EXCEPT ![m] = IF Mutation = "dup_delivery" THEN 1 ELSE 0]
  /\ UNCHANGED <<acked, busy, phase, attempts, forwards, watch, up, crashes, copies, runs, replies, replyRoot, completedBy>>

\* agent-daemon.mjs pollOnce/processItem: the stream frame or the safety poll reads
\* every unacked delivery (since = '' after a restart). Stream frames only trigger polls,
\* so any unacked delivery can be picked. floor-warden-bridge.mjs handle(): no running
\* invocation for this trigger, or forwards[] already set -> 'skipped' -> ack.
BridgePicks(m) ==
  /\ up /\ busy = "idle" /\ dcount[m] > 0 /\ ~acked[m]
  /\ IF inv[m] = "running" /\ ~forwards[m]
     THEN busy' = m /\ phase' = "post" /\ UNCHANGED acked
     ELSE acked' = [acked EXCEPT ![m] = TRUE] /\ UNCHANGED <<busy, phase>>
  /\ UNCHANGED <<posted, inv, dcount, attempts, forwards, watch, up, crashes, copies, runs, replies, replyRoot, completedBy>>

\* Relay failRoomInvocation: invocation failed, next queued promoted (same txn).
FailInv(m, ack) ==
  /\ Promote([inv EXCEPT ![m] = "failed"], dcount, [acked EXCEPT ![m] = ack])
  /\ watch' = [watch EXCEPT ![m] = FALSE]

\* post() returns ok. The agent's routine received the payload.
PostOk(m) ==
  /\ up /\ busy = m /\ phase = "post"
  /\ phase' = "ok"
  /\ copies' = [copies EXCEPT ![m] = @ + 1] /\ runs' = [runs EXCEPT ![m] = @ + 1]
  /\ UNCHANGED <<posted, inv, dcount, acked, busy, attempts, forwards, watch, up, crashes, replies, replyRoot, completedBy>>

\* forward(): update() writes forwards[], arm() starts the reply watch, then the daemon acks.
RecordForward(m) ==
  /\ up /\ busy = m /\ phase = "ok"
  /\ forwards' = [forwards EXCEPT ![m] = TRUE] /\ attempts' = [attempts EXCEPT ![m] = 0]
  /\ watch' = [watch EXCEPT ![m] = TRUE] /\ acked' = [acked EXCEPT ![m] = TRUE]
  /\ busy' = "idle" /\ phase' = "post"
  /\ UNCHANGED <<posted, inv, dcount, up, crashes, copies, runs, replies, replyRoot, completedBy>>

\* post() returns retry (timeout, network, 408/429/5xx). AbortSignal.timeout fires on the
\* bridge side only, so the agent may or may not have the request (got).
\* attempt >= maxAttempts -> fail FLOOR_WARDEN_UNREACHABLE (daemon acks the 'failed' outcome).
\* Otherwise either sleep and retry in-loop, or throw FLOOR_WARDEN_RETRY -> 'room_unacked'.
PostRetry(m, got, stay) ==
  /\ up /\ busy = m /\ phase = "post"
  /\ copies' = [copies EXCEPT ![m] = IF got THEN @ + 1 ELSE @]
  /\ runs' = [runs EXCEPT ![m] = IF got THEN @ + 1 ELSE @]
  /\ attempts' = [attempts EXCEPT ![m] = @ + 1]
  /\ IF attempts[m] + 1 >= MaxAttempts
     THEN FailInv(m, TRUE) /\ busy' = "idle"
     ELSE /\ UNCHANGED <<inv, dcount, watch>>
          /\ busy' = IF stay THEN m ELSE "idle"
          /\ acked' = [acked EXCEPT ![m] = IF ~stay /\ Mutation = "ack_on_retry" THEN TRUE ELSE @]
  /\ phase' = "post"
  /\ UNCHANGED <<posted, forwards, up, crashes, replies, replyRoot, completedBy>>

\* post() returns reject (4xx) -> fail FLOOR_WARDEN_REJECTED, ack.
PostReject(m) ==
  /\ up /\ busy = m /\ phase = "post"
  /\ FailInv(m, TRUE) /\ busy' = "idle"
  /\ UNCHANGED <<posted, phase, attempts, forwards, up, crashes, copies, runs, replies, replyRoot, completedBy>>

\* floor-warden-replies.mjs runReply: step 8 needs a running invocation whose trigger is
\* in_reply_to; acceptEnvelope (expectedTriggerMessageId) completes it single-shot
\* (finishInvocation in applyRoomDispatch) and posts in threadRootOf(trigger).
\* A refused reply posts nothing. Mutations drop the trigger check or single-shot.
AgentReplies(m) ==
  /\ runs[m] > 0
  /\ runs' = [runs EXCEPT ![m] = @ - 1]
  /\ LET target == IF Mutation = "no_trigger_check" THEN Running
                   ELSE IF Mutation = "no_single_shot" /\ inv[m] = "completed" THEN {m}
                   ELSE Running \cap {m}
     IN IF target = {}
        THEN UNCHANGED <<inv, dcount, acked, watch, replies, replyRoot, completedBy>>
        ELSE \E t \in target :
               /\ replies' = [replies EXCEPT ![m] = @ + 1]
               /\ replyRoot' = [replyRoot EXCEPT ![m] = Root[t]]
               /\ completedBy' = [completedBy EXCEPT ![t] = m]
               /\ watch' = [watch EXCEPT ![t] = FALSE]
               /\ IF inv[t] = "running"
                  THEN Promote([inv EXCEPT ![t] = "completed"], dcount, acked)
                  ELSE UNCHANGED <<inv, dcount, acked>>
  /\ UNCHANGED <<posted, busy, phase, attempts, forwards, up, crashes, copies>>

\* The agent run ends without replying.
AgentGivesUp(m) ==
  /\ runs[m] > 0 /\ runs' = [runs EXCEPT ![m] = @ - 1]
  /\ UNCHANGED <<posted, inv, dcount, acked, busy, phase, attempts, forwards, watch, up, crashes, copies, replies, replyRoot, completedBy>>

\* Reply watch deadline (finish/watch poll) -> failRoomInvocation REPLY_TIMEOUT.
ReplyTimeout(m) ==
  /\ up /\ watch[m] /\ inv[m] = "running"
  /\ FailInv(m, acked[m])
  /\ UNCHANGED <<posted, busy, phase, attempts, forwards, up, crashes, copies, runs, replies, replyRoot, completedBy>>

\* Bridge process dies: in-memory busy/watch lost; session store and relay rows persist.
BridgeCrash ==
  /\ up /\ crashes < MaxCrashes
  /\ up' = FALSE /\ crashes' = crashes + 1 /\ busy' = "idle" /\ phase' = "post"
  /\ watch' = [m \in Mentions |-> FALSE]
  /\ UNCHANGED <<posted, inv, dcount, acked, attempts, forwards, copies, runs, replies, replyRoot, completedBy>>

\* start(): onStart = recover() arms a watch for every running invocation, then polls.
BridgeRestart ==
  /\ ~up /\ up' = TRUE
  /\ watch' = [m \in Mentions |-> inv[m] = "running"]
  /\ UNCHANGED <<posted, inv, dcount, acked, busy, phase, attempts, forwards, crashes, copies, runs, replies, replyRoot, completedBy>>

Progress ==
  \/ \E m \in Mentions : HumanPostsMention(m) \/ BridgePicks(m) \/ PostOk(m) \/ RecordForward(m)
        \/ PostReject(m) \/ AgentReplies(m) \/ AgentGivesUp(m) \/ ReplyTimeout(m)
        \/ \E g, s \in BOOLEAN : PostRetry(m, g, s)
  \/ BridgeCrash \/ BridgeRestart

Done == ~ENABLED Progress /\ UNCHANGED vars

Next == Progress \/ Done

\* ---- rules ---------------------------------------------------------------
OneDeliveryPerMention == \A m \in Mentions :
  /\ dcount[m] <= 1
  /\ (inv[m] \in {"running", "completed"} => dcount[m] = 1)
NoDoubleReply == \A m \in Mentions : replies[m] <= 1
ReplyInRightThread == \A m \in Mentions :
  /\ (replies[m] > 0 => replyRoot[m] = Root[m])
  /\ (completedBy[m] # None => completedBy[m] = m)
NoLostDelivery == (~ENABLED Progress) => \A m \in posted : inv[m] \in Terminal
AgentRunsOnce == \A m \in Mentions : copies[m] <= 1
TypeOK == busy \in Mentions \cup {"idle"}
=============================================================================
