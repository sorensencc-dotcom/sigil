# Sigil Implementation Specification v1.0

**Status:** Draft for implementation
**Profile:** Codex connector -> PostgreSQL relay -> Claude connector -> relay -> Codex
**Protocol dependency:** `sigil-protocol-spec-v1.0.0-draft.md`

## 1. Objective and boundary

Implement one durable, approval-aware task round trip. Codex sends a signed
`task.request`; the relay validates, stores, authorizes, and delivers it;
Claude acknowledges and returns a signed `task.result`; Codex receives the
result. No local command execution, arbitrary file access, chat UI, provider
marketplace, or background orchestration is part of this slice.

The relay is authoritative for identity, routing, delivery state, approvals,
capability grants, and audit. Connectors are authoritative for private keys,
local inbox/outbox durability, runtime invocation, and local policy.

## 2. Technology decisions

- Relay: Node.js + TypeScript service using PostgreSQL, versioned REST, and
  authenticated WebSocket push delivery.
- Transport: TLS 1.3 for REST and WebSocket; bearer-token connection
  authentication plus per-envelope Ed25519 signatures. REST inbox polling is
  the explicit reconnect fallback; WebSocket carries thin delivery notices,
  not the durable source of truth.
- Signatures: Ed25519 over RFC 8785 JCS bytes; SHA-256 for action and context
  integrity hashes.
- Identifiers: opaque UUIDv7-compatible strings with resource prefixes.
- Connectors: TypeScript libraries with SQLite-backed inbox/outbox stores;
  host adapters remain thin and replaceable.
- Secrets: OS-native secure storage in connectors (DPAPI is the Windows
  reference); relay stores public keys only. Private keys and bearer tokens
  never enter PostgreSQL, plaintext configuration, environment variables, or
  ordinary logs.

## 3. Components

### Relay

Modules: endpoint registry, envelope validator, authorization engine, approval
service, delivery worker, idempotency store, context-reference broker, audit
writer, and quota/rate limiter. Every module receives authenticated principal
context from the API boundary; no module trusts owner or capability claims from
message bodies.

### Codex connector

Commands: register endpoint, send task, poll inbox, acknowledge, submit result,
and resolve an explicitly granted context reference. It renders sender/runtime
identity and approval state before handing content to the host runtime.

### Claude connector

Commands mirror Codex. Runtime dispatch is opt-in and policy-gated. A received
task is data; it cannot change connector capabilities, tools, approval policy,
or filesystem scope.

### MCP and plugin boundary

The connector is a standalone local process with a localhost-only HTTP API.
Claude's MCP adapter and Codex's tool-calling plugin are separate, thin,
keyless RPC adapters. They expose only `sigil_send_task`, `sigil_check_inbox`,
`sigil_get_result`, `sigil_request_approval`, and `sigil_resolve_context`; signing,
capability enforcement, token handling, and relay communication remain inside
the connector.

## 4. Relay API contract

All endpoints require TLS, authenticated endpoint credentials, request IDs, and
bounded request bodies. JSON responses contain `request_id`, stable `code`, and
machine-readable details on failure.

| Method | Route | Purpose |
|---|---|---|
| POST | `/v1/endpoints` | Register endpoint and public key |
| POST | `/v1/envelopes` | Validate and durably accept signed envelope |
| GET | `/v1/inbox?since=` | Fetch queued deliveries after cursor/timestamp |
| POST | `/v1/deliveries/{id}/ack` | Durable connector acknowledgement |
| POST | `/v1/deliveries/{id}/processing` | Report processing start or terminal failure |
| POST | `/v1/approval-requests` | Create approval workflow item |
| POST | `/v1/decisions` | Record relay-verifiable human decision |
| POST | `/v1/grants` | Create capability grant |
| POST | `/v1/revocations` | Revoke capability grant |
| GET | `/v1/context/{ref_id}` | Resolve reference after authorization |
| GET | `/v1/tasks/{task_id}` | Read authorized task lineage/status |
| GET | `/v1/audit?conversation_id=` | Read authorized audit events |

`POST /v1/envelopes` persists the envelope and an outbox delivery in one
transaction before returning `202 Accepted`. Duplicate idempotency keys return
the original acceptance result when the canonical body matches; conflicting
bodies return `DUPLICATE_MESSAGE`.

## 5. PostgreSQL schema

Tables use generated IDs plus `created_at`/`updated_at` where mutable state is
needed. Immutable protocol objects are append-only.

- `humans(id, status, created_at)`
- `endpoints(id, owner_id, runtime, installation_id, display_name, status)`
- `endpoint_keys(id, endpoint_id, algorithm, public_key, status, valid_from, valid_until)`
- `conversations(id, owner_id, status, created_at)`
- `conversation_members(conversation_id, endpoint_id, role, added_at, removed_at)`
- `capability_grants(id, endpoint_id, capability, scope, granted_by, expires_at)`
- `capability_revocations(id, grant_id, revoked_by, reason, created_at)`
- `envelopes(message_id, conversation_id, message_type, canonical_bytes, signature_algorithm, signature_key_id, signature_value, action_hash, expires_at)`
- `envelope_participants(message_id, endpoint_id, direction)`
- `deliveries(id, message_id, recipient_endpoint_id, state, attempts, next_attempt_at, updated_at, failure_code)`
- `approval_requests(request_id, message_id, action_hash, requested_by, created_at, expires_at)`
- `decisions(decision_id, request_id, actor_id, auth_method, action_hash, decision, expires_at, created_at)`
- `tasks(task_id, request_message_id, result_message_id, status)`
- `context_refs(ref_id, message_id, kind, scope, integrity, descriptor_json)`
- `idempotency_keys(idempotency_key, endpoint_id, message_id, canonical_hash, expires_at)`
- `audit_events(id, actor_type, actor_id, event_type, resource_id, metadata_json, created_at)`

Constraints and indexes MUST enforce unique endpoint/key IDs, unique
`(endpoint_id, idempotency_key)`, unique delivery per message/recipient, valid
state transitions, `expires_at > created_at`, and `expires_at <= created_at +
interval '24 hours'` for envelopes. PostgreSQL transactions use row
locks for inbox claims; workers use leases and bounded retries.

## 6. State and transaction rules

Intake transaction: authenticate endpoint, load authoritative owner/key,
canonicalize and verify signature, validate schema/version/clock/expiry,
authorize route and requested capabilities, resolve approval if required,
insert envelope, participants, deliveries, idempotency record, and audit event.

Delivery transaction: claim one eligible delivery lease, increment attempt,
send to connector, and transition only after a connector acknowledgement.
Expired or exhausted deliveries become terminal dead letters with an audit
event. A worker restart must safely reclaim leases after their timeout.

Connector transaction: write an inbound envelope to local inbox, deduplicate
by `message_id`, then acknowledge relay. Processing is separate from delivery;
result submission preserves the original correlation and task identity.

## 7. Approval and capability enforcement

The relay recomputes the action hash from the protocol-defined fields. It never
trusts `approval.status` or a sender-provided owner ID. High-risk policy is
configured per environment and defaults to approval required for project
mutation, external messaging, private context sharing, and unsandboxed
execution. No connector prompt alone authorizes an action.

Requested capabilities are intersected with active, non-revoked grants scoped to
the conversation/task/reference. Inbound content cannot create or widen a
grant. Connectors cache grants only for the current process, fail closed when
the cache is stale or the relay is unavailable, and recheck revocations before
each high-risk action and context resolution. Context resolution repeats
authorization and integrity checks, including absolute-path, traversal,
symlink, and allow-list enforcement in the connector.

Human approval is distinct from endpoint signing. The approval actor must
authenticate through a relay-verifiable human session or deployment-approved
human credential; an endpoint Ed25519 signature alone cannot establish human
approval. The relay binds the authenticated actor, decision, expiration, and
action hash before authorizing delivery.

## 8. Security and operational controls

- Rotate endpoint keys with proof of possession; retain retiring keys for the
  protocol replay window and audit every transition.
- Apply per-endpoint, owner, conversation, and recipient quotas before durable
  acceptance; return `RATE_LIMITED` or `QUOTA_EXCEEDED` without partial writes.
- Redact payloads, keys, tokens, and private context from logs by default.
- Require correlation/request IDs and structured audit events for every state
  transition and authorization failure.
- Use migrations with forward-only versioning and a tested rollback/recovery
  procedure for operational data, without deleting audit history.
- Health checks cover database connectivity, worker lease recovery, inbox
  delivery, and key registry availability; readiness fails when persistence is
  unavailable.

## 9. Test and conformance plan

Unit tests cover JCS canonicalization, signatures, action hashes, schema/type
validation, scope ancestry, expiry, clock skew, key rotation, and state-machine
transitions. Integration tests use PostgreSQL migrations and restart the relay
between acceptance and delivery. Connector tests use temporary SQLite stores.

The first vertical slice is complete only when all 25 protocol conformance
items are demonstrated, including forged/expired/revoked approval rejection,
replay versus duplicate distinction, broadcast restrictions, context path
guards, quota isolation, and unsupported-version rejection. A passing focused
test suite is not production readiness; authenticated deployment, backup/
restore, key rotation, and failure-injection evidence are separate gates.

## 10. Separate component contracts and tests

Each component owns a versioned contract and test suite. Component tests may use
fakes for adjacent components; only the vertical-slice suite uses a real relay,
PostgreSQL migration, and both connector processes. A component cannot claim
the other component's test results as its own conformance evidence.

### Relay contract

**Inputs:** authenticated REST/WS requests, signed protocol envelopes, endpoint
and key registrations, approval/grant/revocation records.

**Outputs:** stable HTTP status/code responses, persisted envelope and delivery
states, thin WebSocket delivery notices, verified approval outcomes, and
append-only audit events.

**Relay MUST test independently:**

- JCS signature verification, schema/version/clock/expiry validation, and
  authoritative owner/key lookup;
- route, membership, capability, approval, quota, and rate authorization;
- idempotency, conflicting retry, replay detection, and immutable envelopes;
- PostgreSQL transaction atomicity, migration integrity, lease recovery, and
  restart persistence;
- per-recipient broadcast delivery, bounded retries, dead-letter transitions,
  and audit completeness; and
- REST polling and WebSocket notification equivalence, including reconnect.

### Codex connector contract

**Inputs:** local tool/plugin requests, relay inbox pages or delivery notices,
  approval responses, and explicitly scoped local context requests.

**Outputs:** correctly signed envelopes, durable local inbox/outbox records,
  relay acknowledgements, visible endpoint identity, and task results linked to
  the originating `task_id`/`correlation_id`.

**Codex connector MUST test independently:**

- secure key/token loading and refusal to expose private material through its
  plugin API;
- deterministic envelope/action-hash construction and signature generation;
- durable-before-ack inbox behavior, duplicate-safe retries, reconnect
  reconciliation, and local processing failure handling;
- blocking approval prompt contents and refusal to submit unauthorized
  high-risk actions;
- capability intersection and context path/symlink/integrity guards; and
- symmetric handling of malformed, stale, revoked, and prompt-injection-shaped
  inbound content as untrusted data; and
- MCP/tool-plugin adapter behavior using connector fakes, without relay access
  from adapter code.

### Claude connector contract

**Inputs:** local Claude host requests, relay inbox pages or delivery notices,
  approval responses, and explicitly scoped local context requests.

**Outputs:** the same connector-level envelope, storage, acknowledgement,
  identity, and result guarantees as Codex; runtime dispatch remains opt-in and
  policy-gated.

**Claude connector MUST test independently:**

- secure key/token handling and endpoint identity presentation;
- signed `task.result` construction with required task lineage and statuses;
- durable-before-ack behavior, deduplication, reconnect reconciliation, and
  bounded processing retries;
- blocking approval UX and denial behavior for high-risk actions;
- capability/context enforcement before material is exposed to Claude; and
- MCP adapter RPC behavior with connector fakes, including malformed and
  prompt-injection-shaped inbound content treated strictly as data.

### Contract fixtures and integration gate

Store canonical JSON fixtures for registration, valid/invalid envelopes,
approval decisions, grants/revocations, context references, delivery states,
and stable errors. Both connectors consume the same fixtures; the relay is the
only authority for acceptance and authorization expectations.

The integration gate runs these scenarios in order: register distinct Codex
and Claude endpoints; submit and persist a signed Codex request; deliver after
disconnect/reconnect; acknowledge durably; process in Claude; submit a signed
result; deliver it to Codex; then assert audit lineage and all intermediate
states. Failure-injection cases cover relay restart, duplicate delivery,
expired approval, revoked capability, invalid signature, and context integrity
  mismatch. Assert exact delivery transitions `queued -> delivered ->
  acknowledged -> processing -> processed`, plus duplicate and reconnect
  behavior. Evidence reports component results separately and labels the
combined run as vertical-slice proof.

## 11. Delivery milestones

1. Freeze JSON schemas, error codes, state transitions, and migration baseline.
2. Implement endpoint/key registry and signed envelope intake.
3. Implement durable inbox/outbox, leases, retries, acknowledgements, and
   restart recovery.
4. Implement human approval authentication, approvals, grants/revocations,
   context-reference authorization,
   and audit queries.
5. Build Codex and Claude connector adapters against contract fixtures.
6. Run conformance, security, recovery, quota, and authenticated staging gates.
7. Record Tier 1 approval before treating the implementation specification as
   a locked governance/architecture decision.

## 12. Locked v1 decisions and remaining work

The seven implementation choices are locked in
`sigil-implementation-decisions-v1.0.md`: Node.js/TypeScript relay, REST plus
authenticated WebSocket push, single-schema PostgreSQL, TLS 1.3 with bearer
tokens and envelope signatures, host-native connector key storage, standalone
connector plus thin MCP/plugin adapters, blocking connector-layer approval
prompts, and connector-local context resolution with relay pointer metadata
only.

Before coding, complete `sigil-human-approval-auth-spec-v1.0.md`, then specify
rate and quota values, dead-letter reaper behavior,
retention periods, and PostgreSQL backup/restore ownership. Bearer-token
issuance and rotation are fixed as follows: registration returns a one-time
endpoint-scoped token over the authenticated bootstrap channel; the connector
stores it in host-native secure storage; rotation requires an authenticated
request signed by the current endpoint key (or an approved recovery flow),
invalidates the old token immediately, and emits an audit event. Token values
are never logged or returned after creation. These are implementation controls,
not alternatives to the locked architecture.
