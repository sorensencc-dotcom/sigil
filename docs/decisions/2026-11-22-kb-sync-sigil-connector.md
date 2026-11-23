> This is the 2026-11-22 investigation brief, included for review.

# Decision brief: kb-sync connector to Sigil (2026-11-22)

## Summary

The kb-sync memory connector is up now. It listens on 127.0.0.1:4411. A `query_context_cache` probe succeeded between about 5:55 PM and 6:02 PM ET on Nov 22.

It will not persist across logoff. Its scheduled task uses the Interactive logon type with an AtLogOn trigger only. The task runs only while you are logged on. The room stack tasks use S4U, so they keep running.

Codex tried an S4U fix at about 12:21 PM ET. The S4U task did not open port 4411. Codex rolled the task back to Interactive.

This is a proposal only. No changes were applied. No changes were made on WIN-DTA4V21LKVR, Cloudflare, Tailscale, or any repo. No PRs were opened.

## Current state

Times are ET unless marked UTC.

- Machine WIN-DTA4V21LKVR was online. Machine ID 7a21213b-66a4-4743-ae0a-03616680071d.
- The MCP probe `query_context_cache` with query "sigil connector" returned 3 topic hits. The connector was up at probe time.
- Scheduled task `SigilStack_connector-kb-sync`:
  - State: Running. User: soren. LogonType: Interactive (not S4U). RunLevel: Highest.
  - Last run: 11/22/2026 4:47:02 PM. LastResult: 267009 (SCHED_S_TASK_RUNNING).
  - Trigger: AtLogOn only. StartWhenAvailable: False.
  - ExecutionTimeLimit: PT0S. RestartCount: 999. RestartInterval: PT1M. MultipleInstances: IgnoreNew.
- Task action: `node.exe sigil\cli\sigil.mjs service run connector-kb-sync` with service config `C:\dev\sigil-repo\.sigil\kb-sync-service.json`. Working directory: `C:\dev\sigil-repo`.
- Live config file `C:\dev\sigil-repo\.sigil\kb-sync-service.json` exists. It is 318 bytes. Modified 4:46:51 PM. Its contents were not read.
- Listener: 127.0.0.1:4411, node pid 45728. Parent pid 42968 (started 4:47:02 PM). Grandparent svchost pid 2316. Command lines for these elevated processes were not accessible.
- Tailscale serve (tailnet only) on `https://win-dta4v21lkvr.tailb2474f.ts.net:443`:
  - `/` proxies to `http://127.0.0.1:3773`. T3 Code Beta listens on 0.0.0.0:3773.
  - `/mcp/memory` proxies to `http://127.0.0.1:4411/mcp/memory`.
- Room stack tasks (relay, rooms-web, agent-first_mate, agent-floor_warden, agent-grok_bot): Running, S4U, Highest. Last run 11/21/2026 9:50:34 PM. They use `.sigil\service.json` (contents not read).
- Relay listens on 127.0.0.1:8791, 8792, 8796, and 8797 (node pid 28520, started 11/21 9:52:02 PM). rooms-web listens on 5173.
- Old task `SigilStack`: Disabled. Last run 11/19/2026 2:45:42 PM. LastResult: 267014 (SCHED_S_TASK_TERMINATED).
- Old task `SigilMeshDaemon`: Disabled. Last run 11/10/2026 6:00:10 PM. LastResult: 1.
- `Node-Process-Janitor` does not kill Sigil processes by default. Port 4411 is in `$protectedPorts`. The janitor did not cause the downtime.

## What changed in the repos (Nov 19-22)

Repo: `sorensencc-dotcom/sigil` unless noted.

- Nov 19, 10:53 AM ET: PR #232, "fix(service): run the documented relay on rewritelabs.io (refs #219)". Merge commit 1c67cf68681f82c71b9e985c98ec05f5510766cf. It did not change the `/mcp/memory` path. https://github.com/sorensencc-dotcom/sigil/pull/232
- Nov 19, 6:36 PM ET: PR #233, "docs: record #219 cutover and Phase 7 room bots going live". https://github.com/sorensencc-dotcom/sigil/pull/233
- Nov 18, 7:19 PM ET (2026-11-19T00:19:42Z): direct commit a2d8114 in kb-sync, "fix(sync): export Drive guide before pack and fail loud on export error". This touches the ingestion and pack path, not the MCP connector. https://github.com/sorensencc-dotcom/kb-sync/commit/a2d8114
- Nov 20, 4:12 PM ET: PR #235, "fix(service): make sigil service on Windows able to replace the stack launcher". Merge commit 31783397ed168e754cd8d508a790ae550aa34e2e. It replaced the old stack launcher with per-component tasks that use `service.json`. https://github.com/sorensencc-dotcom/sigil/pull/235
- Nov 21, 1:15 PM ET: PR #237, "feat: add isolated KB-Sync connector service". Merge commit dc4fd3204d0afd76cfaea4e2419f5393f00d8230. Source branch: `codex/kb-sync-connector-service-20261121`. It updates `docs/service-config.md`, `sigil/cli/service-config.mjs`, `windows-supervisor.ps1`, and a Trail learning. https://github.com/sorensencc-dotcom/sigil/pull/237
- Live `.sigil/service.json` was not read. The room tasks use that file and do not include a connector component. The docs say to keep the connector in its own config.
- Other merged PRs since Nov 19 cover rooms, AG-UI, and the relay. They are not on the memory path: #231, #230, #236, #238, #239, #246, #247, #248, #249, #250, #251, #252, and #275.
- Current `origin/main` tip in sigil: commit 74a4e9376fb8, "Merge pull request #275 ...". Committed 2026-11-22T22:09:09 UTC (5:09 PM ET). No open PRs.
- kb-sync `origin/main` tip: commit 8d35a2a96cca, "test(telemetry): cover inaccessible repositories (#168)". Committed 2026-11-22T17:48:56 UTC. No kb-sync PR since Nov 10 changed `/mcp/memory`.
- librarian-archive `main` tip: commit a366a0797680, "Merge pull request #34 from sorensencc-dotcom/daily/2026-11-21". Committed 2026-11-22T22:19:46 UTC. A GitHub code search for `4411`, `mcp/memory`, and `connector-kb-sync` in librarian-archive returned no hits.

## Why the connector broke

Confidence levels come from the investigation notes.

1. The connector ran as a long-lived process before Nov 21. Node pid 43616 ran `connector-daemon.mjs --port 4411`. It started about 10:00 PM ET on Nov 20. This matches `connector-restart-20261120-220246.log`, which shows a 10:02:46 PM listen. The janitor saw pid 43616 through 6:00 PM ET on Nov 21. It is gone after that.
2. PR #235 moved room services to per-component tasks driven by `service.json`. PR #237 added a connector config. It kept the connector out of `service.json`.
3. At 9:50:34 PM ET on Nov 21, the S4U room tasks started together. This is consistent with a logon or reboot. Port 4411 had no durable S4U supervisor after that point. Confidence: MEDIUM-HIGH.
4. The PowerShell cutover history stopped port listeners on 8791, 8792, 8796, 8797, and 5173. Port 4411 was not in that kill list. The history file ends at 12:02 PM ET on Nov 22.

## Why Codex's fix did not persist

- 12:06:47 PM ET: an elevated transcript (`kb-sync-elevation.log`) ran `sigil service stop`. The stop reported success for the stack. The connector stop failed: PID 27556, a child of PID 2316, could not be terminated.
- 12:21:17 to 12:22:52 PM ET: a second elevated transcript (`kb-sync-elevation-retry.log`) ran install and start. The install and start succeeded. The output then reported `ELEVATED_SETUP_FAILED: S4U task started without opening port 4411`. The script reinstalled and restored the prior Interactive task.
- The out log has no listening line for the 12:24:07 PM start. This suggests a bind failure. `connector-kb-sync.err.log` is 0 bytes, so the exact error was not captured.
- A sandbox live test ran on port 4412 in `C:\dev\dev-sandbox\sigil-kb-sync-service` under task `SigilStack_connector-kb-sync-live-test`. It passed `initialize` and `query_context_cache` against a disposable DB, then uninstalled. That task is no longer registered.

Confidence levels:

- HIGH that Codex rolled back to Interactive.
- MEDIUM-HIGH that a leftover process (PID 27556) held the port. The alternative is an S4U-specific failure.
- Not observed: S4U environment or secret inheritance problems. The docs list this as a risk.

The out log has 10 `start #1` lines today. Nine of them include a listening line. The 12:24:07 PM ET start has no listening line. Seven later starts with a listening line run from 12:27 PM to 4:47 PM ET. The operator for those later starts is unknown. Confidence: MEDIUM.

## Isolated connector architecture

Treat kb-sync memory as one built-in connector among many, like a third-party MCP server.

- Own process and port: 4411, `connector-daemon.mjs`. Present.
- Own config: `kb-sync-service.json`, separate from `service.json`. Present. Do not add this connector to `service.json`.
- Own logs and commands: install, start, stop, and status run through `sigil service --service-config .sigil/kb-sync-service.json`. Present.
- Own elevated S4U task with an AtStartup trigger and StartWhenAvailable set to True. Missing. Today's task is Interactive with AtLogOn only. The supervisor code always uses AtLogOn. Adding AtStartup needs a small Sigil code change.
- Own identity. Missing. The docs sample uses `.sigil\grokbot.identity.json`. The target design uses a separate identity. The live identity file was not read.
- Stable endpoint: keep `https://win-dta4v21lkvr.tailb2474f.ts.net/mcp/memory` pointed at `127.0.0.1:4411/mcp/memory`. Persist it with `tailscale serve --bg`.
- Health check: a small probe that starts only the connector task when 4411 is down. It must not restart the room stack.
- Contract test: the 4412 sandbox pattern. Check `initialize`, check that `tools/list` includes `query_context_cache`, and check that `tools/call` does not return `[fallback-cache]`. Run it in CI or a disposable sandbox, not on 4411.
- Relay coupling: the daemon forwards to `http://127.0.0.1:8791`. Making `relay_url` optional for memory-only use would stop relay outages from affecting `/mcp/memory`. This is a code change for a separate PR.

Design choices and tradeoffs:

- Use the existing Sigil supervisor, Windows Task Scheduler, and Tailscale serve. This adds no paid service.
- S4U install needs an elevated shell. It also needs ACLs that let the non-interactive session read the config and identity files.
- S4U tasks do not reliably inherit user environment variables. The connector must not depend on them.
- AtLogOn with S4U still does not start at boot. AtStartup fixes that, but it needs the Sigil change.
- Moving T3 Code off serve root `/` changes Tailscale config. It needs approval. A serve reset for T3 can remove the memory path if both share `/`.

## Recommended fix (approval only)

Do not run any of this until Chris approves. Nothing below has been done.

### Phase A: make the isolated task persist

This is the first step. It does not change the architecture.

1. Run a read-only precheck. Confirm the 4411 process tree and the task state. Do not print `.sigil/*.json` in chat. Change only the supervisor keys in `kb-sync-service.json`, or replace only the `supervisor` block.
2. Stop `SigilStack_connector-kb-sync`. Confirm 127.0.0.1:4411 is free. If a leftover node under svchost holds the port, stop that process tree only after Chris confirms the PID. Do not touch ports 8791 to 8797 or 5173.
3. In `.sigil/kb-sync-service.json`, set `"supervisor": { "logon_type": "s4u", "run_level": "highest" }`. Keep the file connector-only. Do not merge it into `service.json`.
4. From an elevated prompt in `C:\dev\sigil-repo`, run:
   - `node sigil\cli\sigil.mjs service install --service-config .sigil\kb-sync-service.json`
   - `node sigil\cli\sigil.mjs service start --service-config .sigil\kb-sync-service.json`
   - `node sigil\cli\sigil.mjs service status --service-config .sigil\kb-sync-service.json`
5. Verify:
   - `SigilStack_connector-kb-sync` shows S4U and Highest.
   - Port 4411 is in the Listen state.
   - A local MCP `initialize` and `query_context_cache` call both succeed.
   - `tailscale serve` still maps `/mcp/memory` to 4411.
6. If S4U starts but 4411 does not open, capture `connector-kb-sync.out.log` and `connector-kb-sync.err.log`. Then stop. Do not silently restore Interactive. Restoring Interactive is what made today's fix fail to persist.

Risks in Phase A:

- A leftover process can block the port again. PID 27556 blocked the earlier stop.
- The S4U task may start without opening 4411. The out and err logs are the first place to look.
- The S4U task may not read the config or identity files. ACL checks come before the install.

### Phase B: harden (separate approvals)

1. Patch `windows-supervisor.ps1` so S4U tasks also get an AtStartup trigger and StartWhenAvailable set to True. Open a PR. Do not merge it.
2. Give the memory connector its own identity file. Do not use the room bot identity.
3. Consider making `relay_url` optional for memory-only use.
4. Move T3 Code off Tailscale serve `/`. Keep `/mcp/memory` on a persisted serve path.
5. Add a health probe that restarts only the connector task.
6. Move the 4412 sandbox contract test into CI or a documented operator script.

## Rollback

Rollback for Phase A:

- Reinstall the connector with `logon_type` set to `interactive`. This returns to the current behavior, which does not persist across logoff.
- Or re-register the task from a pre-change export. No pre-change export is confirmed in the notes. Check for one before Phase A starts.
- Room stack tasks are not touched if only `kb-sync-service.json` changes.
- Any Tailscale serve change needs its own rollback note before it runs.

## Open questions

1. Approve Phase A: clean stop of 4411, set supervisor to S4U and Highest, and elevated install and start of the connector-only config?
2. Approve a follow-up Sigil PR for AtStartup and StartWhenAvailable on S4U tasks?
3. Should the memory connector drop `relay_url` or make it optional, so it does not depend on the rooms relay?
4. Move T3 Code off the shared Tailscale serve root `/`?
5. Use a dedicated connector identity instead of the grokbot identity in the docs sample?
6. Which operator or process started the runner after 12:24 PM ET? The PowerShell history ends at 12:02 PM ET.

### Next steps

- If Chris approves Phase A, run steps 1 to 6 above and report the out and err logs if the port does not open.
- Log rows were appended at 6:06 PM ET (Status sections were not edited):
  - kb-sync Page: https://cursor.com/canvas/store-f0ec0f6d-5d9c-473c-a79c-9dd49248d451/76514778-c245-4485-9d2e-0a6115edce45
  - Sigil Page: https://cursor.com/canvas/store-f0ec0f6d-5d9c-473c-a79c-9dd49248d451/6171b7a5-ebb3-4172-8120-5be37bfcf568
- This brief is on the box only. It has not been copied to Drive. That needs Chris's yes.

## Sources and limits

Sources:

- The investigation facts file at `/tmp/kb-sync-brief/FACTS.md`. Its author of record is First Mate (Grok Bot investigation, read-only).
- Live probes of the Windows host, Task Scheduler, the listener, and Tailscale serve, as recorded in the facts file.
- GitHub state for `sorensencc-dotcom/sigil`, kb-sync, and librarian-archive, as recorded in the facts file.
- Public docs and code: `docs/service-config.md`, `windows-supervisor.ps1`, and the official sample JSON.

Limits:

- PR URLs were added from the live GitHub checks in this investigation.
- The out log has 10 `start #1` lines today, not nine. Nine have a listening line. One (12:24:07 PM ET) does not.
- Elevated command lines for the listener and parent processes were not accessible.
- `connector-kb-sync.err.log` is empty. The exact bind error is unknown.
- The PowerShell history file ends at 12:02 PM ET. Later operators are not in it.
- The Task Scheduler Operational log had no matching events.
- Not read: the live `.sigil/kb-sync-service.json` contents, the live identity files, the `service.json` contents, and private SSH keys. Only the file path and size were checked for the live config.
- Project Page Status sections were not edited. Append-only log rows were added at 6:06 PM ET.
