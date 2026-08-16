# Sigil Implementation Decisions v1.0

**Status:** Locked for v1 implementation
**Date:** 2026-08-12
**Scope:** Codex-to-Claude first vertical slice (relay + two connectors)

Each decision states the choice, why, and what it rules out.

## 1. Relay runtime/API

**Choice:** Node.js + TypeScript. HTTP REST for envelope submission and control-plane calls; authenticated WebSocket for realtime push delivery. No GraphQL, no gRPC in v1.

- `POST /v1/envelopes` — submit signed envelope, relay validates + persists, returns `accepted` synchronously.
- `GET /v1/inbox?since=` — poll fallback for connectors that don't hold a live socket; `since` is the canonical resume cursor.
- `POST /v1/deliveries/{id}/processing` — report `processing` start or `processing_failed` terminal outcome.
- `WS /v1/stream` — authenticated per-endpoint channel; relay pushes `delivered` notifications; connector still durably persists locally on receipt per spec §9.
- `POST /v1/decisions`, `POST /v1/grants`, `POST /v1/revocations` — control-plane writes, same auth path as envelopes.

**Why:** TS gives mature libraries for the two hard protocol primitives — JCS canonicalization (`canonicalize`) and Ed25519 (`@noble/ed25519` or `tweetnacl`) — with the same language on relay and reference connectors, cutting cross-language canonicalization bugs. REST+WS (not gRPC) keeps the wire format plain JSON/JCS, matching the spec's transport-agnostic envelope requirement (§7) without a second serialization layer.

**Rules out:** Go/Rust relay for v1 (revisit post-slice if throughput demands it — protocol is host-neutral per design principle 7, so a rewrite doesn't break connectors). No message broker (Kafka/NATS) in v1; Postgres is the durability layer per §20.

## 2. PostgreSQL schema

**Choice:** Single Postgres database, one schema, tables below. All state transitions per spec §9/§10/§11 map to rows, never in-place mutation of signed envelopes.

```
humans(id PK, status, created_at)
endpoints(endpoint_id PK, owner_id, runtime, display_name, installation_id, status, revoked_at, revoked_reason, created_at)
endpoint_keys(key_id PK, endpoint_id FK, algorithm, public_key, status, valid_from, valid_until)
conversations(conversation_id PK, kind, project_scope, created_by, created_at)
conversation_members(conversation_id FK, endpoint_id FK, role, added_by, added_at, removed_at, PRIMARY KEY(conversation_id, endpoint_id))
envelopes(message_id PK, conversation_id FK, protocol, message_type, sender_endpoint_id, sender_owner_id, recipient_endpoint_id, broadcast_scope JSONB, body JSONB, context_refs JSONB, capabilities TEXT[], correlation_id, idempotency_key, expires_at, created_at, signature_algorithm, signature_key_id, signature_value, canonical_bytes, action_hash, envelope_status)
deliveries(delivery_id PK, message_id FK, recipient_endpoint_id, state, attempts, queued_at, updated_at, delivered_at, acknowledged_at, processing_at, processed_at, failure_reason)
capability_grants(grant_id PK, capability, scope, granted_to, granted_by, granted_at, expires_at)
capability_revocations(revocation_id PK, capability_grant_id FK, revoked_by, reason, created_at)
approval_requests(request_id PK, message_id FK, action_hash, requested_by, created_at, expires_at)
human_credentials(credential_id PK, human_id FK, type, public_key, status, valid_from, valid_until, created_at)
decisions(decision_id PK, actor_id, credential_id FK, auth_method, action_hash, decision, scope, request_id FK, created_at, expires_at)
audit_events(event_id PK, event_type, subject_id, actor_id, payload JSONB, created_at)
idempotency_keys(idempotency_key PK, endpoint_id FK, message_id FK, canonical_hash, created_at, expires_at)
```

**Indexes:** `envelopes(conversation_id, created_at)`, `deliveries(recipient_endpoint_id, state)`, `capability_grants(granted_to, capability, scope)` (btree on scope prefix for ancestor lookups), `idempotency_keys(expires_at)` for reaper, `audit_events(subject_id, created_at)`.

**Why:** Matches spec §20's PostgreSQL recommendation. Separate `deliveries` from `envelopes` because broadcast makes delivery state per-recipient while the envelope is immutable and singular (§7.3). `idempotency_keys` stores `canonical_hash` so a retry with the same key but different body is detectable as `DUPLICATE_MESSAGE` per error class list. Grants/revocations/decisions are append-only tables, never updated, matching §15 "audit records SHOULD be append-only."

**Rules out:** No JSONB schema-less free-for-all — `body`, `context_refs`, `broadcast_scope`, `signature` are JSONB because their shape varies by `message_type`/kind, but every other field with fixed semantics (status, timestamps, hashes) is a typed column so constraints and indexes apply.

## 3. Transport

**Choice:** HTTPS (TLS 1.3) for all connector-relay calls, both REST submission and WebSocket upgrade. No plaintext transport, no custom TCP protocol.

- Connector → relay: mutual bearer-token auth (endpoint-scoped token issued at registration, rotated with key rotation) over TLS, plus per-envelope Ed25519 signature verified server-side. TLS authenticates the connection; the signature authenticates the envelope — spec §17 requires both (TLS protects transport, signature proves endpoint authenticity).
- Relay → connector push: same WS connection, relay-initiated `delivered` frames only; connector still pulls full envelope via REST GET to keep the push channel thin and replay-safe on reconnect (§9 "connectors MUST reconcile state after reconnecting").

**Why:** Spec explicitly leaves transport as an implementation choice (§9, §13) but requires durable reconciliation, so a thin push+pull split avoids ever trusting WS delivery as source of truth.

**Rules out:** No end-to-end encryption in v1 (explicitly out of scope, §2.2, §14 "SHOULD support encrypted payloads in a future profile"). No long-poll-only fallback for v1 — WS is real-time path, REST poll is the explicit fallback for the conformance profile's "temporary disconnection" test (§18 item 4).

## 4. Key storage

**Choice:** Relay stores only public keys (schema above). Private signing keys never leave the connector's host.

- Connector persists the endpoint's Ed25519 private key using host-native secure storage: macOS Keychain, Windows DPAPI (`CredWrite`/`CredRead`) — this repo runs Windows, so DPAPI is the reference implementation — Linux Secret Service (libsecret) with a file-based encrypted fallback (age or libsodium `crypto_secretbox` under a key derived from an OS-protected passphrase) when no secret service is present.
- Bearer tokens (transport auth, distinct from the signing key) are stored the same way, rotated whenever the signing key rotates.

**Why:** Spec §17 "protect endpoint private keys using the host's secure storage where available" is a MUST. DPAPI as primary on this dev machine matches the actual deployment target instead of assuming a Unix keychain exists.

**Rules out:** No private keys in plaintext config files, env vars, or the Postgres database under any circumstance — a relay compromise must not yield signing capability for any endpoint.

## 5. Plugin/MCP boundary

**Choice:** The Sigil connector is a standalone local process (not an MCP server itself). It exposes a small localhost-only HTTP API. A thin MCP server — one per host runtime (Claude Code, Codex) — is a separate adapter process that calls the connector's localhost API. The MCP layer never touches keys, tokens, or raw capability grants.

```text
Claude Code ─ MCP tool calls ─┐
                               ├─ localhost HTTP ─ Sigil connector (holds keys, does signing, talks to relay)
Codex ─ tool-calling plugin ──┘
```

MCP tool surface is limited to: `sigil_send_task`, `sigil_check_inbox`, `sigil_get_result`, `sigil_request_approval`, and `sigil_resolve_context` — each a thin RPC to the connector, which does signing, capability enforcement, and approval-record creation locally before anything reaches the relay.

**Why:** Spec design principle 7 — "connectors are replaceable... must not depend on Claude hooks, MCP." Making MCP an optional adapter on top of a runtime-independent connector means Codex's tool-calling plugin and Claude's MCP server are two thin skins over the same connector binary/process, not two separate protocol implementations. If a future runtime has no MCP equivalent, only the adapter layer changes.

**Rules out:** No signing or capability-enforcement logic inside the MCP tool handlers themselves — that would tie protocol security to a Claude-specific mechanism, contradicting §13's connector contract (local capability enforcement is a connector responsibility) and design principle 7.

## 6. Approval UX

**Choice:** Terminal/CLI prompt at the connector layer, synchronous and blocking for the triggering action, before any `approval.request` reaches the relay.

Flow: connector detects a high-risk action (per §11's list) → renders a structured local prompt (actor, action description, scope, risk, requested capability, expiration, consequences — same fields required in `approval.request`) → opens a loopback-only companion approval page in the user's browser (or approved host-native WebAuthn UI) → human completes a relay-verified WebAuthn/passkey assertion → connector submits `approval.request` + assertion to the relay → relay derives `actor_id`, verifies the credential, RP ID/origin, and action hash, creates the immutable `decision.record`, and authorizes only an exact approved action. Endpoint signing alone never proves human approval. Full ceremony, credential, challenge, recovery, and test rules are in `sigil-human-approval-auth-spec-v1.0.md`.

**Why:** Both first-slice runtimes (Codex CLI, Claude Code CLI/extension) are terminal-first; a blocking local prompt needs no new UI surface and satisfies §11 "approval record MUST be separate from the request" since the decision is created and signed independently of the original envelope. Blocking (not async/deferred) keeps v1 simple — no need for a pending-approval notification UI yet.

**Rules out:** No web/mobile approval UI in v1 (§2.2 explicitly excludes a required chat interface). No auto-approval policies or capability-based bypass — every §11-listed action gets a human prompt in v1, tightened later only through explicit policy config, not silently.

## 7. Context storage

**Choice:** Relay stores only `context_refs` metadata (kind, repository/commit, scope, integrity hash) — never raw file content, diffs, or artifact bytes. Material resolution happens entirely on the connector side, against the connector's local filesystem/repo state, gated by an active capability grant (§12).

- No relay-side content cache, no relay-side materialization service in v1.
- Connector MAY keep a local content-addressed cache (keyed by the reference's `integrity` hash) to avoid re-reading large files across repeated resolutions within the same conversation, with a bounded TTL. This cache is local-only and never synced to the relay.
- `file_bundle`/`artifact` kinds resolve to whatever the connector's host already has on disk (per spec §12, path normalization, traversal/symlink rejection, allow-list enforcement all happen at resolution time, connector-side).

**Why:** Spec design principle 3 — "context is referenced, not dumped" — and §14 "relay MUST NOT... resolve private files." Keeping the relay a pure pointer store means it never becomes a second copy of potentially sensitive repo content, and context resolution stays bound to whichever machine actually has authorized access to the material.

**Rules out:** No relay-hosted blob storage (S3-equivalent) in v1. No cross-machine context sync — if Codex's connector references a commit Claude's connector's host doesn't have, resolution fails `CONTEXT_NOT_FOUND` rather than the relay fetching and forwarding it.

## Summary table

| Area | v1 choice |
|---|---|
| Relay runtime | Node.js + TypeScript |
| Relay API | REST (submit/control) + WS (push notify only) |
| Database | PostgreSQL, single schema, append-only audit/grant/decision tables |
| Transport | TLS 1.3, bearer token + per-envelope Ed25519 signature |
| Key storage | Host-native secure storage (DPAPI on this dev target), never on relay |
| Plugin/MCP boundary | Standalone connector process; MCP/tool-plugin is a thin keyless adapter |
| Approval UX | Blocking terminal/host-native prompt, connector-signed decision record |
| Context storage | Relay stores pointers only; connector resolves locally, optional local cache |

## Optional integrations (not part of v1 lock)

Chat SDK and Open Chat Widget are host-side integrations, not relay or connector
requirements. Neither is built or wired in v1. They MAY sit on top of the
connector's localhost API the same way the MCP adapter does (§5 above) —
a human-facing chat surface calling `sigil_send_task`/`sigil_check_inbox`
instead of an agent runtime — but nothing in the v1 conformance profile (spec
§18) depends on either existing. Treat as future extensions per spec §19
("human web and mobile clients"), gated behind the same connector contract,
not a special case in the relay protocol.

## Open items deferred past this lock

- Bearer-token issuance/rotation: registration returns a one-time endpoint-scoped token over the authenticated bootstrap channel; rotation requires a request signed by the current endpoint key or approved recovery flow, invalidates the old token immediately, and audits the transition. Tokens are stored only in host-native secure storage and are never logged or returned after creation.
- Rate/quota limit numbers (§14 requires them; this doc doesn't set thresholds).
- Dead-letter queue mechanics for `processing_failed` (§9) — table shape only, no reaper policy yet.

## Amendment 2026-08-16 — Ed25519: stay on node:crypto

Probe (`sigil/relay/v1/ed25519-probe.test.mjs`) confirmed `node:crypto.verify(null, bytes, key, sig)`
correctly implements Ed25519 per RFC 8032, round-trips through
PEM re-import (the exact path `registry-store.mjs` uses), and correctly
rejects tampered signatures. No gap found against the decision doc's intent.
`@noble/ed25519` is **not added** as a dependency; `node:crypto` remains the
conforming Ed25519 implementation for both signing and verification.
