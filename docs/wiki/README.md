# Sigil Wiki & Architecture Guide

Sigil is a cryptographic task relay and host connector protocol designed for multi-agent systems and AI pair programming. It enables autonomous runtimes—such as Codex, Claude, and Antigravity—to coordinate securely, exchange structured tasks, verify cryptographic signatures, and enforce human approval boundaries.

---

## 1. Why Sigil?

When multiple AI models and automated tools collaborate on complex codebases, unauthenticated communication creates security and operational risks:
- **No cryptographic identity**: Prompt injection or network spoofing can forge messages between agents.
- **Lost messages & silent drops**: Ephemeral websockets or polling endpoints lose state across restarts.
- **Uncontrolled agent autonomy**: Autonomous agents can trigger destructive infrastructure commands without human authorization.
- **Unbounded recursion & replay attacks**: Duplicate network retries can re-execute mutations multiple times.

Sigil solves these problems with deterministic cryptography and state-machine governance:
1. **RFC 8785 Canonicalization & Ed25519 Signatures**: Every message is serialized to identical bytes and cryptographically signed before transmission.
2. **Durable Idempotency & Replay Detection**: Every message ID and idempotency key is tracked in a relational transaction log.
3. **Capability-Gated Access Control**: Agents operate with least-privilege tokens bounded by hierarchical capabilities (`sigil.task/submit`, `sigil.task/process`, `sigil.approval/request`).
4. **Human-in-the-Loop WebAuthn Verification**: High-risk actions require hardware-backed WebAuthn passkey assertions.
5. **Real-time Delivery Receipts & Heartbeats**: Senders receive push updates as their messages transition from `delivered` to `acknowledged` and `processed`.

---

## 2. Architecture Overview

Sigil is composed of three primary layers:

```mermaid
flowchart TD
    subgraph Hosts["Multi-Model Agent Hosts & Providers"]
        AG["Antigravity Agent<br/>(Google Gemini / Subagents)"]
        CL["Claude Agent<br/>(Claude Code / Anthropic)"]
        CX["Codex Agent<br/>(Codex CLI / OpenAI)"]
        GK["Grok Agent<br/>(xAI Grok API)"]
        OL["Local LLM Worker<br/>(Ollama / vLLM / llama.cpp)"]
    end

    subgraph Adapters["Execution & Connector Boundary"]
        MCP["MCP Stdio Bridge<br/>(sigil_send_task, sigil_check_inbox, sigil_ack_delivery)"]
        DMN["Autonomous Daemon<br/>(sigil agent run)"]
        LC["Local Connector Policy<br/>(sigil.task/* & capability checks)"]
        Outbox["Local Outbox & Key Store<br/>(RFC 8785 JCS & Ed25519 Signatures)"]
    end

    subgraph Relay["Sigil Relay Server"]
        HTTP["HTTP Intake (/v1/envelopes)"]
        Stream["WebSocket Stream (/v1/stream)"]
        UI["WebAuthn Ceremony UI (/approve)"]
        Auth["Capability Registry & Rate Limiter"]
        Audit["Audit Event Logger"]
        DB[("PostgreSQL 16<br/>(or In-Memory Repo)")]
    end

    AG <--> MCP
    CL <--> MCP
    CX <--> MCP
    AG <--> DMN
    GK <--> DMN
    OL <--> DMN
    MCP <--> LC
    DMN <--> LC
    LC <--> Outbox
    Outbox <--> HTTP
    Outbox <--> Stream
    HTTP <--> Auth
    Auth <--> DB
    HTTP <--> Audit
    Audit <--> DB
    Stream <--> DB
    UI <--> Auth
```

---

## 3. Core Concepts

### Envelopes & Messages
An **Envelope** is the atomic transmission unit in Sigil. It wraps payload bodies (`chat.message`, `task.request`, `task.result`) alongside sender/recipient identities, expiration timestamps, capability claims, and cryptographic signatures.

### Delivery Lifecycle
Messages move through a deterministic state machine:

```mermaid
stateDiagram-v2
    [*] --> queued: Envelope Accepted
    queued --> delivered: Delivered to Recipient
    queued --> delivery_rejected: Delivery Rejected
    delivered --> acknowledged: Acknowledged by Worker
    delivered --> delivery_rejected: Delivery Rejected
    acknowledged --> processing: Processing Started
    acknowledged --> delivery_rejected: Delivery Rejected
    acknowledged --> processing_failed: Processing Failed
    processing --> processed: Processing Succeeded
    processing --> processing_failed: Processing Failed
    processing_failed --> processing: Retry Attempt (< max)
    processing_failed --> dead_letter: Retries Exceeded
    processed --> [*]
    delivery_rejected --> [*]
    dead_letter --> [*]
```

### Capability Boundary & Risk Tiers
Every operation requires explicit capability authorization:
- `sigil.task/submit` (Standard): Permission to create and send outbound task envelopes.
- `sigil.task/read_inbox` (Low): Read-only access to inspect queued deliveries.
- `sigil.task/read_result` (Low): Permission to retrieve completed task execution results.
- `sigil.task/process` (Standard): Permission to mutate delivery states (acknowledge, reject, or mark processed).
- `sigil.approval/request` (Standard): Permission to request human passkey authorization.
- `sigil.core/read_shared_context` (Standard): Permission to resolve workspace file bundles.

---

## 4. Quickstart Guide

### Step 1: Install Sigil

To install the global CLI directly:

```powershell
npm install --global github:sorensencc-dotcom/sigil
```

Or clone the repository:

```powershell
git clone https://github.com/sorensencc-dotcom/sigil.git C:\dev\sigil-repo
cd C:\dev\sigil-repo
npm install
```

### Step 2: Initialize Agent Identities

Create Ed25519 cryptographic identities for your agents:

```powershell
# Create identity for Claude
sigil init claude --owner usr_soren

# Create identity for Codex
sigil init codex --owner usr_soren
```

This generates private keys in `.sigil/claude.identity.json` and `.sigil/codex.identity.json` and registers public keys in `.sigil/registry.json`.

### Step 3: Start the Relay

#### Option A: Ephemeral In-Memory Relay (Development)
```powershell
sigil relay up --port 8791 --stream-port 8793
```

#### Option B: Durable PostgreSQL Relay (Production)
```powershell
# Start PostgreSQL container
docker run -d --name sigil-db -p 55432:5432 -e POSTGRES_USER=sigil -e POSTGRES_PASSWORD=sigil_password -e POSTGRES_DB=sigil postgres:16-alpine

# Start relay with database persistence
sigil relay up --port 8791 --stream-port 8793 --database-url postgres://sigil:sigil_password@127.0.0.1:55432/sigil
```

### Step 4: Send and Receive Messages

#### Send a message with delivery receipt tracking:
```powershell
sigil send --identity .sigil/codex.identity.json `
  --relay-url http://127.0.0.1:8791 `
  --to ep_claude `
  --to-owner usr_soren `
  --message "Please audit the latest test suite changes" `
  --wait-for-receipt
```

#### Read or wait for incoming messages:
```powershell
sigil inbox --identity .sigil/claude.identity.json --relay-url http://127.0.0.1:8791 --wait

# Continuous watch stream
sigil inbox --identity .sigil/claude.identity.json --relay-url http://127.0.0.1:8791 --watch

#### View persistent local inbox ledger:
```powershell
sigil inbox --local
```

### Step 5: Run Autonomous Agent Worker Daemon

To have an agent host automatically listen for `task.request` envelopes, execute subprocess workers, and return signed `task.result` envelopes:

```powershell
# Run daemon using default Claude worker
sigil agent run --identity .sigil/claude.identity.json --relay-url http://127.0.0.1:8791

# Run daemon with a custom worker script
sigil agent run --identity .sigil/claude.identity.json --relay-url http://127.0.0.1:8791 --worker sigil/scripts/codex-cli-worker.mjs
```

---

## 5. WebAuthn Human Approval Ceremony

For high-risk operations requiring human authorization (such as root filesystem access or sensitive API execution):

1. **Challenge Request**: The agent requests a one-time approval challenge bound to the canonical action hash:
   ```http
   POST /v1/approval-challenges
   { "action_hash": "sha256:...", "callback_url": "http://127.0.0.1:4567/callback" }
   ```
2. **Browser Ceremony (`GET /approve`)**: The user's browser opens `https://<relay-origin>/approve?challenge=<id>&cb=<callback_url>` and prompts for a biometric Touch ID, Windows Hello, or hardware passkey assertion via `navigator.credentials.get()`.
3. **Loopback Handshake**: The relay verifies the signed assertion, records the approval, and redirects to the connector's localhost callback with a single-use decision token to resume agent execution.

---

## 6. Library SDK Usage

`@sorensencc/sigil` can be imported directly into Node.js applications:

```javascript
import {
  createRelayServer,
  createConnector,
  createAgentDaemon,
  RelayClient,
  LocalOutbox,
  canonicalJson
} from '@sorensencc/sigil';

// Start a programmatic relay instance
const server = createRelayServer({
  relayOrigin: 'http://127.0.0.1:8791',
  rpId: '127.0.0.1'
});
await new Promise((resolve) => server.listen(8791, resolve));
```

---

## 7. MCP Host Integration

Sigil exposes an MCP stdio server that integrates seamlessly with AI agent hosts like Claude Code and OpenAI Codex CLI.

### Available MCP Tools

- `sigil_send_task`: Send a signed task envelope to another agent endpoint.
- `sigil_check_inbox`: Read authenticated inbox deliveries.
- `sigil_get_result`: Retrieve execution results for a task.
- `sigil_ack_delivery`: Acknowledge or report failure (`acknowledged`, `processed`, `delivery_rejected`, `processing_failed`) for a delivery.
- `sigil_request_approval`: Request verified human approval for an action.
- `sigil_resolve_context`: Resolve an integrity-checked context bundle.

### Configuring Google Antigravity

Antigravity seamlessly coordinates with Sigil through either the native MCP bridge or terminal CLI automation:

```json
{
  "mcpServers": {
    "sigil": {
      "command": "node",
      "args": ["C:\\dev\\sigil-repo\\sigil\\connectors\\v1\\mcp-stdio-server.mjs"],
      "env": {
        "SIGIL_RUNTIME": "codex",
        "SIGIL_CONNECTOR_URL": "http://127.0.0.1:8791",
        "SIGIL_CONNECTOR_TOKEN": "ep_antigravity_token_secret"
      }
    }
  }
}
```

Antigravity subagents and workflows can also run background worker daemons directly via:
```powershell
sigil agent run --identity .sigil/antigravity.identity.json --relay-url http://127.0.0.1:8791
```

### Configuring Claude Code

Add Sigil to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "sigil": {
      "command": "node",
      "args": ["C:\\dev\\sigil-repo\\sigil\\connectors\\v1\\mcp-stdio-server.mjs"],
      "env": {
        "SIGIL_RUNTIME": "claude",
        "SIGIL_CONNECTOR_URL": "http://127.0.0.1:8791",
        "SIGIL_CONNECTOR_TOKEN": "ep_claude_token_secret"
      }
    }
  }
}
```

### Configuring Codex CLI

Register Sigil in Codex:

```powershell
codex mcp add sigil --env SIGIL_RUNTIME=codex -- node C:\dev\sigil-repo\sigil\connectors\v1\mcp-stdio-server.mjs
```

### Local Sovereign Models (Ollama, vLLM, llama.cpp)

Sigil enables completely offline, private multi-agent execution using open-source models:

```powershell
# Run local agent daemon powered by Ollama (e.g. Llama 3 / Mistral / DeepSeek)
$env:OLLAMA_HOST = "http://127.0.0.1:11434"
$env:SIGIL_OLLAMA_MODEL = "llama3:latest"
sigil agent run --identity .sigil/local.identity.json --relay-url http://127.0.0.1:8791 --worker sigil/scripts/ollama-worker.mjs
```

### xAI Grok & OpenAI Models

Execute task requests against xAI Grok or OpenAI endpoints:

```powershell
# Run daemon with xAI Grok
$env:GROK_API_KEY = "xai-..."
$env:SIGIL_MODEL = "grok-beta"
sigil agent run --identity .sigil/grok.identity.json --relay-url http://127.0.0.1:8791 --worker sigil/scripts/openai-worker.mjs
```

---

## 8. Verification and Testing

Sigil enforces strict quality gates across the repository:

1. **JCS Conformance Gate**:
   ```powershell
   npm run audit:jcs
   ```
   Scans all 113 JavaScript source files for JCS compliance (zero hand-rolled canonicalizers, pinned RFC 8785 dependency).

2. **Unit & Contract Suite**:
   ```powershell
   npm test
   ```
   Runs 318 unit, integration, and MCP contract test suites.

3. **Live PostgreSQL Integration Gate**:
   ```powershell
   $env:SIGIL_TEST_DATABASE_URL = "postgres://sigil:sigil_password@127.0.0.1:55432/sigil_test"
   npm run test:live
   ```
   Executes 30 live transaction, rollback, migration, and concurrency tests against PostgreSQL 16.
   These suites run `DROP SCHEMA public CASCADE`, so the URL's database name must end in `_test`
   (never the dev/relay database `sigil` itself) -- `assertDisposableTestDatabase` refuses otherwise.

---

## 7. Error Codes Reference

| Error Code | HTTP Status | Description / Cause |
|---|---|---|
| `INVALID_ENVELOPE` | 400 | Missing required fields, unparseable body, or invalid schema. |
| `INVALID_SIGNATURE` | 400 | Ed25519 signature verification failed over canonical JCS bytes. |
| `CAPABILITY_DENIED` | 403 | Caller does not hold required capability grant for the operation. |
| `HUMAN_CONTEXT_REQUIRED` | 403 | Attempted human-restricted operation (OIDC/WebAuthn) without human session. |
| `MESSAGE_EXPIRED` | 400 | Message `expires_at` is in the past. |
| `REPLAY_DETECTED` | 409 | Previously accepted message resubmitted under conflicting idempotency key. |
| `DUPLICATE_MESSAGE` | 409 | Conflicting submission with same message ID or un-replayable body. |
| `RATE_LIMITED` | 429 | Exceeded per-endpoint, per-owner, or per-conversation rate limits. |
| `QUOTA_EXCEEDED` | 429 | Recipient open inbox depth limit exceeded. |
| `DELIVERY_UNAVAILABLE` | 409 | Invalid delivery state machine transition. |
| `DISPLAY_NAME_COLLISION` | 409 | Unique constraint violation on `(owner_id, normalized_display_name)`. |
| `RELAY_UNREACHABLE` | Exit 4 | Connector missed 3 consecutive WebSocket heartbeats. |
