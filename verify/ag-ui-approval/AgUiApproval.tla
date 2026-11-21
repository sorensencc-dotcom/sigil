---- MODULE AgUiApproval ----
\* Sigil AG-UI projection (docs/superpowers/specs/2026-11-21-sigil-ag-ui-projection-design.md).
\* One thread, one gated (high-risk) envelope, one AG-UI client.
\* The worker's envelope consumes the approval in the relay risk gate.
\* The AG-UI client only observes and resumes; resume never consumes.
\* Fixed = TRUE models the proposed relay: an identical envelope retry returns the
\* original acceptance, and a resume after consumption replays the stored result.
\* Fixed = FALSE models the relay as it is on main (2026-11-21).
EXTENDS Naturals

CONSTANTS MaxRuns, Fixed

VARIABLES
  run,        \* current AG-UI run number (0 = none yet)
  phase,      \* "idle" | "streaming" | "interrupted" | "done" | "error" | "truncated"
  decision,   \* "none" | "pending" | "approved" | "expired" | "consumed" | "cancelled"
  consumes,   \* approvals consumed by the risk gate
  toolRuns,   \* times the gated envelope was accepted (its effect happened)
  workerRetries,   \* identical envelope retries the worker sent
  workerRejected,  \* an identical retry of an accepted envelope got APPROVAL_REQUIRED
  resultShown,     \* client was told the gated action's result
  terminals,  \* run -> terminal events emitted
  cut,        \* runs whose stream was cut before a terminal event
  outcome     \* client belief: "none" | "success" | "interrupt" | "error" | "truncated"

vars == <<run, phase, decision, consumes, toolRuns, workerRetries, workerRejected, resultShown, terminals, cut, outcome>>
Runs == 1..MaxRuns
worker == <<consumes, toolRuns, workerRetries, workerRejected>>

Init ==
  /\ run = 0 /\ phase = "idle" /\ decision = "none"
  /\ consumes = 0 /\ toolRuns = 0 /\ workerRetries = 0 /\ workerRejected = FALSE
  /\ resultShown = FALSE
  /\ terminals = [r \in Runs |-> 0] /\ cut = {} /\ outcome = "none"

Emit(r) == terminals' = [terminals EXCEPT ![r] = @ + 1]

ClientStartsRun ==
  /\ phase = "idle"
  /\ run' = 1 /\ phase' = "streaming"
  /\ UNCHANGED <<decision, worker, resultShown, terminals, cut, outcome>>

\* Worker asks for approval: relay creates a challenge; stream emits the interrupt and ends the run.
WorkerRequestsApproval ==
  /\ phase = "streaming" /\ decision = "none"
  /\ decision' = "pending" /\ phase' = "interrupted" /\ outcome' = "interrupt" /\ Emit(run)
  /\ UNCHANGED <<run, worker, resultShown, cut>>

HumanApproves ==
  /\ decision = "pending"
  /\ decision' = "approved"
  /\ UNCHANGED <<run, phase, worker, resultShown, terminals, cut, outcome>>

\* Challenge and decision share one expires_at.
ApprovalExpires ==
  /\ decision \in {"pending", "approved"}
  /\ decision' = "expired"
  /\ UNCHANGED <<run, phase, worker, resultShown, terminals, cut, outcome>>

\* Worker submits the gated envelope; risk gate consumes the approval. Independent of the client.
WorkerSubmitsEnvelope ==
  /\ decision = "approved"
  /\ decision' = "consumed" /\ consumes' = consumes + 1 /\ toolRuns' = toolRuns + 1
  /\ resultShown' = (phase = "streaming" \/ resultShown)
  /\ UNCHANGED <<run, phase, workerRetries, workerRejected, terminals, cut, outcome>>

\* Worker's HTTP call timed out; it resends the identical envelope (same idempotency key and bytes).
WorkerRetriesEnvelope ==
  /\ decision = "consumed" /\ workerRetries = 0
  /\ workerRetries' = 1
  /\ workerRejected' = ~Fixed
  /\ UNCHANGED <<run, phase, decision, consumes, toolRuns, resultShown, terminals, cut, outcome>>

\* Client resumes on a new run. Relay reads decision state; never consumes.
ClientResumes ==
  /\ phase = "interrupted" /\ run < MaxRuns
  /\ run' = run + 1
  /\ \/ /\ decision = "approved"                 \* approved, worker not yet in: wait for it
        /\ phase' = "streaming" /\ outcome' = "none"
        /\ UNCHANGED <<decision, resultShown, terminals>>
     \/ /\ decision = "consumed"                 \* already accepted: show stored result
        /\ phase' = "streaming" /\ outcome' = "none" /\ resultShown' = TRUE
        /\ UNCHANGED <<decision, terminals>>
     \/ /\ decision = "expired"                  \* approval can no longer be used: RUN_ERROR
        /\ phase' = "error" /\ outcome' = "error"
        /\ terminals' = [terminals EXCEPT ![run + 1] = @ + 1]
        /\ UNCHANGED <<decision, resultShown>>
  /\ UNCHANGED <<worker, cut>>

\* A resume while the approval is still pending is refused (409); no run starts, interrupt stays open.
ClientResumesTooEarly ==
  /\ phase = "interrupted" /\ decision = "pending"
  /\ UNCHANGED vars

\* Client cancels the interrupt (resume status cancelled). Relay revokes the challenge and any
\* unused decision in the same transaction the risk gate locks, so a later approve or envelope fails.
ClientCancels ==
  /\ phase = "interrupted" /\ run < MaxRuns /\ decision \in {"pending", "approved"}
  /\ run' = run + 1
  /\ decision' = "cancelled" /\ phase' = "error" /\ outcome' = "error"
  /\ terminals' = [terminals EXCEPT ![run + 1] = @ + 1]
  /\ UNCHANGED <<worker, resultShown, cut>>

\* While waiting for the worker, the approval runs out: RUN_ERROR.
WaitExpires ==
  /\ phase = "streaming" /\ decision = "expired" /\ run > 1
  /\ phase' = "error" /\ outcome' = "error" /\ Emit(run)
  /\ UNCHANGED <<run, decision, worker, resultShown, cut>>

AgentFinishes ==
  /\ phase = "streaming"
  /\ \/ decision = "none"
     \/ decision = "consumed" /\ resultShown
  /\ phase' = "done" /\ outcome' = "success" /\ Emit(run)
  /\ UNCHANGED <<run, decision, worker, resultShown, cut>>

StreamDrops ==
  /\ phase = "streaming"
  /\ phase' = "truncated" /\ outcome' = "truncated" /\ cut' = cut \cup {run}
  /\ UNCHANGED <<run, decision, worker, resultShown, terminals>>

\* Client resends the same resume after a cut stream.
ClientRetriesAfterDrop ==
  /\ phase = "truncated" /\ run < MaxRuns /\ decision # "none"
  /\ run' = run + 1
  /\ IF decision = "consumed" /\ Fixed
       THEN /\ phase' = "streaming" /\ outcome' = "none" /\ resultShown' = TRUE
            /\ UNCHANGED terminals
       ELSE IF decision = "approved"
         THEN /\ phase' = "streaming" /\ outcome' = "none"
              /\ UNCHANGED <<terminals, resultShown>>
         ELSE /\ phase' = "error" /\ outcome' = "error"
              /\ terminals' = [terminals EXCEPT ![run + 1] = @ + 1]
              /\ UNCHANGED resultShown
  /\ UNCHANGED <<decision, worker, cut>>

Idle ==
  /\ \/ phase \in {"done", "error"}
     \/ phase = "truncated" /\ (run = MaxRuns \/ decision = "none")
     \/ phase = "interrupted" /\ run = MaxRuns
  /\ UNCHANGED vars

Next ==
  \/ ClientStartsRun \/ WorkerRequestsApproval \/ HumanApproves \/ ApprovalExpires
  \/ WorkerSubmitsEnvelope \/ WorkerRetriesEnvelope
  \/ ClientResumes \/ ClientResumesTooEarly \/ ClientCancels \/ WaitExpires \/ AgentFinishes
  \/ StreamDrops \/ ClientRetriesAfterDrop \/ Idle

Spec == Init /\ [][Next]_vars

\* ---- Rules ----
NoEffectWithoutApproval == toolRuns <= consumes
ConsumedAtMostOnce == consumes <= 1
EffectAtMostOnce == toolRuns <= 1
WorkerRetryNotRejected == ~workerRejected
OneTerminalPerRun == \A r \in Runs : terminals[r] <= 1
UncutRunsEndOnce ==
  phase \in {"done", "error"} => \A r \in 1..run : r \in cut \/ terminals[r] = 1
ErrorMeansNoEffect == outcome = "error" => toolRuns = 0
SuccessShowsResult == (outcome = "success" /\ toolRuns > 0) => resultShown
TruncatedNeverSuccess == phase = "truncated" => outcome # "success"
====
