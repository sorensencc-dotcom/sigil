# Resume note: repo-wide audit transaction atomicity

Plan: `docs/superpowers/plans/2026-09-21-repo-wide-audit-transaction-atomicity.md`

## Status (2026-09-22)

Tasks 1-6 and Task 11 done and committed on `main`. Nothing pushed (no remote
push performed this whole effort — verify with `git log origin/main..main`
once a remote exists, or just note HEAD is ahead of last known push point).

Commits so far (chronological): Task 1-4 commits (see `git log --oneline` for
`createOidcIdentityWithAudit`, `linkAccountWithAudit`,
`issueEndpointTokenWithAudit`, `createDirectoryInviteWithAudit`), then:
- `b502e6b` Task 5: `redeemDirectoryInviteWithAudit`
- `d264c3d` Task 6: `createDirectoryMatchRequestWithAudit`
- `8f3691c` Task 11: `accept-federated-envelope.mjs` audit-in-transaction fix (done by codex-exec, verified correct)

## Deviation from original instruction

User originally asked to have `codex exec` execute this plan (with Claude
reviewing after). Codex-exec proved unreliable twice: first run hit repeated
"code-mode host exited during handshake" errors and made zero commits;
second run burned its budget grepping its own unrelated cross-session memory
file, then skipped 9 of 10 assigned tasks with vague non-technical
justifications, completing only Task 11 (which was verified correct). Given
that, Tasks 1-6 were executed directly by Claude instead, following the
plan's literal TDD steps. Flag this to the user if not already acknowledged.

## Remaining work: Tasks 7-10

Same TDD pattern every time (see any completed task, e.g. Task 5 or 6, as a
template):
1. Read the task section from the plan file (`Read` tool with explicit
   offset/limit — raw `sed`/`cat` reads of this repo have shown transcript-level
   dedup corruption on repeated-looking text; `Read` tool avoids it).
2. Append the exact test block to `sigil/relay/v1/identity-auth-audit-atomicity.test.mjs`.
3. Run it: `timeout 60 node --test sigil/relay/v1/identity-auth-audit-atomicity.test.mjs` — expect SKIP (no `SIGIL_TEST_DATABASE_URL` locally) or a `TypeError: ... is not a function` if run before SKIP-gating kicks in. Never expect PASS locally.
4. Add the exact `*WithAudit` method to `sigil/relay/v1/postgres-repository.mjs`, inserted right before `async recordAuditEvent(` (i.e. after the most-recently-added `*WithAudit` method).
5. Swap the call site in `sigil/relay/v1/http-server.mjs` per the plan's before/after blocks (existence guard widened to `!repository?.x && !repository?.xWithAudit`, call site wrapped in the `repository.xWithAudit ? ... : await (async () => {...})();` ternary).
6. Rerun the atomicity test file (expect SKIP, count goes up by 1).
7. Run the plan-specified regression suite(s) for that task (expect PASS, same baseline as before — currently 49 pass / 1 skip / 0 fail on the directory/http suites).
8. Commit with the exact task's commit message + trailing `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` line.

Tasks still open, with plan line numbers to jump straight to:
- **Task 7** (plan line 797): `nominateDirectoryLinkEndpointWithAudit`. Call site: `http-server.mjs` `POST /v1/directory/matches/:id/nominate` (currently ~line 837-838 after Task 6's edits — re-grep, line numbers shift). Regression suite: `sigil/relay/v1/http-server.test.mjs sigil/relay/v1/postgres-repository.directory-match.test.mjs`.
- **Task 8** (plan line 943): `confirmDirectoryLinkWithAudit`. Call site: `POST /v1/directory/links/:id/confirm`. Note the plan's Interfaces block: emits `directory_link.activated` vs `directory_link.confirmed` conditionally, and **no** audit row on the early no-op "nothing changed" returns — read this task's full step-by-step before implementing, it's not a straight copy of the Task 5-7 shape.
- **Task 9** (plan line ~1083): `revokeDirectoryLinkWithAudit`.
- **Task 10** (plan line ~1206): `upsertPeerWithAudit` + `removePeerWithAudit` — TWO methods in one task. Call sites are in `sigil.mjs`/`peer-discovery.mjs`, NOT `http-server.mjs`, and use an `if (repository.xWithAudit) { ... } else { ... }` shape instead of the ternary used everywhere else — re-read the plan's Architecture section for why before applying the Task 1-9 ternary pattern by habit.

After Task 10 lands, all 11 tasks are done. Final wrap-up for that session:
report full `git log` of every commit made across this whole effort, confirm
no push occurred, and reiterate the codex-exec deviation note above.

## Environment reminders for the next session

- Every test/regression command wrapped in `timeout 60` per repo convention.
- `SIGIL_TEST_DATABASE_URL` unset locally — atomicity tests always SKIP here, that's expected, not a failure.
- Work only inside `C:\dev\sigil-repo` (mandatory repo-context preflight applies; this repo has already been the working directory all along, no need to re-verify unless switching repos).
- Do not push to any remote.
