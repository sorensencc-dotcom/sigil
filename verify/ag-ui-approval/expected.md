# Expected TLC results

Run with the statechart skill (TLC, one worker), `MaxRuns = 3`, `MaxInterrupts = 2`, and `MaxClients = 2`.

The model includes two simultaneous interrupts and two clients resuming the same thread. It checks complete interrupt coverage, pending-resume refusal, expiry/cancel behavior, replay of consumed decisions, and at-most-once effects.

## MC.cfg (Fixed = TRUE, proposed relay)

184904 states generated, 38052 distinct states found. Every rule holds:
NoEffectWithoutApproval, ConsumedAtMostOnce, EffectAtMostOnce, WorkerRetryNotRejected,
OneTerminalPerRun, UncutRunsEndOnce, ErrorMeansNoEffect, SuccessShowsResult,
TruncatedNeverSuccess, MultiEffectAtMostOnce, MultiNoEffectWithoutApproval,
MultiNoResumeWhilePending, MultiConsumedDecisionReplays, MultiCancelPreventsEffect,
MultiPartialCoverageRejected, NoDeadlock.

## MC_current.cfg (Fixed = FALSE, relay on main 2026-11-21)

655 states generated, 260 distinct states found. Two existing counterexamples remain:

- WorkerRetryNotRejected: start run, worker asks for approval, you approve,
  worker sends the gated envelope, worker resends the same envelope (403 APPROVAL_REQUIRED).
  Replayed by sigil/relay/v1/accept-envelope.high-risk-retry.test.mjs.
- ErrorMeansNoEffect: start run, worker asks for approval, you approve, client resumes,
  worker sends the gated envelope, connection drops, client retries the resume (RUN_ERROR
  although the action ran).

<!-- TLC_EXPECTATIONS
{
  "MC_current.cfg": {
    "contains": "Error: Invariant WorkerRetryNotRejected is violated",
    "exit": "nonzero",
    "generatedStates": 655,
    "distinctStates": 260
  },
  "MC.cfg": {
    "contains": "Model checking completed. No error has been found",
    "exit": "zero",
    "generatedStates": 184904,
    "distinctStates": 38052
  }
}
-->
