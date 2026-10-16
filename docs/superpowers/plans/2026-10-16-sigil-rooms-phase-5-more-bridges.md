# Sigil rooms phase 5 (more bridges and Ironbots report posting) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person @mention a GitHub Copilot, xAI Grok CLI, or Hermes agent in a room and get a signed answer in the thread, as Claude and Codex answer today. Copilot ships unconditionally. Grok and Hermes ship only if Task 1 verifies their safety conditions (Grok: Stop cancels the actual model turn; Hermes: a read-only toolset allowlist). Let the Ironbots fleet post its run reports into a room as signed `room.message` rows from its own `report_only` endpoint, with retries that resend one durable signed envelope only inside the relay freshness window and reconcile acceptance through an existing sender-scoped read after that. Ship an Antigravity bridge only if the Task 1 spike finds a headless mode.

**Architecture:** Task 1 is a verification spike that settles the unknown CLI behavior, records the Grok and Hermes go or no-go decisions, verifies the receipts-route semantics the poster relies on (with an ordinary room message, since `report_only` does not exist yet), and records the relay code the later tasks touch. Tasks 2-4 add the CLI registry, the shared conformance suite, and replay and lost-session recovery (a changed session id replaces the whole session record). Tasks 5-8 add the Copilot bridge and, each as a bridge or a written deferral, the Grok CLI, Hermes and Antigravity bridges. Tasks 9-10 add the `report_only` response mode: data (including the relay-assigned `report_post` marker column) and routes first, then the relay post path that sets the marker at accept time, with a per-room rate cap counted from the marker and taken under the room lock; Task 10 repeats the receipts check with a real `report_only` sender. Tasks 11-12 add the report formatter, post policy, a small file-lock helper (per-bot lock and state-file lock), the durable pending envelope with freshness windows, `last_key` skip and receipts reconcile, and the `sigil room report` CLI. Task 13 adds the web client rendering. Task 14 adds the exit test and the opt-in live smoke. Task 15 closes docs and gated final verification: the phase stays open until the PostgreSQL suites have run with zero skips.

**Tech Stack:** Node `.mjs` with `node:test`, `pg`, Postgres 15, `ws`. TypeScript, React 19 and Vitest in `packages/sigil-rooms-web` (Task 13 only).

**Spec:** `docs/superpowers/specs/2026-10-16-sigil-rooms-phase-5-more-bridges-design.md` (read it first; this plan cites it as "spec"). Parent: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md`.

## Global Constraints

- Branch off `main` in a worktree. Never touch the main checkout at `C:\dev\sigil-repo` (no branch switch, stash, reset or checkout over its uncommitted work). No push and no PR unless asked.
- Paths below are relative to `sigil/` unless they start with `packages/` or `docs/`, or name `README.md` or `STATUS.md`, which sit at the repo root. Relay code is `relay/v1/`, bridges are `bridges/v1/`.
- Never read, print, copy or commit anything in `.sigil/*.json`. Tests build identities, session files, state files and lock files in a temp directory.
- Tests use fixture endpoint ids (`ep_test_...`). Never create `ep_ironbots` or any real endpoint, never add one to a real room, never run against a real database or a real relay. Endpoint setup is an operator step outside this plan.
- Nothing in the real CLIs (Copilot, Grok CLI, Hermes), in Postgres, in the relay receipts route, or in the lock helper was run when this plan was written. Every CLI fact and every relay-semantics fact in this plan is something Task 1 must verify, and the later tasks read the Task 1 notes instead of trusting the plan.
- Test commands: there is no `sigil/package.json`. Run `npm test` and `npm run test:live` from the repository root; `cd sigil && npm test` does not work. Unit tests: `timeout 60 node --test <file>`. **Run one `node --test` process at a time.** Overlapping runs deadlock the shared pg. (Child processes that a test itself spawns, as in Task 11, are part of that one test and are killed in a `finally`.)
- Postgres tests are `*.pg.test.mjs`, read `SIGIL_TEST_DATABASE_URL`, skip without it, call `assertDisposableTestDatabase`, and run `applyMigrations(url, { reset: true })`. A skipped pg test is not evidence. **Pg suites must run, not skip, before the phase can be called done.** Tasks 9, 10, 11 and 15 require `skipped 0` with the variable set.
- `npm run test:live` (root) runs `sigil/scripts/live-db-tests.mjs`. It exits 1 if `SIGIL_TEST_DATABASE_URL` is unset, asserts that the database name ends in `_test`, discovers every test file that references `process.env.SIGIL_TEST_DATABASE_URL`, runs them strictly one process at a time with a 120 s per-suite timeout, and prints totals including `skipped`.
- A disposable database comes from a local Postgres install or a docker `postgres:15` container with a database named `sigil_test`. Never point the variable at the dev relay database or any real one.
- Every command that can hang runs under a hard timeout (`timeout --kill-after=30 <seconds> ...`). On Windows, if the timeout fires, the process tree may need `taskkill /T /F`.
- Real CLI runs happen only in Task 1 (short read-only prompts per CLI, in a temp directory, with the allowlisted environment from `agentEnv`) and in the opt-in live smoke script (Task 14). `npm test` never launches a real CLI.
- No CLI is ever launched with an approve-all, yolo, always-approve or bypass flag, in code, in tests, or in the spike. Forbidden: Copilot `--allow-all`, `--yolo`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`; Grok `--always-approve` and `--permission-mode bypassPermissions`; Hermes `--yolo`. Tests assert these are absent from argv.
- Secrets arrive through environment variable names (`--...-env`), never argv. No test, log line, error message or fixture may contain a token, an account id, or a path that includes the user name. Lock files hold only `{pid, host, token, acquired_at}` with a random token that is not a credential.
- Never commit unscrubbed CLI output. Task 1 strips user-name paths, tokens and account ids before any fixture is written.
- Migration number: the spec proposes `035_report_only_mode.sql` (highest on `main` at spec time is `034_oauth_login.sql`). Phase 6 also proposes 035. Re-check with `ls sigil/migrations | tail -3` at execution and renumber if `main` moved.
- Relay error bodies are `{request_id, code, message, details?}`. Use the `fail()` helper pattern from `room-routes.mjs`.
- Both repositories (`relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs`) get every new method and every changed signature.
- New bridge endpoints are created `mentions_only` with `invokable_by` owner. That is operator setup, not a task here.
- No new dependency is added for locking. The lock helper uses exclusive-create lock files (`fs.open(path, 'wx')`, as `sigil/ingress/v1/local-quarantine-storage.mjs` already does). Lock files are advisory (cooperating poster processes only) and local-disk only (not a network share).
- Phase 6 overlap: the session-store file format stays shared and unchanged; the Floor Warden `catch_up` watermark is per bot and not tied to a CLI session, so the session replacement rule does not touch it. Phase 6 Grok bots are Floor Warden, not this CLI, so a Grok deferral does not affect phase 6. The durable report envelope, the receipts-route reconcile and the new lock helper have no phase 6 overlap (Floor Warden signs with relay-held keys; the receipts route is existing; the helper is new in `bridges/v1`). The conditional fallback read route in Task 10 step 6 would touch `relay/v1/http-server.mjs`; if it is taken, re-check the phase 6 branch for edits to that file. The existing room-bridge reply path has the same in-memory outbox but fails the invocation instead of retrying, so it is out of scope here.
- Every commit message ends with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Use `test(sigil):` for test-only commits, `feat(sigil):` otherwise, `docs:` for docs.
- Files are LF. Before using an edit tool on a file, run `file <path>`; if it reports CRLF, edit with a script that preserves line endings.
- Docs follow the repo's technical-writing rules: sentence case headings, no first-person plural, active voice.

---

## File structure

Bridges and CLI (`sigil/`):

- Create `bridges/v1/cli-registry.mjs` (+ test), `bridges/v1/cli-conformance.test.mjs`, `bridges/v1/copilot-cli.mjs` (+ test), `bridges/v1/file-lock.mjs` (+ `file-lock.test.mjs`), `bridges/v1/ironbot-report.mjs` (+ test), `bridges/v1/ironbot-report-concurrency.test.mjs` with the child script `bridges/v1/fixtures/report-poster-child.mjs`, `bridges/v1/rooms-bridges-exit.test.mjs`, `bridges/v1/fixtures/` captured output files (scrubbed).
- Create (only if Task 1 says go for Grok) `bridges/v1/grok-cli.mjs` (+ test). Create (only if Task 1 says go for Hermes) `bridges/v1/hermes-cli.mjs` (+ test). Create (only if Task 1 says go for Antigravity) `bridges/v1/antigravity-cli.mjs` (+ test).
- Create `cli/room-report-command.mjs` (+ test).
- Modify `bridges/v1/cli-runner.mjs` (`agentEnv`), `bridges/v1/claude-cli.mjs` and `bridges/v1/codex-cli.mjs` (`capabilities`), `bridges/v1/room-bridge.mjs` (+ `room-bridge.test.mjs`), `bridges/v1/fixtures/fake-agent-cli.mjs` (Task 3 modes; Task 6 `leader` mode), `relay/v1/transport-tincan/wake-dispatcher.mjs`, `cli/sigil.mjs`, `scripts/live-room-bridges.mjs`, and the relay client module Task 1 step 7 finds (only if it lacks a `getMessageReceipts` method).

Relay (`sigil/`):

- Create `migrations/035_report_only_mode.sql` and `migrations/035_report_only_mode.test.mjs`.
- Create `relay/v1/room-report-only.pg.test.mjs`, `relay/v1/room-routes.report-only.test.mjs`, `relay/v1/room-dispatch.report-only.test.mjs`, `cli/memory-repository.report-only.test.mjs`.
- Modify `relay/v1/room-routes.mjs`, `relay/v1/room-dispatch.mjs`, the accept path file Task 1 finds (`relay/v1/accept-envelope.mjs`: marker set at accept time), `relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs` (`persistAcceptedEnvelope` flag, new `countRecentReports`, `lockRoom`), `contracts/v1/relay-api.json` (+ its test, only if Task 1 notes show the contract lists response modes).
- Conditional (Task 10 step 6, only if the receipts route is found unusable for ordinary messages in Task 1 or for a real `report_only` sender in Task 10 step 5): `relay/v1/http-server.mjs` and its test, for one narrow sender-scoped read route.

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

// bridges/v1/file-lock.mjs (new, no dependency; exclusive-create lock files, advisory, local disk only)
acquireLock(lockPath, { waitMs, staleAfterMs, pollMs, now, sleep, isPidAlive, host }); // -> { token, release() }
                                                                    // lock file content { pid, host, token, acquired_at }; retries with backoff up to waitMs, then throws LOCK_TIMEOUT
                                                                    // stale = pid not alive on the same host, OR older than staleAfterMs; stealing re-reads the file and compares the token immediately before removing it
                                                                    // release() removes the file only if the token on disk still matches
withLock(lockPath, options, fn);                                    // acquire, run fn, release in finally (also when fn throws)
renameWithRetry(from, to, { attempts });                            // retries EPERM / EBUSY a few times (Windows rename over an open file), then rethrows
// defaults used by the poster: bot lock wait 60 s, stale 5 min; state-file lock wait 5 s, stale 30 s

// bridges/v1/ironbot-report.mjs
sanitizeField(value, max);                                          // -> ASCII string, control and bidi stripped, clamped
buildReportText({ bot, status, timestamp, summary, alerts });       // -> string, at most 4000 chars
buildFleetReport(reportJson);                                       // -> { bot:'fleet', status, timestamp, summary, alerts } from structured fields only
export const FRESH_MS, FINAL_MS;                                    // 4 min and 6 min, measured against the envelope created_at on the poster clock
createReportState({ statePath, now, lockOptions });                 // -> {
                                                                    //   withBotLock(bot, fn),     // lock <statePath>.<bot>.lock, held for the WHOLE poster run of that bot (strict bot id pattern)
                                                                    //   loadPending(bot), savePending(bot, pending), markSending(bot), clearPending(bot), dropPending(bot),
                                                                    //   lastPosted(bot),          // -> { status, at, last_key } or null
                                                                    //   recordPosted(bot, { status, at, key }),  // stores last status, time and last_key (the idempotency key of the last accepted report, including any _r<n> suffix)
                                                                    //   nextRecreateCount(bot) }  // increments and returns the bot's recreate_count (per bot, monotonic, never reset)
                                                                    // every read-modify-write takes <statePath>.lock, reads the whole file fresh, changes only this bot's key,
                                                                    // writes a temp file then renameWithRetry, releases; never held across a network call; lock order is bot lock then state lock
                                                                    // per bot: last posted status, time and last_key, recreate_count, and at most one pending =
                                                                    // { message_id, idempotency_key, created_at, report: { status, summary, timestamp }, envelope (full signed), state: 'signed' | 'sending' }
                                                                    // 'sending' is flushed to disk BEFORE the HTTP request and is never set back to 'signed'
createReportPolicy({ state, now });                                 // -> { shouldPost(report) -> boolean, record(report) }
reportIdempotencyKey(bot, timestamp, recreate_count = 0);           // -> `ironbots_<bot>_<timestamp>`, or `..._r<n>` when recreate_count > 0
postReport({ identity, relay, outbox, roomId, report, policy, state, now, log, httpTimeoutMs = 30000 });
                                                                    // -> { posted: boolean, reason: 'accepted'|'duplicate'|'reconciled'|'policy'|'already_posted'|'transient'|'pending'|'lock_timeout'|'refused' }
                                                                    // runs entirely inside state.withBotLock(bot); never resends outside the FRESH window (see Task 11)
                                                                    // before building a new envelope: if reportIdempotencyKey(bot, timestamp, recreate_count) equals the state's last_key
                                                                    // or the key of the pending just resolved, return reason 'already_posted' (exit 0) without signing anything
                                                                    // relay.getMessageReceipts(messageId) -> { status }   // GET /v1/messages/<id>/receipts; 200 = accepted, 404 = relay holds no such message
                                                                    // retry classification: permanent refusal (reason 'refused', pending dropped) is a closed set of relay codes:
                                                                    //   INVALID_ENVELOPE, DUPLICATE_MESSAGE, REPLAY_DETECTED, and the report mode, size, mention and thread refusal codes Task 10 defines;
                                                                    //   everything else is transient (pending kept): 401, 403, 408, 425, 429 (incl. REPORT_RATE_LIMITED), all 5xx, network errors

// cli/room-report-command.mjs
runRoomReport(argv, { env, stdout, stderr, fetchImpl, now });       // -> exit code; flags per spec plus --report-at <iso> and --drop-pending
                                                                    //    exit 0 posted, reconciled, skipped by policy, or skipped as already_posted; 1 usage;
                                                                    //    2 permanent refusal of a fresh envelope = closed set of relay codes (above), pending dropped and logged;
                                                                    //    3 transient failure (401, 403, 408, 425, 429 incl. REPORT_RATE_LIMITED, all 5xx, network errors), reconciliation pending, or lock timeout (pending kept, nothing changed)
                                                                    //    other 4xx responses are NOT permanent refusals; no 24 hour pending expiry exists

// report_only relay rule (relay/v1/room-dispatch.mjs, both repositories)
// assertAgentMayPost: a report_only sender may post a top-level room.message with empty mentions, no thread_root_id, text <= 4000
// accept path (relay/v1/accept-envelope.mjs): when the room plan's senderMember.response_mode is 'report_only' and the envelope is a room.message,
//                                              the row is persisted with report_post = true; the envelope body is unchanged and a sender cannot set the marker
// repository.persistAcceptedEnvelope({ ..., reportPost })  // both implementations store the flag; default false
// repository.countRecentReports({ conversationId, sinceMs, now }) -> number   (NEW in both implementations, no such method exists today; counts accepted rows in the room
//                                                                              with report_post = true inside the window; NO join to conversation_members, so the count survives roster edits)
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

**Interfaces:** Produces the decision matrix (including the Hermes and Grok go or no-go decisions and the receipts-route result for ordinary messages) and fixtures that Tasks 5-8 depend on, and the file and line references that Tasks 2, 4, 9, 10, 11, 12 and 13 depend on.

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
grep -n "setRoomMemberResponseMode\|addRoomMember\|response_mode\|ON CONFLICT" sigil/cli/memory-repository.mjs sigil/relay/v1/postgres-repository.mjs
grep -n "lockRoom\|assignRoomSequence\|idempotency\|DUPLICATE_MESSAGE\|REPLAY_DETECTED" sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/room-routes.mjs sigil/relay/v1/room-dispatch.mjs
grep -n "validateEnvelope\|lookupIdempotency\|persistAcceptedEnvelope\|clock-skew\|INVALID_ENVELOPE" sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs
grep -n "receipts\|lookupMessageSender\|MESSAGE_NOT_FOUND" sigil/relay/v1/http-server.mjs sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs
grep -n "countRecentReports\|accepted_at\|received_at\|created_at" sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs
grep -n "queue(\|expires_at" sigil/connectors/v1/local-outbox.mjs
grep -n "outcome\|ack" sigil/cli/agent-daemon.mjs
grep -n "response_mode\|response-mode" sigil/contracts/v1/relay-api.json
grep -rn "\.sigil" sigil/bridges/v1/*.mjs sigil/cli/sigil.mjs | grep -v test
```

The repo tooling may lack ripgrep, so use these `grep` and `git grep` forms. The `countRecentReports` term in the sixth grep is expected to find no hit: the method does not exist today and Task 10 adds it as new. The other terms in that grep locate the timestamp columns.

Locate the relay client module's send and receipts methods, and the relay test harness that starts the in-process relay over HTTP:

```bash
git grep -n "sendEnvelope\|getMessageReceipts" -- sigil/connectors sigil/cli
git grep -n "listen(0" -- sigil
```

The first command finds the client module (record its path, and whether it already has `getMessageReceipts`). The second finds how existing tests start the relay on a loopback port (record the helper name and path; Tasks 10 and 11 reuse it).

Record: the member-add and set-response-mode handlers; every `assertAgentMayPost` caller; the repository room methods in both repositories; **whether `assertAgentMayPost` already runs inside the accept transaction under the room lock (`lockRoom`, the same `FOR UPDATE` row lock `assignRoomSequence` takes), and where the idempotency lookup sits relative to it** (Task 10 needs both); **that `validateEnvelope` runs before `lookupIdempotency` in the accept path (record both line numbers) and rejects an envelope whose `created_at` is more than 5 minutes from the relay clock with `INVALID_ENVELOPE`, and how the accept path reads its clock so a test can set it** (Task 11 freshness windows and the control test need these); **every caller of `persistAcceptedEnvelope`, the room plan's `senderMember` shape at the point where the row is persisted, and the `addRoomMember` upsert in both repositories (Postgres `ON CONFLICT ... DO UPDATE SET response_mode = EXCLUDED.response_mode, removed_at = NULL`)** (Task 10 marker and the membership-change test need these); the `GET /v1/messages/<message_id>/receipts` handler and `lookupMessageSender`; **which timestamp columns the `envelopes` table has (a relay-assigned acceptance time versus the client-supplied envelope `created_at`) and which one the existing code treats as accepted time** (read here; Task 9 chooses the index column from it and Task 10 uses the same choice); that `queue()` signs the envelope it is given, so the poster sets `created_at` and `expires_at` itself (Task 11), and whether the existing relay client module exposes a receipts method; the daemon ack rule for the outcome strings; whether the contract file lists response modes (decides Task 12 step 6); whether the poster path would write under `.sigil` (it must write only the state file path it is given); and how existing relay tests start the in-process relay over HTTP on a loopback port (Task 11 child-process tests need it).

- [ ] **Step 8: Verify the receipts-route semantics and Windows rename behavior**

Receipts route (decides whether Task 10 step 6 runs). `report_only` does not exist until Tasks 9-10, so this step uses an ordinary accepted room message: a human message, or an agent message inside an invocation. Read the receipts handler and both repositories, then confirm with a throwaway script in the temp directory (not committed) against the in-process relay with the memory repository, and against a disposable Postgres if one is available (otherwise mark the pg half unverified): (a) after an accepted top-level ordinary `room.message`, `GET /v1/messages/<message_id>/receipts` authenticated as its sender answers 200 (the body may carry an empty receipts list, since a broadcast has no deliveries); (b) the same request for an unknown `message_id` answers 404 `MESSAGE_NOT_FOUND`; (c) the same request authenticated as a different endpoint answers 404; (d) an envelope rejected by `validateEnvelope` (for example `created_at` six minutes off) is never persisted, so the same route answers 404 for it; (e) the lookup does not depend on the idempotency key row. Record **receipts route usable for ordinary messages** only if (a)-(e) hold in both repositories. This does not verify the route for a `report_only` sender: that repeat happens in the Task 10 pass step and the Task 11 pg response-loss test, and spec assumption 14 stays unverified until then. If the route answers 404 for an accepted ordinary room message, or the memory repository differs from Postgres, record **fallback route needed** (Task 10 step 6) with the evidence. Also record whether the relay accept path really answers `INVALID_ENVELOPE` for a resend whose `created_at` is six minutes old even though the same bytes were accepted earlier (this justifies the freshness rule), again using an ordinary message.

Windows rename (cheap check). In the temp directory, hold a state-style JSON file open for reading in one process and rename a temp file over it from another. Record whether the rename fails with `EPERM` or `EBUSY` and how many retries at 20 ms spacing it needs. This sets the default `attempts` for `renameWithRetry`. If the check cannot be made cheaply, record "unverified" and keep the default of 5 attempts.

- [ ] **Step 9: Write the notes file**

Sections: versions, decision matrix (rows: headless mode, prompt via stdin or argv, JSON shape, session id, resume, missing-session error, kill behavior including the grok leader process and the quiet period observed, Grok cancel path, Grok go/no-go, auth source, Hermes toolset contents and canary results, `HERMES_READONLY_TOOLSETS` candidates, Hermes go/no-go, Antigravity go/no-go, receipts route usable for ordinary messages or fallback needed (with the pg half marked verified or unverified, and the `report_only` repeat marked pending until Tasks 10-11), acceptance timestamp column found (the choice is made in Task 9), rename retry count; one column per CLI where that applies), relay code references (including the room-lock, idempotency-order, validate-before-idempotency, clock findings, the relay client module path and the in-process relay harness), and a list of assumptions confirmed or changed. State which later task each finding feeds.

- [ ] **Step 10: Commit**

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

**Interfaces:** Produces the `report_only` value in `conversation_members_response_mode_check` and in `RESPONSE_MODES`, and the `envelopes.report_post BOOLEAN NOT NULL DEFAULT FALSE` column with a partial index on `(conversation_id, <acceptance timestamp column>) WHERE report_post`. This task chooses the timestamp column from the Task 1 finding (a relay-assigned acceptance time is preferred; envelope `created_at` is only the stated fallback, spec assumption 16) and records the choice in the notes; Task 10 uses the same column. Add-member accepts the mode for agent endpoints. Set-response-mode refuses a change to or from it.

- [ ] **Step 1: Re-check the migration number and read the precedent**

Run `ls sigil/migrations | tail -3`. Renumber the new file if `main` moved. Read `030_room_router.sql` and `030_room_router.test.mjs`; the new migration drops and re-adds `conversation_members_response_mode_check` the same way. Read the Task 1 acceptance-time finding and choose the timestamp column for the partial index here (prefer the relay-assigned column; fall back to envelope `created_at` only if none exists, and then note the up-to-5-minute skew). Record the chosen column in the verification notes so Task 10 reuses it.

- [ ] **Step 2: Write failing tests**

Migration test (pattern of 030): after `applyMigrations`, an insert with `response_mode = 'report_only'` succeeds; an unknown value is rejected; existing values still pass; re-applying is a no-op. Column and index: `information_schema.columns` shows `envelopes.report_post` as boolean, `is_nullable = 'NO'`, default `false`; `pg_indexes` shows a partial index on `(conversation_id, <chosen timestamp column>)` whose definition contains `WHERE report_post`; an existing non-report row has `report_post = false` (insert an envelope row before applying 035 if `applyMigrations` can stop at 034, otherwise insert one after migrating with the column omitted and assert the default). Route tests (`room-routes.report-only.test.mjs`): add-member with `report_only` for an agent endpoint returns 200; for a non-agent endpoint returns 400; set-response-mode from `mentions_only` to `report_only` returns 400/409 with a stable code; from `report_only` to `joins` is refused the same way; remove then re-add of a member with a different mode through add-member succeeds (Task 10 uses this flow). Memory repository test: a member added as `report_only` reads back with that mode. Pg test: the same cases against Postgres.

- [ ] **Step 3: Run to confirm failure**

Run, with `SIGIL_TEST_DATABASE_URL` set to a disposable `_test` database: `timeout 60 node --test sigil/migrations/035_report_only_mode.test.mjs`
Expected: FAIL (check constraint rejects `report_only`, column missing). Then run the route and memory tests, one at a time; expected FAIL (value not in `RESPONSE_MODES`).

- [ ] **Step 4: Implement**

Write the migration with `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT ... CHECK (response_mode IS NULL OR response_mode IN ('joins','mentions_only','router','report_only'))`, then `ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS report_post BOOLEAN NOT NULL DEFAULT FALSE` and `CREATE INDEX IF NOT EXISTS ... ON envelopes (conversation_id, <chosen timestamp column>) WHERE report_post`. No backfill: `report_only` did not exist, so every existing row is correctly false. Add `report_only` to `RESPONSE_MODES`. In the set-response-mode handler, refuse when the target's current mode or the requested mode is `report_only` (use the `fail()` helper with code `RESPONSE_MODE_LOCKED`). Make the memory repository accept the mode. Confirm `isInvocableAgent` in `room-policy.mjs` is unchanged.

- [ ] **Step 5: Run to confirm pass, with pg evidence**

Set `SIGIL_TEST_DATABASE_URL` to a disposable database whose name ends in `_test` (see Global Constraints). Run, one at a time: the migration test, the route test, the memory test, the pg test, then `room-policy` and the existing 030 migration test.
Expected: PASS, and the summary of the migration test and the pg test shows `skipped 0`. A skipped pg test is not a pass. If no disposable Postgres is available, record "blocked: pg evidence missing" in the verification notes and stop; this task is not done.

- [ ] **Step 6: Commit**

```bash
git add sigil/migrations/035_report_only_mode.sql sigil/migrations/035_report_only_mode.test.mjs sigil/relay/v1/room-routes.mjs sigil/relay/v1/room-routes.report-only.test.mjs sigil/cli/memory-repository.mjs sigil/cli/memory-repository.report-only.test.mjs sigil/relay/v1/room-report-only.pg.test.mjs
git commit -m "feat(sigil): add the report_only response mode and the report_post marker column

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Relay `report_only` post path

**Files:**
- Modify: `relay/v1/room-dispatch.mjs` (`assertAgentMayPost`), `relay/v1/accept-envelope.mjs` (marker at accept time), `relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs`
- Test: `relay/v1/room-report-only.pg.test.mjs`, `cli/memory-repository.report-only.test.mjs`, `relay/v1/room-dispatch.report-only.test.mjs` (new)
- Conditional (step 6 only): `relay/v1/http-server.mjs` and its test

**Interfaces:** Produces the `assertAgentMayPost` exemption; the relay-assigned marker (`report_post` true on the persisted row when the room plan's `senderMember.response_mode` is `report_only` and the envelope is a `room.message`; the envelope body is unchanged and a sender cannot set it); `persistAcceptedEnvelope` taking and storing the flag in both repositories; and a new `repository.countRecentReports({conversationId, sinceMs, now})` in both repositories, counting accepted rows in the room with `report_post = true` inside the window, with no join to `conversation_members`. Over the cap (30 per room per rolling hour, across all reporters) answers `429 REPORT_RATE_LIMITED`. The check runs after `lockRoom` and after the idempotency lookup.

- [ ] **Step 1: Re-read the Task 1 references for `assertAgentMayPost`, its callers, the room lock, the idempotency lookup, `persistAcceptedEnvelope` and the schema**

Confirm where the accept path calls `assertAgentMayPost`, where a 429 can be returned with the `fail()` helper, whether `assertAgentMayPost` already runs under the room lock (`lockRoom(client, conversationId)`, the `FOR UPDATE` row lock `assignRoomSequence` takes), and where the idempotency lookup sits. Retries of an already accepted report at the cap must return 202 duplicate, so the lookup must come before the rate check. If the notes show it comes after, move the check in this task. Use the timestamp column Task 9 chose for the partial index (recorded in the notes) as the window column, so the count uses the index. If that is only the client-supplied envelope `created_at`, add a code comment that it can be off by up to 5 minutes (the relay clock-skew tolerance). Confirm the room plan exposes `senderMember` at the point where the row is persisted.

- [ ] **Step 2: Write failing tests**

Dispatch tests: a `report_only` sender posting a top-level `room.message`, empty mentions, 100 characters is accepted with no invocation; refused (stable codes, which this task defines and records in the notes: they form the report mode, size, mention and thread refusal part of the Task 11 permanent-refusal set) with a non-empty `mentions`, with `thread_root_id`, with `task.request`, with `task.result`, and with 4001 characters. Marker: the accepted report row has `report_post` true; a message from a `joins` agent inside an invocation and a message from a human have `report_post` false; an envelope whose body carries an extra `report_post: true` field from a non-report sender is rejected or ignored and its row stays false (the marker is relay-assigned only). Rate cap, room wide: two reporter endpoints (`ep_test_reporter_a`, `ep_test_reporter_b`) with 15 reports each fill the cap of 30, and the next post from either returns `429 REPORT_RATE_LIMITED`; after the window passes a post is accepted; a duplicate retry of an already accepted report at the cap returns 202 with `duplicate: true`, not 429. Isolation proofs: a report creates no `room_invocations` row; the hop budget counter is unchanged after a report that follows agent turns (a human post still refills it, a report does not); the router receives no delivery; a human `@mention` of the reporter creates no invocation (`isInvocableAgent` false). Add the memory variants. Pg variants, plus a concurrency test: 36 posts by `Promise.all` over separate connections, split between both reporters, yield exactly 30 accepted and 6 refused with `REPORT_RATE_LIMITED`, and exactly 30 rows.

Receipts route with a real `report_only` sender (memory repository over the in-process HTTP relay found in Task 1 step 7, and Postgres): after an accepted report, `GET /v1/messages/<message_id>/receipts` authenticated as the reporter answers 200 (an empty list is allowed, since a report is a broadcast with no deliveries); as a different endpoint it answers 404; for an unknown id it answers 404 `MESSAGE_NOT_FOUND`. This repeats the Task 1 check, which could only use an ordinary message.

Membership-change regression (memory and pg), using add-member and remove-member, not set-response-mode (which refuses report_only changes): (1) reporter A (`report_only`) posts 30 reports; the owner removes A and re-adds A as `mentions_only`; reporter B (`report_only`) posts and gets `429 REPORT_RATE_LIMITED`, because the count reads the stored marker and not the current mode. (2) Variant: re-add A as `report_only`; the count stays 30 and B gets 429. (3) Variant: A is removed and not re-added; A's rows still count and B gets 429 (a reporter removed at the cap still occupies the cap until the window passes). (4) After the window passes in each variant, B's post is accepted.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/room-dispatch.report-only.test.mjs`
Expected: FAIL (`ROOM_NOT_INVOKED` for the report).

- [ ] **Step 4: Implement**

Add the exemption at the top of `assertAgentMayPost`: when the sender's `response_mode` is `report_only`, validate the four constraints, then check the cap through `countRecentReports` (cap constant of 30 per hour, named and exported for tuning), and return without requiring an invocation. In the accept path, compute `reportPost = envelope is room.message && roomPlan.senderMember.response_mode === 'report_only'` and pass it to `persistAcceptedEnvelope` (both repositories take a `reportPost` argument defaulting to false and store it; the Postgres insert writes the `report_post` column; the memory rows carry a `report_post` flag). Serialize: inside the accept transaction, call `repository.lockRoom(client, conversationId)` first if Task 1 shows `assertAgentMayPost` does not already run under it, so the count and the insert happen under that one lock. The memory repository counts and inserts in one synchronous section; add a `lockRoom` equivalent there if the accept path calls it. Run the check after the idempotency lookup. Ensure the post is treated as non-human for dispatch (no refill, no router) and calls no dispatch. Add `countRecentReports({conversationId, sinceMs, now})` as a new method in both repositories (it does not exist today): the number of accepted rows in that room with `report_post = true` whose chosen timestamp falls inside the window; it does not join `conversation_members` at all. Add `REPORT_RATE_LIMITED` to the accept-error to HTTP status mapping as 429 (the Task 1 references show where `reject` codes are mapped), and add a test that the HTTP response status is 429.

- [ ] **Step 5: Run to confirm pass, with pg evidence**

Set `SIGIL_TEST_DATABASE_URL` to a disposable `_test` database. Run, one at a time: the dispatch test, the memory test, the pg test, then `room-routes` tests, `room-invocations.pg.test.mjs` and `rooms-exit.test.mjs`.
Expected: PASS, with `skipped 0` in the pg test and `room-invocations.pg.test.mjs` summaries, and the pg membership-change regression, the 36-post concurrency cases and the `report_only` receipts-route check among the passes. A skipped pg test is not a pass. If no disposable Postgres is available, record "blocked: pg evidence missing" in the verification notes and stop; this task is not done. Record the `report_only` receipts-route result (memory and pg) in the notes. Spec assumption 14 stays unverified for `report_only` until this result and the Task 11 pg response-loss test are both in.

- [ ] **Step 6 (conditional): Add a narrow sender-scoped read route**

Decide this step from the Task 1 result for ordinary messages AND the `report_only` receipts result from step 5. It runs only if either records "fallback route needed": a 404 for an accepted room message or report, or a memory repository that differs from Postgres. If both are usable, skip the step and say so in the commit body. If the Task 11 pg response-loss test later finds a 404 for an accepted report, return here and take this step.

Files in this step: `relay/v1/http-server.mjs`, its test, and both repositories if a new lookup method is needed. Add one read route modeled on the existing receipts route (for example `GET /v1/messages/<message_id>/status`): it answers 200 with `{message_id, status}` only when the authenticated principal endpoint is the stored sender of that `message_id` (any status the relay persisted), and 404 `MESSAGE_NOT_FOUND` otherwise, including for a non-sender; it reads the `envelopes` table by `message_id` and does not touch the idempotency table. Write the failing route test first (200 for the sender after an accepted room message and after an accepted report in both repositories, 404 for unknown id, 404 for another endpoint, 404 for an envelope rejected by `validateEnvelope`), then implement, then re-run step 5 in full. Record the route name in the notes so Task 11 points `getMessageReceipts` at it. This is a conditional relay change, not a given. If taken, re-check the phase 6 branch for edits to `http-server.mjs`.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/room-dispatch.mjs sigil/relay/v1/room-dispatch.report-only.test.mjs sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/cli/memory-repository.report-only.test.mjs sigil/relay/v1/room-report-only.pg.test.mjs
git commit -m "feat(sigil): let report_only members post reports under a marker-counted per-room rate cap

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Only if step 6 was taken, add its files and commit them separately (or amend nothing: use a second commit):

```bash
git add sigil/relay/v1/http-server.mjs sigil/relay/v1/http-server.test.mjs sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs
git commit -m "feat(sigil): add a sender-scoped message status read route as the receipts fallback

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Report formatter, post policy, file locks and durable pending state

**Files:**
- Create: `bridges/v1/file-lock.mjs`, `bridges/v1/file-lock.test.mjs`, `bridges/v1/ironbot-report.mjs`, `bridges/v1/ironbot-report.test.mjs`, `bridges/v1/ironbot-report-concurrency.test.mjs`, `bridges/v1/fixtures/report-poster-child.mjs`
- Modify: `relay/v1/room-report-only.pg.test.mjs` (the pg variant of the response-loss reconcile case; this task depends on Tasks 9-10), the relay client module from Task 1 step 7 (only if it lacks `getMessageReceipts`)

**Interfaces:** Produces `acquireLock`, `withLock`, `renameWithRetry`, `sanitizeField`, `buildReportText`, `buildFleetReport`, `FRESH_MS`, `FINAL_MS`, `createReportState`, `createReportPolicy`, `reportIdempotencyKey`, `postReport` (see "Interfaces fixed up front"). The poster signs once, persists the signed envelope in the state file BEFORE sending, resends the stored bytes only while the envelope is inside the FRESH window, and never resends outside it. Past that it reconciles acceptance through the sender-scoped receipts route. All of one bot's run happens under the per-bot lock. The state also keeps `last_key`, and a run whose key equals `last_key` or the resolved pending key skips as `already_posted`. No `LocalOutbox` change is needed: `LocalOutbox` keeps queued envelopes only in memory, so a rebuilt envelope would get a new `message_id`, timestamps and signature.

- [ ] **Step 1: Read `session-store.mjs`, `local-outbox.mjs`, `local-quarantine-storage.mjs` and the `LocalOutbox` usage in `room-bridge.mjs`**

Copy the atomic write pattern (temp file then rename) and the `outbox.queue` plus `relay.sendEnvelope` call shape; note the `'wx'` open in `local-quarantine-storage.mjs`. Note how the relay answers: 202 with `duplicate: true` for the same key and identical signed bytes (canonical hash), 409 `DUPLICATE_MESSAGE` for the same key with different bytes, `REPLAY_DETECTED` for a `message_id` accepted under another key, and, per Task 1, that `validateEnvelope` runs before the idempotency lookup and rejects a `created_at` more than 5 minutes from the relay clock with `INVALID_ENVELOPE`. A resend is therefore safe only (a) byte for byte and (b) while the envelope is still fresh to the relay. A second process that builds a NEW envelope under the same key gets 409, which is why the state keeps `last_key`. `queue()` signs the envelope it is given, so the poster sets `created_at` and `expires_at` itself (`expires_at` is an envelope field only; there is no pending expiry). Note line numbers.

- [ ] **Step 2: Write failing tests for the lock helper (`file-lock.test.mjs`)**

Use an injectable `now`, `sleep`, `isPidAlive` and `host`. (a) Acquire creates the lock file with `{pid, host, token, acquired_at}`; release removes it. (b) A second acquire on a live, fresh lock waits and throws `LOCK_TIMEOUT` after `waitMs` (use the fake clock; assert the file is untouched). (c) A lock whose pid is not alive on the same host is stolen; a lock from another host is never judged by pid, only by age; a lock older than `staleAfterMs` is stolen even if its pid is alive. (d) Stealing re-reads the lock and compares the token immediately before removing: if another process replaced it in between, the steal backs off and retries instead of removing the new lock. (e) `release()` removes the file only if the token on disk still matches (a stolen lock is left in place). (f) `withLock` releases when `fn` throws and when `fn` rejects. (g) `renameWithRetry` retries `EPERM` and `EBUSY` and succeeds on a later attempt, gives up after `attempts` and rethrows, and rethrows other errors at once.

- [ ] **Step 3: Write failing tests for the poster (`ironbot-report.test.mjs`)**

Sanitization: control characters, bidi overrides (U+202A-202E, U+2066-2069), zero-width characters and non-ASCII are stripped; each field clamps to its max; raw telemetry-looking JSON keys are never copied. Text: `buildReportText` output is ASCII and at most 4000 characters even with a long alert list. Fleet: `buildFleetReport` reads `fleetHealthScore`, `fleetStatus`, `botCount`, `activeBots[]`, `alerts` and ignores `room_id` and `formatted_message`. Policy: first report for a bot posts; same healthy status within 24 hours does not; status change posts; non-healthy status posts every time; 24 hours later posts as heartbeat; the fleet summary posts once per day. State: writes are temp file then `renameWithRetry` (assert via a rename spy that a failure between write and rename leaves the old file intact), the state path is exactly the one passed, a bot id outside the strict pattern is rejected before any lock file name is built, and the shape holds last posted status, time and `last_key` per bot, a monotonic `recreate_count` that is never reset, and at most one `pending` `{message_id, idempotency_key, created_at, report: {status, summary, timestamp}, envelope, state}`. The key is `ironbots_<bot>_<timestamp>`, or `..._r<n>` for `recreate_count` n above zero.

Already posted (`last_key`): after an accepted report with timestamp T, a second `postReport` for the same bot and the same T with a non-healthy status (so the policy would post) returns `{posted:false, reason:'already_posted'}` without calling `outbox.queue` or the transport; the same holds when T equals the key of a pending that was just resolved by a receipts 200 or a FRESH 202. A report with a different timestamp is not skipped. The `last_key` of a recreated report carries its `_r<n>` suffix, so the old unsuffixed report is not mistaken for the new one. Without a report timestamp (no `--report-at`, no file timestamp) each run captures a new timestamp and is a distinct report by design; the policy decides.

Durable retry and reconcile tests run against the real in-process relay with the memory repository, behind a fake transport that can drop the response or drop the request, with the injected `now` also set as the relay's clock (Task 1 step 7 records how the accept path reads its clock). Not a mock that always accepts. `created_at` age is measured on the poster clock: FRESH is under 4 minutes, LOOKUP is 4 minutes up to 6 minutes, FINAL is 6 minutes or more.

- (a) Response lost: the transport delivers the envelope, then throws a network error. `postReport` returns `{posted: false, reason: 'transient'}` and keeps `pending` in state `sending`. Retried inside 4 minutes: identical bytes resent, the relay answers duplicate 202, one stored row, pending cleared, `last_key` recorded. Retried at +6 minutes and again at +7 minutes (separate runs): no `sendEnvelope` call at all, the receipts lookup answers 200, pending cleared, last posted recorded, exactly one stored row, no `INVALID_ENVELOPE`, result `reconciled`.
- (b) Crash before send: state `signed` (crash after persist and before send). Restart at +1 minute sends the stored envelope (fresh window; `outbox.queue` is not called again; state flips to `sending` on disk before the transport is called). Restart at +6 minutes: the `signed` pending is dropped (nothing was ever sent), one fresh envelope is created and sent, one stored row. A `signed` pending at +5 minutes is also dropped at once and the normal policy applies.
- (c) Request lost: the request never reached the relay (state `sending`, relay empty), and the pending report is X while the current report is a different report Y. At +5 minutes: the receipts lookup answers 404, result `pending`, pending kept, no resend. At +6 minutes: 404 means the relay never accepted it and can no longer accept it, so the pending is dropped, `report_recreated_unaccepted` is logged, and the PENDING record's own `report` fields (status, summary, timestamp of X, not Y) are sent as a NEW envelope with a new `message_id`, `created_at` and signature and key `..._r1`; one stored row, and its text is X's. After that the normal policy decides whether Y is also due (a second stored row only if the policy says so); `recreate_count` is 1 and never decreases (a second recreate yields `_r2`).
- (d) Fresh retry and restart: a fresh retry inside 4 minutes resends identical bytes (same `message_id`, `created_at`, signature); a restart with a fresh `LocalOutbox` and no `--report-at` keeps the same `message_id`, `created_at` and signature; boundary cases at 3:59 (resend), 4:00 (lookup, no resend) and 6:00 (final).
- (e) Control case: resend the stored stale bytes straight to the real accept path at +6 minutes; it answers `INVALID_ENVELOPE` although the same bytes were accepted earlier. This proves the freshness rule is needed. Also keep the old control: rebuilding with a new `message_id` under the same idempotency key gets `DUPLICATE_MESSAGE`, which `last_key` and `already_posted` prevent in the poster.
- (f) Receipts transient: a receipts transient failure (network error, 5xx) or auth failure at +6 minutes keeps pending, result `transient`, no resend, no recreate.
- Retry classification (fake transport answers for a fresh envelope): each code in the permanent closed set (`INVALID_ENVELOPE`, `DUPLICATE_MESSAGE`, `REPLAY_DETECTED`, and the report mode, size, mention and thread refusal codes Task 10 defines) drops pending, logs `report_refused`, and returns `refused`. Each of 401, 403, 408, 425, 429 (including `REPORT_RATE_LIMITED`), 500, 503 and a network error keeps pending and returns `transient`. An unknown 4xx code outside the closed set is transient, not a refusal.
- Pending ordering: the state file already holds `pending` with the full envelope when the transport is first called, and `sending` is on disk before the HTTP request. A transient failure keeps `pending`; a later run for that bot with a different status resolves the pending first and creates no new report while it stays unresolved. After a FRESH 202, the normal policy decides whether the current report is due, and a current report whose key equals the resolved pending key or `last_key` sends nothing more (`already_posted`). A receipts-200 reconcile ends the run with `reconciled` and posts nothing else in that run.
- The HTTP request carries a timeout of at most 30000 ms (spy on the transport options).

(g) is the `--drop-pending` case, tested in Task 12. (h) is the pg variant, in the report-only pg suite: the response-loss case (a) at +6 minutes against the Postgres repository with a real `report_only` sender (receipts 200, one row, no `INVALID_ENVELOPE`), which also repeats the receipts-route check for that sender (200 for the sender, 404 for another endpoint). This is the second `report_only` receipts evidence, after the Task 10 pass step.

- [ ] **Step 4: Write failing concurrency tests (`ironbot-report-concurrency.test.mjs`)**

Use real child processes through `child_process` (the fixture `fixtures/report-poster-child.mjs` calls `postReport` with the arguments it is given and prints one JSON result line, including `created: true|false` for whether it signed an envelope, and the `reason`), a real temp directory, and the in-process relay hosted over HTTP on a loopback port (Task 1 step 7 records how). Every child runs under a hard timeout and is killed in a `finally`.

- (a) Two processes for the SAME bot and the SAME report (the same `--report-at` and a non-healthy status, so the policy would post), started together: exactly one result has `created: true`, the relay holds exactly one stored row, and no 409 `DUPLICATE_MESSAGE` occurs. The second process either exits 0 with `already_posted` (it took the bot lock after the first finished and found `last_key` equal), or exits 3 with `lock_timeout` when started with a short bot-lock wait. Neither case creates a second envelope. Without `--report-at` each run is a distinct report by design, so this test always passes the same `--report-at`.
- (b) Two processes for DIFFERENT bots sharing one state file, 20 rounds with a fresh state file per round: first both fail transiently (the relay returns 503), and both pending records survive in the file; then both retry against a healthy relay, and both last-posted entries survive and both pendings are cleared. No round may lose either bot's keys.
- (c) A stale lock whose pid is dead (use the pid of a child that has exited) is stolen and the run proceeds; a lock held by a live process is respected until the wait timeout, then the run exits with reason `lock_timeout` and the state file is unchanged.
- (d) The token check: a holder whose lock was stolen as stale does not delete the new holder's lock on release.
- (e) The helper unit tests for wait timeout and cleanup on exceptions live in `file-lock.test.mjs` (step 2).

- [ ] **Step 5: Run to confirm failure**

Run, one at a time: `timeout 60 node --test sigil/bridges/v1/file-lock.test.mjs`, `timeout 60 node --test sigil/bridges/v1/ironbot-report.test.mjs`, `timeout 120 node --test sigil/bridges/v1/ironbot-report-concurrency.test.mjs`.
Expected: FAIL (modules not found).

- [ ] **Step 6: Implement**

`file-lock.mjs`: `acquireLock` opens the lock path with flag `'wx'`, writes `{pid, host, token, acquired_at}` (random token), and on `EEXIST` retries with backoff until `waitMs`, then throws `LOCK_TIMEOUT`. A lock is stale when its pid is not alive on the same host (`process.kill(pid, 0)` through the injectable `isPidAlive`), or when `acquired_at` is older than `staleAfterMs`. Before removing a stale lock, re-read it and compare the token to the one first read; if it changed, loop instead of removing. `release()` removes the file only if the token on disk still matches. `renameWithRetry` retries `EPERM` and `EBUSY` for `attempts` tries (default from the Task 1 rename finding, else 5) at a short fixed delay. State the residual risk in a code comment: stealing has a small time-of-check window; the relay's idempotency and canonical hash still protect against two sends of the same envelope, and the worst case is one extra independent report, bounded by the per-room rate cap.

`createReportState`: every read-modify-write takes `<statePath>.lock` (wait 5 s, stale 30 s), reads the whole file fresh, changes only this bot's key, writes a temp file, `renameWithRetry`, releases; it is never held across a network call. `withBotLock(bot, fn)` takes `<statePath>.<bot>.lock` (wait 60 s, stale 5 min) and holds it for the whole run. Lock order is always bot lock, then state lock. `recordPosted(bot, {status, at, key})` stores `last_key` with the last status and time.

`postReport` runs inside `state.withBotLock(bot)` (a `LOCK_TIMEOUT` returns `{posted:false, reason:'lock_timeout'}` with nothing changed). It loads `pending` for the bot first and computes its age from the envelope `created_at` against `now`:
- FRESH (under `FRESH_MS`): resend `pending.envelope` untouched (never `outbox.queue`, never rebuild). If state is `signed`, call `markSending` and flush before the request; never set it back. On 202 (including `duplicate: true`) call `recordPosted` with the pending's `idempotency_key` and clear `pending`; on a permanent refusal (a relay code in the closed set: `INVALID_ENVELOPE`, `DUPLICATE_MESSAGE`, `REPLAY_DETECTED`, and the report mode, size, mention and thread refusal codes) drop `pending`, log `report_refused`, return `refused`; every other failure (401, 403, 408, 425, 429 including `REPORT_RATE_LIMITED`, all 5xx, network errors) keeps `pending` and returns `transient`.
- LOOKUP (`FRESH_MS` up to `FINAL_MS`): never resend. State `signed`: drop it and continue to the normal policy. State `sending`: call `relay.getMessageReceipts(message_id)`; 200 means accepted (`recordPosted` with the pending key, clear pending, return `reconciled`); 404 keeps pending and returns `pending`; any other failure keeps pending and returns `transient`.
- FINAL (`FINAL_MS` or more): never resend. State `signed`: drop and continue to the normal policy (nothing was ever sent, so no duplicate is possible). State `sending`: query the receipts route; 200 is `reconciled`; 404 means the relay never accepted it and, past the freshness window, never can, so drop the pending, log `report_recreated_unaccepted`, take `nextRecreateCount` (which increments the bot's `recreate_count`), and send the PENDING record's own `report` fields (status, summary, timestamp), not the current report, as a NEW envelope (new `message_id`, new `created_at` and signature, key `reportIdempotencyKey(bot, pending.report.timestamp, recreate_count)`, i.e. suffixed `_r<n>`), unconditionally and without the `already_posted` check; a transient or auth failure keeps pending and returns `transient`. After that send resolves, the normal policy decides whether the current report is also due.

Once `pending` is resolved, the normal post policy decides whether the current report is due. If it is due and the report timestamp is known (from `--report-at`, from the report file, or from a pending just resolved), compute `key = reportIdempotencyKey(bot, timestamp, recreate_count)`; if `key` equals the state's `last_key` or the key of the pending just resolved, return `{posted:false, reason:'already_posted'}` before signing anything. Otherwise sign a new envelope once through the same outbox path as the bridges, with the reporter's own identity, `message_type` `room.message`, no `thread_root_id`, empty mentions, and a `created_at` and `expires_at` set by the poster; then `savePending` (state `signed`), then `markSending`, then send with the HTTP timeout. Record last posted (status, time and key) only after the relay accepts. If the Task 1 notes say the existing relay client lacks `getMessageReceipts`, add it there as a plain `GET /v1/messages/<id>/receipts` (or the Task 10 step 6 route, if that fallback was taken) that returns `{status}`.

- [ ] **Step 7: Run to confirm pass, with pg evidence**

Run, one at a time: `file-lock.test.mjs`, `ironbot-report.test.mjs`, `ironbot-report-concurrency.test.mjs` (each as `timeout 120 node --test ...`). Then, with `SIGIL_TEST_DATABASE_URL` set to a disposable `_test` database, run `timeout 120 node --test sigil/relay/v1/room-report-only.pg.test.mjs`.
Expected: PASS, with `skipped 0` in the pg run. If no disposable Postgres is available, record "blocked: pg evidence missing" and stop; this task is not done. Record the pg receipts result for the real `report_only` sender in the notes; if it is a 404 for an accepted report, return to Task 10 step 6. Note the Windows risk in the notes: rename over an open file can fail with `EPERM` or `EBUSY`, which `renameWithRetry` retries a few times.

- [ ] **Step 8: Commit**

```bash
git add sigil/bridges/v1/file-lock.mjs sigil/bridges/v1/file-lock.test.mjs sigil/bridges/v1/ironbot-report.mjs sigil/bridges/v1/ironbot-report.test.mjs sigil/bridges/v1/ironbot-report-concurrency.test.mjs sigil/bridges/v1/fixtures/report-poster-child.mjs sigil/relay/v1/room-report-only.pg.test.mjs
git commit -m "feat(sigil): add the Ironbots report poster with file locks, freshness windows and receipts reconcile

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `sigil room report` command and contract

**Files:**
- Create: `cli/room-report-command.mjs`, `cli/room-report-command.test.mjs`
- Modify: `cli/sigil.mjs` (wire `room report`), `contracts/v1/relay-api.json` and `contracts/v1/relay-api.test.mjs` (only if the Task 1 notes show the contract lists response modes)

**Interfaces:** Produces `runRoomReport(argv, deps)` for `sigil room report --identity <path> --relay-url <url> --room <room_id> --bot <id> --status <s> --summary <text> [--alert <text> ...] [--state <path>] [--report-at <iso>] [--drop-pending]` and the `--from-report <ironbots_daily_report.json>` form. Exit codes: 0 posted, reconciled, skipped by policy, or skipped as `already_posted`; 1 usage error; 2 permanent refusal of a fresh envelope, a closed set of relay codes (`INVALID_ENVELOPE`, `DUPLICATE_MESSAGE`, `REPLAY_DETECTED`, and the report mode, size, mention and thread refusals), pending dropped and logged; 3 transient failure (401, 403, 408, 425, 429 including `REPORT_RATE_LIMITED`, all 5xx, network errors), reconciliation pending, or lock timeout, with the pending envelope kept. Other 4xx responses are not permanent refusals. There is no 24 hour pending expiry. `--drop-pending` takes the bot lock, drops that bot's pending record, logs `report_pending_dropped_by_operator`, posts nothing and exits 0; it is for an operator who has checked the room first, and it is documented as such.

- [ ] **Step 1: Read how `sigil.mjs` dispatches `room` subcommands and builds an identity and outbox**

Record the entry points and the flag parser. Reuse them; do not add a second parser.

- [ ] **Step 2: Write failing tests**

Against a fake relay (fixture ids `ep_test_reporter`, `room_test_1`, temp identity and state paths): single report flags post once and exit 0; `--alert` repeats; missing `--room` exits non-zero naming the flag; `--from-report` with a fixture JSON posts a fleet summary built only from structured fields; a report file whose `room_id` is `sigil-fleet-observability` still posts to the `--room` argument (spec assumption 11); `formatted_message` content never appears in the posted text; the default state path is `.sigil/report-state-<endpoint>.json` resolved but the test always passes `--state` so it never touches `.sigil`.

Already posted: a second run with the same `--room`, `--bot`, `--report-at` and a non-healthy status exits 0, prints `already_posted`, and posts nothing (no new row, no 409). A second run with the same healthy status inside 24 hours exits 0 by policy. Without `--report-at` each run is a distinct report by design and the policy decides.

Timestamp and durable retry: `--report-at <iso>` sets the report timestamp and the key `ironbots_<bot>_<timestamp>`; without it the timestamp is captured once when the pending record is first created and persisted; for `--from-report` the report file's own timestamp field wins when present. A 503 from the relay exits 3, keeps `pending` in the state file, and creates no new report for that bot; the next run inside 4 minutes against a healthy relay resends the identical envelope and exits 0.

Restart and reconcile, against the real in-process relay with the memory repository: after a response-loss failure, a second `runRoomReport` with a fresh `LocalOutbox`, fresh deps, a later `now` inside 4 minutes and no `--report-at` resends the same `message_id`, `created_at` and signature, the relay answers duplicate 202, one row exists, exit 0. After a response-loss failure, a run at +6 minutes exits 0 with no resend (receipts 200) and one row. With state `sending` and an unaccepted request (pending report X), a run at +5 minutes exits 3 and sends nothing; a run at +6 minutes re-sends the pending record's own report fields (X, not the current report) as a recreated envelope with the `_r1` key and exits 0, and the normal policy then decides whether the current report is also due. A receipts transient failure exits 3 with pending kept. A bot-lock timeout (a live lock held by the test) exits 3 and changes nothing.

Retry classification: each relay code in the closed set (`INVALID_ENVELOPE`, `DUPLICATE_MESSAGE`, `REPLAY_DETECTED`, and the report mode, size, mention and thread refusal codes) on a fresh envelope exits 2, prints the relay `code` and never a token, and drops pending. Each of 401, 403, 408, 425, 429 (including `REPORT_RATE_LIMITED`), 500, 503 and a network error exits 3 with pending kept. An unknown 4xx code outside the closed set exits 3, not 2.

(g) `--drop-pending`: after a failed post leaves a pending record, `runRoomReport ... --drop-pending` exits 0, prints `report_pending_dropped_by_operator` on stderr, clears the pending record, leaves other bots' records untouched, and sends nothing; the next run applies the normal policy. There is no test or code path for a 24 hour pending expiry.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/cli/room-report-command.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

Parse flags, load the identity, build the report (flags or `buildFleetReport`), create the state with `createReportState` and the policy, call `postReport` (or, for `--drop-pending`, take the bot lock and call `dropPending`), and map its result to the exit codes above (`transient`, `pending` and `lock_timeout` to 3; `refused` to 2; `accepted`, `duplicate`, `reconciled`, `policy` and `already_posted` to 0). Wire `room report` into `sigil.mjs` and add its help line, including `--report-at`, `--drop-pending` and the exit codes.

- [ ] **Step 5: Run to confirm pass**

Run: `timeout 60 node --test sigil/cli/room-report-command.test.mjs`
Expected: PASS.

- [ ] **Step 6: Contract entry (conditional)**

If the Task 1 notes show `relay-api.json` lists response modes, add `report_only` to that enum, extend `relay-api.test.mjs` with an assertion first (run `timeout 60 node --test sigil/contracts/v1/relay-api.test.mjs`, expect FAIL), then edit the JSON and re-run (expect PASS). If it does not list them, skip this step and record that in the commit body. If Task 10 step 6 added a route, add it to the contract in the same way.

- [ ] **Step 7: Commit**

```bash
git add sigil/cli/room-report-command.mjs sigil/cli/room-report-command.test.mjs sigil/cli/sigil.mjs sigil/contracts/v1/relay-api.json sigil/contracts/v1/relay-api.test.mjs
git commit -m "feat(sigil): add the sigil room report command with freshness-window retries and --drop-pending

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

One room, fixture ids only: a resume-capable fake-CLI bridge (`ep_test_resume`) and a replay-mode fake-CLI bridge (`ep_test_replay`, `capabilities.resume = false`), a human, and a `report_only` reporter (`ep_test_reporter`). Assertions: an @mention of each bridge yields a signed reply in the thread; the second turn for the replay bridge carries the replay window and stores no session; a lost-session fake triggers one retry and a stored new session. Two-thread session replacement on the resume bridge: after visiting threads A and B, a `CLI_SESSION_LOST` in A replaces the record (only A's cursor remains), and the next turn in B starts from cursor 0 with the replay window. The reporter posts a report through `postReport`, and afterwards no invocation exists for it, the hop budget is unchanged, the router fake received nothing; an @mention of the reporter creates no invocation; the stored row has `report_post` true. Response-loss retry for the reporter: the transport delivers a report and then fails the response; a retry inside the fresh window resends the stored envelope and the room holds exactly one report row with `pending` cleared; a second case retried at +6 minutes reconciles through the receipts route with no resend, no `INVALID_ENVELOPE`, and still exactly one report row.

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

List the bridges that shipped: `claude`, `codex`, `copilot`, plus `grok` only if Task 6 took Branch A, `hermes` only if Task 7 took Branch A (with the `--agent-toolsets` allowlist drawn from `HERMES_READONLY_TOOLSETS`), and `antigravity` only if Task 8 took Branch A. State the `.exe` requirement for `--agent-command` on Windows. Document `sigil room report` with its flags, `--report-at`, `--drop-pending`, and exit codes 0-3 (0 includes a report skipped as `already_posted`; 2 is a permanent refusal, a closed set of relay codes; 3 is transient, reconciliation pending or lock timeout). State that without `--report-at` each run is a distinct report and the post policy decides. Follow the docs style rules (sentence case, active voice, no first-person plural).

- [ ] **Step 2: Update `STATUS.md` and the help text**

Draft the phase 5 entry and list what stays deferred and where (copy the spec's Deferred table rows, including a deferred Grok, Hermes or Antigravity and the blocked tincan multi-host demo if Grok is deferred). Mark phase 5 done only after step 5 passes; until then the entry reads "in progress" and, when applicable, "blocked: pg evidence missing". Update the `--room-bridge` and `room report` help text in `cli/sigil.mjs`.

- [ ] **Step 3: Write the Ironbots wiring note**

One short page: how a script on the Ironbots host would call `sigil room report --identity <path> --relay-url <url> --room <room_id> --bot <id> --status <s> --summary <text> --state <path>` per bot run and `--from-report` once a day for `ironbots_daily_report.json`; that exit code 3 means "retry later" (transient failure, reconciliation pending, or lock timeout) and the same command either resends the stored envelope (inside 4 minutes of its creation) or reconciles through the relay (after that) and never resends a stale envelope; that exit code 2 is a permanent refusal (a closed set of relay codes) and that other 4xx responses such as 401, 403, 408, 425 and 429 are transient; that passing the same `--report-at` makes repeated calls the same report (a repeat exits 0 as `already_posted`) while omitting it makes each run a distinct report decided by the post policy; that the room id is supplied by the operator; that the operator creates the `report_only` endpoint and adds it to the room; that the state file path must be on a local disk (the lock files next to it are advisory and are not safe on a network share); that the poster and relay clocks must agree within about one minute and the poster HTTP timeout is 30 seconds or less, because a larger clock skew can make the poster treat a pending envelope as final too early and a duplicate report is then possible; that delivery is exactly once except under clock skew above about one minute, a stale-lock steal race, or an operator `--drop-pending` on an accepted report; that a report whose receipts lookup never succeeds stays pending and blocks that bot's later reports (visible as repeated exit 3), and an operator may clear it with `--drop-pending` only after checking the room; that `C:\dev\scripts` is not edited by this plan.

- [ ] **Step 4: Run the core suite from the repository root under a hard timeout**

There is no `sigil/package.json`, so run `npm test` at the repository root, in the background, with `SIGIL_TEST_DATABASE_URL` unset (pg files skip there by design; step 5 is their evidence, and a set variable would let the core run race the sequential gate), and do not start any other `node --test` process meanwhile:

```bash
(timeout --kill-after=30 1500 npm test > "$TMPDIR/phase5-core.log" 2>&1; echo "exit $?" >> "$TMPDIR/phase5-core.log") &
```

Poll with `tail -n 3 "$TMPDIR/phase5-core.log"` until an `exit` line appears. On Windows, if the timeout fires and children survive (including child processes left by the lock and concurrency tests), kill the tree with `taskkill /T /F`. Expected: `exit 0`, with the file-lock, concurrency (child process) and reconcile tests among the passes. Report any failing file by name.

- [ ] **Step 5: Run the live pg gate and record the evidence**

After step 4 finishes, set `SIGIL_TEST_DATABASE_URL` to a disposable database whose name ends in `_test` (a local or docker `postgres:15` database named `sigil_test`; never the dev relay database). Run from the repository root:

```bash
(timeout --kill-after=30 1800 npm run test:live > "$TMPDIR/phase5-live.log" 2>&1; echo "exit $?" >> "$TMPDIR/phase5-live.log") &
```

Poll `tail -n 5 "$TMPDIR/phase5-live.log"` until the `exit` line appears. The runner executes one process at a time with a 120 s per-suite timeout. The phase is complete only if all of these hold:

1. The log lists `migrations/035_report_only_mode.test.mjs` (if it references the variable), `relay/v1/room-report-only.pg.test.mjs` and the report-only dispatch tests, and the totals show `fail 0` and zero skipped in those files.
2. Those files cover migration (including the `report_post` column with default false, the partial index, and an existing non-report row at false), report acceptance and marker persistence, restrictions (mentions, thread, task types, length, invocation isolation), the room-wide rate cap counted from the marker, the membership-change regression (remove and re-add as `mentions_only`, re-add as `report_only`, removed and not re-added), concurrent submissions, duplicate retry, and the response-loss case retried at +6 minutes with a real `report_only` sender, receipts reconcile and no `INVALID_ENVELOPE`.
3. The core suite from step 4 ended with `exit 0`, including the lock helper, same-bot (same `--report-at`, `already_posted`, no 409) and different-bot concurrency, freshness window and reconcile tests, and the `--drop-pending` test.
4. The Task 1 notes record the receipts-route result for ordinary messages in both repositories, and the Task 10 step 5 and Task 11 pg results record it for a real `report_only` sender (or, if the pg half was unverified earlier, this step supplies it); if the Task 10 step 6 fallback route was taken, its tests appear in the log.

Record the commands, the totals and the skipped counts in the verification notes file. If no disposable Postgres is available, record "blocked: pg evidence missing" there and in `STATUS.md`, leave the phase open, and stop. Core-suite evidence alone never marks the phase done.

- [ ] **Step 6: Check LF endings on every new or edited file**

Run `file <path>` for each file this plan touched; none may report CRLF.

- [ ] **Step 7: Write the design-to-task checklist**

Append to the verification notes a checklist mapping each spec section to its task: Scope reading and Decisions (Tasks 2-3), CLI bridge contract and registry (2-4), Copilot (5), Grok CLI (1, 6; written deferral if Task 1 says no-go), Hermes (1, 7; written deferral if no-go), Antigravity (1, 8), Replay and recovery (4), Ironbots report posting (1, 9-12, including freshness windows, receipts reconcile, `last_key` and `already_posted`, retry classification, locks and `--drop-pending`), Loop guards and catch-up (3, 4, 10, 14), Data (9, 10), CLI (2, 7, 12), Deferred (15), Testing (3-14), Assumptions (the design has assumptions 1-16; the checklist maps each to the task named in it, and lists which are unverified until Task 1 or a pg run: 4 (gates Task 6, unverified until Task 1), 12 (gates Task 7, unverified until Task 1), 14 (receipts route, unverified until Task 1 for ordinary messages and until the Task 10 pass step and the Task 11 pg test for a real `report_only` sender), 15 (clock agreement, HTTP timeout, advisory local-disk locks, rename behavior), 16 (acceptance timestamp column: Task 1 reads the schema, Task 9 chooses the index column, Task 10 uses the same choice), and the pg evidence in 13), Open questions (recorded, unchanged), Interaction with phase 6 (migration renumber in 9, shared files in 2 and 10, shared session-store format in 4, no overlap for the receipts route and lock helper, `http-server.mjs` only if the Task 10 step 6 fallback is taken), and the design's Review changes (items 1-6 in Tasks 4, 6, 7, 10, 11, 15; item 7, the freshness window and receipts reconcile, in Tasks 1, 11 and 12; item 8, cross-process locking, in Task 11; item 9, the relay-assigned report marker, in Tasks 9 and 10; item 10, the second-round fixes, in Tasks 1 (ordinary-message receipts check), 9 (index column choice), 10 (`report_only` receipts repeat, new `countRecentReports`), 11 (`last_key`, `already_posted`, classification, FINAL recreate of the pending report, `recreate_count`) and 12 (exit codes)).

- [ ] **Step 8: Commit**

```bash
git add README.md STATUS.md sigil/cli/sigil.mjs docs/superpowers/plans/2026-10-16-phase-5-ironbots-wiring-note.md docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md
git commit -m "docs: document phase 5 bridges, room report, and the Ironbots wiring note

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
