# Sigil rooms phase 5 (more bridges and Ironbots report posting) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person @mention a GitHub Copilot, xAI Grok CLI, or Hermes agent in a room and get a signed answer in the thread, as Claude and Codex answer today. Copilot ships unconditionally. Grok and Hermes ship only if Task 1 verifies their safety conditions (Grok: Stop cancels the actual model turn; Hermes: a read-only toolset allowlist). Let the Ironbots fleet post its run reports into a room as signed `room.message` rows from its own `report_only` endpoint, with retries that resend one durable signed envelope. Ship an Antigravity bridge only if the Task 1 spike finds a headless mode.

**Architecture:** Task 1 is a verification spike that settles the unknown CLI behavior, records the Grok and Hermes go or no-go decisions, and records the relay code the later tasks touch. Tasks 2-4 add the CLI registry, the shared conformance suite, and replay and lost-session recovery (a changed session id replaces the whole session record). Tasks 5-8 add the Copilot bridge and, each as a bridge or a written deferral, the Grok CLI, Hermes and Antigravity bridges. Tasks 9-10 add the `report_only` response mode: data and routes first, then the relay post path with a per-room rate cap taken under the room lock. Tasks 11-12 add the report formatter, post policy and durable pending envelope, and the `sigil room report` CLI. Task 13 adds the web client rendering. Task 14 adds the exit test and the opt-in live smoke. Task 15 closes docs and gated final verification: the phase stays open until the PostgreSQL suites have run with zero skips.

**Tech Stack:** Node `.mjs` with `node:test`, `pg`, Postgres 15, `ws`. TypeScript, React 19 and Vitest in `packages/sigil-rooms-web` (Task 13 only).

**Spec:** `docs/superpowers/specs/2026-10-16-sigil-rooms-phase-5-more-bridges-design.md` (read it first; this plan cites it as "spec"). Parent: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md`.

## Global Constraints

- Branch off `main` in a worktree. Never touch the main checkout at `C:\dev\sigil-repo` (no branch switch, stash, reset or checkout over its uncommitted work). No push and no PR unless asked.
- Paths below are relative to `sigil/` unless they start with `packages/` or `docs/`, or name `README.md` or `STATUS.md`, which sit at the repo root. Relay code is `relay/v1/`, bridges are `bridges/v1/`.
- Never read, print, copy or commit anything in `.sigil/*.json`. Tests build identities, session files and state files in a temp directory.
- Tests use fixture endpoint ids (`ep_test_...`). Never create `ep_ironbots` or any real endpoint, never add one to a real room, never run against a real database or a real relay. Endpoint setup is an operator step outside this plan.
- Nothing in the real CLIs (Copilot, Grok CLI, Hermes) or in Postgres was run when this plan was written. Every CLI fact in this plan is something Task 1 must verify, and the later tasks read the Task 1 notes instead of trusting the plan.
- Test commands: there is no `sigil/package.json`. Run `npm test` and `npm run test:live` from the repository root; `cd sigil && npm test` does not work. Unit tests: `timeout 60 node --test <file>`. **Run one `node --test` process at a time.** Overlapping runs deadlock the shared pg.
- Postgres tests are `*.pg.test.mjs`, read `SIGIL_TEST_DATABASE_URL`, skip without it, call `assertDisposableTestDatabase`, and run `applyMigrations(url, { reset: true })`. A skipped pg test is not evidence. **Pg suites must run, not skip, before the phase can be called done.** Tasks 9, 10, 11 and 15 require `skipped 0` with the variable set.
- `npm run test:live` (root) runs `sigil/scripts/live-db-tests.mjs`. It exits 1 if `SIGIL_TEST_DATABASE_URL` is unset, asserts that the database name ends in `_test`, discovers every test file that references `process.env.SIGIL_TEST_DATABASE_URL`, runs them strictly one process at a time with a 120 s per-suite timeout, and prints totals including `skipped`.
- A disposable database comes from a local Postgres install or a docker `postgres:15` container with a database named `sigil_test`. Never point the variable at the dev relay database or any real one.
- Every command that can hang runs under a hard timeout (`timeout --kill-after=30 <seconds> ...`). On Windows, if the timeout fires, the process tree may need `taskkill /T /F`.
- Real CLI runs happen only in Task 1 (short read-only prompts per CLI, in a temp directory, with the allowlisted environment from `agentEnv`) and in the opt-in live smoke script (Task 14). `npm test` never launches a real CLI.
- No CLI is ever launched with an approve-all, yolo, always-approve or bypass flag, in code, in tests, or in the spike. Forbidden: Copilot `--allow-all`, `--yolo`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`; Grok `--always-approve` and `--permission-mode bypassPermissions`; Hermes `--yolo`. Tests assert these are absent from argv.
- Secrets arrive through environment variable names (`--...-env`), never argv. No test, log line, error message or fixture may contain a token, an account id, or a path that includes the user name.
- Never commit unscrubbed CLI output. Task 1 strips user-name paths, tokens and account ids before any fixture is written.
- Migration number: the spec proposes `035_report_only_mode.sql` (highest on `main` at spec time is `034_oauth_login.sql`). Phase 6 also proposes 035. Re-check with `ls sigil/migrations | tail -3` at execution and renumber if `main` moved.
- Relay error bodies are `{request_id, code, message, details?}`. Use the `fail()` helper pattern from `room-routes.mjs`.
- Both repositories (`relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs`) get every new method.
- New bridge endpoints are created `mentions_only` with `invokable_by` owner. That is operator setup, not a task here.
- Phase 6 overlap: the session-store file format stays shared and unchanged; the Floor Warden `catch_up` watermark is per bot and not tied to a CLI session, so the session replacement rule does not touch it. Phase 6 Grok bots are Floor Warden, not this CLI, so a Grok deferral does not affect phase 6. The durable report envelope has no phase 6 overlap (Floor Warden signs with relay-held keys). The existing room-bridge reply path has the same in-memory outbox but fails the invocation instead of retrying, so it is out of scope here.
- Every commit message ends with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Use `test(sigil):` for test-only commits, `feat(sigil):` otherwise, `docs:` for docs.
- Files are LF. Before using an edit tool on a file, run `file <path>`; if it reports CRLF, edit with a script that preserves line endings.
- Docs follow the repo's technical-writing rules: sentence case headings, no first-person plural, active voice.

---

## File structure

Bridges and CLI (`sigil/`):

- Create `bridges/v1/cli-registry.mjs` (+ test), `bridges/v1/cli-conformance.test.mjs`, `bridges/v1/copilot-cli.mjs` (+ test), `bridges/v1/ironbot-report.mjs` (+ test), `bridges/v1/rooms-bridges-exit.test.mjs`, `bridges/v1/fixtures/` captured output files (scrubbed).
- Create (only if Task 1 says go for Grok) `bridges/v1/grok-cli.mjs` (+ test). Create (only if Task 1 says go for Hermes) `bridges/v1/hermes-cli.mjs` (+ test). Create (only if Task 1 says go for Antigravity) `bridges/v1/antigravity-cli.mjs` (+ test).
- Create `cli/room-report-command.mjs` (+ test).
- Modify `bridges/v1/cli-runner.mjs` (`agentEnv`), `bridges/v1/claude-cli.mjs` and `bridges/v1/codex-cli.mjs` (`capabilities`), `bridges/v1/room-bridge.mjs` (+ `room-bridge.test.mjs`), `bridges/v1/fixtures/fake-agent-cli.mjs` (Task 3 modes; Task 6 `leader` mode), `relay/v1/transport-tincan/wake-dispatcher.mjs`, `cli/sigil.mjs`, `scripts/live-room-bridges.mjs`.

Relay (`sigil/`):

- Create `migrations/035_report_only_mode.sql` and `migrations/035_report_only_mode.test.mjs`.
- Create `relay/v1/room-report-only.pg.test.mjs`, `relay/v1/room-routes.report-only.test.mjs`, `relay/v1/room-dispatch.report-only.test.mjs`, `cli/memory-repository.report-only.test.mjs`.
- Modify `relay/v1/room-routes.mjs`, `relay/v1/room-dispatch.mjs`, `relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs` (`countRecentReports`, `lockRoom`), `contracts/v1/relay-api.json` (+ its test, only if Task 1 notes show the contract lists response modes).

Web (`packages/sigil-rooms-web/src/`): modify `rooms/RosterPanel.tsx`, `api/types.ts`; spec beside them.

Docs: create `docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md`; modify `README.md`, `STATUS.md`, and the design's Deferred table only in a deferral branch (Grok, Hermes or Antigravity).

## Interfaces fixed up front

```js
// bridges/v1/cli-registry.mjs
export const CLI_KINDS;                         // frozen array: 'claude','codex','copilot' (+ 'grok' only if Task 6 Branch A, 'hermes' only if Task 7 Branch A, 'antigravity' only if Task 8 Branch A)
export function createCli(kind, options);       // -> CLI object; throws UNKNOWN_BRIDGE_KIND for any other kind
export function isCliKind(kind);                // -> boolean
export function envPrefixesFor(kind);           // -> string[] extra allowlisted env prefixes (never GITHUB_TOKEN / GH_TOKEN by default)

// bridges/v1/cli-runner.mjs
agentEnv(source, { extraPrefixes = [] } = {});  // allowlist as today plus per-CLI prefixes

// CLI object (all kinds)
{ name, capabilities: { resume: boolean }, run({ prompt, sessionId, signal }) } // -> { text, sessionId }
// errors: CLI_INVALID_OUTPUT, CLI_INVALID_SESSION, CLI_SESSION_LOST (new, thrown by a CLI when a resumed session no longer exists)

// bridges/v1/hermes-cli.mjs (only if Task 7 Branch A)
export const HERMES_READONLY_TOOLSETS;          // frozen array; holds only toolsets Task 1 verified read-only (listing + canary probe)
export function parseHermesToolsets(value);     // comma separated, trimmed -> string[]; empty list -> HERMES_TOOLSETS_REQUIRED;
                                                // empty entry, failed name pattern, or name not in the constant -> HERMES_TOOLSET_NOT_ALLOWED naming the entry
createHermesCli({ toolsets, ... });             // validates through parseHermesToolsets; sigil.mjs flag parse validates too; both run BEFORE any spawn
// no wildcard, no 'all', no default toolset

// bridges/v1/fixtures/fake-agent-cli.mjs (new mode, Task 6 Branch A)
// leader:  fake client + fake leader; the leader keeps advancing a turn marker after the client dies until the bridge issues the verified cancel path

// bridges/v1/room-bridge.mjs
// replay mode:  cli.capabilities.resume === false -> ignore watermark, prompt carries the last threadContextLimit (20) thread messages, no session stored
// recovery:     CLI_SESSION_LOST on a resumed run -> retry once with sessionId null + replay window
// session record rule: when the stored session id changes (lost-session recovery, or result.sessionId differs from the resumed id for any reason)
//               REPLACE the record: { session_id: new, last_seq_by_thread: { [currentThread]: context.lastSeq } }, dropping every other thread cursor.
//               Unchanged session id keeps today's merge. The session-store file format does not change.

// bridges/v1/ironbot-report.mjs
sanitizeField(value, max);                                          // -> ASCII string, control and bidi stripped, clamped
buildReportText({ bot, status, timestamp, summary, alerts });       // -> string, at most 4000 chars
buildFleetReport(reportJson);                                       // -> { bot:'fleet', status, timestamp, summary, alerts } from structured fields only
createReportState({ statePath, now });                              // -> { loadPending(bot), savePending(bot, pending), clearPending(bot), lastPosted(bot), recordPosted(bot, { status, at }) }
                                                                    //    atomic temp-file-then-rename writes; per bot: last posted status and time, plus at most one
                                                                    //    pending = { idempotency_key, report: { status, summary, timestamp }, envelope (full signed), created_at }
createReportPolicy({ state, now });                                 // -> { shouldPost(report) -> boolean, record(report) }
reportIdempotencyKey(bot, timestamp);                               // -> `ironbots_<bot>_<timestamp>`
postReport({ identity, relay, outbox, roomId, report, policy, state, now, log }); // -> { posted: boolean, reason: 'accepted'|'duplicate'|'policy'|'transient'|'expired'|'refused' }
                                                                    //    persists the signed envelope BEFORE sending; a retry resends the stored envelope byte for byte and never calls outbox.queue

// cli/room-report-command.mjs
runRoomReport(argv, { env, stdout, stderr, fetchImpl, now });       // -> exit code; flags per spec plus --report-at <iso>
                                                                    //    exit 0 posted or skipped by policy, 1 usage, 2 relay refusal or expired unconfirmed, 3 transient failure with pending kept

// report_only relay rule (relay/v1/room-dispatch.mjs, both repositories)
// assertAgentMayPost: a report_only sender may post a top-level room.message with empty mentions, no thread_root_id, text <= 4000
// repository.countRecentReports({ conversationId, sinceMs, now }) -> number   (both implementations; counts accepted room.message rows in the room
//                                                                              sent by ANY report_only member, so the cap is per room across all reporters)
// repository.lockRoom(client, conversationId)  // Postgres: SELECT 1 FROM rooms WHERE conversation_id = $1 FOR UPDATE (exists); memory repository gets an equivalent
// the rate check runs inside the accept transaction AFTER lockRoom and AFTER the idempotency lookup; count and insert happen under that one lock
// over the cap (30 per room per rolling hour) -> 429 REPORT_RATE_LIMITED
// a report never calls dispatch, never refills the hop budget, never reaches the router
```

---

### Task 1: Verification spike

**Files:**
- Create: `docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md`
- Create: scrubbed fixture files under `bridges/v1/fixtures/` (names chosen in step 6)

**Interfaces:** Produces the decision matrix (including the Hermes and Grok go or no-go decisions) and fixtures that Tasks 5-8 depend on, and the file and line references that Tasks 2, 4, 9, 10, 11, 12 and 13 depend on.

- [ ] **Step 1: Record versions and set up a temp directory**

```bash
copilot --version; grok --version; hermes --version
SPIKE="$(mktemp -d)" && echo "$SPIKE"
```

Record the three versions in the notes (spec assumption 7). Run every real prompt below from that temp directory. Build the child environment with a one-line node script that prints `agentEnv(process.env)` as `KEY=value` lines, and start each CLI with `env -i` plus those lines. Never run a CLI with an approve-all, yolo, always-approve or bypass flag. Nothing here has been run before this task; record every observation as observed, and mark anything not observed as unverified.

- [ ] **Step 2: Run one short read-only prompt per CLI and capture raw output to the temp directory only**

Prompt text: "Reply with the single word ok." Capture stdout and stderr for: Copilot `-p ... -s --output-format json` with a read-only tool set; Grok `--prompt-file` (and stdin if accepted) with `--output-format json` and `--permission-mode default`; Hermes `-z ... -t <toolset>` (skip Hermes in this step; run its ok-prompt after step 4 clears a toolset, with that toolset only). Test whether Copilot and Hermes accept the prompt on stdin (assumption 2). Do not copy raw output into the repo yet.

- [ ] **Step 3: Test resume, missing-session errors and auth**

For each CLI: run once to obtain a session id (Copilot `--session-id=<uuid>`, Grok `--session-id <uuid>`, Hermes: record whether any id is reported, assumption 3); resume it with a second short prompt; resume a made-up id and record the exact error text and exit code (this becomes the `CLI_SESSION_LOST` signal). Record the auth source for each CLI with the allowlisted environment (assumption 6). Record what `--safe-mode`, `--ignore-user-config` and `--ignore-rules` do.

- [ ] **Step 4: Verify the Hermes toolset allowlist and the Grok cancel of the actual turn**

Hermes (decides Task 7). Read `hermes --help` and its toolset listing, and write down the tools each toolset contains. Record whether oneshot (`-z`) bypasses approvals, since then the toolset is the only gate. For each candidate toolset, run a canary probe in the temp directory with `-t <candidate>`: ask the CLI to create a file named `canary.txt` and to run a harmless command; confirm no file exists afterwards and the CLI reports the tool as unavailable. Confirm that `-t` actually restricts oneshot runs. Never run an unrestricted probe. Record the toolsets that pass listing and canary as the `HERMES_READONLY_TOOLSETS` candidates. Record **Hermes go** only if at least one toolset is verified read-only and `-t` restricts oneshot runs; otherwise **Hermes no-go** (Task 7 Branch B).

Grok (decides Task 6; spec assumption 4 stays unverified until this step). Start a read-only turn long enough to interrupt, in the temp directory. Kill the client, including its leader process as the notes require. Observe after the kill: the session transcript or leader activity must stop advancing for a defined quiet period (write the period down) and no assistant answer may complete later. Look in `grok --help` for an explicit cancel or stop command; if one exists, call it and repeat the same observation. Record **Grok go** only if (a) killing the client ends the leader-owned turn, or (b) an explicit cancel command ends it, each shown by that observation. Killing a fake client process is not evidence. Otherwise record **Grok no-go** (Task 6 Branch B).

- [ ] **Step 5: Antigravity spike**

```bash
command -v agy antigravity || echo "none on PATH"
```

Read the help of `antigravity-ide` (read-only, no prompt). Look for a headless prompt mode, a resume mode and a tool allowlist. Record a go or no-go with the evidence (assumption 5).

- [ ] **Step 6: Scrub and write fixtures**

Strip paths containing the user name, tokens, and account ids from every captured output. Never commit unscrubbed output. Write scrubbed fixtures under `bridges/v1/fixtures/` (one per shipped-candidate CLI for a successful run, one per CLI for a missing-session error), each with a header line recording the CLI version. Run `grep -rniE "soren|token|bearer|account" sigil/bridges/v1/fixtures/` and confirm no secret or user-name hit remains.

- [ ] **Step 7: Read the relay code the later tasks touch and record file and line references**

```bash
grep -n "RESPONSE_MODES\|assertAgentMayPost\|response-mode\|members" sigil/relay/v1/room-routes.mjs sigil/relay/v1/room-dispatch.mjs
grep -n "setRoomMemberResponseMode\|addRoomMember\|response_mode" sigil/cli/memory-repository.mjs sigil/relay/v1/postgres-repository.mjs
grep -n "lockRoom\|assignRoomSequence\|idempotency\|DUPLICATE_MESSAGE\|REPLAY_DETECTED" sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/room-routes.mjs sigil/relay/v1/room-dispatch.mjs
grep -n "queue(\|expires_at" sigil/connectors/v1/local-outbox.mjs
grep -n "outcome\|ack" sigil/cli/agent-daemon.mjs
grep -n "response_mode\|response-mode" sigil/contracts/v1/relay-api.json
grep -rn "\.sigil" sigil/bridges/v1/*.mjs sigil/cli/sigil.mjs | grep -v test
```

Record: the member-add and set-response-mode handlers; every `assertAgentMayPost` caller; the repository room methods in both repositories; **whether `assertAgentMayPost` already runs inside the accept transaction under the room lock (`lockRoom`, the same `FOR UPDATE` row lock `assignRoomSequence` takes), and where the idempotency lookup sits relative to it** (Task 10 needs both); that `queue()` signs the envelope it is given, so the poster sets `created_at` and `expires_at` itself (Task 11); the daemon ack rule for the outcome strings; whether the contract file lists response modes (decides Task 12 step 6); whether the poster path would write under `.sigil` (it must write only the state file path it is given).

- [ ] **Step 8: Write the notes file**

Sections: versions, decision matrix (rows: headless mode, prompt via stdin or argv, JSON shape, session id, resume, missing-session error, kill behavior including the grok leader process and the quiet period observed, Grok cancel path, Grok go/no-go, auth source, Hermes toolset contents and canary results, `HERMES_READONLY_TOOLSETS` candidates, Hermes go/no-go, Antigravity go/no-go; one column per CLI), relay code references (including the room-lock and idempotency-order findings), and a list of assumptions confirmed or changed. State which later task each finding feeds.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md sigil/bridges/v1/fixtures/
git commit -m "docs: record phase 5 CLI verification notes and scrubbed fixtures

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: CLI registry and per-CLI environment policy

**Files:**
- Create: `bridges/v1/cli-registry.mjs`, `bridges/v1/cli-registry.test.mjs`
- Modify: `bridges/v1/cli-runner.mjs` (`agentEnv`), `cli/sigil.mjs` (the `bridgeKind` ternary), `relay/v1/transport-tincan/wake-dispatcher.mjs` (`BRIDGES`)

**Interfaces:** Produces `CLI_KINDS`, `createCli`, `isCliKind`, `envPrefixesFor`, and `agentEnv(source, { extraPrefixes })`.

- [ ] **Step 1: Read the three call sites**

Read `agentEnv` in `cli-runner.mjs`, the ternary near `--room-bridge` in `cli/sigil.mjs`, and `BRIDGES` in `wake-dispatcher.mjs`. Note the line numbers in the notes file.

- [ ] **Step 2: Write failing tests**

In `cli-registry.test.mjs`: `CLI_KINDS` contains `claude`, `codex`; `createCli('claude', {})` and `createCli('codex', {})` return objects named accordingly; `createCli('nope', {})` throws `UNKNOWN_BRIDGE_KIND`; `BRIDGES` from `wake-dispatcher.mjs` equals `new Set([...CLI_KINDS, 'router'])`; the `sigil.mjs` kind check accepts every registry kind and rejects an unknown kind (use the exported validator, or spawn `sigil agent run --room-bridge nope` against a temp identity and assert a non-zero exit with the error text). Add an `agentEnv` case: with `extraPrefixes: ['CLAUDE_']` a `CLAUDE_X` variable passes, `GITHUB_TOKEN` and `SIGIL_RELAY_TOKEN` never pass.

- [ ] **Step 3: Run it to confirm failure**

Run: `timeout 60 node --test sigil/bridges/v1/cli-registry.test.mjs`
Expected: FAIL (module `cli-registry.mjs` not found).

- [ ] **Step 4: Implement**

Create the registry for claude and codex. Extend `agentEnv` with `extraPrefixes`, keeping today's prefixes `ANTHROPIC_`, `CLAUDE_`, `CODEX_`, `OPENAI_` as the claude and codex entries. Replace the ternary in `sigil.mjs` with `createCli(bridgeKind, cliOptions)` and gate the flag on `isCliKind(bridgeKind) || bridgeKind === 'router'`. Build `BRIDGES` in `wake-dispatcher.mjs` from `CLI_KINDS` plus `router`.

- [ ] **Step 5: Run to confirm pass, plus the existing wiring tests**

Run, one at a time: `timeout 60 node --test sigil/bridges/v1/cli-registry.test.mjs`, then `timeout 60 node --test sigil/bridges/v1/cli-runner.test.mjs`, then `timeout 60 node --test sigil/bridges/v1/agent-cli.test.mjs`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/bridges/v1/cli-registry.mjs sigil/bridges/v1/cli-registry.test.mjs sigil/bridges/v1/cli-runner.mjs sigil/cli/sigil.mjs sigil/relay/v1/transport-tincan/wake-dispatcher.mjs
git commit -m "feat(sigil): add a shared CLI registry used by sigil.mjs and the wake dispatcher

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Shared conformance suite

**Files:**
- Create: `bridges/v1/cli-conformance.test.mjs`
- Modify: `bridges/v1/fixtures/fake-agent-cli.mjs` only if it lacks a mode the table needs (read it first; add modes, do not change existing ones)

**Interfaces:** Produces a table of `{kind, makeCli(command), goodOutput, badOutput}` rows that Tasks 5-8 extend with one entry each.

- [ ] **Step 1: Read `fixtures/fake-agent-cli.mjs` and `agent-cli.test.mjs`**

Record which modes the fake supports (output, sleep, exit code, argv echo, env echo, child process spawn). Note any missing mode in the notes file.

- [ ] **Step 2: Write the table-driven suite for claude and codex**

For each row assert: forbidden flags absent from argv (claude: no `--dangerously-skip-permissions`; codex: no `--dangerously-bypass-approvals-and-sandbox`, no `danger-full-access`); the child environment contains an allowlisted variable and never `SIGIL_RELAY_TOKEN` or an unrelated secret-looking key; unreadable output throws `CLI_INVALID_OUTPUT`; an invalid session id throws `CLI_INVALID_SESSION`; aborting the signal kills the process tree (the fake spawns a grandchild; assert it is gone); a short `timeoutMs` kills the tree and throws `CLI_TIMEOUT`; a `.cmd` path throws `CLI_START_FAILED` (spec assumption 9).

- [ ] **Step 3: Run it to confirm the state**

Run: `timeout 60 node --test sigil/bridges/v1/cli-conformance.test.mjs`
Expected: FAIL only where the fake lacks a mode or a CLI object lacks `capabilities`; list each failure in the commit body.

- [ ] **Step 4: Fix test-side gaps only**

Add the missing fake modes. Do not change production CLI code in this task. If a claude or codex assertion fails on production behavior, record it in the notes and stop; report instead of patching.

- [ ] **Step 5: Run to confirm pass**

Run: `timeout 60 node --test sigil/bridges/v1/cli-conformance.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/bridges/v1/cli-conformance.test.mjs sigil/bridges/v1/fixtures/fake-agent-cli.mjs
git commit -m "test(sigil): add a table-driven CLI conformance suite for claude and codex

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Resume capability, replay mode and lost-session recovery

**Files:**
- Modify: `bridges/v1/room-bridge.mjs`, `bridges/v1/claude-cli.mjs`, `bridges/v1/codex-cli.mjs`
- Test: `bridges/v1/room-bridge.test.mjs`

**Interfaces:** Produces `capabilities: { resume }` on every CLI object, `CLI_SESSION_LOST`, and the session record replacement rule. Does not change the session-store format.

- [ ] **Step 1: Read `room-bridge.mjs` and `session-store.mjs`**

Record where `sessions.get`/`sessions.set` and the watermark are used, and where the prompt window is built. Note line numbers. Confirm the store keeps ONE entry per room, `{session_id, last_seq_by_thread}`, and that `room-bridge.mjs` writes `{session_id: result.sessionId, last_seq_by_thread: {...previous, [threadRootId]: context.lastSeq}}`. One CLI session serves every thread of the room, so a cursor in any thread claims that the CLI session saw those messages. A new session has seen none of them.

- [ ] **Step 2: Write failing tests in `room-bridge.test.mjs`**

Replay mode: a fake CLI with `capabilities.resume = false` receives a prompt containing the last 20 thread messages every turn even when the stored watermark is newer, and `sessions.set` is never called with a session id. Resume mode: `capabilities.resume = true` keeps today's watermark behavior. Recovery: a fake CLI throws `CLI_SESSION_LOST` on a resumed run and succeeds on the retry; assert exactly two `run` calls, the second with `sessionId` null and the replay window, and the new session id stored. A second `CLI_SESSION_LOST` fails the invocation through `relay.failRoomInvocation`.

Session replacement: (1) visit thread A and thread B on session S1 so both cursors are stored; then thread A gets `CLI_SESSION_LOST` and the retry creates S2; assert the stored record is exactly `{session_id: 'S2', last_seq_by_thread: {A: <A's lastSeq>}}` with no cursor for B; then invoke in thread B and assert its prompt contains B's earlier messages (cursor 0, up to the 20-message window) and that exactly one run was made, with `sessionId` S2. (2) A resumed run whose `result.sessionId` differs from the resumed id, with no error, replaces the record the same way. (3) Unchanged-session case: the result keeps the resumed session id, and the other thread's cursor stays in the record.

- [ ] **Step 3: Run it to confirm failure**

Run: `timeout 60 node --test sigil/bridges/v1/room-bridge.test.mjs`
Expected: FAIL on the new cases (no `capabilities` handling, no retry, cursors merged across a session change).

- [ ] **Step 4: Implement**

Add `capabilities: { resume: true }` to the claude and codex CLI objects. In `room-bridge.mjs` branch on `cli.capabilities?.resume === false` for replay, and wrap the run in a single retry on `CLI_SESSION_LOST`. When the session id to store differs from the stored one (recovery, or `result.sessionId` differs from the resumed id for any reason), write the whole record `{session_id: new, last_seq_by_thread: {[currentThread]: context.lastSeq}}` and drop every other cursor; when the id is unchanged, keep the merge as today. Map each CLI's missing-session error (from the Task 1 notes) to `CLI_SESSION_LOST` inside the CLI module, not in the bridge.

- [ ] **Step 5: Run to confirm pass, plus neighbors**

Run, one at a time: `room-bridge.test.mjs`, `agent-cli.test.mjs`, `cli-conformance.test.mjs`, `rooms-exit.test.mjs` (each as `timeout 60 node --test sigil/bridges/v1/<file>`).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/bridges/v1/room-bridge.mjs sigil/bridges/v1/claude-cli.mjs sigil/bridges/v1/codex-cli.mjs sigil/bridges/v1/room-bridge.test.mjs
git commit -m "feat(sigil): add resume capability, replay mode and session replacement to the room bridge

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Copilot bridge

**Files:**
- Create: `bridges/v1/copilot-cli.mjs`, `bridges/v1/copilot-cli.test.mjs`
- Modify: `bridges/v1/cli-registry.mjs`, `bridges/v1/cli-conformance.test.mjs`

**Interfaces:** Produces `createCopilotCli({command, commandArgs, allowedTools, cwd, env, timeoutMs, runner})` returning `{name: 'copilot', capabilities: {resume: true}, run}`.

- [ ] **Step 1: Re-read the Task 1 notes and fixtures for Copilot**

Confirm the prompt channel (stdin or argv), the JSONL event shape holding the answer text, the session id field, and the missing-session error.

- [ ] **Step 2: Write failing parser and argv tests**

`copilot-cli.test.mjs`: `parseCopilotOutput` reads the scrubbed success fixture into `{text, sessionId}`; the missing-session fixture raises `CLI_SESSION_LOST`; garbage raises `CLI_INVALID_OUTPUT`; argv contains `-p`, `-s`, `--output-format json`, `--no-ask-user`, `--no-auto-update`, a read-only `--available-tools` set, and `--resume <id>` or `--session-id=<uuid>`; argv contains none of `--allow-all`, `--yolo`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`. Add a Copilot row to the conformance table.

- [ ] **Step 3: Run it to confirm failure**

Run: `timeout 60 node --test sigil/bridges/v1/copilot-cli.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

Build the bridge on `runCli` and `agentEnv` with Copilot's prefix from the Task 1 auth finding (never `GITHUB_TOKEN`/`GH_TOKEN` unless the notes prove it is needed, and then only with Chris's approval recorded in the notes). If Task 1 found stdin unsupported, pass the prompt in argv and add a code comment naming the length and process-list risk. Register `copilot` in the registry.

- [ ] **Step 5: Run to confirm pass**

Run, one at a time: `copilot-cli.test.mjs`, `cli-conformance.test.mjs`, `cli-registry.test.mjs`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/bridges/v1/copilot-cli.mjs sigil/bridges/v1/copilot-cli.test.mjs sigil/bridges/v1/cli-registry.mjs sigil/bridges/v1/cli-conformance.test.mjs
git commit -m "feat(sigil): add the GitHub Copilot CLI bridge

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Grok CLI bridge or written deferral

**Files:** depends on the Task 1 Grok decision. Do exactly one branch.

**Interfaces:** Branch A produces `createGrokCli({command, commandArgs, tools, cwd, env, timeoutMs, runner})` returning `{name: 'grok', capabilities: {resume: true}, run}`, makes `grok` a valid `--room-bridge` value in both lists, and adds the `leader` mode to the fake CLI. Branch B produces no code.

- [ ] **Step 1: Read the Grok decision in the verification notes**

Open `docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md` and read the Grok go or no-go row. Do not re-run the spike. Branch A applies only if Task 1 recorded evidence that Stop and timeout cancel the actual model turn, not just the client process: observation after the kill (transcript or leader activity stopped advancing for the recorded quiet period, no assistant answer completed later), by killing the client or by an explicit cancel command the bridge calls on abort. Anything else is Branch B. There is no third option of documenting a turn that keeps running. Also read the prompt channel, JSON shape, session id field, missing-session error and cancel path.

- [ ] **Step 2 (Branch A, only if Task 1 says go): Write failing tests**

Files in this branch: create `bridges/v1/grok-cli.mjs` and `grok-cli.test.mjs`; modify `bridges/v1/cli-registry.mjs`, `bridges/v1/cli-conformance.test.mjs`, `bridges/v1/fixtures/fake-agent-cli.mjs` (new `leader` mode), `relay/v1/transport-tincan/wake-dispatcher.test.mjs` (read it first; extend only the kind assertions). Tests: parser from the scrubbed fixture; missing-session fixture raises `CLI_SESSION_LOST`; garbage raises `CLI_INVALID_OUTPUT`; argv has `--output-format json`, `--permission-mode default`, a `--tools` allowlist, `--max-turns`, `--disable-web-search`, `--no-subagents`, and `--resume <id>` or `--session-id <uuid>`; argv has neither `--always-approve` nor `bypassPermissions`. The prompt file is written to a temp file with mode `0600` and removed after the run (test that the file is gone). Add a Grok row to the conformance table. Add a wiring test: `BRIDGES` includes `grok` and `sigil agent run --room-bridge grok` passes flag validation.

Stop-contract test with the new `leader` mode: a fake client plus a fake leader; the leader keeps advancing a turn marker after the client dies unless the bridge issues the cancel path Task 1 verified. Assert that on abort and on timeout the leader's turn marker stops advancing. This test covers the bridge's cancel logic only. It does NOT replace the Task 1 verification against the real CLI, and a pass here proves nothing about the real leader.
Run: `timeout 60 node --test sigil/bridges/v1/grok-cli.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3 (Branch A): Implement and re-run**

Build on `runCli`. Write the prompt to a temp file (or stdin per Task 1), delete it in a `finally`. On abort and timeout, run the cancel path Task 1 verified before reporting the failure. Register `grok`; the registry change makes both `sigil.mjs` and `wake-dispatcher.mjs` accept it with no edit to either. Re-run, one at a time: `grok-cli.test.mjs`, `cli-conformance.test.mjs`, `cli-registry.test.mjs`, and the wake-dispatcher test. Expected: PASS.

- [ ] **Step 4 (Branch B, only if Task 1 says no-go): Write the deferral**

Files in this branch: modify `docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md` (append a "Grok deferral" section with the evidence: what was observed after the kill, the quiet period, the cancel commands examined, and the conditions that would reopen it: a verified cancel of the actual model turn); modify `docs/superpowers/specs/2026-10-16-sigil-rooms-phase-5-more-bridges-design.md` (add a Grok CLI row to the Deferred table with the reason and "later phase", and state that the tincan plan's multi-host demo waits for `grok` as a `--room-bridge` value, so this deferral blocks that demo); modify `STATUS.md` (one line under deferred work, naming the blocked demo). The registry keeps omitting `grok`. Phase 6 is unaffected (its Grok bots are Floor Warden). Add an assertion to `cli-registry.test.mjs` that `createCli('grok', {})` throws `UNKNOWN_BRIDGE_KIND`, and run `timeout 60 node --test sigil/bridges/v1/cli-registry.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit (use the message for the branch taken)**

Branch A:

```bash
git add sigil/bridges/v1/grok-cli.mjs sigil/bridges/v1/grok-cli.test.mjs sigil/bridges/v1/cli-registry.mjs sigil/bridges/v1/cli-conformance.test.mjs sigil/bridges/v1/fixtures/fake-agent-cli.mjs sigil/relay/v1/transport-tincan/wake-dispatcher.test.mjs
git commit -m "feat(sigil): add the xAI Grok CLI bridge and the grok room-bridge kind

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Branch B:

```bash
git add docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md docs/superpowers/specs/2026-10-16-sigil-rooms-phase-5-more-bridges-design.md STATUS.md sigil/bridges/v1/cli-registry.test.mjs
git commit -m "docs: defer the Grok CLI bridge until Stop cancels the model turn

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Hermes bridge or written deferral

**Files:** depends on the Task 1 Hermes decision. Do exactly one branch.

**Interfaces:** Branch A produces `HERMES_READONLY_TOOLSETS`, `parseHermesToolsets` and `createHermesCli({command, commandArgs, toolsets, cwd, env, timeoutMs, runner})` returning `{name: 'hermes', capabilities: {resume: false}, run}`. The factory throws `HERMES_TOOLSETS_REQUIRED` for an empty list and `HERMES_TOOLSET_NOT_ALLOWED` for any entry outside the constant. The allowlist is Hermes specific because Hermes `--help` says oneshot bypasses approvals (Task 1 confirms); `--agent-toolsets` for other kinds is unchanged. Branch B produces no code.

- [ ] **Step 1: Read the Hermes decision in the verification notes**

Open `docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md` and read the Hermes go or no-go row, the toolset listing and the canary results. Branch A applies only if Task 1 verified at least one toolset read-only (listing plus canary probe) and verified that `-t` restricts oneshot runs. Otherwise take Branch B. Also read the prompt channel, what `--ignore-user-config` and `--ignore-rules` do, and that no session id is reported (assumption 3).

- [ ] **Step 2 (Branch A, only if Task 1 says go): Write failing tests**

Files in this branch: create `bridges/v1/hermes-cli.mjs` and `hermes-cli.test.mjs`; modify `bridges/v1/cli-registry.mjs`, `bridges/v1/cli-conformance.test.mjs`, `cli/sigil.mjs` (`--agent-toolsets` flag wiring). Tests:

- `HERMES_READONLY_TOOLSETS` is frozen and equals the verified list from the notes.
- `createHermesCli` with no or an empty `toolsets` throws `HERMES_TOOLSETS_REQUIRED`, and the message names `--agent-toolsets`.
- `HERMES_TOOLSET_NOT_ALLOWED`, naming the offending entry, for: an unknown name, an alias, a composite or broader toolset, `all`, `*`, a verified name mixed with an unverified one, an empty entry (`a,,b`), and a name that fails the strict pattern (for example `^[A-Za-z][A-Za-z0-9_-]{0,63}$`). Each rejection test passes a spy as the spawn function (the `runner` seam) and asserts the spy was never called.
- Every entry of the constant is accepted. Argv has `-z`, `-t <list>`, and (if the notes confirm the effect) `--ignore-user-config --ignore-rules`; argv has no `--yolo`; `run` returns `{text, sessionId: null}`; plain-text output parses; empty output raises `CLI_INVALID_OUTPUT`.
- Add a Hermes row to the conformance table and a replay-mode assertion through `room-bridge` (prompt carries the 20-message window, nothing stored).
- In a `sigil.mjs` test: `--room-bridge hermes` without `--agent-toolsets` exits non-zero with the flag name in the error; with a disallowed toolset it exits non-zero with `HERMES_TOOLSET_NOT_ALLOWED` before any process starts (point `--agent-command` at a script that would write a marker file, and assert the marker is absent); with an allowed toolset, flag validation passes.

Run: `timeout 60 node --test sigil/bridges/v1/hermes-cli.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3 (Branch A): Implement and re-run**

Build on `runCli`. Parse the list in `parseHermesToolsets` (comma separated, trimmed, empty entries rejected, strict name pattern, membership in the constant); no wildcard, no `all`, no default. The factory calls it, and the `--agent-toolsets` parse in `sigil.mjs` calls it again, both before any spawn. For other kinds `--agent-toolsets` maps to that CLI's tool allowlist only where the CLI object accepts it, and is unchanged. Register `hermes`. Re-run, one at a time: `hermes-cli.test.mjs`, `cli-conformance.test.mjs`, `cli-registry.test.mjs`, `room-bridge.test.mjs`. Expected: PASS.

- [ ] **Step 4 (Branch B, only if Task 1 says no-go): Write the deferral**

Files in this branch: modify `docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md` (append a "Hermes deferral" section with the evidence: toolsets examined, canary results, whether `-t` restricted oneshot runs, and the condition that would reopen it: a toolset verified read-only that `-t` enforces in oneshot); modify `docs/superpowers/specs/2026-10-16-sigil-rooms-phase-5-more-bridges-design.md` (add Hermes to the Deferred table with the reason and "later phase"); modify `STATUS.md` (one line under deferred work). The registry keeps omitting `hermes`. Add an assertion to `cli-registry.test.mjs` that `createCli('hermes', {})` throws `UNKNOWN_BRIDGE_KIND`, and run `timeout 60 node --test sigil/bridges/v1/cli-registry.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit (use the message for the branch taken)**

Branch A:

```bash
git add sigil/bridges/v1/hermes-cli.mjs sigil/bridges/v1/hermes-cli.test.mjs sigil/bridges/v1/cli-registry.mjs sigil/bridges/v1/cli-conformance.test.mjs sigil/cli/sigil.mjs
git commit -m "feat(sigil): add the Hermes Agent bridge with an allowlisted read-only toolset

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Branch B:

```bash
git add docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md docs/superpowers/specs/2026-10-16-sigil-rooms-phase-5-more-bridges-design.md STATUS.md sigil/bridges/v1/cli-registry.test.mjs
git commit -m "docs: defer the Hermes bridge until a read-only toolset is verified

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Antigravity bridge or written deferral

**Files:** depends on the Task 1 decision. Do exactly one branch.

**Interfaces:** Branch A produces `createAntigravityCli(...)` with `{name: 'antigravity', capabilities: {resume}, run}`. Branch B produces no code.

- [ ] **Step 1: Read the Antigravity decision in the verification notes**

Open `docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md` and read the go or no-go row. Do not re-run the spike.

- [ ] **Step 2 (Branch A, only if Task 1 says go): Write failing tests**

Files in this branch: create `bridges/v1/antigravity-cli.mjs` and `antigravity-cli.test.mjs`; modify `bridges/v1/cli-registry.mjs` and `bridges/v1/cli-conformance.test.mjs`; modify `README.md` later in Task 15. Tests: parser from the scrubbed fixture, read-only tool allowlist in argv, no auto-approve or bypass flag, no `high` risk-tier capability, conformance row, registry includes `antigravity`.
Run: `timeout 60 node --test sigil/bridges/v1/antigravity-cli.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3 (Branch A): Implement and re-run**

Build on `runCli`, with the read-only allowlist from the notes. Register `antigravity`. Re-run `antigravity-cli.test.mjs`, `cli-conformance.test.mjs`, `cli-registry.test.mjs`, one at a time. Expected: PASS.

- [ ] **Step 4 (Branch B, only if Task 1 says no-go): Write the deferral**

Files in this branch: modify `docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md` (append a "Antigravity deferral" section with the evidence and the conditions that would reopen it: a headless prompt mode, a resume mode, a tool allowlist); modify `docs/superpowers/specs/2026-10-16-sigil-rooms-phase-5-more-bridges-design.md` (add Antigravity to the Deferred table with the reason and "later phase"); modify `STATUS.md` (one line under deferred work). The registry keeps omitting `antigravity` (spec open question 3). Note: Branch B has no failing test; run `timeout 60 node --test sigil/bridges/v1/cli-registry.test.mjs` and expect PASS to confirm `antigravity` is not accepted.

- [ ] **Step 5: Commit (use the message for the branch taken)**

Branch A:

```bash
git add sigil/bridges/v1/antigravity-cli.mjs sigil/bridges/v1/antigravity-cli.test.mjs sigil/bridges/v1/cli-registry.mjs sigil/bridges/v1/cli-conformance.test.mjs
git commit -m "feat(sigil): add the Antigravity CLI bridge with a read-only tool allowlist

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Branch B:

```bash
git add docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md docs/superpowers/specs/2026-10-16-sigil-rooms-phase-5-more-bridges-design.md STATUS.md
git commit -m "docs: defer the Antigravity bridge until a headless CLI exists

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `report_only` response mode: migration, routes, repositories

**Files:**
- Create: `migrations/035_report_only_mode.sql`, `migrations/035_report_only_mode.test.mjs`, `relay/v1/room-routes.report-only.test.mjs`, `cli/memory-repository.report-only.test.mjs`, `relay/v1/room-report-only.pg.test.mjs`
- Modify: `relay/v1/room-routes.mjs` (`RESPONSE_MODES`, add-member and set-response-mode handlers), `cli/memory-repository.mjs`

**Interfaces:** Produces the `report_only` value in `conversation_members_response_mode_check` and in `RESPONSE_MODES`. Add-member accepts it for agent endpoints. Set-response-mode refuses a change to or from it.

- [ ] **Step 1: Re-check the migration number and read the precedent**

Run `ls sigil/migrations | tail -3`. Renumber the new file if `main` moved. Read `030_room_router.sql` and `030_room_router.test.mjs`; the new migration drops and re-adds `conversation_members_response_mode_check` the same way.

- [ ] **Step 2: Write failing tests**

Migration test (pattern of 030): after `applyMigrations`, an insert with `response_mode = 'report_only'` succeeds; an unknown value is rejected; existing values still pass; re-applying is a no-op. Route tests (`room-routes.report-only.test.mjs`): add-member with `report_only` for an agent endpoint returns 200; for a non-agent endpoint returns 400; set-response-mode from `mentions_only` to `report_only` returns 400/409 with a stable code; from `report_only` to `joins` is refused the same way. Memory repository test: a member added as `report_only` reads back with that mode. Pg test: the same cases against Postgres.

- [ ] **Step 3: Run to confirm failure**

Run, with `SIGIL_TEST_DATABASE_URL` set to a disposable `_test` database: `timeout 60 node --test sigil/migrations/035_report_only_mode.test.mjs`
Expected: FAIL (check constraint rejects `report_only`). Then run the route and memory tests, one at a time; expected FAIL (value not in `RESPONSE_MODES`).

- [ ] **Step 4: Implement**

Write the migration with `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT ... CHECK (response_mode IS NULL OR response_mode IN ('joins','mentions_only','router','report_only'))`. Add `report_only` to `RESPONSE_MODES`. In the set-response-mode handler, refuse when the target's current mode or the requested mode is `report_only` (use the `fail()` helper with code `RESPONSE_MODE_LOCKED`). Make the memory repository accept the mode. Confirm `isInvocableAgent` in `room-policy.mjs` is unchanged.

- [ ] **Step 5: Run to confirm pass, with pg evidence**

Set `SIGIL_TEST_DATABASE_URL` to a disposable database whose name ends in `_test` (see Global Constraints). Run, one at a time: the migration test, the route test, the memory test, the pg test, then `room-policy` and the existing 030 migration test.
Expected: PASS, and the summary of the migration test and the pg test shows `skipped 0`. A skipped pg test is not a pass. If no disposable Postgres is available, record "blocked: pg evidence missing" in the verification notes and stop; this task is not done.

- [ ] **Step 6: Commit**

```bash
git add sigil/migrations/035_report_only_mode.sql sigil/migrations/035_report_only_mode.test.mjs sigil/relay/v1/room-routes.mjs sigil/relay/v1/room-routes.report-only.test.mjs sigil/cli/memory-repository.mjs sigil/cli/memory-repository.report-only.test.mjs sigil/relay/v1/room-report-only.pg.test.mjs
git commit -m "feat(sigil): add the report_only response mode

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Relay `report_only` post path

**Files:**
- Modify: `relay/v1/room-dispatch.mjs` (`assertAgentMayPost`), `relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs`, the accept path caller found in Task 1
- Test: `relay/v1/room-report-only.pg.test.mjs`, `cli/memory-repository.report-only.test.mjs`, `relay/v1/room-dispatch.report-only.test.mjs` (new)

**Interfaces:** Produces the `assertAgentMayPost` exemption and `repository.countRecentReports({conversationId, sinceMs, now})` in both repositories, counting accepted `room.message` rows in the room from ANY `report_only` member. Over the cap (30 per room per rolling hour, across all reporters) answers `429 REPORT_RATE_LIMITED`. The check runs after `lockRoom` and after the idempotency lookup.

- [ ] **Step 1: Re-read the Task 1 references for `assertAgentMayPost`, its callers, the room lock and the idempotency lookup**

Confirm where the accept path calls `assertAgentMayPost`, where a 429 can be returned with the `fail()` helper, whether `assertAgentMayPost` already runs under the room lock (`lockRoom(client, conversationId)`, the `FOR UPDATE` row lock `assignRoomSequence` takes), and where the idempotency lookup sits. Retries of an already accepted report at the cap must return 202 duplicate, so the lookup must come before the rate check. If the notes show it comes after, move the check in this task.

- [ ] **Step 2: Write failing tests**

Dispatch tests: a `report_only` sender posting a top-level `room.message`, empty mentions, 100 characters is accepted with no invocation; refused (stable codes) with a non-empty `mentions`, with `thread_root_id`, with `task.request`, with `task.result`, and with 4001 characters. Rate cap, room wide: two reporter endpoints (`ep_test_reporter_a`, `ep_test_reporter_b`) with 15 reports each fill the cap of 30, and the next post from either returns `429 REPORT_RATE_LIMITED`; after the window passes a post is accepted; a duplicate retry of an already accepted report at the cap returns 202 with `duplicate: true`, not 429. Isolation proofs: a report creates no `room_invocations` row; the hop budget counter is unchanged after a report that follows agent turns (a human post still refills it, a report does not); the router receives no delivery; a human `@mention` of the reporter creates no invocation (`isInvocableAgent` false). Add the memory variants. Pg variants, plus a concurrency test: 36 posts by `Promise.all` over separate connections, split between both reporters, yield exactly 30 accepted and 6 refused with `REPORT_RATE_LIMITED`, and exactly 30 rows.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/room-dispatch.report-only.test.mjs`
Expected: FAIL (`ROOM_NOT_INVOKED` for the report).

- [ ] **Step 4: Implement**

Add the exemption at the top of `assertAgentMayPost`: when the sender's `response_mode` is `report_only`, validate the four constraints, then check the cap through `countRecentReports` (cap constant of 30 per hour, named and exported for tuning), and return without requiring an invocation. Serialize: inside the accept transaction, call `repository.lockRoom(client, conversationId)` first if Task 1 shows `assertAgentMayPost` does not already run under it, so the count and the insert happen under that one lock. The memory repository counts and inserts in one synchronous section; add a `lockRoom` equivalent there if the accept path calls it. Run the check after the idempotency lookup. Ensure the post is treated as non-human for dispatch (no refill, no router) and calls no dispatch. Implement `countRecentReports` in both repositories as accepted `room.message` rows in that room whose sender is any `report_only` member (Postgres: envelopes joined to the room's members with `response_mode = 'report_only'`). Add `REPORT_RATE_LIMITED` to the accept-error to HTTP status mapping as 429 (the Task 1 references show where `reject` codes are mapped), and add a test that the HTTP response status is 429.

- [ ] **Step 5: Run to confirm pass, with pg evidence**

Set `SIGIL_TEST_DATABASE_URL` to a disposable `_test` database. Run, one at a time: the dispatch test, the memory test, the pg test, then `room-routes` tests, `room-invocations.pg.test.mjs` and `rooms-exit.test.mjs`.
Expected: PASS, with `skipped 0` in the pg test and `room-invocations.pg.test.mjs` summaries. A skipped pg test is not a pass. If no disposable Postgres is available, record "blocked: pg evidence missing" in the verification notes and stop; this task is not done.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/room-dispatch.mjs sigil/relay/v1/room-dispatch.report-only.test.mjs sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/cli/memory-repository.report-only.test.mjs sigil/relay/v1/room-report-only.pg.test.mjs
git commit -m "feat(sigil): let report_only members post reports under a per-room rate cap

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Report formatter, post policy and durable pending state

**Files:**
- Create: `bridges/v1/ironbot-report.mjs`, `bridges/v1/ironbot-report.test.mjs`
- Modify: `relay/v1/room-report-only.pg.test.mjs` (the pg variant of the response-loss retry; this task depends on Tasks 9-10)

**Interfaces:** Produces `sanitizeField`, `buildReportText`, `buildFleetReport`, `createReportState`, `createReportPolicy`, `reportIdempotencyKey`, `postReport` (see "Interfaces fixed up front"). The poster signs once, persists the signed envelope in the state file BEFORE sending, and resends that stored envelope byte for byte on every retry. No `LocalOutbox` change is needed: `LocalOutbox` keeps queued envelopes only in memory, so a rebuilt envelope would get a new `message_id`, timestamps and signature.

- [ ] **Step 1: Read `session-store.mjs`, `local-outbox.mjs` and the `LocalOutbox` usage in `room-bridge.mjs`**

Copy the atomic write pattern (temp file then rename) and the `outbox.queue` plus `relay.sendEnvelope` call shape. Note how the relay answers: 202 with `duplicate: true` for the same key and identical signed bytes (canonical hash), 409 `DUPLICATE_MESSAGE` for the same key with different bytes, `REPLAY_DETECTED` for a `message_id` accepted under another key. A retry is safe only if it resends the byte-identical signed envelope. `queue()` signs the envelope it is given, so the poster sets `created_at` and `expires_at` (`created_at + 24 hours`) itself. Note line numbers.

- [ ] **Step 2: Write failing tests**

Sanitization: control characters, bidi overrides (U+202A-202E, U+2066-2069), zero-width characters and non-ASCII are stripped; each field clamps to its max; raw telemetry-looking JSON keys are never copied. Text: `buildReportText` output is ASCII and at most 4000 characters even with a long alert list. Fleet: `buildFleetReport` reads `fleetHealthScore`, `fleetStatus`, `botCount`, `activeBots[]`, `alerts` and ignores `room_id` and `formatted_message`. Policy: first report for a bot posts; same healthy status within 24 hours does not; status change posts; non-healthy status posts every time; 24 hours later posts as heartbeat; the fleet summary posts once per day. State: `createReportState` writes atomically (assert via a rename spy that a failure between write and rename leaves the old file intact), the path is exactly the one passed, and the shape holds last posted status and time per bot plus at most one `pending` `{idempotency_key, report: {status, summary, timestamp}, envelope, created_at}`. The key is `ironbots_<bot>_<timestamp>`.

Durable retry tests run against the real in-process relay with the memory repository, behind a fake transport that can drop the response (not a mock that always accepts):

- (a) Accepted, then the response is lost: the transport delivers the envelope to the relay, then throws a network error to the client. `postReport` returns `{posted: false, reason: 'transient'}` and keeps `pending`. The retry resends identical bytes, the relay answers duplicate 202, there is exactly one stored row, no `DUPLICATE_MESSAGE`, `pending` is cleared and the last posted status is recorded.
- (c) Crash after persist and before send: the first call persists `pending`, then a simulated crash stops it before the transport is called. A second call sends the stored envelope, `outbox.queue` is never called again, one row is stored.
- (d) Expired pending: with `now` past the envelope's `expires_at` (created_at + 24 hours), `postReport` drops the pending record without rebuilding, calls `log` with `report_expired_unconfirmed`, sends nothing, returns `reason: 'expired'`.
- (e) Control case: rebuild the envelope with a new `message_id` under the same idempotency key and send it; the real accept path answers `DUPLICATE_MESSAGE`. This proves why the stored envelope must be reused.
- Pending ordering: the state file already holds `pending` with the full envelope when the transport is first called. A transient failure (network error, 5xx, 429) keeps `pending`, and a later report for that bot with a different status resends the pending envelope first and creates no new report while it stays unresolved. If the current report's idempotency key equals the resolved pending key, the retry is complete and nothing more is sent. Other refusals clear `pending` and return `reason: 'refused'`.

Run (f) in the report-only pg suite: the same flow as (a) against the Postgres repository.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/bridges/v1/ironbot-report.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

Implement the functions from the interfaces block. `postReport` loads `pending` for the bot first. If `pending` exists and is expired, drop it, log the notice, return `expired`. If it is live, resend `pending.envelope` untouched (never `outbox.queue`, never rebuild); on 202, including `duplicate: true`, record last posted and clear `pending`; on a transient failure keep `pending` and return `transient`. Once `pending` is resolved, the normal post policy decides whether the current report is due. If a new envelope is due, sign it once through the same outbox path as the bridges, with the reporter's own identity, `message_type` `room.message`, no `thread_root_id`, empty mentions, and `expires_at` of `created_at + 24 hours` (set by the poster, since `queue()` signs the envelope it is given). Then `savePending`, then send. Record last posted only after the relay accepts.

- [ ] **Step 5: Run to confirm pass, with pg evidence**

Run: `timeout 60 node --test sigil/bridges/v1/ironbot-report.test.mjs`. Then, with `SIGIL_TEST_DATABASE_URL` set to a disposable `_test` database, run `timeout 120 node --test sigil/relay/v1/room-report-only.pg.test.mjs`.
Expected: PASS, with `skipped 0` in the pg run. If no disposable Postgres is available, record "blocked: pg evidence missing" and stop; this task is not done.

- [ ] **Step 6: Commit**

```bash
git add sigil/bridges/v1/ironbot-report.mjs sigil/bridges/v1/ironbot-report.test.mjs sigil/relay/v1/room-report-only.pg.test.mjs
git commit -m "feat(sigil): add the Ironbots report formatter, post policy and durable pending envelope

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `sigil room report` command and contract

**Files:**
- Create: `cli/room-report-command.mjs`, `cli/room-report-command.test.mjs`
- Modify: `cli/sigil.mjs` (wire `room report`), `contracts/v1/relay-api.json` and `contracts/v1/relay-api.test.mjs` (only if the Task 1 notes show the contract lists response modes)

**Interfaces:** Produces `runRoomReport(argv, deps)` for `sigil room report --identity <path> --relay-url <url> --room <room_id> --bot <id> --status <s> --summary <text> [--alert <text> ...] [--state <path>] [--report-at <iso>]` and the `--from-report <ironbots_daily_report.json>` form. Exit codes: 0 posted or skipped by policy, 1 usage error, 2 relay refusal or expired unconfirmed pending, 3 transient failure with the pending envelope kept.

- [ ] **Step 1: Read how `sigil.mjs` dispatches `room` subcommands and builds an identity and outbox**

Record the entry points and the flag parser. Reuse them; do not add a second parser.

- [ ] **Step 2: Write failing tests**

Against a fake relay (fixture ids `ep_test_reporter`, `room_test_1`, temp identity and state paths): single report flags post once and exit 0; a second identical run exits 0 and posts nothing (policy and idempotency); `--alert` repeats; missing `--room` exits non-zero naming the flag; `--from-report` with a fixture JSON posts a fleet summary built only from structured fields; a report file whose `room_id` is `sigil-fleet-observability` still posts to the `--room` argument (spec assumption 11); `formatted_message` content never appears in the posted text; the default state path is `.sigil/report-state-<endpoint>.json` resolved but the test always passes `--state` so it never touches `.sigil`.

Timestamp and durable retry: `--report-at <iso>` sets the report timestamp and the key `ironbots_<bot>_<timestamp>`; without it the timestamp is captured once when the pending record is first created and persisted; for `--from-report` the report file's own timestamp field wins when present. A 503 from the relay exits 3, keeps `pending` in the state file, and creates no new report for that bot; the next run against a healthy relay resends the identical envelope and exits 0. (b) Restart, against the real in-process relay with the memory repository: after a response-loss failure, a second `runRoomReport` with a fresh `LocalOutbox`, fresh deps, a later `now` and no `--report-at` resends the same `message_id`, `created_at` and signature, the relay answers duplicate 202, one row exists, exit 0. (d) With `now` past the stored envelope's `expires_at`, the command exits 2, prints `report_expired_unconfirmed` on stderr, clears `pending`, and never calls `outbox.queue` or sends; the next run applies the normal policy. A permanent relay refusal exits 2 and prints the relay `code`, never a token.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/cli/room-report-command.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

Parse flags, load the identity, build the report (flags or `buildFleetReport`), create the state with `createReportState` and the policy, call `postReport`, and map its result to the exit codes above (`transient` to 3, `expired` and `refused` to 2). Wire `room report` into `sigil.mjs` and add its help line, including `--report-at` and the exit codes.

- [ ] **Step 5: Run to confirm pass**

Run: `timeout 60 node --test sigil/cli/room-report-command.test.mjs`
Expected: PASS.

- [ ] **Step 6: Contract entry (conditional)**

If the Task 1 notes show `relay-api.json` lists response modes, add `report_only` to that enum, extend `relay-api.test.mjs` with an assertion first (run `timeout 60 node --test sigil/contracts/v1/relay-api.test.mjs`, expect FAIL), then edit the JSON and re-run (expect PASS). If it does not list them, skip this step and record that in the commit body.

- [ ] **Step 7: Commit**

```bash
git add sigil/cli/room-report-command.mjs sigil/cli/room-report-command.test.mjs sigil/cli/sigil.mjs sigil/contracts/v1/relay-api.json sigil/contracts/v1/relay-api.test.mjs
git commit -m "feat(sigil): add the sigil room report command with durable pending retries

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Web roster renders `report_only` read-only

**Files:**
- Modify: `packages/sigil-rooms-web/src/api/types.ts`, `packages/sigil-rooms-web/src/rooms/RosterPanel.tsx`
- Test: `packages/sigil-rooms-web/src/rooms/RosterPanel.spec.tsx`

**Interfaces:** The `ResponseMode` type gains `'report_only'`. The roster shows it as a read-only label and offers no mode editor for that member; the editor's option list never includes `report_only`.

- [ ] **Step 1: Install dependencies in the package if the worktree has none**

Run inside `packages/sigil-rooms-web/`: `timeout 300 npm ci --ignore-scripts`
Expected: install completes. (Root `npm run test:web` can fail with `EALLOWSCRIPTS`; always run package steps from inside the package directory.)

- [ ] **Step 2: Write the failing spec**

In `RosterPanel.spec.tsx`: a member with `response_mode: 'report_only'` renders the text "Report only" with no select or button for changing the mode; the mode editor options for an editable agent are exactly `joins`, `mentions_only`, `router` (no `report_only`); existing cases unchanged.

- [ ] **Step 3: Run it to confirm failure**

Run: `cd packages/sigil-rooms-web && timeout 300 npx vitest run src/rooms/RosterPanel.spec.tsx`
Expected: FAIL (type error or missing label).

- [ ] **Step 4: Implement**

Extend the type. In `RosterPanel.tsx`, treat `report_only` like a non-editable role: render a label, skip the editor. Keep the editor's option constant unchanged.

- [ ] **Step 5: Run the package checks**

Inside `packages/sigil-rooms-web/`, one at a time: `timeout 300 npm run typecheck`, `timeout 300 npm test`, `timeout 300 npm run build`.
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/sigil-rooms-web/src/api/types.ts packages/sigil-rooms-web/src/rooms/RosterPanel.tsx packages/sigil-rooms-web/src/rooms/RosterPanel.spec.tsx
git commit -m "feat(sigil): show report_only members read-only in the roster panel

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Exit test and live smoke

**Files:**
- Create: `bridges/v1/rooms-bridges-exit.test.mjs`
- Modify: `scripts/live-room-bridges.mjs`

**Interfaces:** Produces the automated end-to-end test and an opt-in live smoke. `npm test` runs the first and never the second.

- [ ] **Step 1: Read `rooms-exit.test.mjs` and `scripts/live-room-bridges.mjs`**

Copy the harness shape (in-process relay with the memory repository, fake CLIs, temp identities). Note how the live script selects CLIs and reads its flags.

- [ ] **Step 2: Write the exit test (it fails until the earlier tasks are in place)**

One room, fixture ids only: a resume-capable fake-CLI bridge (`ep_test_resume`) and a replay-mode fake-CLI bridge (`ep_test_replay`, `capabilities.resume = false`), a human, and a `report_only` reporter (`ep_test_reporter`). Assertions: an @mention of each bridge yields a signed reply in the thread; the second turn for the replay bridge carries the replay window and stores no session; a lost-session fake triggers one retry and a stored new session. Two-thread session replacement on the resume bridge: after visiting threads A and B, a `CLI_SESSION_LOST` in A replaces the record (only A's cursor remains), and the next turn in B starts from cursor 0 with the replay window. The reporter posts a report through `postReport`, and afterwards no invocation exists for it, the hop budget is unchanged, the router fake received nothing; an @mention of the reporter creates no invocation. Response-loss retry for the reporter: the transport delivers a report and then fails the response; the retry resends the stored envelope, the room holds exactly one report row, and `pending` is cleared.

- [ ] **Step 3: Run it to confirm the state**

Run: `timeout 60 node --test sigil/bridges/v1/rooms-bridges-exit.test.mjs`
Expected: PASS if Tasks 2-12 are complete. If it fails, fix the earlier task, not this test.

- [ ] **Step 4: Extend the live smoke script**

Add the CLIs that shipped (copilot always; grok only if Task 6 took Branch A; hermes only if Task 7 took Branch A) to `scripts/live-room-bridges.mjs`, gated on `SIGIL_LIVE_BRIDGES=1` (exit 0 with a skip message otherwise). Each uses read-only tools, one short prompt, a temp directory, the allowlisted environment, and no approve-all flag. Hermes takes its toolset from `HERMES_READONLY_TOOLSETS`, never from a hand-typed list. If Grok shipped, add an opt-in Grok Stop check gated on `SIGIL_LIVE_GROK_STOP=1`: start a read-only turn, abort the signal, and observe that the turn stops advancing for the quiet period recorded in the Task 1 notes. The script must not reference `SIGIL_TEST_DATABASE_URL` (`npm run test:live` discovers files by that reference) and is not referenced by any `npm test` glob; verify with `grep -n "live-room-bridges" package.json`.

- [ ] **Step 5: Verify the script skips by default**

Run: `node sigil/scripts/live-room-bridges.mjs`
Expected: prints the skip message and exits 0 without launching any CLI.

- [ ] **Step 6: Commit**

```bash
git add sigil/bridges/v1/rooms-bridges-exit.test.mjs sigil/scripts/live-room-bridges.mjs
git commit -m "test(sigil): add the phase 5 bridges exit test and an opt-in live smoke

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Docs and final verification

**Files:**
- Modify: `README.md`, `STATUS.md`, `cli/sigil.mjs` (help text)
- Create: `docs/superpowers/plans/2026-10-16-phase-5-ironbots-wiring-note.md`

**Interfaces:** None. Documentation and the gated final run. The phase is NOT complete until step 5 passes.

- [ ] **Step 1: Update `README.md`**

List the bridges that shipped: `claude`, `codex`, `copilot`, plus `grok` only if Task 6 took Branch A, `hermes` only if Task 7 took Branch A (with the `--agent-toolsets` allowlist drawn from `HERMES_READONLY_TOOLSETS`), and `antigravity` only if Task 8 took Branch A. State the `.exe` requirement for `--agent-command` on Windows. Document `sigil room report` with its flags, `--report-at`, and exit codes 0-3. Follow the docs style rules (sentence case, active voice, no first-person plural).

- [ ] **Step 2: Update `STATUS.md` and the help text**

Draft the phase 5 entry and list what stays deferred and where (copy the spec's Deferred table rows, including a deferred Grok, Hermes or Antigravity and the blocked tincan multi-host demo if Grok is deferred). Mark phase 5 done only after step 5 passes; until then the entry reads "in progress" and, when applicable, "blocked: pg evidence missing". Update the `--room-bridge` and `room report` help text in `cli/sigil.mjs`.

- [ ] **Step 3: Write the Ironbots wiring note**

One short page: how a script on the Ironbots host would call `sigil room report --identity <path> --relay-url <url> --room <room_id> --bot <id> --status <s> --summary <text> --state <path>` per bot run and `--from-report` once a day for `ironbots_daily_report.json`; that exit code 3 means "retry later" and the same command resends the stored envelope; that the room id is supplied by the operator; that the operator creates the `report_only` endpoint and adds it to the room; that `C:\dev\scripts` is not edited by this plan.

- [ ] **Step 4: Run the core suite from the repository root under a hard timeout**

There is no `sigil/package.json`, so run `npm test` at the repository root, in the background, with `SIGIL_TEST_DATABASE_URL` unset (pg files skip there by design; step 5 is their evidence, and a set variable would let the core run race the sequential gate), and do not start any other `node --test` process meanwhile:

```bash
(timeout --kill-after=30 1500 npm test > "$TMPDIR/phase5-core.log" 2>&1; echo "exit $?" >> "$TMPDIR/phase5-core.log") &
```

Poll with `tail -n 3 "$TMPDIR/phase5-core.log"` until an `exit` line appears. On Windows, if the timeout fires and children survive, kill the tree with `taskkill /T /F`. Expected: `exit 0`. Report any failing file by name.

- [ ] **Step 5: Run the live pg gate and record the evidence**

After step 4 finishes, set `SIGIL_TEST_DATABASE_URL` to a disposable database whose name ends in `_test` (a local or docker `postgres:15` database named `sigil_test`; never the dev relay database). Run from the repository root:

```bash
(timeout --kill-after=30 1800 npm run test:live > "$TMPDIR/phase5-live.log" 2>&1; echo "exit $?" >> "$TMPDIR/phase5-live.log") &
```

Poll `tail -n 5 "$TMPDIR/phase5-live.log"` until the `exit` line appears. The runner executes one process at a time with a 120 s per-suite timeout. The phase is complete only if all of these hold:

1. The log lists `migrations/035_report_only_mode.test.mjs` (if it references the variable), `relay/v1/room-report-only.pg.test.mjs` and the report-only dispatch tests, and the totals show `fail 0` and zero skipped in those files.
2. Those files cover migration, report acceptance, restrictions (mentions, thread, task types, length, invocation isolation), the room-wide rate cap, concurrent submissions, duplicate retry, and the response-loss retry.
3. The core suite from step 4 ended with `exit 0`.

Record the commands, the totals and the skipped counts in the verification notes file. If no disposable Postgres is available, record "blocked: pg evidence missing" there and in `STATUS.md`, leave the phase open, and stop. Core-suite evidence alone never marks the phase done.

- [ ] **Step 6: Check LF endings on every new or edited file**

Run `file <path>` for each file this plan touched; none may report CRLF.

- [ ] **Step 7: Write the design-to-task checklist**

Append to the verification notes a checklist mapping each spec section to its task: Scope reading and Decisions (Tasks 2-3), CLI bridge contract and registry (2-4), Copilot (5), Grok CLI (1, 6; written deferral if Task 1 says no-go), Hermes (1, 7; written deferral if no-go), Antigravity (1, 8), Replay and recovery (4), Ironbots report posting (9-12), Loop guards and catch-up (3, 4, 10, 14), Data (9), CLI (2, 7, 12), Deferred (15), Testing (3-14), Assumptions 1-11 (Task 1 plus the task named in each assumption; assumption 4 is unverified until Task 1 and gates Task 6), Open questions (recorded, unchanged), Interaction with phase 6 (migration renumber in 9, shared files in 2 and 10, shared session-store format in 4), and the design's Review changes (Tasks 4, 6, 7, 10, 11, 15).

- [ ] **Step 8: Commit**

```bash
git add README.md STATUS.md sigil/cli/sigil.mjs docs/superpowers/plans/2026-10-16-phase-5-ironbots-wiring-note.md docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md
git commit -m "docs: document phase 5 bridges, room report, and the Ironbots wiring note

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
