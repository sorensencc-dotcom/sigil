# Sigil

Governed task relay and host connector for Codex and Claude runtimes.

Sigil keeps host capabilities behind an authenticated local connector, validates signed envelopes before durable idempotency handling, and records delivery, approval, and processing state in PostgreSQL.

## Current status

The repository has focused and live validation, but is not a production deployment package. The latest live PostgreSQL gate passed 29 tests with zero failures against PostgreSQL 16. The normal suite passes 186 tests with 29 expected PostgreSQL skips when no live database is configured.

## Repository map

- `sigil/relay/v1/` — signed envelope validation, relay routes, delivery state, approvals, and PostgreSQL repositories.
- `sigil/connectors/v1/` — authenticated local connector, Codex/Claude adapters, context resolution, and MCP stdio bridge.
- `sigil/migrations/` — ordered PostgreSQL migrations `001` through `004`.
- `sigil/scripts/live-db-tests.mjs` — sequential live database gate; suites reset the `public` schema.
- `.mcp.json` — repo-scoped Claude MCP registration.

## Requirements

- Node.js 20+
- PostgreSQL 16 for live validation
- A registered Sigil endpoint token and matching connector grants

There is no root `package.json`; run Node commands from this repository using paths under `sigil/`.

## Run tests

Run the non-live suite:

```powershell
node --test
```

Run the live PostgreSQL gate against a fresh database. Use a fresh database because migrations and suites reset schema state:

```powershell
$env:SIGIL_TEST_DATABASE_URL = "postgres://sigil:<password>@127.0.0.1:55432/sigil"
node sigil/scripts/live-db-tests.mjs
Remove-Item Env:SIGIL_TEST_DATABASE_URL
```

The live gate applies migrations `001`–`004` and runs schema-resetting suites sequentially. It covers migration constraints, durable approvals and audit transactions, identity/session/grant persistence, envelope idempotency, and acknowledgement races.

The live end-to-end receipt is separate from that gate. `node sigil/scripts/live-claude-worker-receipt.mjs` verifies real Codex-signed HTTP submission, MCP dispatch, connector HTTP processing, a real Claude worker subprocess, and result-envelope read-back. Its persistence layer is intentionally in-memory, so it does not replace the PostgreSQL gate or prove restart durability.

## Host MCP integration

The shared MCP bridge is `sigil/connectors/v1/mcp-stdio-server.mjs`. It exposes only these tools:

- `sigil_send_task`
- `sigil_check_inbox`
- `sigil_get_result`
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

Keep `SIGIL_CONNECTOR_URL` and `SIGIL_CONNECTOR_TOKEN` in the parent environment so they are not persisted in host configuration.

## Claude task worker

Claude task processing is an explicit local subprocess boundary. Configure:

```powershell
$env:SIGIL_CLAUDE_PROCESS_COMMAND = "node"
$env:SIGIL_CLAUDE_PROCESS_ARGS = '["C:\\path\\to\\claude-worker.mjs"]'
```

The worker receives one JSON task on stdin and must emit one JSON result on stdout. Exit zero on success; exit nonzero on failure. Logs belong on stderr. The adapter enforces a 30-second timeout and 1 MiB combined output limit, and rejects invalid JSON or failed processes.

Without `SIGIL_CLAUDE_PROCESS_COMMAND`, Claude processing fails closed with `PROCESSING_UNAVAILABLE`.

The included worker attempts the Anthropic API only when `SIGIL_WORKER_ENABLE_LIVE_API=1`. If the API is unavailable, including billing failure, it records the error and performs local fallback processing. This fallback proves the subprocess contract, not model output. No API key is required for the default local path.

## Capability boundary

Every connector operation requires the capability in both package permissions and connector grants. Relevant capabilities include:

| Operation | Capability |
| --- | --- |
| Send task | `sigil.task/submit` |
| Read inbox | `sigil.task/read_inbox` |
| Read result | `sigil.task/read_result` |
| Request approval | `sigil.approval/request` |
| Resolve context | `sigil.core/read_shared_context` |
| Process Claude task | `sigil.task/process` |

High-risk delivery requires an approved action hash. Endpoint identity is not human approval; approval is verified and consumed durably by the relay.

## Security notes

- Never commit endpoint tokens, database passwords, or worker credentials.
- Use HTTPS for non-local relay origins and scoped, short-lived grants.
- Treat the MCP bridge as a capability boundary, not as an authorization bypass.
- Review migration and live-gate output before describing an environment as production-ready.
