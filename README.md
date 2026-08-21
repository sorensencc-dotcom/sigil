# Sigil

[![Node Version](https://img.shields.io/badge/node-%3E%3D22.0.0-blue.svg)](https://nodejs.org/)

Governed cryptographic task relay and host connector for Antigravity, Claude, Codex, xAI Grok, and sovereign local LLMs (Ollama, vLLM).

- **User & Architecture Guide**: [Sigil Wiki](docs/wiki/README.md)
- **Quickstart Guide**: [Getting started](docs/getting-started.md)

For remote machines, install directly from GitHub with `npm install --global github:sorensencc-dotcom/sigil`; no local `C:\dev\sigil-repo` checkout is required.

Multi-agent execution supports Google Antigravity, Anthropic Claude, OpenAI Codex, xAI Grok, and local Ollama models; see [the wiki guide](docs/wiki/README.md#multi-model-agent-hosts--providers).

Sigil keeps host capabilities behind an authenticated local connector, validates signed envelopes before durable idempotency handling, and records delivery, approval, and processing state in PostgreSQL.

## Current status

The repository is verified against full v1 protocol conformance specifications:
- **GitHub Actions CI (`.github/workflows/ci.yml`)**: Automated cross-platform matrix on Node 22.x and 24.x with live PostgreSQL service container.
- **Dependency Audit Gate (`npm run audit:deps`)**: 100% PASS with 0 hoisted dependency gaps and strict exact pinning.
- **JCS Conformance Gate (`npm run audit:jcs`)**: 100% PASS across 116 source files, enforcing pinned RFC 8785 canonicalization.
- **Unit & Contract Suite (`npm test`)**: 336 passed, 0 failed.
- **Live PostgreSQL Gate (`npm run test:live`)**: 30 passed, 0 failed across 4 schema-resetting suites against PostgreSQL 16.
- **Total Test Suite**: 366 passed, 0 failed.

## Prerequisites

* **Node.js**: `>= 22.0.0` (Tested on Node 22.x and Node 24.x)
* **npm**: `>= 10.0.0`
* **PostgreSQL**: 16 for live validation and persistent relay mode
* A registered Sigil endpoint token and matching connector grants

### Compatibility matrix

| Environment | Supported Versions | CI Status |
| :--- | :--- | :--- |
| **Node.js** | `22.x`, `24.x` | Verified |
| **OS** | Ubuntu (latest), Windows (latest) | Verified |
| **PostgreSQL** | 16.x | Verified |

## Repository map

- `index.js` — root library entrypoint exporting connectors, relay, repositories, JCS, daemon, and identity utilities.
- `bin/` — executable entrypoint for the `sigil` CLI.
- `sigil/cli/` — CLI commands (`init`, `relay up`, `agent run`, `send`, `inbox`), autonomous agent daemon, durable inbox ledger (`.sigil/inbox.jsonl`), and config resolution.
- `sigil/contracts/v1/` — protocol schemas (`task-request-schema`, `task-result-schema`), envelope fixtures, and RFC 8785 JCS canonicalization.
- `sigil/relay/v1/` — signed envelope validation, replay classification, rate limiting, capability registry, relay routes, WebAuthn approval ceremony UI (`/approve`), delivery state, and PostgreSQL repositories.
- `sigil/connectors/v1/` — authenticated local connector, Codex/Claude adapters, context resolution, and MCP stdio bridge.
- `sigil/scripts/` — worker subprocess adapters (`claude-worker.mjs`, `codex-cli-worker.mjs`, `ollama-worker.mjs`, `openai-worker.mjs`).
- `sigil/migrations/` — ordered PostgreSQL migrations `001` through `011`.
- `sigil/scripts/live-db-tests.mjs` — sequential live database gate; suites reset the `public` schema.
- `docs/wiki/` — user-friendly wiki, architecture overview, and operational runbooks.
- `.github/workflows/ci.yml` — continuous integration pipeline.
- `.mcp.json` — repo-scoped Claude MCP registration.

## Requirements

- Node.js 22+ (>=22.0.0)
- PostgreSQL 16 for live validation and persistent relay mode
- A registered Sigil endpoint token and matching connector grants

## CLI Usage

The package provides the unified `sigil` command (`bin/sigil.mjs`):

```powershell
# Initialize local identity and endpoint configuration (.sigil/)
sigil init codex --owner usr_soren
sigil init claude --owner usr_soren

# Start a local relay instance (in-memory or PostgreSQL-backed)
sigil relay up
sigil relay up --port 8791 --stream-port 8793 --database-url postgres://sigil:password@127.0.0.1:55432/sigil

# Start autonomous background worker daemon (listens for tasks and auto-replies)
sigil agent run
sigil agent run --worker sigil/scripts/claude-worker.mjs

# Send a signed task envelope to an agent runtime
sigil send --to ep_claude --to-owner usr_soren --message "Analyze test suite coverage" --wait-for-receipt

# Inspect queued inbox messages, wait for incoming envelopes, or view local durable ledger
sigil inbox
sigil inbox --wait
sigil inbox --local

# Start MCP stdio server
sigil mcp
```

## Run tests

Run the JCS audit gate and non-live test suite:

```powershell
npm test
# or: node sigil-jcs-audit.mjs && node --test
```

Run the live PostgreSQL gate against an active database:

```powershell
$env:SIGIL_TEST_DATABASE_URL = "postgres://sigil:sigil_password@127.0.0.1:55432/sigil_test"
npm run test:live
Remove-Item Env:SIGIL_TEST_DATABASE_URL
```

These suites run `DROP SCHEMA public CASCADE` against whatever database this URL points at. Its name must end in `_test` (never the dev/relay database `sigil` itself) -- `assertDisposableTestDatabase` refuses to run otherwise.

The live gate applies migrations `001`–`011` and runs schema-resetting suites sequentially. It covers migration constraints, durable approvals and audit transactions, identity/session/grant persistence, envelope idempotency, capability verification, rate quotas, normalized display-name collisions, acknowledgement races, and task cross-reference lookup optimization.

## Host MCP integration

The shared MCP bridge is `sigil/connectors/v1/mcp-stdio-server.mjs`. It exposes these tools:

- `sigil_send_task`
- `sigil_check_inbox`
- `sigil_get_result`
- `sigil_ack_delivery`
- `sigil_request_approval`
- `sigil_resolve_context`

Claude can use the repository `.mcp.json`. Configure connector values in the host environment; do not commit tokens:

```powershell
$env:SIGIL_RUNTIME = "claude"
$env:SIGIL_CONNECTOR_URL = "http://127.0.0.1:8787"
$env:SIGIL_CONNECTOR_TOKEN = "<endpoint-token>"
$env:SIGIL_PACKAGE_PERMISSIONS = "sigil.task/*,sigil.approval/request,sigil.core/read_shared_context"
$env:SIGIL_CONNECTOR_GRANTS = $env:SIGIL_PACKAGE_PERMISSIONS
```

Codex is registered through its MCP CLI:

```powershell
codex mcp add sigil --env SIGIL_RUNTIME=codex -- node C:\dev\sigil-repo\sigil\connectors\v1\mcp-stdio-server.mjs
```

## Capability boundary

Every connector operation requires the capability in both package permissions and connector grants:

| Operation | Capability | Risk tier |
| --- | --- | --- |
| Send task | `sigil.task/submit` | Standard |
| Read inbox | `sigil.task/read_inbox` | Low |
| Read result | `sigil.task/read_result` | Low |
| Acknowledge / reject delivery | `sigil.task/process` | Standard |
| Request approval | `sigil.approval/request` | Standard |
| Resolve context | `sigil.core/read_shared_context` | Standard |
| Process Claude task | `sigil.task/process` | Standard |

High-risk delivery requires an approved action hash. Endpoint identity is not human approval; approval is verified and consumed durably by the relay.

## Security notes

- Never commit endpoint tokens, database passwords, or worker credentials.
- Use HTTPS for non-local relay origins and scoped, short-lived grants.
- Treat the MCP bridge as a capability boundary, not as an authorization bypass.
- Review migration and live-gate output before describing an environment as production-ready.

