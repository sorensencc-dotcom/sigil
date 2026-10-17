# Phase 5 verification notes

Observed 2026-10-16 on base `04bafd2789f9ed2ceadc79fede69f67aba263898`. Task 1 only: no production changes. Controller rulings override unsafe probe ordering and fictional commit attribution. All prompts used a private temporary working directory and `agentEnv(process.env)` constructed in memory; environment values were never intentionally printed. No `.sigil/*.json` file was opened.

## Versions and evidence boundary

| CLI | Observed version | Evidence |
|---|---|---|
| Copilot | 1.0.98 | `copilot --version`, exit 0 |
| Grok | 1.0.52 (0920c8169e27), stable | `grok --version`, exit 0 |
| Hermes | 0.21.2 (2026.9.11), upstream a7254e2d | `hermes --version`, exit 0 |
| Antigravity | Unavailable | `agy`, `antigravity`, and `antigravity-ide` absent from executable discovery |

Version/help probes had 15-second deadlines; prompt probes had 30- or 45-second deadlines. A temporary Node runner spawned each executable with `windowsHide`, closed stdin, captured stdout/stderr privately, and killed only its child process tree on timeout. Completed probes required no timeout kill. Initial sandbox Copilot version discovery failed during package extraction with `EPERM`; elevated bounded discovery and prompts succeeded. No approval-bypass flags were used.

## Decision matrix

“Observed” means a real bounded CLI run. “Help” and “source” are not empirical capability proof. “Unverified” must not become a later task's readiness assertion.

| Finding | Copilot | Grok | Hermes | Antigravity |
|---|---|---|---|---|
| Headless mode | Observed `-p`, `-s`, JSON output | Observed `--prompt-file`, JSON output | Help: `-z` prints final text only; provider failed before answer | Unverified |
| Prompt transport | Observed argv and stdin-only, both `ok` | Observed prompt file; stdin unverified | Argv canary reached provider; stdin unverified | Unverified |
| JSON shape | **JSONL**, `assistant.message.data.content`; final `result.sessionId` and `exitCode`. Final result contains no answer text | JSON object with `text`, `stopReason`, `sessionId`, `requestId`, `cwd`, usage, and model usage | Plain text; provider failure also prints to stdout | Unverified |
| Session id | Supplied UUID returned as `result.sessionId`; stdin run generated another UUID | Supplied UUID returned as `sessionId` | Help explicitly suppresses session-id line in oneshot; live id unverified | Unverified |
| Resume | Observed `--resume=<known UUID>` returns `ok` and same id | Observed `--resume <known UUID>` returns `ok` and same id | Unverified; safety gate never cleared | Unverified |
| Missing session | Observed exit 1: `No session, task, or name matched '<id>'.` | Observed exit 1 after local miss and remote restore attempt: `Failed to restore session from remote: fetching session record: session get failed: 404 Not Found` | Unverified; no fabricated fixture | Unverified |
| Cancellation / leader ownership | Unverified live; short completed turns do not prove Stop | **No-go**: no process could be safely attributed to private socket after completed probes. No actual long-turn cancellation or quiet interval established | Unverified; safety gate never cleared | Unverified |
| Explicit cancel | Not examined | Help exposes `leader kill` described as “Stop all running leader processes”; it was **not invoked**. No safely scoped turn-cancel command established | Unverified | Unverified |
| Authentication | Observed usable with `agentEnv`; **stored-local-credentials category inferred**, exact backend explicitly deferred by controller ruling below | Observed usable with `agentEnv`; exact credential store unverified | Default local model `llama3.2:latest` missing; authentication not established | Unverified |
| Shipping decision | **Go for Task 5 spike input within controller's auth boundary**: already-authenticated operator profiles, same verified environment, restrictive tools/stdin, and observed JSONL; later factory tests still required | **No-go for Task 6 Branch A**; choose Branch B | **No-go for Task 7 Branch A**; choose Branch B | **No-go for Task 8 Branch A**; choose Branch B |

The Grok success fixture records output shape, not cancellation readiness. Private `--leader-socket $SPIKE/leader.sock` was passed to Grok prompt runs. Process metadata searches found no process bearing that private path. This is insufficient to prove an isolated leader owned the turn, so the controller safety ruling stops cancellation probing. Quiet period: **not observed**, not zero seconds. No preexisting/shared leader was killed. The phase-5 Grok bridge and corresponding demo remain deferred; this does not defer phase-6 Floor Warden bots.

`agentEnv` permits baseline runtime/home variables plus `ANTHROPIC_`, `CLAUDE_`, `CODEX_`, and `OPENAI_` prefixes (`sigil/bridges/v1/cli-runner.mjs:13-23`). It excludes GitHub-, Grok-, and Hermes-specific auth-variable names. Successful prompts prove current local authentication works under that environment. The following nonsecret help observations support a source-category inference, not observation of the actual backend. No credential file was inspected, and no new auth prefix is justified by this spike.

## Copilot authentication-source follow-up

Review fix round 1 ran `copilot login --help` and `copilot help environment` through the same in-memory `agentEnv` runner, with a 15-second deadline each, private raw capture, and output scrubbing before display. Both exited 0 without timeout; neither invoked a provider prompt or authentication action. Top-level/login help exposed no status/source command. Login help describes the system credential store with plaintext configuration fallback. Environment help documents `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` as authentication inputs, in that order; `agentEnv` excludes all three. This evidence and the earlier successful native Copilot prompts support **stored-local-credentials as an inference**. They do not establish whether the active backend is the system store or plaintext fallback.

**Controller ruling, recorded in `progress.md` after review fix round 1:** defer the exact Copilot credential backend after bounded nonsecret help exposed no status/source command. Task 5 may support **already-authenticated operator profiles under the same verified environment only**. Do not expand guessed auth prefixes, inspect credential/configuration values, log in, refresh, or mutate authentication. Other installations may require operator auth setup and provenance checks; this spike does not verify them. This is an explicit evidence deferral, not a claim that the backend was observed. Grok, Hermes, and Antigravity retain their separate unverified/no-go findings.

## Exact safe prompt invocations

`$SPIKE` denotes the private temporary directory, never the repository. Each command below ran through the bounded runner described above; no shell inherited the daemon's full environment.

```text
copilot -p "Reply with the single word ok." -s --output-format json --no-auto-update --no-custom-instructions --disable-builtin-mcps --available-tools view grep glob --allow-tool view grep glob --session-id=63a03c83-27d0-463c-9914-0b38fd6a6293
copilot -p "Reply with the single word ok." --resume=63a03c83-27d0-463c-9914-0b38fd6a6293 -s --output-format json --no-auto-update --no-custom-instructions --disable-builtin-mcps --disable-mcp-server browseros-neo --available-tools view grep glob --allow-tool view grep glob
copilot -p "Reply with the single word ok." --resume=b1687cfa-57e6-4aeb-a508-dd21158e078f -s --output-format json --no-auto-update --no-custom-instructions --disable-builtin-mcps --disable-mcp-server browseros-neo --available-tools view grep glob --allow-tool view grep glob
copilot -s --output-format json --no-auto-update --no-custom-instructions --disable-builtin-mcps --disable-mcp-server browseros-neo --available-tools view grep glob --allow-tool view grep glob
  stdin: Reply with the single word ok.
grok --leader-socket $SPIKE/leader.sock --tools read_file,list_directory,search_files --disable-web-search --no-subagents --permission-mode default --output-format json --session-id 6f2f7f90-97a2-45f0-8e95-f827d11bac41 --prompt-file $SPIKE/prompt.txt
grok --leader-socket $SPIKE/leader.sock --tools read_file,list_directory,search_files --disable-web-search --no-subagents --permission-mode default --output-format json --resume 6f2f7f90-97a2-45f0-8e95-f827d11bac41 --prompt-file $SPIKE/prompt.txt
grok --leader-socket $SPIKE/leader.sock --tools read_file,list_directory,search_files --disable-web-search --no-subagents --permission-mode default --output-format json --resume a2bcd905-4106-4f8d-8653-92ae1b17d3c5 --prompt-file $SPIKE/prompt.txt
hermes --safe-mode -t web -z "Create a file named canary.txt in the current directory, then run the harmless command echo canary. If those tools are unavailable, say which tools are unavailable. Do not use any network tool."
```

Copilot success/resume/stdin each exited 0 and returned `ok`; missing-session exited 1. Grok success/resume each exited 0 and returned `ok`; missing-session exited 1. The file contained only `Reply with the single word ok.`. These Grok runs made no observed tool calls; the exact availability/meaning of its requested tool names remains unverified and does not support a shipping go.

Copilot help says automatic approval of all tools is required in noninteractive mode, but observed restricted runs succeeded without it. `--available-tools view grep glob` restricted the observed model inventory to those three tools; disabled-tools events included write, process, delegation, and MCP tools. `--disable-builtin-mcps` alone still allowed a user MCP server to connect during startup, even though its tools were excluded. Follow-up probes additionally used `--disable-mcp-server browseros-neo`. Tool restriction and startup isolation are distinct: do not infer that built-in disable suppresses all user servers. No MCP tool was called. Prefer stdin in Task 5; prompt-in-argv is unnecessary.

## Hermes restriction gate

`hermes tools` exited 1 because it requires an interactive terminal. `hermes tools --help` exposed `list`; `hermes tools list` printed builtin toolset names, then crashed when reading a boolean MCP configuration (`AttributeError: 'bool' object has no attribute 'get'`). A no-import AST inspection of the installed `toolsets.py` confirmed the following candidate and rejection facts before the canary:

| Toolset | Source-defined tools | Gate result |
|---|---|---|
| `web` | `web_search`, `web_extract` | Restrictive candidate; canary failed before model answer |
| `search` | `web_search` | Source-only read candidate; no live canary |
| `vision` | `vision_analyze` | Source-only candidate; no live canary |
| `session_search` | `session_search` | Not probed; unrelated conversation access unnecessary |
| `file` | `read_file`, `write_file`, `patch`, `search_files` | Rejected: includes writes |
| `terminal` | `terminal`, `process_manage` | Rejected: process execution |
| `code_execution` | `execute_code` | Rejected: execution |
| `safe` | Includes `web`, `vision`, and `image_gen` | Rejected as a read-only assertion: `image_gen` exposes `image_generate` |
| `debugging` | `terminal`, `process_manage`, plus `web` and `file` | Rejected: writes/execution |
| Other platform/composite/plugin/MCP sets | Include mutation, external actions, or dynamically resolved tools | Not candidates; not verified |

Help states that `-z` auto-bypasses approvals, so a successful listing/canary gate is mandatory. Help states that `--ignore-user-config` ignores user config but still loads credentials from `.env`; `--ignore-rules` skips rules/memory/preloaded skills; `--safe-mode` additionally disables plugins/MCP and implies both. These are help claims; no successful tool-boundary canary verified them.

The sole bounded canary used `--safe-mode -t web`. It exited **0** and printed `API call failed after 3 retries: HTTP 404: model 'llama3.2:latest' not found`. No `canary.txt` existed afterwards. Missing file alone does not establish restriction because the provider never answered and never reported the tools unavailable. Therefore `HERMES_READONLY_TOOLSETS = []` (no verified candidates). No Hermes ok, stdin, session, resume, or auth prompt followed the failed gate. Do not interpret exit 0 as successful inference. Task 7 must defer rather than build a parser from this failure fixture.

Antigravity executable discovery returned no match; no help or prompt could run. A future help-only result would still require captured safe headless/tool-boundary evidence before shipping. Task 8 must defer now.

## Ordinary-message receipts and clock probe

Result: **receipts route usable for ordinary messages**, verified against both memory and dedicated disposable PostgreSQL repositories through temporary `127.0.0.1` HTTP listeners. Task 10 step 6 fallback is not indicated by ordinary-message behavior. `report_only` does not exist yet: repeat pending in Tasks 10-11; assumption 14 remains unverified for that sender mode.

The temporary assert-based probe generated fixture identities (`ep_test_phase5_sender`, `ep_test_phase5_other`), created an isolated room, signed ordinary top-level `room.message` envelopes, and called `POST /v1/envelopes` and authenticated `GET /v1/messages/{id}/receipts`. It used only `postgres://sigil@127.0.0.1:55486/sigil_pr57_test`, asserted its `_test` name and exact path before resetting, applied migrations 001-034, and closed listeners/connections/pool in `finally`. A single 85-second deadline bounded the probe; individual HTTP requests had 10-second deadlines. Both modes completed with exit 0.

| Assertion | Memory | PostgreSQL |
|---|---|---|
| Ordinary human room message accepted | 202 | 202 |
| Sender receipts after acceptance, no recipient fanout | 200, empty list | 200, empty list |
| Unknown message | 404 `MESSAGE_NOT_FOUND` | 404 `MESSAGE_NOT_FOUND` |
| Different authenticated endpoint | 404 `MESSAGE_NOT_FOUND` | 404 `MESSAGE_NOT_FOUND` |
| Six-minute-old new envelope | `INVALID_ENVELOPE`; sender lookup null; receipts 404 | Same |
| Same bytes accepted earlier, relay clock advanced six minutes | `INVALID_ENVELOPE`; original receipts still 200 | Same |
| Receipts independent of idempotency | Replaced `lookupIdempotency` with throwing function; receipts still 200; source reads only envelopes/deliveries | Deleted accepted message's idempotency row, asserted zero rows, receipts still 200 |

The memory store does not expose idempotency-map deletion; its independence assertion guards against any lookup call and matches the source. PostgreSQL provides direct missing-row proof. A 404 means no committed message is visible at that instant. It never proves an in-flight or blocked acceptance cannot later commit, and must never authorize automatic envelope recreation.

The probe independently injected the relay clock through `createRelayServer({now: () => now})` while preserving signed envelope bytes. The HTTP server samples that clock at request entry (`http-server.mjs:144-145`) and passes the sampled value to acceptance (`438-443`); `acceptWithRepository` uses `options.now` (`accept-envelope.mjs:160`). A blocked transaction can therefore persist after disconnect using its earlier sampled clock. Tasks 10-11 still need their held-transaction and response-loss tests.

## Acceptance timestamp finding

Live `information_schema.columns` returns only `expires_at` and `created_at` for envelope timestamp columns. `001_initial.sql:62-89` defines the table; `postgres-repository.mjs:1076-1078` inserts `envelope.created_at`. No `accepted_at` or `received_at` exists. Deliveries, idempotency rows, and the `envelope.accepted` audit also use the client envelope time (`1085`, `1096`, `1104`, `1109`), not an independent relay acceptance timestamp. The memory repository retains the envelope and stamps delivery queue time separately (`memory-repository.mjs:273-305`).

Task 9 must explicitly choose the existing `created_at` column or amend its schema requirement; this spike does not invent a relay-assigned acceptance column or call client time relay time. Task 10's count and Task 9's index must use the same chosen column. `countRecentReports` is absent in both repositories and remains new Task 10 work.

## Windows rename observation

A child process held a state-style JSON destination open for reading. A separate process attempted `fs.rename(temp, destination)` five times, 20 ms apart. All five attempts failed with `EPERM`; the destination retained its original JSON. After the reader closed, the next rename succeeded on its first attempt. No `EBUSY` occurred. A first probe's success assertion failed because it expected replacement while the reader stayed open; the corrected observation captured that real failure rather than weakening it.

Keep the plan's bounded default of **5 attempts at 20 ms**: this check does not establish that any finite retry count succeeds while a reader holds the file open. Task 2 must preserve old state and report exhaustion. Do not spin indefinitely or silently overwrite/delete the original state. Longer-lived reader contention remains a documented limitation.

## Source references for later tasks

Paths below are repository-relative. Line numbers refer to the verified base; no source moved in Task 1.

| Surface | References and implication | Consumers |
|---|---|---|
| Runner/environment/process kill | `sigil/bridges/v1/cli-runner.mjs:13-23` environment; `29-35` Windows process-tree kill; `37-71` runner | Tasks 2, 4-8, 14 |
| Existing Claude/Codex parsers | `claude-cli.mjs:16-21`: `is_error` becomes `CLI_INVALID_OUTPUT`; `codex-cli.mjs:7-18`: no answer/thread becomes `CLI_INVALID_OUTPUT`; runner nonzero exit becomes `CLI_FAILED` at `64-65`. Neither factory maps `CLI_SESSION_LOST`, and existing `agent-cli.test.mjs:27-62` tests only valid fake resume | Tasks 3-4; **missing-session strings unverified live**, no invented fixture |
| Member add | `sigil/relay/v1/room-routes.mjs:208-234`; response modes set at `16`; agent check/required mode at `224-225` | Tasks 9, 12 |
| Set response mode | `room-routes.mjs:283-299`; currently reads member and writes mode without one shared room-lock transaction | Tasks 9-10, 12 |
| Repository membership | Memory `330-338` add/restore, `355-360` set mode, `388-400` lookup/list; PostgreSQL `1905-1919` add/restore, `1942-1950` set mode, `1960-1975` lookup/list | Tasks 9-10 |
| Restore upsert | PostgreSQL `1910-1914`: restores only removed rows; sets role, added_by, added_at, `response_mode = EXCLUDED.response_mode`, `removed_at = NULL`, and `invokable_by = 'owner'`. Memory replaces removed row and resets owner invocation policy at `330-338` | Task 10 membership-change proof |
| Accept ordering | `accept-envelope.mjs:263` transaction; `403` `validateEnvelope`; `406` `authorizeRoomEnvelope`; `409-411` idempotency lookup/duplicate return; **`412` sole production caller of `assertAgentMayPost`**; `451` assign room sequence; `456` persist | Task 10 |
| Lock gap | `assertAgentMayPost` already runs inside accept transaction, **before room row lock**. Accept has no `lockRoom` call. `assignRoomSequence` UPDATE (`postgres-repository.mjs:2101-2108`) first takes that row lock later; explicit `lockRoom` uses same row's `FOR UPDATE` at `2111-2114`. Memory sequence `402-407`; lock no-op `435` | Task 10 must lock before counting/authorizing; duplicate lookup remains before new authorization |
| Sender member shape | `room-policy.mjs:39-41`, `65`: current member fields plus `is_agent`; member view includes endpoint_id, role, response_mode, added_at, invokable_by, owner_id, display_name (`postgres-repository.mjs:181-190`, memory `80-85`). `roomPlan.senderMember` remains available at persist site | Task 10 accepted marker |
| Agent admission | `room-dispatch.mjs:26-34`: nonagents pass, agent requires running invocation and correct root. Only production call is acceptance `412`; comment mention in dispatch is not another caller | Task 10 |
| Persist callers | Exhaustive graph search: production calls in `accept-envelope.mjs:456`, `accept-federated-envelope.mjs:280`, and `room-events.mjs:52`; definitions in both repositories. Remaining calls are tests, test helpers, or `scripts/live-claude-worker-receipt.mjs` stub. No additional production accept caller found | Task 10 default-false marker across all paths |
| Room methods | Memory room/create through thread/reset methods `309-527`; PostgreSQL `1858-2114`; create invocation `448`/`1998`, running lookup `468`/`2018`, list invocations `507`/`2062`, reserve turn `514`/`2071`, reset `522`/`2084` | Tasks 9-11 |
| Receipts route | `http-server.mjs:453-482`; message sender from envelope, sender-only 200, same 404 for unknown/other; lookup memory `703-706`, PostgreSQL `268-271` | Tasks 10-12 |
| Outbox signing | `sigil/connectors/v1/local-outbox.mjs:12-18`: copies supplied envelope, attaches sender/signature, signs unchanged timestamps. Poster must set created_at/expires_at before queue | Task 11 |
| Relay client | `sigil/connectors/v1/relay-client.mjs:14` sendEnvelope; class has **no getMessageReceipts method** | Tasks 10-12 must add verified sender-scoped method |
| HTTP harness | `room-send-route.test.mjs:22-33` call helper; `35-67` withWorld; `65` server.listen(0, '127.0.0.1'); test-owned fixture identity/signing and finally close. `createRelayServer` exported from http-server | Tasks 10-11 |
| Validation/clock | `validate-envelope.mjs:105-108`: rejects created_at more than five minutes either side with `INVALID_ENVELOPE`, before accept idempotency `409`; server clock injection above | Task 11 freshness/skew |
| Daemon acknowledgement | `sigil/cli/agent-daemon.mjs:195-204`: a thrown bridge handler leaves delivery unacked; a returned outcome (including failed/cancelled) acknowledges it. `219-225` preserves cursor if room_unacked | Tasks 4, 11, 14 |
| Contract modes | `sigil/contracts/v1/relay-api.json:25` lists joins/mentions_only/router in response-mode route notes; no standalone response-mode enum found | Task 12 must update notes when applicable |
| Default state paths | `sigil/cli/sigil.mjs:47-49` default config/registry; `171` identity creation; `1102` agent-run sessions default under .sigil. `session-store.mjs:11-23` writes only supplied path. Existing room bridge stores sessions but no disk-backed outbox. No report command/poster exists | Tasks 11-12 must use explicit report state path and avoid inheriting agent-run session default |
| CLI parser/help | `sigil/cli/sigil.mjs:58-59` agent help; `1061-1102` command parsing and bridge allowlist | Tasks 4-8, 12, 15 |
| Web roster/type | `packages/sigil-rooms-web/src/api/types.ts:57-64`; `RosterPanel.tsx:8`, `38-50`; client setter `api/client.ts:102-104` | Task 13: reporter label read-only, no editable reporter mode |

## Captured fixtures and checks

Five new scrubbed fixtures live under `sigil/bridges/v1/fixtures/`: Copilot success/missing-session, Grok success/missing-session, and Hermes provider failure. Each begins with `CLI version: ...`; **strip that metadata line before passing the payload to a parser**. Success fixtures retain the observed answer/session fields and remove unrelated usage/provider telemetry, opaque request ids, and user paths. Copilot is a projection of its actual JSONL events, not a claim that its output is a single JSON object. Grok remains a deferred candidate despite captured success. Hermes failure is not a success or missing-session fixture. No Antigravity or Claude/Codex missing-session output was fabricated.

A temporary self-check parsed both success payloads, asserted observed `ok`, required actual missing-session exit 1, and matched the Hermes provider failure/exit-0 observation before writing fixtures. A scoped fixture scan checks username/auth/account strings; all new fixtures are LF. No new executable production code or committed probe script exists, so the already-green full baseline suite was not repeated.

## Assumptions confirmed or changed

- Copilot stdin support is confirmed; JSONL event parsing replaces any assumed single-object/result-text parser. Resume must use `--resume`, because `--session-id` can create new sessions.
- Grok prompt-file/JSON/resume are confirmed. `--session-id` is new-session-only per help, not resume. Grok cancellation and quiet-period assumption remain unverified; defer Task 6 Branch A.
- Hermes toolset restriction, plain-success output, session behavior, stdin, and auth remain unverified. Verified read-only toolset set is empty; defer Task 7 Branch A. Safe-mode still requires a working provider and successful canary.
- Antigravity headless/resume/tools remain unverified; defer Task 8 Branch A.
- Ordinary-message receipts and stale-byte validation behavior are confirmed for both repositories. Reporter-mode receipts and held-transaction clock/commit races remain Tasks 10-11 proof, not Task 1 proof.
- No relay-assigned acceptance timestamp exists. Task 9 must choose a real column/contract explicitly; Task 10 must use that same choice.
- Agent authorization is transactional but precedes the existing room row lock; Task 10 must close that interval.
- Five rename retries can exhaust under a live Windows reader. Preserve old state and surface exhaustion; do not claim five guarantees eventual replacement.

## Task 2 registry call sites

Read against Task 2 base `ce16bb1f2ae41c5985f870aa3867d2944c27b50c` before edits:

- `sigil/bridges/v1/cli-runner.mjs:13-23`: runtime allowlist, four legacy auth prefixes, and `agentEnv`. Direct factory callers: `claude-cli.mjs:44` and `codex-cli.mjs:29`; existing runner coverage: `cli-runner.test.mjs:47`.
- `sigil/cli/sigil.mjs:1061-1101`: `cmdAgentRun`, room-bridge validation at line 1069, and Claude/Codex factory ternary at line 1101. `main` dispatches at line 1882.
- `sigil/relay/v1/transport-tincan/wake-dispatcher.mjs:1-13`: `BRIDGES`, validation at line 6, and child argv at line 8. `tincan-relay.mjs:7,105,299-308` imports the set, validates config, and constructs the spawn dispatcher.

Local graft caller tracing used depth 8 for `agentEnv`, `cmdAgentRun`, `createWakeDispatcher`, `createClaudeCli`, and `createCodexCli`, plus exhaustive `agentEnv` and `BRIDGES` searches. Existing direct factories retain legacy default/explicit-env behavior; registry-created adapters filter both supplied and inherited environments to runtime names plus their own auth prefixes. Claude uses `ANTHROPIC_`/`CLAUDE_`; Codex uses `CODEX_`/`OPENAI_`. No new auth prefix or provider probe is authorized.
