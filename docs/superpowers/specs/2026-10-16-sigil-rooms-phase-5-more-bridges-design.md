# Sigil rooms phase 5: more bridges and Ironbots report posting - design

Status: revised after review, 2026-10-16.
Parent spec: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` ("Delivery phases" item 5, bridge table).
Builds on: phases 1-4 (relay rooms, Claude and Codex bridges, router, browser surface and web client) and the multi-human foundation. Phase 6 (`docs/sigil-rooms-phase6-floor-warden-bridge` branch, commit 49ddd39) is a sibling design; see "Interaction with phase 6".
Inputs also read: the installed CLIs' `--help` output on WIN-DTA4V21LKVR (2026-10-16, read-only, no prompts run) and the 2026-10-16 rooms research notes. The notes are working papers outside the repo; this spec quotes what it uses.

## Goal

A person can @mention a GitHub Copilot, xAI Grok, or Hermes agent in a room and get a signed answer in the thread, as Claude and Codex answer today. The Grok and Hermes bridges each ship only if their Task 1 safety gate passes, like Antigravity (which also needs a headless-mode spike). The Ironbots fleet can post run reports into a room as signed `room.message` rows from its own endpoint.

## Scope

In scope:
- A shared CLI bridge contract, a CLI registry, and `grok` as a valid `--room-bridge` value in both places that list bridge kinds (if the Grok bridge ships).
- Bridges for GitHub Copilot CLI, xAI Grok CLI, and Hermes Agent. Grok and Hermes each ship only if their Task 1 gate passes (Grok: Stop cancels the model turn; Hermes: verified read-only toolsets).
- An Antigravity spike (Task 1) that ends as a bridge or a written deferral.
- Replay mode for CLIs without resume, and lost-session recovery.
- Ironbots report posting: a `report_only` response mode, one relay exemption, a poster module with durable retry, and a `room report` CLI.
- Conformance, forbidden-flag, and environment tests for every new bridge.

Out of scope, with the reason:
- Ironbots requests, command lists, and per-bot endpoints. Phase 6 owns the request half and the narrow-command-list design.
- Creating `ep_ironbots` or any bridge endpoint, and adding them to rooms. This is an operator step outside the phase. Tests use fixture ids.
- Editing `C:\dev\scripts`. The bots live outside the sigil repo. The phase ships the poster and a documented invocation; Chris or a later step wires it in.
- The Floor Warden bridge, Grok bots, and the visible loop guards (cap event, Continue, halt event). Phase 6.
- Everything in "Deferred to later phases".

## Scope reading

Chosen reading of "phase 5": four CLI bridges (Copilot, plus Antigravity, xAI Grok CLI, and Hermes, each gated) and step one of Ironbots, one-way report posting. Ironbots requests stay in phase 6, whose design says: "Ironbots requests. They are the other half of the parent spec's phase 6 and get their own design."

Name clash: xAI Grok CLI is a local program (`grok`) that a bridge spawns. It is unrelated to the Grok bots of phase 6 (Chief and Helix CI Triage in the Grok Bot app, reached through the Floor Warden webhook). This spec uses "Grok CLI" for the first and never for the second.

Rejected readings:
- A. CLI bridges only, all Ironbots work in phase 6. Rejected: the master design lists report posting in phase 5.
- B. Include Ironbots requests. Rejected: phase 6 owns them.
- C. One endpoint per Ironbot (9). Rejected: no policy difference for one-way text; open question for phase 6.
- D. Relay-authored `room.event` rows via a new route. Rejected: loses the reporter's own signature; the master design says `room.message`.
- E. Reporter as a normal agent inside an invocation. Rejected: no invocation exists, and `assertAgentMayPost` throws `ROOM_NOT_INVOKED`.
- F. Build Antigravity assuming a headless CLI. Rejected: none found; gated on a spike.
- G. Pull Hyperagent-derived items (notes, Canvas, approval cards, budgets, schedules, webhooks) into phase 5. Rejected: later phases.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Bridge shape | Each new CLI is a factory like `createClaudeCli`, returning `{name, capabilities, run({prompt, sessionId, signal})}` | `room-bridge.mjs` already drives any such object. No bridge-loop change. |
| Registry | One registry module maps bridge kind to factory. `sigil.mjs` and `wake-dispatcher.mjs` both read it | Two hard-coded lists exist today (a ternary and `BRIDGES`). A shared registry keeps them equal. |
| Process control and auto-approve | Every CLI runs through `runCli`; none is launched with an approve-all or bypass flag | No shell, capped output, process tree killed on abort and timeout. Tests assert the forbidden flags are absent from argv. |
| Prompt delivery | Stdin or a prompt file where the CLI supports it, argv otherwise | Argv exposes the prompt in the process list and hits the Windows length limit (assumption 2). |
| Hermes | Default-deny toolsets from a verified constant; replay mode | Oneshot auto-approves, and it reports no session id. Deferred if no toolset verifies read-only. |
| Grok | Ships only if Task 1 verifies Stop cancels the model turn | A killed client may leave a leader-owned turn running. Otherwise deferred, no documenting-around. |
| Antigravity | Spike first, bridge only on success | No headless agent CLI was found. |
| Reporter identity | One `report_only` agent endpoint | It is an agent, so it never counts as human. It is not invocable, so an @mention creates nothing nobody serves. |
| Report relay path | Exemption in `assertAgentMayPost` for `report_only` senders | Smallest change. The accept path, signing, and fan-out stay as they are. |
| Report retries | Poster signs once, persists the signed envelope before sending, and resends it byte for byte | The relay compares canonical hashes, not only keys; a rebuilt envelope fails. |
| Report rate cap | Per room across all reporters, checked under the room lock | A per-reporter count lets several reporters exceed the cap and races under concurrency. |
| Session replacement | A changed session id replaces the whole session record | One CLI session serves all threads, so stale cursors would claim unseen messages. |
| System endpoint as reporter | Rejected | A `system` endpoint is neither agent nor human, so dispatch would treat it as human, refill the hop budget, and reach the router. |
| Post policy | Post on status change, on non-healthy status, and on a 24 hour heartbeat; fleet daily summary always | Two bots run every 15 minutes (96 runs a day). Posting each run floods the room. |
| New bridge endpoints | Created `mentions_only` with `invokable_by` owner | Matches the research: ask before agent-to-agent requests, connector owns the agent. |

## Components

### CLI bridge contract and registry

Each CLI object has `name`, `capabilities: {resume: boolean}`, and `run({prompt, sessionId, signal})` returning `{text, sessionId}`. The registry exposes the list of kinds and a `createCli(kind, options)` function. `sigil.mjs` replaces its ternary with the registry. `wake-dispatcher.mjs` builds `BRIDGES` from the registry kinds plus `router`. After the change both accept the same set: `claude`, `codex`, `copilot`, `router`, plus `grok`, `hermes`, and `antigravity` only when each one's Task 1 gate passes (a deferred kind is omitted). The tincan plan (2026-10-09) and its handoff say the multi-host demo is "Awaiting the addition of grok to the --room-bridge flags in Phase 5", so `grok` is the required value and a Grok deferral blocks that demo.

Shared rules, enforced by one table-driven conformance suite over all factories using `fixtures/fake-agent-cli.mjs`:
- The CLI is spawned through `runCli` with `agentEnv`. The relay token and unrelated keys never reach the child. Each CLI may add its own auth prefix to the allowlist (assumption 6).
- Session ids pass `assertSessionId` (`SESSION_ID_PATTERN`) before use.
- Output the parser cannot read throws `CLI_INVALID_OUTPUT`, as `parseClaudeOutput` does.
- A Stop (the relay no longer shows the invocation running) kills the process tree. A timeout does too.
- `--agent-command` must name an `.exe`. Spawning without a shell cannot run `.cmd` shims on Windows (assumption 9).

### GitHub Copilot CLI (1.0.97)

Headless: `-p/--prompt`, `-s/--silent`, `--output-format json` (JSONL). Resume: `--resume <id>`, and `--session-id=<uuid>` starts a session with a chosen id, so the bridge can name new sessions itself.

| Flags it uses | Purpose |
|---|---|
| `-p`, `-s`, `--output-format json` | Headless run, response only, parseable output |
| `--resume <id>`, `--session-id=<uuid>` | Resume, or start with a known id |
| `--available-tools`, `--excluded-tools`, `--allow-tool`, `--deny-tool` | Read-only tool set |
| `--no-ask-user`, `--no-auto-update` | No prompts, no self-update during a run |
| `--usage-output-file` | Deferred (see later phases) |

Flags it never uses: `--allow-all`, `--yolo`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`.

Task 1 must verify: whether stdin can carry the prompt, the JSONL event shapes, and the auth source.

### xAI Grok CLI (1.0.52)

Headless: `-p/--single` or `--prompt-file`, with `--output-format json`. Resume: `--resume <id>`, and `--session-id <uuid>` for a chosen id. The CLI talks to a background leader process.

| Flags it uses | Purpose |
|---|---|
| `--prompt-file <path>` (or stdin if Task 1 confirms) | Keeps the prompt out of argv |
| `--output-format json` | Parseable output |
| `--resume <id>`, `--session-id <uuid>` | Resume, or start with a known id |
| `--tools <list>`, `--disallowed-tools`, `--permission-mode default` | Read-only tool set |
| `--max-turns`, `--cwd`, `--disable-web-search`, `--no-subagents` | Bounded runs |

Flags it never uses: `--always-approve`, `--permission-mode bypassPermissions`.

Ship gate (assumption 4). The bridge ships only if Task 1 verifies that Stop and timeout cancel the actual model turn, not just the client process. Accepted evidence: (a) killing the client ends the leader-owned turn, shown by real observation after the kill (the session transcript or leader activity stops advancing for a defined quiet period and no assistant answer completes later), or (b) the CLI offers an explicit cancel or stop command that the bridge calls on abort, with the same observation. Killing a fake client does not count. If neither is verified, Task 1 ends in Branch B: a written deferral with evidence, the registry omits `grok`, and the design does not document around the gap. Task 1 must also verify the JSON output shape. A bridge-level test uses a new mode in `fixtures/fake-agent-cli.mjs` (fake client plus fake leader): the leader keeps a turn running after the client dies unless the bridge issues the cancel path, and the test asserts the turn marker stops on abort and on timeout. It covers the bridge's cancel logic only and does not replace the Task 1 real-CLI verification.

### Hermes Agent (0.21.2)

Headless: `-z/--oneshot <PROMPT>` prints only the final response text and no session id. Per `--help`, "approvals are auto-bypassed", and AGENTS.md in the working directory loads as normal.

| Flags it uses | Purpose |
|---|---|
| `-z <prompt>` | Oneshot run |
| `-t/--toolsets <list>` | Verified read-only toolsets, required |
| `--ignore-user-config`, `--ignore-rules` | Keep local config and rules out of a room run (Task 1 confirms effect) |
| `--usage-file` | Deferred |

Flags it never uses: `--yolo`.

Because oneshot auto-approves, the bridge is default-deny. `hermes-cli.mjs` exports a frozen `HERMES_READONLY_TOOLSETS`. Task 1 fills it only with toolsets it verified read-only, by reading the toolset listing for the tools each contains and by a canary probe in the temp directory (ask the CLI to create a file or run a command with that toolset; confirm no file exists afterwards and the CLI reports the tool unavailable). The factory parses `--agent-toolsets` (comma separated, trimmed, empty entries rejected, strict name pattern) and throws `HERMES_TOOLSET_NOT_ALLOWED` naming the offending entry for any name outside the constant, including unknown names, aliases, and composite or broader toolsets. An empty list throws `HERMES_TOOLSETS_REQUIRED`. Validation runs in the factory and again at the `sigil.mjs` flag parse, before any process is spawned. No wildcard, no `all`, no default. If Task 1 verifies no read-only toolset, or finds that `-t` does not restrict oneshot runs, the Hermes bridge is deferred (Branch B, written deferral, registry omits `hermes`, as for Antigravity). Hermes `--help` says oneshot bypasses approvals, so this check is Hermes specific. `--safe-mode` is not used until Task 1 learns what it does. `capabilities.resume` is false (assumption 3).

### Antigravity

PATH holds no `agy` or `antigravity`. The only launcher is `antigravity-ide(.cmd)`, an IDE launcher. Task 1 is a spike: look for a headless prompt mode, a session-resume mode, and a tool allowlist. Outcomes:
- Found: the bridge follows the same contract. Read-only tool allowlist, no `high` risk-tier capabilities, no auto-approve. The master design gives the reason: Antigravity once faked an approval and force-pushed during IronLedger Phase 1 (2026-09-01).
- Not found: Task 1 ends with a written deferral in the plan and the registry omits `antigravity`. This is an accepted outcome of the phase.

### Replay mode and lost-session recovery

- Replay mode. When `cli.capabilities.resume` is false (Hermes), the bridge ignores the watermark and puts the last `threadContextLimit` (20) messages of the thread in the prompt every turn. This is the master design's fallback. It stores no session id.
- Lost-session recovery. If a resumed run fails because the CLI no longer has the session, the bridge retries once with no session id and the replay window. A second failure fails the invocation as today. How each CLI signals a missing session is a Task 1 verification item.
- Session replacement. The store holds one entry per room, `{session_id, last_seq_by_thread}`, and one CLI session serves every thread of the room. Whenever the stored session id changes (lost-session recovery, or `result.sessionId` differing from the resumed id for any reason), the bridge replaces the whole record with `{session_id: new, last_seq_by_thread: {[currentThread]: context.lastSeq}}` and drops every other cursor. A later turn in a previously visited thread starts at cursor 0 with the 20-message window. With an unchanged id, other cursors are kept as today.
- The session-store file format does not change. Phase 6 uses the same format, and its Floor Warden `catch_up` watermark is per bot and not tied to a CLI session, so it is unaffected.

### Ironbots report posting

Reporter endpoint. One agent endpoint (fixture name `ep_ironbots`) posts `room.message` reports signed with its own key. It uses the same `LocalOutbox` and `relay.sendEnvelope` path the bridges use. The identity file stays on the Ironbots host.

`report_only` mode. A new `response_mode` value. A `report_only` member:
- is an agent (`response_mode != null`), so it never counts as human: no hop-budget refill, no router delivery;
- is not invocable (`isInvocableAgent` stays `joins` or `mentions_only`), so an @mention of it creates no invocation;
- never receives deliveries;
- is set only when the member is added, by an owner or room manager. The set-response-mode route refuses a change to or from `report_only`.

The mode joins `RESPONSE_MODES` in `room-routes.mjs`, which the add-member and set-response-mode handlers both read. The roster panel in the web client renders it read-only.

Relay rules for a report. `assertAgentMayPost` gains one exemption: a `report_only` sender may post a top-level `room.message` without an invocation. The relay enforces:
- `message_type` is `room.message` only (no `task.request`, no `task.result`);
- no `thread_root_id`;
- `mentions` is empty;
- text is at most 4000 characters;
- a rate cap per room across all `report_only` reporters, starting at 30 reports per rolling hour, answered with `429 REPORT_RATE_LIMITED` (assumption 8).

The idempotency lookup runs before the rate check, so a retry of an already accepted report at the cap returns 202 duplicate, not 429 (Task 10 verifies this against the accept path and moves the check if needed). The check runs inside the accept transaction after `repository.lockRoom(client, conversationId)`, the `FOR UPDATE` room row lock `assignRoomSequence` takes, so count and insert happen under one lock. Task 1 step 7 records whether `assertAgentMayPost` already runs under that lock; if not, Task 10 calls `lockRoom` first. The memory repository counts and inserts in one synchronous section. A report never dispatches anything.

Poster (`bridges/v1/ironbot-report.mjs`, new). It builds ASCII text from structured fields: bot id, status, timestamp, one-line summary, and an optional alert list. It strips control and bidi characters, clamps each field, and never includes raw telemetry blobs. Telemetry strings can carry scraped or log text (for example `driftFindings` and `recentIssues`), so report text is untrusted content to every agent that later reads the room, and the poster passes only fields it clamps.

Post policy. A bot's report is posted when its status differs from the last posted status for that bot, when the status is not healthy, or when 24 hours have passed since its last post. The fleet daily summary is always posted once a day. The idempotency key is `ironbots_<bot>_<timestamp>`. The CLI has no report timestamp today, so `--report-at <iso>` is added. If omitted, the timestamp is captured once when the pending record is first created and persisted; for `--from-report`, the report file's own timestamp field wins when present.

Durable retry. The relay keys idempotency on (sender endpoint_id, idempotency_key) and compares `canonical_hash`, the sha256 of the signed bytes: the same key with identical bytes returns 202 with `duplicate: true`, the same key with different bytes returns 409 `DUPLICATE_MESSAGE`, and a `message_id` already accepted under another key returns `REPLAY_DETECTED`. `LocalOutbox` keeps envelopes only in an in-memory Map and `queue()` signs a new envelope, so a rebuilt envelope after a restart has a new `message_id`, timestamps and signature. A retry is safe only if it resends the byte-identical signed envelope. The poster therefore signs once and persists a signed pending envelope in the state file before sending (default `.sigil/report-state-<endpoint>.json`, path flag; atomic temp file then rename, as `session-store.mjs`). State per bot: last posted status and time, plus at most one `pending` record `{idempotency_key, report (status, summary, timestamp), envelope (the full signed envelope), created_at}`. A retry (same process, later run, or after a restart) first resends the stored envelope byte for byte and never calls `outbox.queue` or rebuilds it. After `pending` is resolved, the normal post policy decides whether the current report is due. No `LocalOutbox` change is needed. The existing room-bridge reply path has the same in-memory outbox but fails the invocation instead of retrying, so it is out of scope. Phase 6 overlap: none (Floor Warden signs with relay-held keys).
- On 202 (including `duplicate: true`) it records the last-posted status and clears `pending`.
- On a transient failure (network error, 5xx, 429) it keeps `pending`, creates no new report for that bot, and exits with code 3.
- If the stored `expires_at` (`created_at` + 24 hours) has passed, it drops `pending` without rebuilding, logs a `report_expired_unconfirmed` notice, and exits 2. A rebuilt envelope under the old key could fail with `DUPLICATE_MESSAGE`.

Room id. The daily report file already carries a `roomEvent` object with `room_id: 'sigil-fleet-observability'`. That is not a Sigil room id (rooms are `room_<uuid>`). The poster takes the room id as an argument and does not trust the field.

CLI:
- `sigil room report --identity <path> --relay-url <url> --room <room_id> --bot <id> --status <s> --summary <text> [--alert <text> ...] [--state <path>] [--report-at <iso>]`
- `sigil room report ... --from-report <ironbots_daily_report.json>` posts the fleet summary built from the structured fields of that file (`fleetHealthScore`, `fleetStatus`, `botCount`, `activeBots[]`, `alerts`). It ignores `formatted_message`, which contains mojibake.

This is one-way. No invocation and no request entry point exist (phase 6).

## Loop guards and catch-up

Inherited, unchanged, for every new bridge: the hop budget (`max_agent_turns`, default 6 per thread after the latest human message), one running invocation per agent per room, and Stop (the bridge polls its invocation and kills the CLI tree).

Phase 5 adds:
1. A conformance test that each new bridge dies on Stop and on timeout. For Grok, real-CLI turn cancellation is a Task 1 ship gate.
2. A per-bridge rule that no CLI is launched with an auto-approve or bypass flag. Tests assert the forbidden flags are absent from argv.
3. The `report_only` path cannot dispatch, refill budgets, or mention, and it has a room-wide rate cap.

Phase 6 owns the visible guards: `agent_cap_reached`, Continue, signed `room_halted`, `invocation_failed`, and mention-free bot replies. Phase 5 does not redefine them and works without them. The research on Hermes bot-to-bot loops and silent capped handoffs concerns its Discord gateway, not this CLI. It is why phase 5 leans on the existing hop budget plus conformance tests.

Catch-up already exists for Claude and Codex as a per-thread watermark (`last_seq_by_thread`) in the session store. Phase 5 adds `capabilities.resume`, replay mode, lost-session recovery, and whole-record replacement on a session change. Phase 6 defines the Floor Warden `catch_up` object on the same store format.

## Data

New migration `035_report_only_mode.sql` (assumption 10 covers the number): drops and re-adds `conversation_members_response_mode_check` to include `report_only`. Migration 030 did the same for `router`, and 027 created the original check. No new tables. A migration test follows the pattern of `030_room_router.test.mjs`.

`countRecentReports({conversationId, endpointId, sinceMs, now})` becomes `countRecentReports({conversationId, sinceMs, now})`. It counts accepted `room.message` rows in that room sent by any `report_only` member (Postgres: envelopes joined to the room's members with `response_mode = 'report_only'`). Both `postgres-repository.mjs` and `cli/memory-repository.mjs` get every new method, including the lock path: Postgres already has `lockRoom`, and the memory repository gets the matching synchronous section.

## CLI

- `sigil agent run --room-bridge claude|codex|copilot|grok|hermes|router` (`grok`, `hermes`, and `antigravity` only if their gates pass). `--agent-command` names the executable and must be an `.exe` on Windows.
- `--agent-toolsets <list>` is required for `hermes`, validated against `HERMES_READONLY_TOOLSETS`, and optional for the others, where it maps to that CLI's tool allowlist.
- `sigil room report` as above, with `--report-at <iso>`. Exit 2: expired pending dropped. Exit 3: transient failure, pending kept.
- Existing flags (`--agent-cwd`, `--room-sessions`) are unchanged.

## Deferred to later phases

| Item | Why not now | Where it goes |
|---|---|---|
| Grok CLI bridge, if Stop does not cancel the turn | Task 1 gate failed; blocks the tincan multi-host demo | Revisit when the CLI exposes a verified cancel |
| Hermes bridge, if no toolset verifies read-only or `-t` does not restrict oneshot | Task 1 gate failed | Revisit with a CLI that restricts oneshot |
| Ironbots requests and per-bot endpoints | Needs the narrow-command-list design | Phase 6 |
| Floor Warden bridge and Grok bots | Not CLI bridges | Phase 6 |
| Visible loop guards | Phase 6 owns them | Phase 6 |
| Enforced cost budgets, per-bridge cost capture (Copilot `--usage-output-file`, Hermes `--usage-file`) | No budget layer yet; `room_invocations.cost_units` exists | Rooms polish phase |
| Approval cards via WebAuthn | Needs its own spec | About phase 4c |
| Signed webhooks and schedules | Needs an automation design | Room automation phase after phase 7 |
| Notes, Canvas, decision log | New surface | New phase |
| Federated rooms | Cross-relay design | Later phase |
| Visible moderator router mode | Not needed for bridges | Later phase |
| Agent-to-agent opt-in handoff for bots | Needs loop analysis | Later phase |
| Streaming partial output | Master design marks it v2 | v2 |
| Per-CLI model selection UI | Polish | Rooms polish phase |

## Testing

- Conformance: a table-driven suite over all CLI factories with `fixtures/fake-agent-cli.mjs`, in the style of `agent-cli.test.mjs`.
- Parser tests per CLI from captured fixtures (Task 1 captures scrubbed real output); forbidden-flag assertions per CLI; environment test: the relay token and unrelated keys never reach the child, and per-CLI auth prefixes do.
- Hermes toolsets: each rejection case (unknown, alias, composite, empty entry, bad pattern, empty list) throws the right code, and the spawn function is never called on rejection, in the factory and at the flag parse.
- Stop and timeout kill tests (pattern of `cli-runner.test.mjs`). Grok adds the fake client plus fake leader test: the leader's turn marker stops on abort and on timeout.
- Resume, lost-session recovery, and replay-mode tests. In `room-bridge.test.mjs`: visit threads A and B on session S1; thread A gets `CLI_SESSION_LOST` and the retry creates S2; the stored record holds only A's cursor; an invocation in thread B then has a prompt with B's earlier messages (cursor 0, up to 20) and exactly one run with S2. An unchanged-session case keeps the other thread's cursor.
- Registry tests (`sigil.mjs` and `wake-dispatcher.mjs` accept the same kinds) and the migration test.
- `report_only` relay tests in memory and `*.pg.test.mjs`: allowed post; refused with mentions, a thread id, `task.request`, or over 4000 characters; no hop-budget refill; an @mention of the reporter creates no invocation; mode edit refused. Rate cap: two reporter endpoints with 15 reports each fill the cap and the next post from either gets 429 `REPORT_RATE_LIMITED`; a duplicate retry at the cap returns 202; after the window passes a post is accepted; a pg test submits 36 posts from both reporters with `Promise.all` over separate connections and expects exactly 30 accepted, 6 refused, and 30 rows.
- Poster tests: sanitization, post policy, atomic state file, `--report-at`, idempotency, run against the real in-process relay with the memory repository (not a mock that always accepts). (a) Accepted then the response is lost: the fake transport delivers the envelope, then throws a network error; the retry resends identical bytes, the relay answers duplicate 202, one stored row, no `DUPLICATE_MESSAGE`, pending cleared. (b) Restart: a fresh `LocalOutbox`, fresh deps and a later `now` with no `--report-at` resend the same `message_id`, `created_at` and signature. (c) Crash after persist and before send: the retry sends the stored envelope. (d) Expired pending is dropped, not rebuilt. (e) Control case: rebuilding with a new `message_id` gets `DUPLICATE_MESSAGE` from the real accept path. (f) A pg variant of (a) in the report-only pg suite.
- `room report` CLI test, including exit codes 2 and 3; exit test: two fake-CLI bridges and a reporter in one room, in the pattern of `rooms-exit.test.mjs`.
- Live smoke: an extension of `scripts/live-room-bridges.mjs` for real `copilot`, `grok`, and `hermes`. It costs credits, so it runs only behind an opt-in environment flag, with read-only tools and a short prompt. It includes an opt-in Grok Stop check.

Tests use fixture endpoint ids. They never read, print, or commit `.sigil/*.json`.

## Assumptions

1. Copilot and Grok CLI JSON output shapes and session id fields are not known. Task 1 must verify them.
2. Copilot and Hermes may not accept the prompt on stdin. If not, the prompt goes in argv, with the Windows length limit and process-list exposure noted. Grok uses `--prompt-file` or stdin. Task 1 tests each.
3. Hermes oneshot cannot report a session id, so it runs in replay mode. Task 1 must confirm.
4. Unverified, and the shipping gate for Grok: Stop and timeout cancel the actual model turn, not just the client process, under the evidence rules in the Grok section. Nothing about the real Grok CLI has been run.
5. Antigravity has no headless CLI on this machine. The Task 1 spike repeats the PATH search and reads the launcher's help.
6. Each CLI authenticates from its own stored login, not from env vars. If one needs an env var, only that CLI's prefix is allowlisted, and never `GITHUB_TOKEN` or `GH_TOKEN` by default. Task 1 must check with the allowlisted environment.
7. Installed versions (Copilot 1.0.97, Grok 1.0.52, Hermes 0.21.2) and flags may change. The spike records versions in the fixture headers.
8. The reporter cap of 30 per room per hour (across all reporters) and the 4000-character limit are starting values, tunable after real use.
9. A shell-less spawn cannot run `.cmd` shims on Windows, so `--agent-command` must name an `.exe`. A test spawns a `.cmd` path and expects `CLI_START_FAILED`.
10. Migration 035 may be taken by phase 6. Re-check the number against `main` at execution and renumber.
11. The room id for reports comes from the operator. The report file's `room_id` is not trusted. A test feeds a file with a non-room value and expects the argument to win.
12. Unverified, and the shipping gate for Hermes: `-t` restricts oneshot runs, and at least one toolset is read-only by listing and canary probe. Task 1 must verify both.
13. PostgreSQL evidence is required before the phase is done; none has been gathered yet. There is no `sigil/package.json`: `npm test` runs from the repository root, and `npm run test:live` (root) runs `sigil/scripts/live-db-tests.mjs`. It needs `SIGIL_TEST_DATABASE_URL` (exit 1 if unset) naming a disposable database whose name ends in `_test`, runs suites one process at a time with a 120 s per-suite timeout, and prints `skipped`. Pg test files skip individually when the variable is unset, so a run without it proves nothing. Task 9 step 5, Task 10 step 5 and Task 15 need a pg run with `skipped 0` under hard timeouts; without a disposable database (for example a local or docker `postgres:15` with a database named `sigil_test`, never the dev relay database) they record "blocked: pg evidence missing" and the phase stays open.

## Open questions

1. Should phase 6 give each Ironbot its own endpoint once bots are invocable, or keep one reporter plus a command list? This phase assumes one reporter.
2. Is 30 reports per room per hour right for a fleet of nine bots plus a daily summary? It is a starting value only.
3. If the Antigravity spike fails, should the registry reserve the `antigravity` kind with a clear "not available" error, or omit it? This spec omits it, as it does `grok` and `hermes` on a deferral.
4. Should a `report_only` post also mark the room unread differently in the web client? Not designed here.
5. If the Grok gate fails, how does the tincan multi-host demo proceed without `grok` as a `--room-bridge` value? The deferral blocks it.

## Interaction with phase 6

Both phases touch the same four things:
- The `--room-bridge` flag in `sigil/cli/sigil.mjs`. Phase 5 adds `copilot` and, if their gates pass, `grok` and `hermes` through the registry. Phase 6 adds `floor-warden`.
- `BRIDGES` in `wake-dispatcher.mjs`. Same two changes.
- `room-dispatch.mjs`. Phase 5 adds the `report_only` exemption to `assertAgentMayPost`. Phase 6 edits the same file for the cap event, and its reply route reaches the same accept path.
- The migration number. Phase 5 proposes 035. Phase 6 proposes `035_floor_warden_bridge.sql`. Whichever lands second renumbers.

Phase 5 lands first and does not depend on phase 6. It uses the existing hop budget and Stop, and it does not need the cap event, Continue, or halt event. Phase 6 then rebases onto the registry and the shared `RESPONSE_MODES` set. If phase 6 lands first instead, phase 5 renumbers its migration and rebases the same files, with no design change. Review fixes that touch phase 6: report retry has no overlap (Floor Warden signs with relay-held keys); session replacement leaves the per-bot `catch_up` watermark unaffected and the store format shared; phase 6's Grok bots are Floor Warden, not this CLI, so a Grok CLI deferral does not affect them.

## Review changes

1. Report retries persist the signed pending envelope and resend it byte for byte; `--report-at`, exit code 3, expiry, and relay-backed tests added.
2. Hermes is default-deny against a verified `HERMES_READONLY_TOOLSETS`, checked before any spawn; deferred if none verifies.
3. The Grok bridge ships only if Task 1 verifies Stop cancels the model turn; otherwise deferred, with a bridge-level cancel test and the tincan demo consequence stated.
4. A changed session id replaces the whole session record, so other threads restart at cursor 0.
5. The report rate cap is per room across all reporters, checked under the room lock after the idempotency lookup.
6. Final verification requires a pg run with `skipped 0`; the phase stays open without it.
