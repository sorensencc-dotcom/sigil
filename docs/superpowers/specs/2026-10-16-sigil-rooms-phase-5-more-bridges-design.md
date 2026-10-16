# Sigil rooms phase 5: more bridges and Ironbots report posting - design

Status: draft for review, 2026-10-16.
Parent spec: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` ("Delivery phases" item 5, bridge table).
Builds on: phases 1-4 (relay rooms, Claude and Codex bridges, router, browser surface and web client) and the multi-human foundation. Phase 6 (`docs/sigil-rooms-phase6-floor-warden-bridge` branch, commit 49ddd39) is a sibling design; see "Interaction with phase 6".
Inputs also read: the installed CLIs' `--help` output on WIN-DTA4V21LKVR (2026-10-16, read-only, no prompts run) and the 2026-10-16 rooms research notes. The notes are working papers outside the repo; this spec quotes what it uses.

## Goal

A person can @mention a GitHub Copilot, xAI Grok, or Hermes agent in a room and get a signed answer in the thread, the same way Claude and Codex answer today. The Ironbots fleet can post its run reports into a room as signed `room.message` rows from its own endpoint. An Antigravity bridge ships only if a Task 1 spike finds a headless mode.

## Scope

In scope:

- A shared CLI bridge contract, a CLI registry, and `grok` as a valid `--room-bridge` value in both places that list bridge kinds.
- Bridges for GitHub Copilot CLI, xAI Grok CLI, and Hermes Agent.
- An Antigravity spike (Task 1) that ends as a bridge or a written deferral.
- Replay mode for CLIs without resume, and lost-session recovery.
- Ironbots report posting: a `report_only` response mode, one relay exemption, a poster module, and a `room report` CLI.
- Conformance, forbidden-flag, and environment tests for every new bridge.

Out of scope, with the reason:

- Ironbots requests, command lists, and per-bot endpoints. Phase 6 owns the request half and the narrow-command-list design.
- Creating `ep_ironbots` or any bridge endpoint, and adding them to rooms. This is an operator step outside the phase. Tests use fixture ids.
- Editing `C:\dev\scripts`. The bots live outside the sigil repo. The phase ships the poster and a documented invocation; Chris or a later step wires it in.
- The Floor Warden bridge and Grok bots. Phase 6.
- The visible loop guards (cap event, Continue, halt event). Phase 6 owns them.
- Everything in "Deferred to later phases".

## Scope reading

Chosen reading of "phase 5": four CLI bridges (Copilot, Antigravity gated on a spike, xAI Grok CLI, Hermes) plus step one of Ironbots, which is one-way report posting. Ironbots requests, the second step in the master design, stay in phase 6. The phase 6 design says so: "Ironbots requests. They are the other half of the parent spec's phase 6 and get their own design."

Name clash: xAI Grok CLI is a local program (`grok`) that a bridge spawns. It is unrelated to the Grok bots of phase 6 (Chief and Helix CI Triage in the Grok Bot app, reached through the Floor Warden webhook). This spec uses "Grok CLI" for the first and never for the second.

Rejected readings:

- A. CLI bridges only, with all Ironbots work moved to phase 6. Rejected: the master design lists "Ironbots report posting" in phase 5, and phase 6 leaves only requests.
- B. Include Ironbots requests. Rejected: phase 6 owns them, and they need its narrow-command-list design.
- C. One endpoint per Ironbot now (9 endpoints). Rejected: the provisioning cost buys nothing for one-way text with no policy difference. Per-bot endpoints matter once bots are invocable. Open question for phase 6.
- D. Post reports as relay-authored `room.event` rows through a new route. Rejected: it loses the reporter's own signature, which is the point of Sigil identity, and the master design says `room.message`.
- E. Make the reporter a normal agent that posts inside an invocation. Rejected: no invocation exists to complete, and the relay refuses agent posts without one (`assertAgentMayPost` throws `ROOM_NOT_INVOKED`).
- F. Build an Antigravity bridge now, assuming a headless CLI exists. Rejected: none was found on this machine. The bridge is gated on a spike with a written deferral if it fails.
- G. Pull Hyperagent-derived items (notes, Canvas, approval cards, enforced budgets, schedules, webhooks) into phase 5. Rejected: they belong to later phases.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Bridge shape | Each new CLI is a factory like `createClaudeCli`, returning `{name, capabilities, run({prompt, sessionId, signal})}` | `room-bridge.mjs` already drives any such object. No bridge-loop change. |
| Registry | One registry module maps bridge kind to factory. `sigil.mjs` and `wake-dispatcher.mjs` both read it | Two hard-coded lists exist today (a ternary and `BRIDGES`). A shared registry keeps them equal. |
| Process control | Every CLI runs through `runCli` | It spawns without a shell, caps output, and kills the process tree on abort and timeout. |
| Auto-approve | No CLI is ever launched with an approve-all or bypass flag | Tests assert the forbidden flags are absent from argv. |
| Prompt delivery | Stdin or a prompt file where the CLI supports it, argv otherwise | Argv exposes the prompt in the process list and hits the Windows length limit. See assumption 2. |
| Hermes | Refuses to start without an explicit restrictive toolset, and runs in replay mode | Hermes oneshot auto-approves, and it reports no session id. |
| Antigravity | Spike first, bridge only on success | No headless agent CLI was found. |
| Reporter identity | One `report_only` agent endpoint | It is an agent, so it never counts as human. It is not invocable, so an @mention creates nothing nobody serves. |
| Report relay path | Exemption in `assertAgentMayPost` for `report_only` senders | Smallest change. The accept path, signing, and fan-out stay as they are. |
| System endpoint as reporter | Rejected | A `system` endpoint is neither agent nor human, so dispatch would treat it as human, refill the hop budget, and reach the router. |
| Post policy | Post on status change, on non-healthy status, and on a 24 hour heartbeat; fleet daily summary always | Two bots run every 15 minutes (96 runs a day). Posting each run floods the room. |
| New bridge endpoints | Created `mentions_only` with `invokable_by` owner | Matches the research: ask before agent-to-agent requests, connector owns the agent. |

## Components

### CLI bridge contract and registry

Each CLI object has `name`, `capabilities: {resume: boolean}`, and `run({prompt, sessionId, signal})` returning `{text, sessionId}`. The registry exposes the list of kinds and a `createCli(kind, options)` function. `sigil.mjs` replaces its ternary with the registry. `wake-dispatcher.mjs` builds `BRIDGES` from the registry kinds plus `router`. After the change both accept the same set: `claude`, `codex`, `copilot`, `grok`, `hermes`, `router`, and `antigravity` only if the spike succeeds. The tincan plan (2026-10-09) and its handoff say the multi-host demo is "Awaiting the addition of grok to the --room-bridge flags in Phase 5", so `grok` is the required value.

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

| Flags it never uses |
|---|
| `--allow-all`, `--yolo`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls` |

Unknown: whether stdin can carry the prompt, the JSONL event shapes, and the auth source. Task 1 captures them.

### xAI Grok CLI (1.0.52)

Headless: `-p/--single` or `--prompt-file`, with `--output-format json`. Resume: `--resume <id>`, and `--session-id <uuid>` for a chosen id. The CLI talks to a background leader process.

| Flags it uses | Purpose |
|---|---|
| `--prompt-file <path>` (or stdin if Task 1 confirms) | Keeps the prompt out of argv |
| `--output-format json` | Parseable output |
| `--resume <id>`, `--session-id <uuid>` | Resume, or start with a known id |
| `--tools <list>`, `--disallowed-tools`, `--permission-mode default` | Read-only tool set |
| `--max-turns`, `--cwd`, `--disable-web-search`, `--no-subagents` | Bounded runs |

| Flags it never uses |
|---|
| `--always-approve`, `--permission-mode bypassPermissions` |

Unknown: the JSON output shape, and whether killing the `grok` client stops the model turn when a leader process exists (assumption 4). The conformance kill test covers the client process. Task 1 checks the turn.

### Hermes Agent (0.21.2)

Headless: `-z/--oneshot <PROMPT>` prints only the final response text and no session id. Per `--help`, "approvals are auto-bypassed", and AGENTS.md in the working directory loads as normal.

| Flags it uses | Purpose |
|---|---|
| `-z <prompt>` | Oneshot run |
| `-t/--toolsets <list>` | Restrictive toolset, required |
| `--ignore-user-config`, `--ignore-rules` | Keep local config and rules out of a room run (Task 1 confirms effect) |
| `--usage-file` | Deferred |

| Flags it never uses |
|---|
| `--yolo` |

Because oneshot auto-approves, the bridge refuses to start unless `--agent-toolsets` (new, generic name) is set to an explicit list, and it fails with a plain error that names the flag. It never falls back to a default toolset. Toolset names are unknown, and Task 1 records them. `--safe-mode` is not used until Task 1 learns what it does. `capabilities.resume` is false (assumption 3).

### Antigravity

PATH holds no `agy` or `antigravity`. The only launcher is `antigravity-ide(.cmd)`, an IDE launcher. Task 1 is a spike: look for a headless prompt mode, a session-resume mode, and a tool allowlist. Outcomes:

- Found: the bridge follows the same contract. Read-only tool allowlist, no `high` risk-tier capabilities, no auto-approve. The master design gives the reason: Antigravity once faked an approval and force-pushed during IronLedger Phase 1 (2026-09-01).
- Not found: Task 1 ends with a written deferral in the plan and the registry omits `antigravity`. This is an accepted outcome of the phase.

### Replay mode and lost-session recovery

- Replay mode. When `cli.capabilities.resume` is false (Hermes), the bridge ignores the watermark and puts the last `threadContextLimit` (20) messages of the thread in the prompt every turn. This is the master design's fallback. It stores no session id.
- Lost-session recovery. If a resumed run fails because the CLI no longer has the session, the bridge retries once with no session id and the replay window, stores the new session id, and resets that thread's watermark. A second failure fails the invocation as today. How each CLI signals a missing session is captured in Task 1.
- The session-store format does not change. Phase 6 uses the same format.

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
- a per-room rate cap, starting at 30 reports per rolling hour, answered with `429 REPORT_RATE_LIMITED` (assumption 8).

A report never dispatches anything.

Poster (`bridges/v1/ironbot-report.mjs`, new). It builds ASCII text from structured fields: bot id, status, timestamp, one-line summary, and an optional alert list. It strips control and bidi characters, clamps each field, and never includes raw telemetry blobs. Telemetry strings can carry scraped or log text (for example `driftFindings` and `recentIssues`), so report text is untrusted content to every agent that later reads the room, and the poster passes only fields it clamps.

Post policy. A bot's report is posted when its status differs from the last posted status for that bot, when the status is not healthy, or when 24 hours have passed since its last post. The fleet daily summary is always posted once a day. State lives in a file (default `.sigil/report-state-<endpoint>.json`, path flag), written atomically like `session-store.mjs`. The idempotency key is `ironbots_<bot>_<timestamp>`, so a retry never double-posts.

Room id. The daily report file already carries a `roomEvent` object with `room_id: 'sigil-fleet-observability'`. That is not a Sigil room id (rooms are `room_<uuid>`). The poster takes the room id as an argument and does not trust the field.

CLI:

- `sigil room report --identity <path> --relay-url <url> --room <room_id> --bot <id> --status <s> --summary <text> [--alert <text> ...] [--state <path>]`
- `sigil room report ... --from-report <ironbots_daily_report.json>` posts the fleet summary built from the structured fields of that file (`fleetHealthScore`, `fleetStatus`, `botCount`, `activeBots[]`, `alerts`). It ignores `formatted_message`, which contains mojibake.

This is one-way. No invocation and no request entry point exist (phase 6).

## Loop guards and catch-up

Inherited, unchanged, for every new bridge: the hop budget (`max_agent_turns`, default 6 per thread after the latest human message), one running invocation per agent per room, and Stop (the bridge polls its invocation and kills the CLI tree).

Phase 5 adds:

1. A conformance test that each new bridge dies on Stop and on timeout.
2. A per-bridge rule that no CLI is launched with an auto-approve or bypass flag. Tests assert the forbidden flags are absent from argv.
3. The `report_only` path cannot dispatch, refill budgets, or mention, and it has a rate cap.

Phase 6 owns the visible guards: `agent_cap_reached`, Continue, signed `room_halted`, `invocation_failed`, and mention-free bot replies. Phase 5 does not redefine them and works without them. The research on Hermes bot-to-bot loops and silent capped handoffs concerns its Discord gateway, not this CLI. It is why phase 5 leans on the existing hop budget plus conformance tests.

Catch-up already exists for Claude and Codex as a per-thread watermark (`last_seq_by_thread`) in the session store. Phase 5 adds only `capabilities.resume`, replay mode, and lost-session recovery. Phase 6 defines the Floor Warden `catch_up` object on the same store format.

## Data

New migration `035_report_only_mode.sql` (assumption 10 covers the number): drops and re-adds `conversation_members_response_mode_check` to include `report_only`. Migration 030 did the same for `router`, and 027 created the original check. No new tables. The memory repository and `postgres-repository.mjs` both enforce the per-room report rate cap, and the memory repository accepts the new mode. A migration test follows the pattern of `030_room_router.test.mjs`.

## CLI

- `sigil agent run --room-bridge claude|codex|copilot|grok|hermes|router` (plus `antigravity` if the spike succeeds). `--agent-command` names the executable and must be an `.exe` on Windows.
- `--agent-toolsets <list>` is required for `hermes` and optional for the others, where it maps to that CLI's tool allowlist.
- `sigil room report` as above.
- Existing flags (`--agent-cwd`, `--room-sessions`) are unchanged.

## Deferred to later phases

| Item | Why not now | Where it goes |
|---|---|---|
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
- Parser tests per CLI from captured fixtures. Task 1 captures real output into scrubbed fixture files.
- Forbidden-flag assertions per CLI, including the Hermes refusal without toolsets.
- Environment test: the relay token and unrelated keys never reach the child, and per-CLI auth prefixes do.
- Stop and timeout kill tests (pattern of `cli-runner.test.mjs`).
- Resume, lost-session recovery, and replay-mode tests.
- Registry tests: `sigil.mjs` and `wake-dispatcher.mjs` accept the same kinds.
- Migration test.
- `report_only` relay tests in memory and `*.pg.test.mjs`: allowed post; refused with mentions, a thread id, `task.request`, or over 4000 characters; rate cap; no hop-budget refill; an @mention of the reporter creates no invocation; mode edit refused.
- Poster tests: sanitization, post policy, atomic state file, idempotency.
- `room report` CLI test.
- Exit test: two fake-CLI bridges and a reporter in one room, in the pattern of `rooms-exit.test.mjs`.
- Live smoke: an extension of `scripts/live-room-bridges.mjs` for real `copilot`, `grok`, and `hermes`. It costs credits, so it runs only behind an opt-in environment flag, with read-only tools and a short prompt.

Tests use fixture endpoint ids. They never read, print, or commit `.sigil/*.json`.

## Assumptions

1. Copilot and Grok CLI JSON output shapes and session id fields are not known. Task 1 captures them.
2. Copilot and Hermes may not accept the prompt on stdin. If not, the prompt goes in argv, with the Windows length limit and process-list exposure noted. Grok uses `--prompt-file` or stdin. Task 1 tests each.
3. Hermes oneshot cannot report a session id, so it runs in replay mode. Task 1 confirms.
4. Killing the `grok` client stops the turn even with a leader process. Task 1 checks this by starting a turn and killing the client.
5. Antigravity has no headless CLI on this machine. The Task 1 spike repeats the PATH search and reads the launcher's help.
6. Each CLI authenticates from its own stored login, not from env vars. If one needs an env var, only that CLI's prefix is allowlisted, and never `GITHUB_TOKEN` or `GH_TOKEN` by default. Task 1 checks with the allowlisted environment.
7. Installed versions (Copilot 1.0.97, Grok 1.0.52, Hermes 0.21.2) and flags may change. The spike records versions in the fixture headers.
8. The reporter cap of 30 per room per hour and the 4000-character limit are starting values, tunable after real use.
9. A shell-less spawn cannot run `.cmd` shims on Windows, so `--agent-command` must name an `.exe`. A test spawns a `.cmd` path and expects `CLI_START_FAILED`.
10. Migration 035 may be taken by phase 6. Re-check the number against `main` at execution and renumber.
11. The room id for reports comes from the operator. The report file's `room_id` is not trusted. A test feeds a file with a non-room value and expects the argument to win.

## Open questions

1. Should phase 6 give each Ironbot its own endpoint once bots are invocable, or keep one reporter plus a command list? This phase assumes one reporter.
2. Is 30 reports per room per hour right for a fleet of nine bots plus a daily summary? It is a starting value only.
3. If the Antigravity spike fails, should the registry reserve the `antigravity` kind with a clear "not available" error, or omit it? This spec omits it.
4. Should a `report_only` post also mark the room unread differently in the web client? Not designed here.

## Interaction with phase 6

Both phases touch the same four things:

- The `--room-bridge` flag in `sigil/cli/sigil.mjs`. Phase 5 adds `copilot`, `grok`, `hermes` through the registry. Phase 6 adds `floor-warden`.
- `BRIDGES` in `wake-dispatcher.mjs`. Same two changes.
- `room-dispatch.mjs`. Phase 5 adds the `report_only` exemption to `assertAgentMayPost`. Phase 6 edits the same file for the cap event, and its reply route reaches the same accept path.
- The migration number. Phase 5 proposes 035. Phase 6 proposes `035_floor_warden_bridge.sql`. Whichever lands second renumbers.

Phase 5 lands first and does not depend on phase 6. It uses the existing hop budget and Stop, and it does not need the cap event, Continue, or halt event. Phase 6 then rebases onto the registry and the shared `RESPONSE_MODES` set. If phase 6 lands first instead, phase 5 renumbers its migration and rebases the same files, with no design change.