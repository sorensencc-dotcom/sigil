# Sigil Protocol Specification

**Version:** 1.0.0-draft
**Status:** Draft for review
**Date:** 2026-08-12

## 1. Abstract

Sigil is a governed, model-agnostic communication fabric and cryptographic
mailbox protocol for humans and AI agents. It provides a durable universal
mailbox through which independently
installed agent runtimes can exchange messages, tasks, reviews, decisions, and
explicit references to shared context.

Sigil separates:

- human identity from agent endpoint identity;
- message transport from agent runtime behavior;
- authentication from human authorization;
- context references from context materialization; and
- protocol requirements from connector-specific implementation details.

The first target is Codex-to-Claude communication through a shared relay. The
protocol is intended to support Claude, Codex, Kimi, Ollama, Antigravity, human
clients, and future runtimes without requiring a common model or host.

## 2. Scope

### 2.1 In scope

- Direct and project-scoped human/agent conversations
- Agent-to-agent task and review messages
- Durable asynchronous delivery
- Endpoint registration and identity
- Capability declarations and authorization
- Human approval records
- Portable references to code, documents, threads, and artifacts
- Delivery, processing, and audit events

### 2.2 Out of scope for v1

- A required web or mobile chat interface
- A required model provider
- Automatic access to local files or repositories
- Universal interception of host-agent actions
- Persistent remote execution or agent orchestration
- Automatic bidirectional synchronization with Slack or Teams
- End-to-end encryption implementation details

## 3. Design principles

1. **Human authority is explicit.** An agent may propose, but authorization is
   represented separately and cannot be inferred from message text.
2. **Endpoints are visible.** Messages identify the active agent runtime and
   installation; agents must not impersonate their human owner.
3. **Context is referenced, not dumped.** Large or sensitive material is shared
   by explicit, integrity-checked references.
4. **Delivery is durable.** Realtime connections improve latency but are not
   the source of truth.
5. **Inbound content is data, not authority.** A received message cannot expand
   an endpoint's capabilities or override local policy.
6. **Least privilege is the default.** Capabilities are scoped to a project,
   conversation, task, endpoint, and expiration where applicable.
7. **Connectors are replaceable.** The protocol must not depend on Claude hooks,
   MCP, Repomix, Git worktrees, or a particular operating system.

## 4. Terminology

- **Human:** An account representing a person or authorized organizational
  principal.
- **Endpoint:** A registered runtime instance capable of sending or receiving
  Sigil messages, such as `Alex's Claude` or `You's Codex`.
- **Connector:** Local or hosted software adapting an endpoint runtime to Sigil.
- **Relay:** A service that authenticates, persists, routes, and acknowledges
  envelopes.
- **Conversation:** A durable direct, group, or project-scoped message stream.
- **Capability:** A bounded permission granted to an endpoint.
- **Context reference:** A typed pointer to material that may be resolved by an
  authorized connector.
- **Decision:** An immutable record of a human authorization or project choice.

## 5. Topology

```text
Agent runtime ─ Connector ─┐
Human client ──────────────┼─ Sigil relay ─ durable inboxes ─ connectors
Agent runtime ─ Connector ─┘
```

The relay is the coordination authority for Sigil state. It does not grant an
endpoint access to local files, repositories, tools, or model providers.

## 6. Identity and endpoint registration

Identifiers are opaque and stable. Human-readable names are metadata and may be
changed without changing identity.

```json
{
  "endpoint_id": "ep_01JEXAMPLE",
  "owner_id": "usr_01JEXAMPLE",
  "runtime": "claude-code",
  "display_name": "Alex's Claude",
  "installation_id": "install_01JEXAMPLE",
  "public_keys": [
    {
      "key_id": "key_01JEXAMPLE",
      "algorithm": "Ed25519",
      "public_key": "ed25519:...",
      "status": "active",
      "valid_from": "2026-08-12T00:00:00Z",
      "valid_until": null
    }
  ],
  "status": "active",
  "revoked_at": null,
  "revoked_reason": null
}
```

An endpoint MUST have a unique signing key. The relay MUST verify that the
endpoint is registered and authorized to act for its owner before accepting a
signed envelope. Revoked endpoints MUST include `revoked_at` and MAY include
`revoked_reason`; they MUST be rejected after revocation.

An endpoint signature proves endpoint authenticity. It does not prove that a
human approved the action. Human approval MUST be represented separately.

The relay MUST derive the authoritative `owner_id` from its endpoint registry.
It MUST reject an envelope when `sender.owner_id` does not exactly match the
registered owner for `sender.endpoint_id`; downstream authorization MUST NOT
trust the envelope copy alone.

Display names MUST NOT be used as identity. User interfaces MUST display the
stable endpoint fingerprint
or a verified identity indicator alongside `display_name`, especially on first
contact and approval screens. A connector MUST provide a way to inspect the
full `endpoint_id`, owner, runtime, and key fingerprint before accepting a new
endpoint. Display-name changes MUST be audited.

Endpoint status values are `pending`, `active`, `suspended`, `revoked`, and
`decommissioned`. Only `active` endpoints may send new envelopes. `suspended`
endpoints may retain queued inbound messages but may not send or process new
ones. `revoked` and `decommissioned` endpoints cannot authenticate.

`public_keys` MUST contain every currently valid or grace-period key for the
endpoint. Each key has a unique `key_id`, algorithm, validity interval, and
status of `active`, `retiring`, or `retired`. At most one key SHOULD be active
for new outbound messages. A key with `valid_until: null` remains valid until
explicitly retired or revoked.

## 7. Envelope

All protocol messages use JSON Canonicalization Scheme (JCS), specified by RFC
8785. Implementations MAY transport the result as JSON, MessagePack, or another
encoding, but signatures MUST cover the JCS bytes, not transport-specific bytes.
Parsers MUST reject duplicate object keys, invalid UTF-8, non-finite numbers,
and values that cannot be represented by JCS.

The canonical signed value is the UTF-8 JCS serialization of the envelope with
the entire `signature` member omitted. `signature.value` is an Ed25519
signature over those bytes. The `algorithm` and `key_id` MUST resolve to a key
registered for the sender endpoint.

The `protocol` field uses the form `sigil/<major>`. A connector and relay MUST
negotiate supported major versions during endpoint connection or registration.
Backward-compatible additions are negotiated through feature capabilities. An
implementation MUST reject an unsupported major version with
`VERSION_UNSUPPORTED` before persisting the envelope.

```json
{
  "protocol": "sigil/1",
  "message_id": "msg_01JEXAMPLE",
  "conversation_id": "conv_01JEXAMPLE",
  "message_type": "task.request",
  "sender": {
    "owner_id": "usr_you",
    "endpoint_id": "ep_you_codex",
    "kind": "agent"
  },
  "recipient": {
    "owner_id": "usr_alex",
    "endpoint_id": "ep_alex_claude"
  },
  "body": {
    "instruction": "Review the API migration.",
    "task_id": "task_01JEXAMPLE"
  },
  "context_refs": [],
  "capabilities": ["sigil.core/read_shared_context"],
  "approval": {
    "required": true,
    "status": "approved",
    "decision_id": "decision_01JEXAMPLE"
  },
  "correlation_id": "msg_01JEPARENT",
  "idempotency_key": "send_01JEXAMPLE",
  "expires_at": "2026-08-13T00:00:00Z",
  "created_at": "2026-08-12T00:00:00Z",
  "signature": {
    "algorithm": "Ed25519",
    "key_id": "key_01JEXAMPLE",
    "value": "base64url:..."
  }
}
```

This example shows the pre-approved form: the decision record was created and
verified before the envelope was signed. For approval requested after initial
submission, the envelope MUST use `status: "pending"` and omit
`decision_id`; the later verified decision is recorded in relay delivery
metadata and linked through the `approval.request` and `decision.record` IDs.

`correlation_id` identifies the prior Sigil message or task operation that
caused the current envelope. It is used for reply threading, task lineage,
approval linkage, and audit traversal; it does not imply ordering or delivery.
It MUST reference an envelope or task visible within the same authorized
conversation.

Required envelope fields:

- `protocol`
- `message_id`
- `conversation_id`
- `message_type`
- `sender`
- `recipient` or an explicit broadcast scope
- `body`
- `created_at`
- `expires_at`
- `signature`

`context_refs` is required when the body depends on shared context.
`capabilities` is required when the sender requests any capability and MUST be
an empty array otherwise. `approval` is required when policy requires approval;
its absence means approval has not been requested and MUST NOT be treated as
approval.

`expires_at` is mandatory for every envelope. It bounds delivery, approval, and
replay validity. There is no unbounded no-expiry envelope in the v1 profile.

An `approval.status` of `approved` is meaningful only when the relay resolves
`decision_id` to a valid, unexpired `decision.record` covering the exact
message or action hash. A sender-provided status or unresolvable decision ID
MUST NOT authorize delivery or execution.

### 7.1 Approval workflow

Approval uses immutable envelopes and a separate decision record. An envelope is
never edited or resent with a changed approval block.

```text
task.request (approval.required, pending)
        ↓
approval.request (references message_id and action_hash)
        ↓
decision.record (approved, rejected, or expired)
        ↓
relay verifies decision and authorizes original envelope
        ↓
recipient receives original envelope plus verified decision reference
```

The sender or relay MAY create `approval.request`, but it MUST reference the
original immutable message and its recomputed `action_hash`. A human or
authorized administrator creates the `decision.record`. The relay MUST verify
that the decision actor has authority for the requested action, that the record
is unexpired, and that its action hash matches the original envelope.

If approved, the relay marks the original envelope authorized in delivery
metadata; it does not modify the signed envelope. If rejected or expired, the
original envelope MUST NOT be delivered for execution. A connector MAY display
a local approval prompt, but local approval MUST still result in a verifiable
decision record before the relay honors the action.

### 7.2 Approval action binding

`approval.action_hash` is the SHA-256 digest of the JCS canonical bytes of an
action-binding object containing exactly:

```text
protocol, message_id, conversation_id, message_type,
sender, recipient or broadcast_scope, body, context_refs,
capabilities, correlation_id, expires_at
```

The action-binding object excludes `approval`, `signature`, `created_at`,
delivery state, and transport metadata. The relay MUST recompute this hash from
the received envelope and compare it with the decision record before honoring
approval. Changing any listed field requires a new approval.

### 7.3 Broadcast scope

An envelope MUST contain exactly one of `recipient` or `broadcast_scope`.
Version 1 permits only this broadcast form:

```json
{
  "kind": "conversation_members",
  "conversation_id": "conv_01JEXAMPLE",
  "exclude_endpoint_ids": []
}
```

The relay resolves recipients from authoritative conversation membership. An
agent MUST have an active `sigil.core/broadcast_message` grant for that
conversation.
Broadcast delivery creates per-recipient delivery records.

For group delivery, the envelope is accepted once, while each resolved
recipient has an independent delivery record with its own `queued`, `delivered`,
`acknowledged`, `processing`, and terminal state. Envelope-level status is
`processed` only when the sender's configured completion policy is satisfied;
the default policy is successful acceptance by the relay, not acknowledgement
by every member. A relay MUST expose per-recipient outcomes and MUST NOT imply
that all group members acknowledged when only some did.

The relay MUST reject expired messages, invalid signatures, unknown or revoked
endpoints, duplicate idempotency keys with conflicting bodies, unauthorized
routes, and approval claims that do not resolve to a valid decision record. It
MUST also reject a broadcast scope that is unsupported, unauthorized, or does
not resolve to at least one authorized conversation member.

## 8. Message types

### 8.1 `chat.message`

Human or agent conversation content. The sender endpoint remains visible.

### 8.2 `task.request`

A bounded request with this body shape:

```json
{
  "task_id": "task_01JEXAMPLE",
  "instruction": "Review the API migration.",
  "success_criteria": ["Identify breaking route changes"],
  "dependencies": [],
  "deadline": "2026-08-13T00:00:00Z"
}
```

`task_id` and `instruction` are required. `success_criteria`, `dependencies`,
and `deadline` are optional. The task body MUST be an object; unknown fields
MAY be retained but MUST NOT change the semantics of required fields.

### 8.3 `task.result`

The result of a task with this body shape:

```json
{
  "task_id": "task_01JEXAMPLE",
  "status": "completed",
  "summary": "Routes remain compatible.",
  "findings": [],
  "artifacts": [],
  "verification": ["npm test: 14 passed"]
}
```

`task_id`, `status`, and `summary` are required. `findings`, `artifacts`, and
`verification` default to empty arrays. A result MUST reference an existing
task request visible to the sender.

Allowed statuses:

```text
accepted | in_progress | completed | blocked | rejected | expired
```

### 8.4 `approval.request`

A request for a human to authorize a specific proposed action. It MUST describe
the target, scope, risk, requested capability, expiration, and consequences.

### 8.5 `decision.record`

An immutable record of a human decision or project decision. A decision MUST
identify the actor, decision, scope, timestamp, and related message or task.

### 8.6 `presence.update`

Best-effort endpoint state. Presence is advisory and MUST NOT be used as proof
that an endpoint is able to process a task.

Allowed states:

```text
online | idle | working | blocked | offline | unknown
```

Review and context workflows SHOULD initially use `task.request` with a typed
body. Dedicated message types may be added in a compatible future revision.

## 9. Delivery and processing

Delivery states are distinct:

```text
accepted → queued → delivered → acknowledged → processing → processed
                                      │              ├────→ processing_failed
                                      └──────────────└────→ delivery_rejected
```

- **Accepted:** Relay validated and persisted the envelope.
- **Queued:** Envelope awaits endpoint delivery.
- **Delivered:** Connector received the envelope.
- **Acknowledged:** Connector durably stored it locally.
- **Processing:** Connector or runtime began handling it.
- **Processed:** Runtime handled it and emitted an outcome.
- **Processing failed:** Runtime could not complete handling; retry policy or
  dead-letter handling applies.

`envelope_rejected` is a relay intake outcome before `accepted`; it is not a
delivery state. `delivery_rejected` occurs after acceptance when a queued
envelope cannot be delivered or authorized. `rejected` remains reserved for a
task's application-level result status.

`processing_failed` MUST retain the original message identity and failure
reason. It MUST NOT be silently converted to `processed`. A connector MAY retry
processing, but retries MUST be bounded or explicitly requeued.

`message_id` identifies one immutable logical envelope. `idempotency_key` is a
client-generated key for one logical send operation and MUST remain unchanged
across transport retries. A retry MUST reuse both values. A new logical message
MUST use a new `message_id` and a new `idempotency_key`.

The relay MUST persist accepted envelopes before acknowledging the sender.
Connectors MUST acknowledge only after durable local storage. Retries MUST be
safe through `message_id` and `idempotency_key` deduplication.

Connectors SHOULD use a persistent local inbox/outbox and MUST reconcile state
after reconnecting. WebSockets, SSE, polling, and queue transports are
implementation choices.

The relay MUST enforce a clock-skew tolerance of no more than five minutes.
`created_at` MUST be within that tolerance of relay time unless the message is
an authorized queued retry. `expires_at` MUST be later than `created_at` and
MUST NOT exceed the v1 maximum lifetime of 24 hours. Replay and idempotency
records MUST remain available until at least `expires_at` plus the skew
tolerance.

## 10. Capabilities and authorization

Capabilities are allow-listed strings scoped by policy. Example capabilities:

```text
sigil.core/read_shared_context
sigil.core/execute_local_tests
sigil.core/write_sandbox
sigil.core/create_task
sigil.core/send_external_message
sigil.core/modify_project_state
```

Capability names use an authority namespace. Core capabilities use the
`sigil.core/` namespace, for example `sigil.core/read_shared_context`.
Extensions MUST use a namespace they control, such as
`com.example.travel/search` or `org.example.connector/write_sandbox`. A relay
MUST reject unknown namespaces unless an administrator has registered their
definitions, scopes, and risk policy. Namespaces do not prove safety; the
registered definition and active grant remain authoritative.

Capabilities in an envelope are requests, not grants. The relay and connector
MUST intersect requested capabilities with policy before use.

A capability grant SHOULD include:

```json
{
  "grant_id": "grant_01JEXAMPLE",
  "capability": "sigil.core/read_shared_context",
  "scope": "scope:project/proj_123/thread/thread_456",
  "granted_to": "ep_alex_claude",
  "granted_by": "usr_alex",
  "granted_at": "2026-08-12T00:00:00Z",
  "expires_at": "2026-08-13T00:00:00Z"
}
```

`granted_at` MUST be earlier than or equal to `expires_at`. A grant becomes
effective only after the relay validates the granting principal's authority.
Inbound instructions MUST NOT create, widen, or renew capabilities.

Capability revocation is represented by an immutable record:

```json
{
  "revocation_id": "revoke_01JEXAMPLE",
  "capability_grant_id": "grant_01JEXAMPLE",
  "revoked_by": "usr_alex",
  "reason": "Project access ended",
  "created_at": "2026-08-12T12:00:00Z"
}
```

The relay MUST evaluate revocation at authorization and context-resolution
time. Revocation takes precedence over the original expiry time.

### 10.1 Conversation authority

Conversations are created by a human owner or authorized service principal. The
relay maintains authoritative membership. Adding, removing, or changing a
participant MUST produce an audit event. Agents may request membership changes,
but may apply them only with `sigil.core/manage_conversation_membership` and an
approval
from the conversation owner or authorized administrator.

The relay MUST verify that the sender and recipient are conversation members
and that the endpoint is authorized to act for its owner. A caller cannot mint a
`conversation_id` or route to an existing conversation by identifier alone.

## 11. Human approval

Approval is required by policy for actions such as:

- sending a message to an external recipient;
- modifying files or project state;
- executing commands outside a declared sandbox;
- sharing private or sensitive context;
- changing endpoint permissions; and
- accepting a task with consequential side effects.

The approval record MUST be separate from the request and include:

```json
{
  "decision_id": "decision_01JEXAMPLE",
  "actor_id": "usr_alex",
  "action_hash": "sha256:...",
  "decision": "approved",
  "scope": "message:msg_01JEXAMPLE",
  "created_at": "2026-08-12T00:00:00Z",
  "expires_at": "2026-08-13T00:00:00Z"
}
```

Approval MUST bind to the exact action or content hash. A later modification
requires a new approval.

## 12. Context references

Context references identify material without placing all material in the
envelope. A reference MUST declare its kind, scope, integrity metadata, and
resolver requirements.

Sigil scopes use URI-like components: `scope:<kind>/<identifier>` followed by
zero or more `/`-delimited subscopes. A grant covers a reference only when the
grant scope is an ancestor of the reference scope and the grant capability
permits the reference kind. Scope coverage MUST NOT use string similarity or
display names.

In the v1 profile, `sigil.core/read_shared_context` permits all supported
context-reference kinds, subject to the grant scope and policy. Future profiles
MAY define narrower capability-to-kind mappings.

```json
{
  "ref_id": "ctx_01JEXAMPLE",
  "kind": "git_commit",
  "repository": "repo_123",
  "commit": "d631d6a...",
  "paths": ["src/api/**"],
  "scope": "scope:project/proj_123/context/repo_123",
  "integrity": "sha256:...",
  "access": "explicit_grant"
}
```

Supported v1 kinds:

```text
conversation_thread | git_commit | artifact | file_bundle | structured_data
```

Connectors MAY use Repomix, Tree-sitter, worktrees, archives, or other tools to
materialize references. These tools are not required by the protocol. A
connector MUST verify integrity and scope before exposing material to a runtime.
For `access: "explicit_grant"`, the connector MUST resolve an active
`sigil.core/read_shared_context` capability grant whose scope covers the
reference under the scope grammar above, verify that the grant has not been
revoked, and reject resolution otherwise. The
reference itself is not an access grant.

At materialization time, the connector MUST normalize paths, reject absolute
paths and traversal segments, apply its symlink policy, and expose only files
matching the declared allow-list at the immutable referenced version.

## 13. Connector contract

A connector MUST provide:

- endpoint registration and key protection;
- inbound inbox synchronization;
- outbound envelope creation and signing;
- local capability enforcement;
- approval handling for configured high-risk actions;
- durable acknowledgement and retry behavior; and
- visible endpoint identity in user-facing output.

Host-specific hooks, MCP tools, slash commands, terminal prompts, and local
notifications are optional adapter mechanisms. A connector MUST NOT claim that
it can intercept host actions that the host does not expose.

## 14. Relay responsibilities

The relay MUST:

- authenticate endpoint connections;
- validate signatures and schemas;
- authorize routing and conversation membership;
- resolve `sender.owner_id` from the endpoint registry and reject mismatches;
- persist envelopes and state transitions;
- provide idempotent delivery;
- enforce per-endpoint, per-owner, per-conversation, and per-recipient rate and
  quota limits before durable acceptance;
- enforce bounded inbox and storage quotas, with fair-use scheduling and
  explicit backpressure responses;
- prevent unauthorized capability expansion;
- resolve and validate referenced approval decisions before honoring an
  `approved` status;
- enforce capability grants, expiry, and revocations at authorization time;
- expose audit events; and
- support endpoint revocation.

The relay SHOULD support encrypted payloads in a future profile. TLS protects
transport but does not by itself provide end-to-end confidentiality.

The relay MUST NOT execute local commands, resolve private files, or decide
whether an agent may use a local tool.

## 15. Audit and privacy

Implementations MUST record:

- endpoint registration and revocation;
- capability revocations and failed authorization attempts;
- envelope acceptance and rejection;
- delivery and processing transitions;
- capability grants and denials;
- human approval decisions;
- context access and materialization; and
- connector errors relevant to message integrity.

Audit records SHOULD be append-only, time-stamped, queryable by conversation and
task, and subject to explicit retention policy. Sensitive message content MUST
be separately protected from operational metadata using access control and
encryption appropriate to the deployment. Operational logs MUST NOT expose
secrets, private context, approval contents, or unredacted sensitive payloads
by default.

## 16. Error classes

Implementations SHOULD use stable machine-readable codes:

```text
INVALID_ENVELOPE
ENVELOPE_REJECTED
INVALID_SIGNATURE
UNKNOWN_ENDPOINT
ENDPOINT_REVOKED
ROUTE_NOT_AUTHORIZED
CAPABILITY_DENIED
APPROVAL_REQUIRED
APPROVAL_EXPIRED
CONTEXT_NOT_FOUND
CONTEXT_SCOPE_DENIED
CONTEXT_INTEGRITY_MISMATCH
DUPLICATE_MESSAGE
REPLAY_DETECTED
MESSAGE_EXPIRED
DELIVERY_UNAVAILABLE
RATE_LIMITED
QUOTA_EXCEEDED
VERSION_UNSUPPORTED
```

## 17. Security requirements

Implementations MUST:

- protect endpoint private keys using the host's secure storage where available;
- support endpoint revocation and key rotation;
- avoid logging secrets or private context by default;
- treat inbound message content as untrusted data;
- enforce authorization on every context resolution;
- prevent replay using expiry, message identifiers, and idempotency keys; and
- distinguish agents from humans in all user-visible output.

### 17.1 Key rotation

The endpoint registry MUST retain active and recently retired public keys with
activation and retirement times. Rotation requires proof of possession of the
new key. Messages signed with a retiring key remain valid when their
`created_at` predates retirement and they arrive within the replay window.
After retirement plus that window, the old key MUST be rejected. Registration,
rotation, retirement, and revocation MUST be audited.

Prompt-injection scanning, secret detection, command policy, sandboxing, and
test-first enforcement are connector or organizational policy features. They
are recommended, but are not protocol primitives.

## 18. v1 conformance profile

A conforming minimal implementation MUST demonstrate:

1. Registration of two endpoints with distinct identities and signing keys.
2. Codex connector sending a signed `task.request`.
3. Relay persistence across relay restart.
4. Claude connector receiving after temporary disconnection.
5. Duplicate-safe retry and acknowledgement.
6. Claude connector returning a signed `task.result`.
7. Human approval represented separately from endpoint signatures.
8. Rejection of unauthorized routing and capability escalation.
9. Rejection of a forged, missing, expired, or revoked approval decision.
10. Grant, revocation, and post-revocation denial of a capability.
11. Explicit context reference resolution with integrity verification and an
    active scope-matching capability grant.
12. Processing failure, bounded retry, and terminal dead-letter behavior.
13. Replay detection distinct from ordinary duplicate delivery.
14. Signature verification across reordered JSON keys and alternate transport
    encodings using JCS canonical bytes.
15. Approval rejection when any action-binding field changes after approval.
16. Broadcast restriction to authorized conversation membership.
17. Context path traversal, absolute-path, symlink, and out-of-scope rejection.
18. Key rotation with valid in-flight old-key messages and rejection after the
    retirement window.
19. Audit events sufficient to replay the message lifecycle.
20. A high-risk task without a valid decision record is rejected with
    `APPROVAL_REQUIRED` and is not delivered for execution.
21. Task request and result bodies validate against the v1 field and type
    requirements.
22. Sender owner mismatch, display-name collision, and unverified endpoint
    presentation are rejected or visibly marked.
23. Rate and quota limits prevent one endpoint from exhausting another
    endpoint's durable inbox.
24. Key rotation validates both active and retiring keys during the grace
    period and rejects expired keys.
25. Unsupported major protocol versions are rejected with
    `VERSION_UNSUPPORTED` before persistence.

## 19. Extensions

Future profiles MAY define:

- human web and mobile clients, including a Chat SDK and an Open Chat Widget;
- Slack, Teams, Discord, and other chat bridges;
- end-to-end encrypted payloads;
- agent marketplaces and discovery;
- long-running execution providers;
- Git worktree orchestration;
- shared project task boards;
- delegated agent groups; and
- richer review, planning, and decision message types.

These extensions MUST preserve endpoint visibility, least privilege, durable
delivery, explicit context access, and independent human authorization.

### 19.1 Chat SDK and Open Chat Widget

A Chat SDK and an Open Chat Widget are optional, non-normative host
integrations, not relay or connector requirements. Neither is part of the v1
conformance profile (§18), and no v1 requirement depends on either existing.

Where implemented, both MUST sit on top of a connector's existing local
interface rather than a special relay path: a human-facing chat surface calls
the same local operations an MCP adapter or other tool-plugin adapter would
call (send message, check inbox, fetch result, request approval), and the
connector retains sole custody of signing keys, capability enforcement, and
approval-record creation as required by §13. The relay MUST NOT distinguish a
Chat SDK or Open Chat Widget sender from any other human client at the
protocol level; both are ordinary human endpoints per §6.

## 20. First implementation boundary

The first vertical slice is intentionally narrow:

```text
Codex → Sigil relay → Claude → Sigil relay → Codex
```

It proves the protocol without requiring a standalone chat application,
continuous background agent execution, a specific context-packaging tool, or a
third-party chat platform.

The first implementation SHOULD use PostgreSQL for durable relay state, a simple
authenticated realtime transport, local connector inbox/outbox stores, and one
model-host adapter per runtime. Additional runtimes are added by implementing
the connector contract rather than changing the relay protocol.
