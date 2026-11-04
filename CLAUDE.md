# Sigil

## What this repo is

Sigil (`@sorensencc/sigil`) is a governed, cryptographically signed task relay and host connector for Codex, Claude, Grok, Antigravity and local LLMs. It also runs multi-agent "rooms" over the same durable relay, backed by PostgreSQL. Stack: Node.js (>=22), ESM (`.mjs`), tests with the built-in `node --test` runner.

## Where things live

- `index.js`: package entry point (`main`).
- `bin/sigil.mjs`: the `sigil` CLI binary.
- `sigil/relay/v1/`: relay server and envelope handling. HTTP entry is `sigil/relay/v1/http-server.mjs`; envelope intake is `accept-envelope.mjs`.
- `sigil/connectors/v1/`: host connector. The MCP stdio server is `sigil/connectors/v1/mcp-stdio-server.mjs`, wired up in `.mcp.json`.
- `sigil/cli/`: CLI code, including `sigil/cli/agent-daemon.mjs` and `sigil/cli/identity.mjs`.
- `sigil/ingress/v1/`: inbound ingress (for example AgentMail).
- `sigil/bridges/v1/`: bridges to agent hosts and bots.
- `sigil/contracts/v1/`: JSON and `.mjs` contracts.
- `sigil/migrations/`: SQL migrations. Apply them with `npm run db:migrate`.
- `sigil/hooks/`: hook scripts. `sigil/scripts/`: operational scripts (migrations, secret scan, wiki sync and audit, git hooks).
- `sigil/integration/`: integration code and tests.
- `packages/sigil-rooms-web/`: browser client for rooms, with its own `package.json`.
- `packages/relay-jobs-verification/`: relay-jobs verification package.
- `modules/grok-bridge/`: Grok bridge module.
- `verify/`: TLA+ models (`verify/bridge-session`, `verify/room-delivery`, `verify/suspend-pick`).
- `tests/`: stray top-level tests (`tests/dlq-reaper.test.mjs`). Most tests sit next to their source as `*.test.mjs`. Some are root-level (`index.test.mjs`, `cli-wrappers.test.mjs`).
- `sigil-dep-audit.mjs`, `sigil-jcs-audit.mjs`: dependency and JCS audits that run before tests.
- `scripts/windows/`: Windows stack start and scheduled-task registration (see `scripts/windows/README.md`).
- `.github/workflows/`: `ci.yml`, `release.yml`, `wiki-sync.yml`.
- `.trail/learnings/`: teammate notes about gotchas (pre-push hook, Windows launcher, reapers, and so on). Read the ones relevant to your task.
- Other root docs: `README.md`, `STATUS.md`, `TODOS.md`, `CHANGELOG.md`, `AGENTS.md`.

## Build and test

There is no build step for the main package. All scripts below exist in `package.json`:

- `npm test`: runs `sigil-dep-audit.mjs`, `sigil-jcs-audit.mjs`, then `node --test --test-timeout=30000`.
- `npm run test:bounded`: runs `npm test` with a 60s overall timeout.
- `npm run audit:deps` / `npm run audit:jcs`: run each audit alone.
- `npm run test:live`: live database tests (`sigil/scripts/live-db-tests.mjs`).
- `npm run test:web`: install, typecheck, test and build `packages/sigil-rooms-web`.
- `npm run db:migrate`: apply SQL migrations.
- `npm run secret-scan`: secret scan.
- `npm run receipt:claude`: live Claude worker receipt script.
- `npm run pack:check`: `npm pack --dry-run`.
- `npm run release:check`: audits, tests and pack dry-run.
- `npm run wiki:sync`, `wiki:audit`, `wiki:verify-diagrams`, `wiki:record-diagrams`: maintain `docs/wiki/`.
- `npm run prepare`: installs git hooks. It runs automatically on `npm install`.

Run a single test file with `node --test path/to/file.test.mjs`.

## Knowledge lookup

Before answering a question about this project, look it up in the knowledge base first and cite the file path you used.

1. In this repo, start at `docs/wiki/README.md`. This repo has no `wiki/Index.md`; `docs/wiki/README.md` is the wiki entry point. Other wiki pages: `docs/wiki/Session-Layer-Protocol.md`, `docs/wiki/Grokbot-Adapter.md`.
2. For protocol and auth details, use `docs/specs/` (for example `docs/specs/sigil-protocol-spec-v1.0.0-draft.md`).
3. For setup, use `docs/getting-started.md`. For operations, use `docs/reply-ingress-runbook.md`, `docs/observability/`, and `docs/handoff.md`.
4. For anything that spans repos, or when the local docs come up empty, use the `kb-sync` MCP server:
   - `query_context_cache`: search the cached context.
   - `fetch_topic_note`: pull a specific topic note.
5. Cite the source path (or the kb-sync note) in your answer. If you can't find it, say so, and don't answer from memory.

## Procedures

Project skills live in `.claude/skills/`:

- `.claude/skills/sigil-consult/SKILL.md`: ask a Sigil peer (Codex) for a second opinion.
- `.claude/skills/verify-relay-job-leases/SKILL.md`: use when a change touches the relay_jobs claim/lease/finalize protocol or the federation reaper.
- `.claude/skills/verify-room-delivery/SKILL.md`: use when a change touches room message delivery to a Floor Warden bot. It model-checks `verify/room-delivery` with TLC.
- `.claude/skills/verify-suspend-pick/SKILL.md`: use when a change touches router pick vs human suspension lock order. It checks `verify/suspend-pick`.

Runbooks and guides:

- `docs/reply-ingress-runbook.md`: reply ingress operations.
- `docs/agentmail-ingress.md`: AgentMail ingress.
- `docs/observability/session-layer-rollout.md` and `docs/observability/session-resend-dashboard.md`: session layer rollout and monitoring.
- `scripts/windows/README.md`: Windows supervisor and scheduled task setup.
- `docs/meta/sigil-host-inbox-wait-convention.md`: host inbox wait convention.
