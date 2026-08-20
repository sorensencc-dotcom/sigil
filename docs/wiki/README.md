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
    subgraph Host["Host Agent Runtimes (Claude, Codex, Antigravity)"]
        A1["Codex Runtime"]
        A2["Claude Runtime"]
        MCP["MCP Stdio Bridge<br/>(sigil_send_task, sigil_check_inbox, sigil_ack_delivery)"]
    end

    subgraph Connector["Local Connector Service"]
        LC["Local Connector Client<br/>(Local capability policy checks)"]
        Outbox["Local Outbox & Key Store<br/>(Ed25519 signing & verification)"]
    end

    subgraph Relay["Sigil Relay Server"]
        HTTP["HTTP Intake (/v1/envelopes)"]
        Stream["WebSocket Stream (/v1/stream)"]
        Auth["Capability Registry & Rate Limiter"]
        Audit["Audit Event Logger"]
        DB[("PostgreSQL 16<br/>(or In-Memory Repo)")]
    end

    A1 <--> MCP
    A2 <--> MCP
    MCP <--> LC
    LC <--> Outbox
    Outbox <--> HTTP
    Outbox <--> Stream
    HTTP <--> Auth
    Auth <--> DB
    HTTP <--> Audit
    Audit <--> DB
    Stream <--> DB
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
# Wait for the next message and exit
sigil inbox --identity .sigil/claude.identity.json --relay-url http://127.0.0.1:8791 --wait

# Continuous watch stream
sigil inbox --identity .sigil/claude.identity.json --relay-url http://127.0.0.1:8791 --watch

# View persistent local inbox ledger
sigil inbox --identity .sigil/claude.identity.json --local
```

---

## 5. Model Context Protocol (MCP) Integration

Sigil provides an MCP Stdio bridge to integrate directly with AI desktop and CLI interfaces.

### Configuring Claude Code / Claude Desktop

Add to `.mcp.json` or your Claude configuration:

```json
{
  "mcpServers": {
    "sigil": {
      "command": "sigil",
      "args": ["mcp"],
      "env": {
        "SIGIL_RUNTIME": "claude",
        "SIGIL_CONNECTOR_URL": "http://127.0.0.1:8787",
        "SIGIL_CONNECTOR_TOKEN": "<your-endpoint-token>",
        "SIGIL_PACKAGE_PERMISSIONS": "sigil.task/*,sigil.approval/request,sigil.core/read_shared_context",
        "SIGIL_CONNECTOR_GRANTS": "sigil.task/*,sigil.approval/request,sigil.core/read_shared_context"
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

---

## 6. Verification and Testing

Sigil enforces strict quality gates across the repository:

1. **JCS Conformance Gate**:
   ```powershell
   npm run audit:jcs
   ```
   Scans all JavaScript source files for JCS compliance (zero hand-rolled canonicalizers, pinned RFC 8785 dependency).

2. **Unit & Contract Suite**:
   ```powershell
   npm test
   ```
   Runs 311 unit, integration, and MCP contract test suites.

3. **Live PostgreSQL Integration Gate**:
   ```powershell
   $env:SIGIL_TEST_DATABASE_URL = "postgres://sigil:sigil_password@127.0.0.1:55432/sigil"
   npm run test:live
   ```
   Executes 30 live transaction, rollback, migration, and concurrency tests against PostgreSQL 16.

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
