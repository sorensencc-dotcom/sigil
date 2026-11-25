# Status

Older entries live in `docs/status-archive/<YYYY-MM>.md`. Keep about six recent entries here; move the oldest to the archive when adding a new one.

## Session update: 2026-11-25 pwsh test skip, quiet test logs, and probe hardening (PRs #308, #309)

- **Goal:** Stop the pre-push gate from failing on machines without `pwsh`, and cut `sigil.hop` noise from `npm test` output.
- **Completed:** `tests/chief-watchdog.test.mjs` skips its 3 PowerShell tests when `pwsh` is missing (`ENOENT`), and fails when `pwsh` is missing in CI, hangs (15 s probe timeout, `SIGKILL`), or exits nonzero. `npm test` loads `sigil/scripts/test-quiet.mjs`, which defaults `SIGIL_HOP_LOG=0`; a caller-set value wins. `accept-envelope.hop.test.mjs` sets the variable itself.
- **Decisions:** Node `--import` instead of an inline `VAR=0` so it works on Windows. A broken `pwsh` shim reported as `ENOENT` is not detected (rare, and no reliable check exists).
- **Tests:** Full `npm test` without `pwsh`: 2865 tests, 0 fail, 395 skipped, 0 hop lines. All required checks passed on both PRs.
- **Next action:** None open from these PRs.

## Session update: 2026-11-25 CI runs the pre-push-gate model and path-filters jobs (PR #307)

- **Goal:** Run `verify/pre-push-gate/check.mjs` in CI, and skip CI jobs a web-only or docs-only PR cannot affect, without breaking required checks.
- **Completed:** `formal-verification` runs the pre-push-gate check. New `changes` job (`sigil/scripts/ci-changes.mjs`, union over every touched area, fails closed). `web`, `relay-jobs-verification` and `formal-verification` skip whole when not needed. `test-linux` and `test-windows` always run and skip only their steps.
- **Decisions:** `main` requires `Linux - Node 22.x/24.x` and `Windows - Node 22.x/24.x`. A matrix job skipped with a job-level `if` never reports those names, so steps are skipped instead. No protection change was needed. Core/db also run the web job (superset of the model's `Req`). Model: `CIFilter`, `FilterReq`/`UFilter`, `CIWebOnlyCheap`, `MC_ci_filter.cfg`; `MC_ci_bug.cfg` still breaks.
- **Tests:** `check.mjs` exits 0 (9 configs). `ci-changes.test.mjs` 8/8, `ci-workflow.test.mjs` 7/7. CI green.
- **Blockers:** none. No `.context/retros/` retro JSON was written; see `docs/retro.md`.
- **Next action:** Owner decides whether to skip the four required jobs whole (needs an always-running aggregate check plus a branch-protection change). `.md` counts as docs, so a test reading a markdown file would not run on a docs-only PR.

## Session update: 2026-11-22 Issue 257 rooms-web sender chips

- **Goal:** Show on every row who sent it, whether human or agent, and which owner an agent acts for (issue #257, plan story 1, P0).
- **Completed:** New `packages/sigil-rooms-web/src/rooms/SenderChip.tsx` (chip, `senderKind`, `actingForLabel`, `senderName`) and `createOwnerNameFor` in `useContacts.ts`. Wired into `RowView`, the thread root in `ThreadPanel`, `Timeline`, and `App`. Chip styles in `styles.css`.
- **Decisions:** Agent means a roster member with a `response_mode`, the same rule as the relay's `memberIsHuman`. A sender outside the loaded roster shows no mark. The acting-for line uses `envelope.sender.owner_id`, which `validate-envelope.mjs:92` checks against the endpoint owner. Owner name order: human contact, then the owner's human member in the room, then the raw owner id; the viewer's own agents read "acting for you". Avatar stays in ticket 10b.
- **Tests:** rooms-web vitest 33 files, 242 tests pass; `tsc --noEmit` clean. Playwright 5 of 5 pass (two runs in a row).
- **Follow-up fixes:** `vite.config.ts` now stops vitest with a clear error when the working directory has a lowercase drive (`c:\...`), and `AGENTS.md` states the uppercase-drive rule. The e2e check in `rooms.e2e.ts` that expected no copy of a thread reply in the main timeline was stale since `b61f2bb` added reply previews; it now checks that the reply shows only as a preview, never as its own row.
- **Next action:** Push `feat/issue-257-sender-chips` (worktree `C:\dev\sigil-wt-issue-257`) and open the PR with the proposed "acting for" copy.

## Session update: 2026-11-19 Phase 7 room bots live, Chief and Helix CI retired

- **Goal:** Replace Chief and Helix CI with the Phase 7 room bots (Grok Bot · Elon, First Mate · Orchestrator, Floor Warden), and prove that each one answers in room `room_056dd222-ec61-4426-87a4-9b0f9d143781`.
- **Completed:** Ran three `agent run --room-bridge floor-warden` daemons (configured in `.sigil/service.json`, which is gitignored). Created per-bot reply tokens. The external Floor Warden routine now answers as the bot that was mentioned, using that bot's token. Ran `sigil bot disable` on Chief (`016f0b34-f0da-49b2-a32f-482d6e635825`) and Helix CI (`28782df8-9cf6-48a8-ad0c-97c510c66e38`). Removed `ep_chief@rewritelabs.io` from the room by setting `conversation_members.removed_at`.
- **Verified:** Every bot reply reached the room: Floor Warden at seq 70, Grok Bot at seq 79 and 81, and First Mate at seq 80 and 82, about 1.5 to 2 minutes after each post. `/v1/health` ok.
- **Decision:** Room member removal has no route or CLI command, so it is a soft delete in Postgres, the same UPDATE as `PostgresRepository.removeRoomMember`. To undo it, set `removed_at` back to NULL.
- **Not committed:** The working-tree `scripts/windows/start-sigil-stack.ps1` is the old full supervisor. `main` already replaced it with a deprecated wrapper around `sigil service start`, so the working copy is held back so that it does not undo that change.
- **Next action:** Restart the 5 `mcp-stdio-server` connectors. Decide whether the stack should move to `sigil service start` from `.sigil/service.json`. Close #219.

## Session update: 2026-11-19 Issue 219 endpoint id cutover to @rewritelabs.io

- **Goal:** Make the live relay (`--domain rewritelabs.io`) accept envelopes. Every registry endpoint id was bare, so every send was rejected.
- **Completed:** Re-keyed the 7 registry endpoints (`ep_claude`, `ep_codex`, `ep_antigravity`, `ep_ollama`, `ep_grokbot`, `ep_chief`, `ep_helix_ci`) to `<id>@rewritelabs.io` in Postgres (318 FK rows plus 55 `quota_usage` rows, FK orphan check clean), in the registry, in the 7 identity files, in `.sigil/service.json`, and in the launcher `--reconcile-kind` args. Untouched: `ep_relay_system`, `ep_alice@local`, signed envelope bodies, and the audit trail. Restarted SigilStack.
- **Decision:** Chose the full cutover over a code alias after a TLA+ statechart of the cutover showed that every half-migrated state breaks room delivery to chief. Rehearsed on a restored copy first; the forward and reverse runs left all 53 tables identical to live.
- **Verified:** `/v1/health` ok; no "belongs to domain" warning; no seed conflict; chief daemon runs as `ep_chief@rewritelabs.io` with its stream connected and an empty err log. A send to `ep_codex@rewritelabs.io` was accepted and read from the codex inbox. A bare `ep_codex` send still returns MALFORMED_FEDERATED_ID.
- **Rollback:** DB copy `sigil_pre219` (template) and `C:\Users\soren\.sigil-secrets\backup-219-db\sigil-pre219.dump`; file backups in `C:\Users\soren\.sigil-secrets\backup-219-20261119-132138\`. The scripts take `-v reverse=1` / `-Reverse`.
- **Not verified:** A room message reaching chief (that would call the external Floor Warden webhook). The 16 old deliveries queued to antigravity (Oct 29 to Nov 11) still carry bare ids in their signed bodies.
- **Next action:** Restart the 5 `mcp-stdio-server` connectors. Send one room message to chief. Commit the launcher change and the trail learnings. Close #219.

## Session update: 2026-11-14 Sigil 0.2.3 release gate repair

- **Goal:** Repair the release workflow failure before the 0.2.3 npm publish.
- **Completed:** Changed the PostgreSQL service database and live-test URL to `sigil_test`; added an exact-name regression test for both workflow values. Set `npm test` and package `prepack` tests to one test file at a time, and updated the test command in `CLAUDE.md`.
- **Tests:** The workflow regression failed against the prior `sigil` configuration and passed after the fix (1/1). Affected tests passed serially (39 passed, 1 skipped); the concurrency suite passed 6/6. `git diff --check` passed.
- **CI:** All four required checks passed on PR head `5738701`. The review fixes still need CI on their new commit.
- **Blockers:** The existing `v0.2.3` tag points to the failed workflow run; it must not be moved. No npm publish occurred.
- **Next action:** Push the review fixes and verify their PR checks. Select a safe release trigger after the fix merges.
