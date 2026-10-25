---
name: verify-relay-job-leases
description: Use when a change touches the relay_jobs claim/lease/finalize protocol or the federation reaper (federation-reaper.mjs, claimDueRelayJobs, finalizeRelayJob, relay_jobs migrations, resend-worker). Runs an exhaustive two-reaper schedule check against the real code on real Postgres semantics.
---

# Verify relay job leases

## Property and harm

Property: two reaper passes sharing one `relay_jobs` table never double-finalize, resurrect, or lose a job, and each outcome is counted and audited once.

Harm if broken: a federated envelope or directory revocation is silently dropped, delivered with the wrong final state, or stuck in `processing` forever. Tests cover one reaper at a time. This check runs two.

## Run it

From the repo root:

```
npm --prefix packages/relay-jobs-verification ci
node packages/relay-jobs-verification/check.mjs                 # about 5 minutes, 539 schedules
node packages/relay-jobs-verification/check.mjs --scenario crash   # about 15 seconds
node packages/relay-jobs-verification/mutate.mjs                # break-it proof, restores files itself
```

Needs Node 22+. No Docker or Java: PGlite is real Postgres compiled to WASM. Pinned: `@electric-sql/pglite` 0.5.11.

Exit codes of `check.mjs`: `0` failures equal `known-findings.json`; `1` a property fails that is not a known finding; `2` a known finding stopped failing.

## What it checks

It runs the unmodified `runFederationReaperPass` and `PostgresRepository` on a PGlite database built from every file in `sigil/migrations/`. Reaper A and reaper B are parked at each transaction start and each peer POST, and the explorer tries every order of those steps (up to 3 preemptions), every peer outcome (2xx, 4xx, transport failure, and an unexpected throw in A), and a B clock inside and past the lease.

| Property | Plain meaning |
|---|---|
| `lease-respected` | a claim takes only due jobs or jobs whose lease expired |
| `finalize-owner-only` | a finalize lands only with the current claim token |
| `terminal-absorbing` | done / rejected / dead_letter never change again |
| `accounting-exact` | counters and `federation.*` audit rows equal the finalizes that landed |
| `no-stuck-processing` | no job stays `processing` after both passes finish cleanly |
| `abandoned-recoverable` | a clean pass after the lease expiry finishes everything |
| `send-owner-only` | a reaper POSTs only while it holds the lease (row skipped when the renewal fails) |

Scenarios: `one-job`, `one-job-last-attempt` (fourth failure dead-letters), `two-jobs` (A reaches row 2 after its lease expired), `crash` (A throws mid-batch).

## Fixed finding: duplicate send after lease expiry

The first run found that a slow pass POSTed rows another reaper had already reclaimed (the finalize was discarded, but the peer got the job twice). Fixed by `renewRelayJobLease` (`postgres-repository.mjs`, `memory-repository.mjs`): the reaper renews the lease with its claim token right before each send and skips the row when the renewal updates nothing (`renewLease` in `federation-reaper.mjs`). `known-findings.json` is empty. The mutation `send-without-lease-renewal` removes the guard and must be caught.

Model assumption: a POST ends within 5 s (`postDirectory`'s `AbortSignal.timeout`), far below the 300 s lease, so a renewed lease covers the send. `explore.mjs` clamps a rival's claim clock to the in-flight send's deadline (`SEND_TIMEOUT_MS`). If that timeout or the default lease changes, revisit the assumption.

Remaining at-least-once case: a send that outlives the lease, or a crash after the POST but before the finalize, still retries. Envelope duplicates are absorbed (`accept-federated-envelope.mjs:141` answers `202 duplicate: true`). Directory confirmation and revocation duplicates were not checked, and the scenarios only drive `envelope` rows.

## Covered code and sync commit

Last confirmed to describe the code at commit `e38da9e`. That commit is `16d3187` plus `renewRelayJobLease` and the two send skips. `git diff 16d3187 45c193f` is empty for `federation-reaper.mjs`, `postgres-repository.mjs`, and `sigil/migrations`. The checker at `e38da9e` explored 539 schedules and reported no failing properties.

- `sigil/relay/v1/federation-reaper.mjs`: `runFederationReaperPass`, `settleForward`, `dispatchDirectoryRow`
- `sigil/relay/v1/postgres-repository.mjs`: `claimDueRelayJobs`, `renewRelayJobLease`, `finalizeRelayJob`, `enqueueRelayJob`, `withTransaction`
- `sigil/migrations/017`, `021`, `022`, `023` and every later file (all are applied)
- `sigil/relay/v1/resend-worker.mjs` uses the same two repository methods but is NOT driven by this check

Before relying on the check, run `git diff e38da9e -- sigil/relay/v1/federation-reaper.mjs sigil/relay/v1/postgres-repository.mjs sigil/migrations`. Empty means the check still describes the code. A diff means read it against the table above, rerun, then move the commit above forward only after you confirm the check matches the new code.

## Reading a result

- Exit 1, new failure: read the `steps:` line. `A:txn` / `B:txn` is a database transaction starting, `A:post` a peer POST, `A.peer=0` the peer outcome chosen. If the story reads as a real interleaving of the code, it is a bug: report it, do not weaken the property. If it needs a step the code cannot take (a state the migrations forbid, a call the real code never makes), fix the harness in `explore.mjs`.
- Exit 2: a fix landed. Delete the finding from `known-findings.json`, rerun, and commit both.
- `mutate.mjs` prints `MISSED`: the check lost power for that property. Fix `explore.mjs` before trusting a pass. It prints `SKIPPED` when a source line it breaks was edited: update the anchor text in `mutate.mjs`.

## Updating after an intended change

New job state, new finalize path, or new claim condition: add the state to `TERMINAL` or the expected-state logic in `explore.mjs`, add a scenario to `SCENARIOS`, add one mutation to `mutate.mjs` that the new logic must catch, and run all three commands.

## Not covered

Row-level locking across real connections (`FOR UPDATE SKIP LOCKED` is accepted by PGlite, which has one session, so concurrent claims are serialised); more than two reapers; the `resend` job type; clock skew between reapers other than the two offsets; the HTTP layer; the receiving relay.
