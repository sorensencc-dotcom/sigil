# Expected TLC results

Run with the statechart skill (TLC, one worker), `MaxRuns = 3`.

## MC.cfg (Fixed = TRUE, proposed relay)

68 states generated, 36 distinct states found. Every rule holds:
NoEffectWithoutApproval, ConsumedAtMostOnce, EffectAtMostOnce, WorkerRetryNotRejected,
OneTerminalPerRun, UncutRunsEndOnce, ErrorMeansNoEffect, SuccessShowsResult,
TruncatedNeverSuccess, NoDeadlock.

## MC_current.cfg (Fixed = FALSE, relay on main 2026-11-21)

18 states generated, 12 distinct states found. Two rules break:

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
    "generatedStates": 18,
    "distinctStates": 12
  },
  "MC.cfg": {
    "contains": "Model checking completed. No error has been found",
    "exit": "zero",
    "generatedStates": 68,
    "distinctStates": 36
  }
}
-->
