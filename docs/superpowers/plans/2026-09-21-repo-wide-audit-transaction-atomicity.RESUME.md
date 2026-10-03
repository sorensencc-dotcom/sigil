# Resume note: repo-wide audit transaction atomicity

Plan: `docs/superpowers/plans/2026-09-21-repo-wide-audit-transaction-atomicity.md`

## Status (2026-09-24): ALL 11 TASKS DONE

Tasks 1-11 all done and committed on `main` (Tasks 7-10 landed after this
note was originally written on 2026-09-22 — this update reconciles that).
Nothing pushed (no remote push performed this whole effort — verify with
`git log origin/main..main` once a remote exists, or just note HEAD is
ahead of last known push point).

Verified 2026-09-24: `identity-auth-audit-atomicity.test.mjs` (14 SKIP,
expected — no `SIGIL_TEST_DATABASE_URL` locally), `postgres-repository.peer.test.mjs`
(8 SKIP, expected), `http-server.test.mjs` + `postgres-repository.directory-match.test.mjs`
(49 pass / 1 skip / 0 fail — matches the baseline this note originally cited),
`peer-discovery.test.mjs` + `sigil-peer.test.mjs` + `memory-repository.peer.test.mjs`
(54/54 pass — Task 10's plan-specified `sigil.test.mjs` doesn't exist under
that name; used the real CLI peer test files instead).

Commits so far (chronological): Task 1-4 commits (see `git log --oneline` for
`createOidcIdentityWithAudit`, `linkAccountWithAudit`,
`issueEndpointTokenWithAudit`, `createDirectoryInviteWithAudit`), then:
- `b502e6b` Task 5: `redeemDirectoryInviteWithAudit`
- `d264c3d` Task 6: `createDirectoryMatchRequestWithAudit`
- `8f3691c` Task 11: `accept-federated-envelope.mjs` audit-in-transaction fix (done by codex-exec, verified correct)
- `b73e9c0` Task 7: `nominateDirectoryLinkEndpointWithAudit`
- `abec3cf` Task 8: `confirmDirectoryLinkWithAudit`
- `c3881c3` Task 9: `revokeDirectoryLinkWithAudit`
- `a2ac542` Task 10: `upsertPeerWithAudit` + `removePeerWithAudit`

## Deviation from original instruction

User originally asked to have `codex exec` execute this plan (with Claude
reviewing after). Codex-exec proved unreliable twice: first run hit repeated
"code-mode host exited during handshake" errors and made zero commits;
second run burned its budget grepping its own unrelated cross-session memory
file, then skipped 9 of 10 assigned tasks with vague non-technical
justifications, completing only Task 11 (which was verified correct). Given
that, Tasks 1-6 were executed directly by Claude instead, following the
plan's literal TDD steps. Flag this to the user if not already acknowledged.

## Remaining work: none

Tasks 1-11 are all done, committed, and verified (see test run above). No
plan-file line numbers left to work from.

## Final wrap-up (per original instruction, now that Task 10 has landed)

Full `git log` of the whole effort (chronological, oldest first) — run
`git log --oneline --reverse <first-task-commit>..a2ac542` to reproduce.
No push has occurred to any remote across this whole effort — confirm with
`git log origin/main..main` once a remote exists, or `git status -sb`
locally (shows `## main...origin/main`, no ahead/behind count published
here since remote wasn't queried as part of this update).

Reiterating the codex-exec deviation note above: `codex exec` was abandoned
after two unreliable runs (handshake failures, then budget burned on
unrelated memory-file greps with only Task 11 completed). Tasks 1-10 were
executed directly by Claude following the plan's literal TDD steps instead.

## Environment reminders for the next session

- Every test/regression command wrapped in `timeout 60` per repo convention.
- `SIGIL_TEST_DATABASE_URL` unset locally — atomicity tests always SKIP here, that's expected, not a failure.
- Work only inside `C:\dev\sigil-repo` (mandatory repo-context preflight applies; this repo has already been the working directory all along, no need to re-verify unless switching repos).
- Do not push to any remote.
