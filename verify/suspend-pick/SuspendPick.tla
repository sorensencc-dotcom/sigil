---------------------------- MODULE SuspendPick ----------------------------
(* Router pick vs suspendHuman. Each action cites the code it models.
   Mutation "none" is the real code. "lock_human" is the STATUS.md fix.
   "no_endpoint_lock" drops lockEndpointForShare. *)
EXTENDS Integers

CONSTANTS TriggerStatus,  \* "active" or "revoked": endpoints.status of the trigger sender
          Mutation        \* "none" | "lock_human" | "no_endpoint_lock"

VARIABLES pick,         \* pick pc: idle, human, ep, room, read, done
          susp,         \* suspend pc: idle, human, endpoints, scan, rooms, done
          humanStatus,  \* committed humans.status
          inv,          \* committed room_invocations.status for this pick
          pickSubject,  \* humans.status pick read (lookupInvocationSubject)
          scanHit,      \* suspend's scan saw a committed running row
          epLock,       \* lock on the trigger sender's endpoints row
          humanLock,    \* lock on the humans row
          roomLock,     \* lock on the rooms row
          otherEpLock   \* lock on the subject's other still-active endpoint

vars == <<pick, susp, humanStatus, inv, pickSubject, scanHit,
          epLock, humanLock, roomLock, otherEpLock>>

ShareOK(lock) == lock \in {"free", "share"}
ExclOK(lock) == lock = "free"

Init ==
  /\ pick = "idle" /\ susp = "idle"
  /\ humanStatus = "active" /\ inv = "none"
  /\ pickSubject = "unset" /\ scanHit = FALSE
  /\ epLock = "free" /\ humanLock = "free"
  /\ roomLock = "free" /\ otherEpLock = "free"

\* STATUS.md fix, taken first: SELECT 1 FROM humans WHERE human_id = $1 FOR SHARE
\* (order humans -> endpoints -> rooms). Current code never does this.
PickLockHuman ==
  /\ pick = "idle"
  /\ Mutation = "lock_human"
  /\ ShareOK(humanLock)
  /\ pick' = "human" /\ humanLock' = "share"
  /\ UNCHANGED <<susp, humanStatus, inv, pickSubject, scanHit,
                 epLock, roomLock, otherEpLock>>

\* room-routes.mjs: lockEndpointForShare(preTrigger.envelope.sender.endpoint_id)
PickLockEp ==
  /\ \/ /\ Mutation = "none" /\ pick = "idle"
     \/ /\ Mutation = "lock_human" /\ pick = "human"
  /\ ShareOK(epLock)
  /\ pick' = "ep" /\ epLock' = "share"
  /\ UNCHANGED <<susp, humanStatus, inv, pickSubject, scanHit,
                 humanLock, roomLock, otherEpLock>>

\* room-routes.mjs: lockRoom after the sender lock.
\* Mutation "no_endpoint_lock" skips FOR SHARE and takes the room lock first.
PickLockRoom ==
  /\ \/ /\ Mutation = "no_endpoint_lock" /\ pick = "idle"
     \/ /\ Mutation # "no_endpoint_lock" /\ pick = "ep"
  /\ ExclOK(roomLock)
  /\ pick' = "room" /\ roomLock' = "excl"
  /\ UNCHANGED <<susp, humanStatus, inv, pickSubject, scanHit,
                 epLock, humanLock, otherEpLock>>

\* room-dispatch.mjs subjectBlocker -> lookupInvocationSubject
\* READ COMMITTED: sees committed humans.status only.
PickReadSubject ==
  /\ pick = "room"
  /\ pick' = "read" /\ pickSubject' = humanStatus
  /\ UNCHANGED <<susp, humanStatus, inv, scanHit,
                 epLock, humanLock, roomLock, otherEpLock>>

\* dispatchToTarget then COMMIT: INSERT room_invocations becomes visible,
\* FOR SHARE / room locks drop.
PickCommit ==
  /\ pick = "read"
  /\ pick' = "done"
  /\ inv' = IF pickSubject = "active" THEN "running" ELSE "refused"
  /\ epLock' = IF epLock = "share" THEN "free" ELSE epLock
  /\ humanLock' = IF humanLock = "share" THEN "free" ELSE humanLock
  /\ roomLock' = "free"
  /\ UNCHANGED <<susp, humanStatus, pickSubject, scanHit, otherEpLock>>

\* postgres-repository.mjs suspendHuman: UPDATE humans SET status = 'suspended'
\* Uncommitted until SuspendCommit, so pick's READ COMMITTED read is unchanged.
SuspendUpdateHuman ==
  /\ susp = "idle"
  /\ ExclOK(humanLock)
  /\ susp' = "human" /\ humanLock' = "excl"
  /\ UNCHANGED <<pick, humanStatus, inv, pickSubject, scanHit,
                 epLock, roomLock, otherEpLock>>

\* UPDATE endpoints SET status = 'suspended' WHERE owner_id AND status = 'active'
\* A revoked trigger sender is not in that UPDATE, so its FOR SHARE does not wait.
SuspendUpdateActiveEps ==
  /\ susp = "human"
  /\ ExclOK(otherEpLock)
  /\ TriggerStatus # "active" \/ ExclOK(epLock)
  /\ susp' = "endpoints"
  /\ otherEpLock' = "excl"
  /\ epLock' = IF TriggerStatus = "active" THEN "excl" ELSE epLock
  /\ UNCHANGED <<pick, humanStatus, inv, pickSubject, scanHit,
                 humanLock, roomLock>>

\* SELECT DISTINCT room_id FROM room_invocations WHERE subject AND queued|running
\* Sees committed rows only.
SuspendScan ==
  /\ susp = "endpoints"
  /\ susp' = "scan"
  /\ scanHit' = (inv = "running")
  /\ UNCHANGED <<pick, humanStatus, inv, pickSubject,
                 epLock, humanLock, roomLock, otherEpLock>>

\* lockRoom per scanned room. Empty scan takes no room lock.
SuspendLockRooms ==
  /\ susp = "scan"
  /\ IF scanHit THEN ExclOK(roomLock) ELSE TRUE
  /\ susp' = "rooms"
  /\ roomLock' = IF scanHit THEN "excl" ELSE roomLock
  /\ UNCHANGED <<pick, humanStatus, inv, pickSubject, scanHit,
                 epLock, humanLock, otherEpLock>>

\* cancelRoomInvocations for the scanned rooms, then COMMIT.
SuspendCommit ==
  /\ susp = "rooms"
  /\ susp' = "done"
  /\ humanStatus' = "suspended"
  /\ inv' = IF scanHit /\ inv = "running" THEN "cancelled" ELSE inv
  /\ humanLock' = "free"
  /\ otherEpLock' = "free"
  /\ epLock' = IF epLock = "excl" THEN "free" ELSE epLock
  /\ roomLock' = IF scanHit THEN "free" ELSE roomLock
  /\ UNCHANGED <<pick, pickSubject, scanHit>>

Done ==
  /\ pick = "done" /\ susp = "done"
  /\ UNCHANGED vars

Next ==
  \/ PickLockHuman \/ PickLockEp \/ PickLockRoom
  \/ PickReadSubject \/ PickCommit
  \/ SuspendUpdateHuman \/ SuspendUpdateActiveEps
  \/ SuspendScan \/ SuspendLockRooms \/ SuspendCommit
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ pick \in {"idle", "human", "ep", "room", "read", "done"}
  /\ susp \in {"idle", "human", "endpoints", "scan", "rooms", "done"}
  /\ humanStatus \in {"active", "suspended"}
  /\ inv \in {"none", "running", "refused", "cancelled"}
  /\ pickSubject \in {"unset", "active", "suspended"}
  /\ scanHit \in BOOLEAN
  /\ epLock \in {"free", "share", "excl"}
  /\ humanLock \in {"free", "share", "excl"}
  /\ roomLock \in {"free", "share", "excl"}
  /\ otherEpLock \in {"free", "share", "excl"}

\* After suspend commits, no running invocation remains under that subject,
\* and a pick that has not yet committed cannot create one that survives.
NoSurvivingInvocation ==
  humanStatus = "suspended" => inv # "running"
=============================================================================
