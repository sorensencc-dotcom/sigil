# Status

## Session update: 2026-10-21 Sigil Rooms Phase 7 Task 16 (reply ingress close)

- Branch `docs/phase-7-task-16-close`, plan `docs/superpowers/plans/2026-10-17-sigil-rooms-phase-7-tunnel.md`, spec `docs/superpowers/specs/2026-10-17-sigil-rooms-phase-7-tunnel-design.md`. Tasks 1-15 merged through PRs #89 (runbook), #91 (live Cloudflare smoke notes), #92 (`relay up` passes the token matcher so the 30 per minute per-bot limit applies), #93 and #94 (`freeDistinctPorts` test helper), #95 (`--bot-id` in the spec revoke examples) and #96 (federation-directory minute-rollover test flake).
- Phase 7 transport is proven. The live transport smoke passed on 2026-10-20 at about 10:23 PM ET through a Cloudflare named tunnel and an Access service-token policy to the ingress on `127.0.0.1:8796`. Notes: `docs/superpowers/plans/2026-10-17-reply-ingress-smoke-notes.md`.
- Decisions: default ingress port 8796; limits of 120 per minute for the ingress and 30 per minute for each bot; per-bot reply tokens only, with the global token allowed only behind `--ingress-allow-global-token`; no signed request mode in phase 7; the PWA and Web Push move to phase 7b.
- Proof bar still open: a real Grok reply landing in a room, then 7 days with no incidents before the old listener is retired.
- Assumptions A1-A5 stay open until the live Grok smoke (spec "Assumptions"):
  - A1: the Grok bot posts the reply with a curl step.
  - A2: the bot can store the reply token where it can read it.
  - A3: the bot retries a failed POST.
  - A4: a Cloudflare-managed domain exists for the hostname.
  - A5: the bot can send the Access service-token headers.
- Still gated on Chris: copying the routine's webhook URL and sender key, and creating `ep_chief` and `ep_helix_ci`.
- Verification (Linux, Node 22.23.4, 2026-10-21): `npm test` 2297 tests, 1939 pass, 1 fail, 357 skipped (pg tests skip without a database). The one failure, `sigil/cli/init-domain.test.mjs` "aborts identity creation when the domain does not resolve", is environmental: the verification host's DNS answers `nonexistent.invalid` with a synthetic address, so the domain resolves. The seven named pg files pass against a disposable `_test` database with zero skips: `039_reply_ingress` 5, `floor-warden-reply-tokens` 2, `bot-token-commands` 1, `ingress-commands` 1, `reply-ingress` 8, `floor-warden-ingress-e2e` 7, `floor-warden-e2e` 9. Secret scan passes. The repo defines no lint script.

## Session update: 2026-10-19 Sigil Rooms Phase 5 Task 9

- Report-only mode implementation is staged locally on `feat/sigil-phase5-task9-report-only`; Antigravity remains omitted from the registry.
- Task 9 uses existing `envelopes.created_at` for the report-post partial index because no relay-assigned acceptance timestamp exists. The existing five-minute envelope clock tolerance bounds the fallback; Task 10 must use the same column.
- Focused memory, route, migration-static, and policy tests pass. PostgreSQL proof is blocked because `SIGIL_TEST_DATABASE_URL` is unset and no disposable local PostgreSQL service is available. Do not advance to Task 10 until the PostgreSQL gate runs.

## Session update: 2026-10-19 Sigil Rooms Phase 5 Task 8

- Antigravity CLI discovery initially failed because its bin directory was absent from the probe process's `PATH`. Direct invocation verified `agy.exe` 1.4.2, headless JSON output, and conversation resume.
- The permission probe created a marker outside the workspace without an auto-approve flag. The current CLI configuration is not a verified read-only boundary.
- The registry continues to omit `antigravity`. Phase 5 report-only implementation remains closed.


## Session update: 2026-10-19 Sigil Rooms Phase 5 Task 6

- Grok CLI bridge deferred under Branch B. Task 1 did not verify cancellation of the actual model turn or establish a safe leader owner; the tincan multi-host demo remains blocked until that evidence exists. The registry intentionally omits `grok`; see the phase 5 verification notes and design deferred table.
- Task 6 registry test now pins `grok` out of `CLI_KINDS` and the wake dispatcher bridges. Grok cancellation, live PostgreSQL proof, and hosted CI proof remain unverified.
- Hermes bridge deferred under Branch B. Task 1 verified no read-only toolset and no successful oneshot restriction canary; the registry intentionally omits `hermes`.

## Session update: 2026-10-18 Sigil Rooms Phase 5 Task 3

- Isolated checkout `C:\dev\dev-sandbox\sigil-rooms-phase5-task3`, branch `codex/sigil-rooms-phase5-task3`, based on `origin/main` `9737bac` with merged Task 2.
- Task 3 changes remain uncommitted. Fixture modes, grandchild readiness, a real `.cmd` fixture, and the authorized synchronous `CLI_START_FAILED` runner fix are present.
- Restricted sandbox run was blocked because `taskkill /T /F` failed with `The user name or password is incorrect`; this was an environment limitation, not a product failure.
- Outside-sandbox Windows verification cleared the environment limitation. Conformance passed 10/10 and the runner suite passed 7/7. Changes are ready for the scoped local commit; no push or PR is authorized.
- The `.cmd` mapping fix and regression now pass. Full conformance remains blocked because sandbox `taskkill /T /F` fails with `The user name or password is incorrect`, leaving fake process trees alive; the existing runner abort-tree test fails identically.
- Independent review found no Critical findings, one Important blocker, and one Minor assertion gap. No provider, relay, database, auth, or `.sigil` JSON access occurred.

## Session update: 2026-10-16 Floor Warden bridge (phase 6)

- Branch `feat/sigil-rooms-phase6-floor-warden-bridge`, plan `docs/superpowers/plans/2026-10-16-sigil-rooms-phase-6-floor-warden-bridge.md`, spec `docs/superpowers/specs/2026-10-16-sigil-rooms-phase-6-floor-warden-bridge-design.md`. Tasks 1-15 done; merged as PR #59. Follow-ups on `fix/sigil-phase6-followups`.
- Adds the Floor Warden bridge (`sigil agent run --room-bridge floor-warden`), `sigil bot add` and `sigil bot disable`, relay-held bot signing, and `POST /v1/rooms/{room_id}/replies` (enabled by `--floor-warden-reply-token-env`). README "Floor Warden bridge" documents flags and secret storage.
- Open assumptions (spec "Assumptions"), none closed against the real routine:
  - 1: the sender-key header format is unknown; the bridge sends `Authorization: Bearer <key>` unless `--floor-warden-key-header` says otherwise.
  - 2: the routine may deliver a payload twice; dedupe is not assumed.
  - 3: the 256 KiB webhook payload limit is a guess.
  - 4: the owner id comes from the operator identity, not the literal `usr_soren`.
  - 7: bot signing needs Postgres; memory mode answers `503 BOT_SIGNING_UNAVAILABLE`.
  - 8: the 15-minute deadline, 5 forward attempts, 20-message context, and 4000-character clip are starting values.
  - 5 and 6 (token loading, daemon ack) were checked in Task 1; see `docs/superpowers/plans/2026-10-16-floor-warden-bridge-verification-notes.md`.
- Still open: copy the routine's webhook URL and sender key (parent spec open question 2), the live smoke test (needs the phase 7 tunnel so Grok's cloud can reach the reply route), `ep_chief` and `ep_helix_ci` creation, and Ironbots requests.

## Session update: 2026-10-15 third-party login merged (PR #53)

- PR #53 (`feat/sigil-rooms-third-party-login`) merged to `main` as `dce8139`; all 8 checks green. Supersedes the 2026-10-14 entry below (Tasks 0-15 done, now merged).
- CI fixes before merge: `sigil/cli/relay-up-p2p.test.mjs` now clears its start-timeout timers (Node 22 file process outlived the 30s per-file timeout); CI builds `packages/sigil-rooms-web/dist` before `npm run test:live` (guard in root `ci-workflow.test.mjs`); the 033 dup-key migration test deletes its rows in `finally` so migration 034 does not refuse in the shared DB.
- Still open, none blocking:
  - `relay-admin-listener.pg` hangs (3088s once), fails identically on main `013480e`, and pollutes the shared DB for later suites.
  - Deferred minors: e2e wrong-Origin WS check hangs instead of failing if the socket opens (needs reject-on-open plus timeout); logout close code unasserted; README `--human` row omits `[--room] [--endpoint]`; `20d62bc` (Date vs function `now`) covered by e2e only.
  - Spec says `/approve` via the proxy returns 404; implementation returns the SPA shell with 200. Amend the spec or make the static server return 404.
  - Router-pick vs revoke race and the targeted-invite reactivation gap (see entries below) remain deferred.
  - Manual smoke against real GitHub not run.
- Cleanup: worktree `C:\dev\.worktrees\sigil-third-party-login` and its branch still exist; remove by hand.

## Session update: 2026-10-14 third-party (GitHub) login Task 15 (e2e, Origin check, docs)

- Branch `feat/sigil-rooms-third-party-login` in `C:dev.worktreessigil-third-party-login`, plan `docs/superpowers/plans/2026-10-13-sigil-rooms-third-party-login.md`. Tasks 0-15 implemented; unpushed, no PR; final whole-branch review pending.
- New: `sigil/integration/oauth-login.e2e.test.mjs` (real `relay up --enable-mock-oauth`, static server in cookie mode, fake GitHub, loopback TLS proxy from `sigil/integration/fixtures/loopback-tls-proxy.mjs`), `packages/sigil-rooms-web/e2e/cookie-origin.e2e.ts` (Playwright: the form POST to `start` carries Origin equal to `--public-origin`), and the real-provider checklist `docs/superpowers/plans/2026-10-13-oauth-login-manual-smoke.md`.
- The e2e found two production bugs, both fixed: ws tickets from the cookie listener had no `session_id` (logout did not close the socket), and the cookie listener passed `now` as a function so room writes failed with Invalid time value.
- Still deferred: router-pick vs revoke race (see below); a targeted (`--human`) invite that reactivates a revoked identity consumes the invite but adds no rooms; `/approve` through the proxy returns the SPA shell (static fallback), not the relay page.
- Manual smoke against real GitHub (open items 1 and 4) not run yet.
- Next action: final whole-branch review, then push and PR (ask first).

## Session update: 2026-10-13 multi-human foundation Task 17 (docs and full verification)

- Branch `docs/sigil-rooms-third-party-login-spec` in `C:\dev\.worktrees\sigil-third-party-login`, plan `docs/superpowers/plans/2026-10-12-sigil-rooms-multi-human-foundation.md`. Tasks 1-17 done; nothing pushed, no PR.
- Docs: README "Multi-human rooms" (wrap key, `--reconcile-kind`, `--public-origin`, trust change, operator commands, invocation policy, residual risk, room controls, known limitations), CHANGELOG Unreleased, and the `relay up` help text.
- Test fixes (stale fixtures, no production change): `sigil/ingress/v1/build-task-request.test.mjs` (registry entry needs a `keys` Map), `sigil/relay/v1/http-server.test.mjs` directory invites (registry row needs `kind: 'human'` to get `human_id`), `sigil/relay/v1/postgres-repository.integration.test.mjs` (two tests stored `decode('00')` as the public key, which the Postgres trust lookup now reads; they returned 500).
- New tests for spec Testing bullets: legacy no-`kind` row and `--reconcile-kind` (`registry-seed.pg`), shadow sender refused on local accept (`accept-federated-envelope.pg`), fixed-size `sigil_admin` payloads for a human with 120 endpoints and sessions (`human-suspension.pg`), `human add --room` from a second process reaching a live relay socket (`relay-admin-listener.pg`).
- Verification, `SIGIL_TEST_DATABASE_URL=postgres://sigil:sigil_password@127.0.0.1:55432/sigil_test`:
  - `npm test` with the URL set runs Postgres files in parallel and they reset the shared schema: 1855 tests, 1617 pass, 236 fail (206 `pg_type_typname_nsp_index`, 99 "already exists"). Not a valid run; use the two runs below.
  - `npm test` without the URL (Postgres tests skip): 1858 tests, 1606 pass, 3 fail, 3 cancelled, 246 skipped. All six are 30 s subprocess timeouts under load from an unrelated concurrent `npm test`; rerun serially (`agent-cli`, `cli-runner`, `rooms-exit`, `rooms-router-exit`, `agent-daemon`, `contract-signing`): 38 pass, 0 fail.
  - The 58 Postgres test files, `node --test --test-concurrency=1`, in two halves: 151 tests, 150 pass, 0 fail, 1 skipped (multi-worker control race, needs provisioned fixtures); 125 tests, 125 pass, 0 fail.
- Known, unchanged: `relay up --p2p` listen-multiaddr test can time out; CLI subprocess tests are flaky under parallel load and pass serially.
- Next action: final whole-branch review, then the login-spec plan (`docs/superpowers/specs/2026-10-11-sigil-rooms-third-party-login-design.md`).

### Known gap: router pick vs suspension after endpoint revoke

Router pick (`POST /v1/rooms/:id/invocations`, `sigil/relay/v1/room-routes.mjs`) takes `FOR SHARE` on the trigger sender's endpoint before the room lock so a concurrent `suspendHuman` waits and then cancels the picked invocation. `suspendHuman` updates only `active` endpoints, so if the trigger sender's endpoint was already revoked (and the human still has another active endpoint in the room) the suspension does not wait, and a pick landing mid-suspension can start one running invocation under the suspended human that nothing cancels. Exposure: one agent turn. Fix: also `SELECT 1 FROM humans WHERE human_id = $1 FOR SHARE` on the trigger sender's `owner_id` before the endpoint lock (order humans, endpoints, rooms), plus a revoked-endpoint interleaving test through `handleRoomRoute`. The existing race test calls `lockEndpointForShare` and `dispatchToTarget` directly, not the route.

### Known gaps: memory-only test coverage

The foundation spec's Testing section says every bullet runs against Postgres. The bullets below are covered only by memory-repository or stubbed-handler tests. No Postgres versions exist yet; write them before you rely on Postgres coverage for these rules.

- Guest `task.request` to an owner-only assignee is refused; a `members` assignee runs with the guest as subject: `sigil/relay/v1/room-dispatch.test.mjs` "policy 3".
- A `members` agent invoked by a guest cannot hand off to an owner-only agent: `room-dispatch.test.mjs` "policy 4".
- A guest who may invoke no `joins` agent triggers no router delivery: `room-dispatch.test.mjs` "policy 5".
- A guest thread post does not reset an operator chain's `agent_turns`: `room-dispatch.test.mjs` "policy 6".
- Promotion refuses a queued invocation whose subject was removed from the room, or whose agent switched to `owner`: `room-dispatch.test.mjs` "policy 7" (memory labels). Only the suspended-subject case has a Postgres test (`room-invocations.pg.test.mjs` "policy 7 (Postgres)").
- Guest `stop` cancels none of the operator's invocations and does cancel its own, at route level: `sigil/relay/v1/room-routes.manage.test.mjs` "stop: a guest cancels what they started...". The repository query has a Postgres test (`rooms-manage.pg.test.mjs` "cancelRoomInvocations scoped by agent owner or subject"); the route does not.
- Guest `POST /v1/rooms` answers 403: `room-routes.manage.test.mjs` "create room: a non-operator endpoint gets 403...".
- A relay without `--room-human-identity` answers 503 `NO_OPERATOR_IDENTITY`: `room-send-route.test.mjs` "no humanSigner answers 503 NO_OPERATOR_IDENTITY and signs nothing" and `room-routes.manage.test.mjs` "create room: without --room-human-identity...".
- An agent caller cannot create rooms, add members, or post as a human (`HUMAN_CONTEXT_REQUIRED`): `room-routes.test.mjs` and `room-send-route.test.mjs` "a non-member gets 404 and an agent gets 403 HUMAN_CONTEXT_REQUIRED".
- Removing a human member cancels their invocations in that room: `room-routes.manage.test.mjs` "remove member: removing a human cancels their invocations in that room only".

The full bullet-by-bullet coverage walk is in `.superpowers/sdd/2026-10-12-sigil-rooms-multi-human-foundation/task-17-report.md`, which is untracked.

## Session update: 2026-10-10 Tincan listener pushed

- Branch `feat/sigil-tincan-bridge` in `C:\dev\.worktrees\sigil-tincan`. Listener commit `3a7214c feat(tincan): serve dispatch on the tailnet` is on origin (`778b9d9..3a7214c`). This note is the resume record on top of it.
- `POST /v1/dispatch` runs `verifyTailscaleWhoIs`, then `dispatchDeliveryWithRetry`. The peer names `target_endpoint`. Host config owns bridge type, identity path, and relay URL. `GET/POST /v1/approval-callback` calls `releaseEnvelope`. The callback stays on `127.0.0.1` because `createApprovalChallenge` rejects every other host. `--tailnet` binds dispatch to this machine's Tailscale IPv4 address and uses `tailscale whois --json`. Node does not embed Go `tsnet`.
- Pre-push hook: JCS audit passed. `npm test` reported 1471 pass, 0 fail, 175 skipped. Hermetic tincan tests: 29 pass, 1 skipped. `SIGIL_TINCAN_LIVE=1` same-host hairpin passed in 145 ms.
- Push pitfall: `C:\Windows\System32\bash.exe` cannot open `C:/dev/...` hook paths. Prepend `C:\Program Files\Git\bin` to `PATH` before `git push`.
- A docs-only push on 2026-10-10 was cancelled by `sigil/cli/relay-up-p2p.test.mjs:58` (`sigil relay up --p2p logs a listen multiaddr`) at 30000 ms: 1470 pass, 0 fail, 1 cancelled, 175 skipped. That timeout is outside tincan.
- Secret scan rejects a test helper shaped like `token: '<8+ chars>'`. The relay test passes that value as `bearer`.
- Two-node proof, 2026-10-10: Node B `laptop-66oogh2m` (`100.109.165.118`) ran `tincan-relay.mjs --config %TEMP%\tincan-two-node-config.json --tailnet` from `C:\Users\soren\$root` (clone of `feat/sigil-tincan-bridge`). Node A `win-dta4v21lkvr` (`100.80.111.33`) posted `/v1/dispatch` for `ep_codex`. Response HTTP 200 `{"status":"DELIVERED","node":"win-dta4v21lkvr.tailb2474f.ts.net.","alreadyRunning":false,"endpointId":"ep_codex","pid":23332}`. The `node` value is WhoIs of the caller. `pid` 23332 is the process the laptop relay spawned. That path runs `node sigil/cli/sigil.mjs agent run --room-bridge codex`. The laptop firewall rule `tincan-dispatch-proof` allows inbound TCP 8794. The spawned agent uses `proof-identity.json` and `http://127.0.0.1:8791`, so the process can exit after spawn. `DELIVERED` means the spawn returned a pid.
- Room routes committed on this branch: a room `task.request` requires `body.assignee` (a current member). `lookupTaskRequest` prefers the direct recipient, then `body.assignee`. `task.result` must come from that assignee. An invocable assignee gets `decided_by = 'assignee'` via migration `032_room_task_assignee.sql`. `GET /v1/mentions` lists room messages that mention the caller. Hermetic tests passed: room policy, dispatch, and routes; task-request schema; migration 032; `postgres-repository.test.mjs`; `memory-repository.test.mjs` (46 pass, 0 fail on the lookup files).
- MCP tools written in the worktree, not committed: `sigil_dispatch_task` queues a signed room `task.request` with a required `assignee`. `sigil_my_mentions` reads `GET /v1/mentions`. Registered in `mcp-stdio-server.mjs`.
- Pull request: https://github.com/sorensencc-dotcom/sigil/pull/48 at `b5ecc36`. [PR #46](https://github.com/sorensencc-dotcom/sigil/pull/46) merged `d4bb6f6` and does not contain `6e4864f` or these tools.
- Next action: review and merge PR #48. Still deferred: a system-identity path for `host_unreachable`, and `grok` as a `--room-bridge` value. Resume file: `docs/superpowers/plans/2026-10-09-sigil-tincan-transport-bridge-handoff.md`.

## Session update: 2026-10-08 PR #36 conflict resolution

- Merged `origin/main` into `pr-36-conflict-fix` for GitHub PR #36 and resolved the only content conflict in `STATUS.md` by preserving both independent session updates.
- Validation: `node --test --test-timeout=30000 sigil/cli/contract-signing.test.mjs` passed 5/5; `node --test --test-timeout=30000 sigil/relay/v1/federation-reaper.test.mjs` passed 19/19; direct `node --test --test-timeout=30000` passed 1610 tests, 1436 pass, 0 fail, 174 skipped; `git diff --check` passed. `npm run test:bounded` printed the same zero-fail test summary but its 60s wrapper timed out before npm returned.

## Session update: 2026-10-07 verify-contract/reaper review tests

- Reviewed branch `fix/verify-contract-revocation-check` around `verify-contract` revoked-key handling and `startFederationReaper().stop()` timer cleanup.
- Added real CLI-path regression coverage for active, revoked, missing-key, and invalid-signature `verify-contract` outcomes.
- Added focused reaper timer coverage proving `.stop()` exists and prevents later interval passes.
- Focused evidence: `node --test --test-timeout=30000 sigil/cli/contract-signing.test.mjs` passed 5/5; `node --test --test-timeout=30000 sigil/relay/v1/federation-reaper.test.mjs` passed 19/19; `git diff --check` passed.

## Session update: 2026-10-04 sigil rooms phase 3 (router)

- Phase 3 of the rooms design is built on `feat/sigil-rooms-phase-3-router`, executed task by task from `docs/superpowers/plans/2026-10-04-sigil-rooms-phase-3-router.md`. Pushed to origin on 2026-10-05 (PR opened against main); includes Tasks 9-13, the merge of origin/main with PR #22, and the final-review fix wave.
- Shipped: migration 030 (`room_router`) and migration 031 (drops 030's one-router-row-per-trigger index so a decision naming two or more endpoints commits); the `room.event` message type; a relay system identity (`ep_relay_system`, kind `system`) with its own signing key; the `router` response mode and its delivery rule (the router member receives unmentioned human messages); `POST /v1/rooms/{id}/invocations` (the router posts a pick, the relay re-validates it and commits invocation rows and a `router_decision` event in one transaction); the router daemon (`createRoomRouter`, Ollama `/api/chat` with a JSON schema); `router_failed`, refusal, and Stop events visible in room history; CLI wiring (`sigil relay up --room-system-identity`, `sigil agent run --room-bridge router` with `--router-model`, `--router-ollama-url`, `--router-timeout-ms`, `--router-context-messages` (positive integers), and `--router-sole-agent-fallback on|off`); contracts; exit test `rooms-router-exit.test.mjs`.
- Evidence (after the final-review fix wave): `npm test` 1444 tests, 1279 pass, 0 fail, 0 cancelled, 165 skipped (the `relay up --p2p` flake did not trigger). `npm run test:live` (disposable Postgres at localhost:55432, migrations 030 and 031 applied) 180 tests, 179 pass, 0 fail, 1 skipped, 35 files. `npm run audit:jcs` clean. Earlier, the first live run failed 3 tests in `room-events.pg.test.mjs` and `room-invocations-route.pg.test.mjs` (`column "client_id" of relation "oidc_issuer_allowlist" already exists`): those suites migrated without a schema reset; fixed by migrating with `{ reset: true }` like the sibling suites.
- Live smoke (after the fix wave): `SIGIL_LIVE_ROOM_ROUTER=1 node sigil/scripts/live-room-router.mjs` with real Ollama `qwen2.5:7b` and the real `claude` CLI exits 0 with the fallback on, and the decision source was the model, not the fallback (`invoke=["ep_claude"] reason=review error handling`). With `SIGIL_LIVE_ROOM_ROUTER_NO_FALLBACK=1` (fallback off) it also exits 0 with a model pick of `ep_claude`. Before the fix wave the model returned an empty pick and only the fallback produced a reply; the change between runs is the prompt now carrying the trigger text in `<newest_message>`. One run each, so routing quality is still unmeasured.
- Router fallback: when model call succeeds but validated pick is empty and room has exactly one `joins` agent (excluding router), router invokes that agent via the same invocations route; reason is prefixed `fallback: only joins agent`, plain text, max 280 chars. Not applied on model failure (`router_unavailable`, invokes no one), non-empty pick, or 0 or 2+ joins agents. Relay still enforces. Spec decision D5; on by default, `--router-sole-agent-fallback off` disables it.
- Known limits: routing adds one local model call of latency per unmentioned human message (timeout 20 s in the daemon); a 7B model may route unreliably (before the fix wave it returned an empty pick for a clear request) and routing quality is unmeasured; the router depends on a running Ollama and posts `router_failed` when it is unreachable; an agent cannot hand off to another agent without an explicit @mention; the router picks only members with response mode `joins`; emitted `room.event`s are not pushed over SSE, so humans see them only by polling inbox or history (needed before the phase 4 web client); a relay started without `--room-system-identity` creates no router deliveries.
- Provisioning the system identity: generate the file with `node -e "import('./sigil/cli/identity.mjs').then(m => m.saveIdentity('relay-system.json', m.createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' })))"`, then start the relay with `sigil relay up --room-system-identity relay-system.json`. Keep the file out of git and readable only by the relay's service account. To rotate, generate a new identity file (new `key_id`) and restart the relay.
- Open decisions for Chris: none (fallback decided and shipped).
- Next action: review and merge the phase 3 PR; then phase 4 (web client, needs SSE push of room.event) is the next design step.

## Session update: 2026-10-03 sigil rooms phase 2 (bridges and guards)

- Phase 2 of the rooms design shipped on `feat/sigil-rooms-phase-2`, executed task by task from `docs/superpowers/plans/2026-10-02-sigil-rooms-phase-2-bridges.md`. Branch not pushed.
- Shipped: migration 028 (`room_invocations`, `room_threads`, `rooms.max_agent_turns`); invocations per mention; hop budget default 6 per thread, reset by a human message; one running invocation per agent per room with queueing; a Stop route that kills the CLI process tree; Claude and Codex bridges through `sigil agent run --room-bridge claude|codex`; invocation list and fail routes; agents excluded from fan-out.
- Phase 1 leftovers closed: fan-out quota and revoked endpoints, `streamSeq` removed from room notifications, forwarded room envelopes refused before approval consumption, agents refused room management, agent tokens no longer carry `human_id` (Chris chose option b).
- Evidence: exit test `Claude and Codex hold a 6-turn exchange, then the hop budget stops them` passes (plus `Stop cancels the running invocation and kills the CLI before it answers`). `npm test` 1308 tests, 1152 pass, 0 fail, 1 cancelled, 155 skipped; the cancelled test is the known `sigil relay up --p2p logs a listen multiaddr` load flake (30 s timeout), 4/4 when rerun alone. `npm run test:live` 170 tests, 169 pass, 0 fail, 1 skipped (32 files). Live smoke (`SIGIL_LIVE_ROOM_BRIDGES=1 node sigil/scripts/live-room-bridges.mjs`) with real `claude` and `codex`: 6 alternating agent turns, then a `hop_budget` refusal, exit 0.
- Known limits: the daemon processes invocations sequentially across rooms; refusals are visible only through `GET /v1/rooms/{id}/invocations` until phase 3's `room.event`; no daily cost budget yet; a running invocation whose bridge dies stays running until a human presses Stop (no timeout); registry entries without `kind` keep `human_id`; agents cannot create capability grants (403 `GRANT_HUMAN_REQUIRED`) but can revoke their own, recorded in `capability_revocations.revoked_by_endpoint` (migration 029, Chris chose option 3; not yet run against live Postgres); `task.request` and `task.result` stay refused in rooms until phase 3; the Codex `read-only` sandbox still lets Codex read any file on the disk (it blocks writes, not reads), and Windows sandbox enforcement for Codex is unverified; on Windows, `.cmd` shims (for example an npm-installed `claude.cmd`) need `--agent-command` with the real executable path because the bridge spawns without a shell; an expired Claude or Codex resume session id keeps failing every turn in that room until you delete the room's entry from the `--room-sessions` file; the Claude bridge runs `claude -p --output-format json --setting-sources project --permission-mode default [--resume <id>] --strict-mcp-config --tools Read Grep Glob --allowedTools Read Grep Glob` (`--bare` was rejected: it ignores OAuth logins and fails with "Not logged in · Please run /login"), and both CLIs get an environment allowlist (PATH, system and profile dirs, LANG, and `ANTHROPIC_`/`CLAUDE_`/`CODEX_`/`OPENAI_` variables); the bridge offers and extracts mentions only for members with a `response_mode`, so an agent added without a mode is invocable by humans but not by other agents.
- Final review fixes (2026-10-03): Claude bridge isolation flags; per-thread session cursor (`last_seq_by_thread`) so a queued trigger in another thread is not skipped; bridge fails its invocation on any error once the invocation is known, and the daemon leaves the delivery unacked when the bridge throws before that; agents classified by `response_mode` or registry `kind`; `ROOM_NOT_INVOKED` in the contracts; mention boundary check; env allowlist. Report: `.superpowers/sdd/2026-10-02-sigil-rooms-phase-2-bridges/final-fix-report.md`.
- More known limits from the final re-review: `--setting-sources project` still loads `.claude/settings.json` (hooks and allow rules) from the bridge's working directory, so point `--agent-cwd` at a directory with no `.claude/` folder. A room delivery whose bridge fails before it finds its invocation (for example, the agent was removed from the room) stays unacked and is retried every poll (15 s) indefinitely; follow-up is to ack on 4xx relay answers. The CLI environment allowlist drops `HTTPS_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS`, so CLI auth fails behind a proxy.
- Open decisions for Chris: push the branch and open a PR.
- Next action: write the phase 3 plan (router).

## Session update: 2026-10-02 sigil rooms phase 1 (relay rooms) complete

- Phase 1 of the rooms design (`docs/superpowers/specs/2026-10-02-sigil-rooms-design.md`) shipped on `feat/sigil-rooms`, executed task by task from `docs/superpowers/plans/2026-10-02-sigil-rooms-phase-1-relay.md`. Completed 2026-10-02. Branch not pushed; no PR opened yet.
- Relay rooms: migration 027 (`workspaces`, `rooms`, `conversation_members.response_mode`, `envelopes.room_seq`), `room.message` body schema, room methods in both repositories, `room-policy.mjs` (membership checked after signature verification), gapless per-room `room_seq` assigned in the accept transaction, fan-out deliveries plus stream notify, and `/v1/rooms*` HTTP routes with contract entries.
- Final-review fixes: federated and forwarded envelopes cannot enter or enroll into a room; `task.request`/`task.result` are refused in rooms until phase 3 adds assignee binding; history items carry `canonical_bytes`; room route repository failures return 503.
- Evidence: `npm test` 1233 tests, 1086 pass, 146 skipped, 1 fail (the known `sigil relay up --p2p logs a listen multiaddr` load flake, 4/4 when rerun alone). `npm run test:live` 161 tests, 160 pass, 0 fail, 1 skipped (pre-existing multi-worker race suite).
- Not fixed here: the published package omits `sigil/contracts/v1/*.mjs`, so `validate-envelope.mjs` imports fail from the tarball; needs its own `fix(sigil)` PR off `main`.
- Next action: phase 2 (Claude and Codex bridges plus the hop budget, rate limit, and Stop guards).

## Session update: 2026-09-20 libp2p final-review m7 (mDNS opt-out)

- Closed 7 of 8 non-blocking findings from the libp2p transport driver's final review. m8 remains open, needing its own design decision (per-relay logger/metrics instance at the p2p call site).
- m7: `sigil relay up --p2p` accepts `--p2p-no-mdns` to disable mDNS advertisement while keeping the data/control protocols and any explicit `--p2p-listen` dial-in address; default unchanged (mDNS still on with `--p2p`). `sigil.mjs`'s `createP2pHost` call site now derives `enableMdns` from the new flag instead of a hardcoded `true`.
- Focused evidence: `sigil/cli/relay-up-p2p.test.mjs` 4/4 (new regression test: `--p2p-no-mdns flag wires enableMdns: false into createP2pHost`).
- Previously-noted flaky test (`sigil relay up --p2p logs a listen multiaddr`, 5s wait, times out under parallel-suite contention) now has its own TODOS.md entry (filed this session) rather than being tracked only here.

## Session update: 2026-09-20 libp2p final-review hardening batch (m2-m5, n1, n2)

- Closed 6 of 8 non-blocking findings parked in TODOS.md from the libp2p transport driver's final review (m2-m5, n1, n2). m7 and m8 remain open, needing their own design decisions.
- m2: read timeout on inbound streams (`readOneFrameWithTimeout` in `frame-codec.mjs`, 10s default, configurable) — both protocol handlers now abort a stream that never sends a frame.
- m3: `sendEnvelope`/`ping`/both handlers now close the dialed/inbound stream after one round trip instead of relying on host `.stop()`.
- m4: control-protocol handler now has `try/catch`/`finally`, matching the data protocol's shape.
- m5 (rescoped, see below): data-protocol's own catch block no longer forwards an unexpected error's raw message to the remote peer — only `reject()`-originated errors (which carry `.code`) do.
- n1: documented the dropped explicit `node.start()` call in `p2p-host.mjs`.
- n2: all ten libp2p-family dependencies exact-pinned; `sigil-dep-audit.mjs` now reports zero loose-version warnings for this family (verified: it previously flagged all ten).
- **New finding, left open, filed in TODOS.md:** while fixing m5, discovered `accept-envelope.mjs`'s `toResponse` (shared by HTTP and p2p transports) echoes any caught error's raw `.message` verbatim, including unexpected internal exceptions with no `.code` — a broader, transport-shared leak than the p2p-scoped m5 finding described. Not fixed here; changing it touches the HTTP transport's error-response contract and needs its own review.
- Focused evidence: `transport-libp2p/*.test.mjs` + `relay-up-p2p.test.mjs` 14/14 (including 2 new regression tests: m2 stream-close-on-timeout, m5 no-leak-before-acceptEnvelopeAsync). Full pre-push suite 1027/0/132 skip.
- Known flaky test, not caused by this change: `sigil relay up --p2p logs a listen multiaddr` intermittently times out (5s wait) when run inside the full parallel suite; passes 3/3 standalone every time observed this session. Not yet filed as its own TODOS.md entry.

## Session update: 2026-09-20 libp2p DHT ping-service fix

- Registered the `@libp2p/ping` service in `createP2pHost({ enableDht: true })` (`sigil/relay/v1/transport-libp2p/p2p-host.mjs`) — `@libp2p/kad-dht` hard-requires it and `createLibp2p` threw without it. Added `@libp2p/ping` as an explicit dependency (was previously only present transitively). Closes the TODOS.md item of the same name.
- `sigil relay up --p2p` still passes `enableDht: false` by default — the crash is fixed, but turning Kademlia on is a separate, undecided deployment choice (network exposure), not a bug fix.
- Added a regression test (`p2p-host.test.mjs`) asserting `createP2pHost({ enableDht: true })` starts without throwing.
- Focused evidence: full `transport-libp2p/*.test.mjs` + `sigil/cli/relay-up-p2p.test.mjs` pass 14/14.

## Session update: 2026-09-20 disposable PostgreSQL repair

- Reset only the disposable `sigil_test` schema in the running `sigil_postgres` container after migration 014 collided with pre-existing `oidc_issuer_allowlist.client_id` state.
- Live migration evidence: all 27 migrations applied successfully, including AgentMail migrations 024, 025, and 026.

## Session update: 2026-09-20 Doppler resolver adapter

- Added a fail-closed Doppler CLI secret provider for the six configured AgentMail secret references. Secret values remain outside logs and test output; the provider maps only approved `secret://sigil/agentmail/...` paths.
- Focused evidence: resolver adapter plus AgentMail config/bootstrap/rotation tests passed 13/13 with a 10-second test timeout.
- Live Doppler read was not verified from Codex because this process does not share the operator's interactive Doppler login. Run the supplied PowerShell check in the authenticated operator shell before activation. Provider rotation remains intentionally unsupported until a safe AgentMail credential-write contract is approved.
## Session update: 2026-09-20 — libp2p transport driver

Added `sigil/relay/v1/transport-libp2p/` (peer-id.mjs, frame-codec.mjs,
p2p-host.mjs, p2p-data-protocol.mjs, p2p-control-protocol.mjs): a libp2p
(Noise XX / Yamux / TCP, optional mDNS + Kademlia) transport driver that
reuses the existing envelope/JCS/ACL/delivery-state pipeline
(`accept-envelope.mjs`) unmodified. Wired into `sigil relay up --p2p`
(new `--p2p-identity <path>` and `--p2p-listen <multiaddr>` flags;
default listen is `/ip4/127.0.0.1/tcp/0`, loopback-only — override
`--p2p-listen` for real cross-machine deployment).

Verified: unit + integration tests for PeerId derivation, framing,
authenticated dial, data-protocol round trip via `acceptEnvelopeAsync`
(including a `PEER_IDENTITY_MISMATCH` negative-path test — a dial from an
unregistered identity claiming a registered sender endpoint is rejected
before `acceptEnvelopeAsync` is ever called), control-protocol heartbeat,
CLI `--p2p` startup — all in-process over loopback TCP. `npm test`
(dep audit + JCS audit + full suite) green, 1155/1023/0/0/132
(tests/pass/fail/cancelled/skipped).

Known gap: `--p2p --p2p-listen ...` cannot enable Kademlia DHT as shipped
— `createP2pHost({enableDht: true})` throws (`@libp2p/kad-dht` requires an
`@libp2p/ping` service that `p2p-host.mjs` does not register). CLI wiring
sets `enableDht: false` unconditionally pending that fix. mDNS remains the
supported in-process discovery path.

Not verified (needs real multi-process/multi-host environment, not
automatable in `node --test`): mDNS discovery across separate worktrees,
Kademlia provider lookup across networks, Noise handshake rejecting a
mismatched PeerID under adversarial (not just application-level registry
mismatch) conditions, reconnect/retry after a dropped stream. These are
spec §10 Phase-2 gates still open.

Deferred, not built: control-protocol peer-state and revocation gossip
(spec §8 lists these alongside heartbeat; heartbeat only shipped here —
needs a gossip-topology and revocation-trust design this plan didn't make).

## Session update: 2026-09-20 AgentMail provider adapter

- Added the official `svix` dependency and a concrete AgentMail provider adapter. The adapter verifies raw Svix-signed webhook bodies, rejects unsupported or mismatched events, maps documented `message.received` fields, and retrieves oversized message bodies through the existing transport boundary.
- Extended the AgentMail transport with SDK-backed attachment retrieval and atomic webhook-header update operations. No provider account, secret value, or production activation changed.
- Focused evidence: AgentMail provider, transport, ingress, and bootstrap tests pass 21/21; dependency audit, JCS audit, and `git diff --check` pass.
- Rotation remains intentionally uncommitted to a vendor-specific secret-manager write path. The existing rotation port still fails closed until a production secret manager and deployment credential policy are selected and approved.

## Session update: 2026-09-20 AgentMail secret management

- Implemented typed secret references and explicit resolver ports. Production rejects raw or mixed webhook/forwarding credential variables; local/test compatibility remains isolated in `agentmail-legacy-config.mjs`.
- Added immutable composite generations shared by transport and webhook verification, bounded previous-generation overlap, generation-aware SDK clients, PostgreSQL-backed control migration 025 with leases/cache/fail-closed stale behavior, explicit control capabilities in migration 026, authorization, provider-rotation port, and rotation coordinator.
- Wired opt-in deployment bootstrap and `sigil relay up` adapter-module loading. `SIGIL_AGENTMAIL_ENABLE` remains default-off. Authenticated control routing is absent unless an authenticator and control handler are both injected. No deployment secret-manager SDK or provider rotation behavior was fabricated.
- Focused evidence: Tasks 1–5 passed 15/15, 32/32, 22/22, 11/11, and 10/10 respectively. Task 6 real relay HTTP integration passed 1/1; PostgreSQL concurrency evidence skipped because `SIGIL_TEST_DATABASE_URL` is unset.
- Bounded-suite evidence: `npm run test:bounded` exits 1 before child output because its nested worker spawn is denied on this host. Direct bounded-equivalent execution passed: 1097 tests, 973 passed, 0 failed, 124 skipped, 2 suites.
- Audit evidence: `npm run audit:deps`, `npm run audit:jcs`, and `git diff --check` passed. Focused transport/bootstrap regression after the drain-wiring fix passed 7/7.
- Live PostgreSQL evidence: guarded disposable gate passed 29 files, 135 tests, 134 passed, 0 failed, 1 skipped. The AgentMail multi-worker control race remains skipped because deployment approval fixtures are required. Live provider, staging, remote, and production evidence remain separate and absent.
- Production blockers: approved deployment secret-manager adapter, approved AgentMail provider verification/rotation adapter, non-sensitive canary, old-generation rejection check, retention deletion, alert exercise, privacy/compliance approval, and Tier 1 approval.

## Session update: 2026-09-15 AgentMail review remediation

- Scoped review findings were remediated in the disposable checkout `C:\dev\dev-sandbox\sigil-agentmail-review`: raw email body can no longer populate trusted task instructions; canonical mailbox endpoints and per-inbox webhook secret references are required; forwarding addresses enforce one domain; provider verification has a parser timeout; sender rate limits and attachment limits are wired; inactive endpoint mappings fail closed; signed receipts and envelope message IDs are linked; PostgreSQL ledger transitions and queue admission use transactional locking; memory queue depth recovers at terminal states; legal holds cannot be cleared or deleted through ordinary retention operations.
- Focused AgentMail ingress evidence: 45/45 passed. Full direct Node discovery: 1,060 total, 937 passed, 0 failed, 123 skipped. Dependency audit and JCS audit passed. The repository has no `lint` script. No live PostgreSQL gate ran because `SIGIL_TEST_DATABASE_URL` is unset.
- Production blockers remain: live non-sensitive canary, real secret rotation, retention deletion against the deployment storage, operational alerting, privacy/compliance approval, and Tier 1 approval. Financial-sensitive handling remains default-deny; no production readiness is claimed.

## Session update: 2026-09-14 AgentMail ingress implementation

- Implemented the approved three-mailbox AgentMail ingress slice in commits `8e6dd9f`, `c63d687`, `24d8531`, `383b7af`, `7e95960`, `08ef4cc`, `d9ab07d`, `97d17d9`, and `418201d`.
- Added strict inbox configuration/provenance, signed `ep_ingress` task requests using existing JCS/Ed25519 helpers, bounded quarantine/classification/document normalization, pinned `agentmail@0.5.24` transport, deterministic webhook routing, durable ingress ledger migration 024, signed redacted receipts, explicit `ep_ingress` provisioning, opt-in HTTP route registration, and injected-key AES-256-GCM quarantine with legal-hold-aware audited purge.
- Focused evidence: 38/38 AgentMail ingress tests passed; direct repository-wide Node test run: 1,053 tests, 930 passed, 0 failed, 123 skipped. Dependency audit, JCS audit, and `git diff --check` pass. `SIGIL_TEST_DATABASE_URL` was unset, so no live PostgreSQL gate was run in this session.
- Pre-production blockers remain: live non-sensitive AgentMail canary, webhook secret rotation, retention deletion, operational alerting, privacy/compliance approval, and Tier 1 approval. Financial-sensitive handling remains default-deny; no production readiness is claimed.
- Existing dirty work in `sigil/relay/v1/http-server.mjs` inbox error handling, `docs/contracts/sigil-helix-authority-contract-v1.md`, and `modules/` was preserved and not staged by this implementation.

## Current goal
Path 3 (Package & Serviceize the Sigil Relay / CLI) — Steps 1 and 2 implemented. Runtime handoff is locally validated; production rollout remains blocked pending security and governance approval.

## Session update: 2026-09-09 protocol diagrams
- Added custom-standard standalone HTML+SVG diagrams, rendered PNG assets, Mermaid sources, and editable Excalidraw placeholders for the FIX session resend flow and connector gap recovery.
- Embedded both PNG diagrams in the session-layer rollout handoff and linked them from the resend observability dashboard document.
- Validation: both PNGs rendered through the local browser renderer; visual inspection passed; `git diff --check` passed.

## Session update: 2026-09-09 final review fixes
- Added resend-specific regression coverage for expired requests and message-id replays; the implementation rejects both before membership or enqueue side effects.
- Fixed relay queue oldest-age gauges to measure `created_at`/`createdAt`, including jobs delayed by retry backoff.
- Validation: focused suites pass 18/18 executed, 3 PostgreSQL tests skipped without `SIGIL_TEST_DATABASE_URL`; `git diff --check` passed.
- Serialized live PostgreSQL gate passes against Docker `sigil_postgres` / `sigil_test`: 28 files, 134 tests, 134 passed, 0 failed, 0 skipped, 129 seconds.

## Session update: 2026-09-09 Task 3
- Completed the FIX session-layer Task 3 refactor: migrated durable federation outbox rows to typed `relay_jobs`, with compatibility adapters preserving federation-visible states and CLI behavior.
- Added migration and shared job-type-scoped claim, finalize, retry, and terminal-state handling; federation reaper claims only `job_type = 'federation'`.
- Validation: 22/22 federation-focused test files passed against the disposable PostgreSQL database; `git diff --check` and changed-module syntax checks passed.
- Detailed handoff: `.superpowers/sdd/2026-09-09-sigil-fix-session-layer/task-3-report.md`.

## Session update: 2026-09-09 Task 3 fix round 1
- Added migration 022 to make `relay_jobs` genuinely generic: generic JSONB payload, nullable federation-only columns, job-type-scoped federation constraints, and type-leading claim indexes.
- Added a non-federation enqueue/claim/finalize/retry lifecycle test; restored federation gate remains 32/32 green.

## Session update: 2026-09-09 Task 3 fix round 2
- Defined generic relay-job idempotency: non-federation enqueue requires a nonblank `idempotencyKey`; migration 023 derives stable legacy keys and enforces a job-type-scoped unique identity.
- Added repeated generic enqueue regression coverage; generic lifecycle passes and the critical federation gate remains 32/32 green.

## Session update: 2026-09-09 Task 3 fix round 3
- Added direct generic key rejection coverage for omitted, empty, and whitespace-only keys.
- Added migration-023 invariant coverage for legacy backfill, check constraint, and partial unique index; focused tests pass 3/3 and federation gate remains 32/32 green.

## Session update: 2026-09-09 Task 4
- Implemented signed `session.resend_request` validation, membership and range authorization, quota reservation, typed `resend` job enqueue, audit, and 202 response without delivery or fan-out.
- Added retention-bounded resend lookup, stream `resend` and `sequence_reset` frames, asynchronous claim/push/reset/requeue/dead-letter worker, metrics, and relay startup wiring.
- Validation: Task 4 focused suites pass 14/14; federation regression set passes 53/53 executed, with 15 database-dependent tests skipped; syntax checks and `git diff --check` pass.

## Session update: 2026-09-09 Task 5 progress
- Added the connector stream-gap tracker with per-stream high-water persistence, bounded out-of-order buffering, debounced resend requests, reset handling, retry exhaustion release, and NULL-sequence fallback.
- Wired the tracker into optional `inbox-wait` polling and stream handling; default inbox behavior remains unchanged.
- Validation: tracker and inbox-wait tests pass 22/22; syntax checks and `git diff --check` pass.

## Session update: 2026-09-09 Task 6 progress
- Added `sigil resend --conversation --from --to --sender` with local signing and existing relay error mapping.
- Added `sigil inbox --local --gaps` output for known stream holes and updated CLI help.
- Validation: CLI syntax check, help output, and `git diff --check` pass.

## Session update: 2026-09-09 Task 6 verification
- Existing CLI regression suites covering configuration, ledger, receipt transport, relay startup, and stream sequences pass 14/14.

## Session update: 2026-09-09 Task 7 progress
- Added a dependency-free relay metrics registry and wired resend request, fulfillment, reset, latency, and dead-letter instrumentation into relay startup.
- Validation: focused observability, resend, worker, and relay-startup tests pass 11/11; syntax checks and `git diff --check` pass.
- Added session resend dashboard panels and alert thresholds under `docs/observability/`.

## Session update: 2026-09-09 Task 7 verification / Task 8 start
- Existing vertical slice passes 4/4 executable tests; one directory-trust case is skipped without PostgreSQL.
- `npm run test:live` is blocked because `SIGIL_TEST_DATABASE_URL` is not set; no live database evidence was claimed.

## Session update: 2026-09-09 Task 8
- Added rollout handoff covering migration order, one-way `relay_jobs` transition, flag rollback, mixed-fleet NULL behavior, recovery operations, metrics, and approval blockers.
- Docker PostgreSQL container `sigil_postgres` is healthy on host port 55432, and `sigil_test` accepts connections. The serialized live gate completed in 142 seconds: 28 files, 134 tests, 134 passed, 0 failed, 0 skipped.
- Added `sigil/scripts/run-live-db-tests.ps1` with the explicit disposable-container URL as a Windows shortcut; it validates the `_test` suffix and clears the process environment afterward.
- Hardened the live runner with per-suite timeout attribution and broken-pipe handling; the Windows launcher accepts `-SuiteTimeoutSeconds` (default 120).
- Fixed PostgreSQL stream-sequence fixtures to avoid prepared multi-statement SQL and to seed valid canonical bytes, protocol, and unique endpoint keys; the live stream-sequence suite now passes 4/4 individually.
- Added the missing vertical FIX recovery scenario: five sequenced messages, dropped message 3, one request for `[3,3]`, worker replay, and ordered connector delivery; vertical slice passes 5/5 executable tests.
- Final serialized live PostgreSQL gate completed against `sigil_test`: 28 files, 134 tests, 134 passed, 0 failed, 0 skipped, 142 seconds.
- Review fix round: sequence assignment now covers normal task request/result types, resend expiry and replay checks are enforced, tracker overflow advances past the requested gap, queue-health gauges emit from worker passes, and stale federation CLI wording is corrected. Critical focused suites pass 18/18.
- Post-review full serialized live gate passes against `sigil_test`: 28 files, 134 tests, 134 passed, 0 failed, 0 skipped, approximately 125 seconds.

## Completed work
- Packaged CLI and verified local npm binary mapping (`sigil --help`).
- Applied PostgreSQL schema migrations 001 through 019 against the live container on port 55432.
- Updated `sigil/cli/sigil.mjs` to register PostgreSQL endpoints without implicitly granting capabilities.
- Updated `sigil/relay/v1/postgres-repository.mjs` to include `status` in `lookupRecipientEndpoint` queries and JSON-stringify payload structures (`body`, `context_refs`, `broadcast_scope`) for `jsonb` column binding.
- Updated supervisor script `C:\dev\scripts\run-sigil-daemon.ps1` to configure `$env:SIGIL_DATABASE_URL` and pass `--database-url` to persistent relay child processes.
- Verified persistent dispatch round-trip from `ep_grokbot` to `ep_claude` (`conv_persistence_test`), verified database records in `envelopes` and `deliveries`, interrupted and restarted daemon, and retrieved delivery from recipient mailbox using `sigil inbox`.
- Executed all 17 tasks of `docs/superpowers/plans/2026-09-03-sigil-cross-federation-directory.md` (subagent-driven-development) against spec `docs/superpowers/specs/2026-09-02-sigil-cross-federation-directory-design.md`.

## Validation evidence
- Local audits: `node sigil-dep-audit.mjs` passed; `node sigil-jcs-audit.mjs` passed.
- Local `npm test`: bounded wrapper exited 1 without child output; a direct rerun produced extensive passing output but no final summary before the host timeout. Final local total remains unconfirmed.
- Live PostgreSQL gate: `npm run test:live` passed against isolated database `sigil_codex_test` on PostgreSQL 16 — 124 passed, 0 failed, 0 skipped, 26 suites, exit 0. Migrations 001–019 applied.
- Existing end-to-end persistence evidence: daemon restart retained delivery and `sigil inbox` retrieved it; this was not rerun during this review.
- CI evidence: prior green CI run `33610373355` for commit `0829eb5`; not evidence for unpublished `d078c64`.

## Decisions
- Compound primary key scoping `(profile_id, endpoint_id, key_id)` to isolate connector profiles.
- Strict RFC 3339 / ISO 8601 UTC timestamp checking and explicit current-time expiry ($T_{local} \ge T_{expires}$).
- Ed25519-signed relay sync manifests with monotonic sequence enforcement.
- Two-tier fail-closed rejection audit logging with append-only fallback to `path.join(dataDir, 'logs', 'security-failures.log')`.

## Blockers
- `d078c64` is local only and must be handed off/pushed.
- PostgreSQL startup no longer grants capabilities implicitly. The HTTP capability-grant control plane now enforces a maximum 24-hour lifetime; explicit audited renewal remains a follow-up.
- Tier 1, privacy/compliance-owner, and counsel approval remain required before production rollout.

## Resolved
- **CI live-DB gate red (2 broken new test suites)** — fixed in `0829eb5`
  (2026-09-02), test-only, no product-code change. CI run 33610373355 green.
  1. `sigil/cli/sigil-federation-outbox.test.mjs` raw-applied migrations without
     seeding `_sigil_schema_migrations`, so the CLI's
     `withRepository(..., { migrate: true })` replayed `014`'s bare
     `ADD COLUMN client_id` and exited 1. Fixed by replacing the raw apply with
     `applyMigrations(connectionString, { reset: true })` (the same helper the
     CLI runs), which seeds the ledger.
  2. `sigil/relay/v1/accept-envelope.federation-queue.test.mjs`: (a) `upsertPeer`
     used `trustMode: 'pinned'`, violating `peer_relays_trust_mode_check`
     (`016` allows only `tofu`/`static`) → now `'static'`; (b) the row
     assertions read snake_case keys but `listFederationOutbox` returns
     camelCase records → switched to `row.messageId` etc.; (c) teardown called
     `pool.end()` twice (`t.after` + a `finally repository.close()`) → single
     `t.after(() => repository.close())`, `try/finally` removed.

## Known limitations
- Local full-suite final count is not independently confirmed in this review.
- Live DB proof uses disposable local PostgreSQL only; no staging, remote, rollback, or production proof.
- Cross-repository inter-relay documentation debt remains in `C:\dev`, outside this checkout.

## Next action
1. Hand off/push `d078c64` after this status correction and hook validation.
2. Capture a clean final local `npm test` summary in an environment where child-process execution completes.
3. Define and approve capability profiles and explicit audited renewal authorization for deployment tooling.
4. Track doc debt in the `C:\dev` repo, not here: tick the inter-relay plan checkboxes and add I4 `MAX_ATTEMPTS=4` notes.
5. Obtain required Tier 1, privacy/compliance-owner, and counsel approvals before production rollout.



## Production packaging and host adapters (2026-08-27)

### Completed work
- Added `sigil/cli/package.json` with the global `sigil` binary mapping to `./sigil.mjs`.
- Added Windows PowerShell, macOS/Linux shell, and callback guidance for one-shot inbox waits and safe re-arm behavior.

### Tests
- Package metadata validation passed.
- Focused daemon test requires child-process execution; the restricted sandbox returned `spawn EPERM`.

### Next action
- Re-run the focused test outside the restricted sandbox or in CI.

## Policy parameters (2026-08-27)

### Completed work
- Defined endpoint, owner, conversation, and recipient inbox limits.
- Defined bounded dead-letter retry and reaper behavior.
- Defined PII, audit, credential, log, and backup retention periods with legal-hold controls.
- Closed the deferred items in `docs/specs/sigil-implementation-decisions-v1.0.md`.

### Tests
- `git diff --check` passed.

### Blockers
- Tier 1, privacy/compliance-owner, and counsel approval remain required before production rollout.
