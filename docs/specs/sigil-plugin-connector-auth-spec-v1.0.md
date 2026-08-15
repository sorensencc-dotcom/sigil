# Sigil Plugin, Connector, and Authentication Specification v1.0

**Status:** Approved for implementation
**Approval:** Tier 1 approval recorded 2026-08-14
**Profile:** Codex connector -> PostgreSQL relay -> Claude connector
**Normative language:** MUST, MUST NOT, SHOULD, SHOULD NOT, MAY have their usual RFC 2119 meanings.

## 1. Purpose and authority

This specification defines the trust, packaging, authentication, approval,
privacy, and conformance contract for Sigil plugins and connectors.

The relay is authoritative for human identity, account linkage, endpoint
registration, capability grants, approval decisions, revocation, delivery
authorization, and audit. A connector is authoritative only for its endpoint
private key, host integration, local secret storage, and execution boundary.
Plugins and host models are never authorization authorities.

An endpoint signature authenticates an endpoint. It does not authenticate a
human. A human session or approval credential does not authenticate an
endpoint. These identities MUST remain separate in storage, tokens, and audit.

## 2. Plugin and connector architecture

### 2.1 Components

- **Relay:** durable policy, identity, routing, approvals, grants, revocation,
  audit, and delivery state.
- **Connector:** standalone process that binds one host to Sigil, stores its
  endpoint key and token, receives authorized envelopes, and exposes a local
  execution API.
- **Plugin adapter:** thin host-specific adapter for MCP or tool-calling. It
  translates host requests to the shared connector contract and cannot broaden
  permissions.
- **Host/model:** untrusted request origin from the connector's perspective.
  Model-produced text is data, not policy.

### 2.2 Shared MCP contract

The canonical connector API MUST expose versioned operations equivalent to:

```text
connector.get_capabilities()
connector.request_capability(scope, purpose)
connector.submit_envelope(envelope)
connector.list_inbox(cursor, limit)
connector.ack_delivery(delivery_id, outcome)
connector.begin_approval(action_hash, requested_scope)
connector.resolve_context(reference_id)
connector.revoke_local_session(session_id)
```

Each operation MUST include a contract version, request ID, authenticated
local caller identity, and declared capability scope. The connector MUST
reject unknown required fields, unsupported major versions, scope widening,
and calls made after local revocation.

MCP tool descriptions are presentation metadata only. The connector and relay
MUST enforce the same capability and argument policy when MCP is absent.

### 2.3 Packaging

ChatGPT, Codex, and Claude integrations MUST package as adapters over the
shared connector contract. They MAY differ in manifest format, installation
mechanism, UI, and process supervisor, but MUST NOT define separate identity,
approval, capability, or revocation semantics.

Every package MUST declare:

```json
{
  "package_id": "sigil.<host>.<adapter>",
  "contract": "sigil.connector/v1",
  "host": "codex|claude|chatgpt",
  "permissions": ["sigil.core/read_shared_context"],
  "executable_digest": "...",
  "publisher_key_id": "..."
}
```

Installation MUST verify publisher signature, package digest, contract
compatibility, requested permissions, and revocation status before activation.

### 2.4 Local and remote connectors

Local connectors bind to loopback, use OS-native secret storage, and MUST
authenticate every local caller. They MUST refuse non-loopback binding unless
explicitly configured as remote.

Remote connectors use TLS with endpoint authentication, certificate/host
verification, replay protection, and explicit deployment registration. Remote
transport MUST NOT inherit trust merely from a local plugin installation.

Both modes use the same envelope, capability, approval, acknowledgement, and
revocation contract. Only transport bootstrap and process isolation differ.

## 3. Permissions and capability mapping

Permissions are namespaced capabilities, for example
`sigil.core/read_shared_context` or `sigil.task/submit/<task-id>`. A grant MUST
include subject, scope, purpose, provenance, issuer, issued-at, expiry, grant
ID, and revocation reference.

The effective permission is the intersection of:

```text
package declaration
  ∩ connector allow-list
  ∩ endpoint grant
  ∩ human/account policy
  ∩ action-specific approval
```

Ancestor scopes MAY cover descendants only where the policy explicitly permits
it. A plugin MUST NOT convert a context reference into filesystem, network,
credential, or arbitrary tool access. High-risk capabilities MUST require
step-up approval and an action hash.

Installation, grant, use, and revocation events MUST be audited.

Connector submission and acknowledgement MUST be retry-safe. Each submission
MUST carry an idempotency key bound to the endpoint, envelope/action hash, and
contract version. `ack_delivery` MUST be idempotent by delivery ID and outcome.
The relay MUST reject conflicting retries and MUST prevent a retry from causing
double execution. Connectors MUST enforce maximum pending envelopes, maximum
envelope size, approval-queue bounds, and per-endpoint request/rate limits;
overflow MUST produce an auditable backpressure result.

## 4. Versioning, installation, and revocation

The contract uses semantic versions. Major-version mismatch is fatal. Minor
versions are backward-compatible only when the receiver declares support.
Every request, envelope, approval, and audit event carries the contract major
version.

Installation is a staged operation: verify package -> display requested
permissions -> obtain user authorization -> provision connector -> perform
authenticated bootstrap -> health-check -> activate. Failed activation MUST
leave no usable credential.

Revocation MUST support package, publisher, connector endpoint, endpoint token,
human session, human credential, account link, and capability grant as separate
targets. Revocation takes effect before the next delivery authorization and
MUST invalidate cached authorization decisions. Tokens and credentials MUST
never be returned after creation or written to ordinary logs.

## 5. Human identity and authentication

### 5.1 OIDC issuer/subject model

An OIDC identity is identified by the exact pair `(issuer, subject)`. Issuer
URLs MUST be normalized according to the configured provider policy and stored
with the provider's discovery metadata. Subject values MUST be compared as
opaque strings; email MUST NOT substitute for subject identity.

The relay creates an internal `human_id` for the verified identity. Provider,
issuer, subject, and verification evidence are stored separately from display
attributes.

### 5.2 Account linking and unlinking

Linking a second identity requires an authenticated session for the existing
account plus fresh step-up authentication. The new identity MUST complete its
own issuer validation and nonce/state checks. Linking MUST be transactional,
audited, and protected by replay-resistant link tokens.

Unlinking requires step-up authentication and MUST be refused if it would leave
no recoverable authentication method. A link is never inferred from matching
name, email, or phone. Link, unlink, merge, and recovery events MUST identify
the initiating human, identities, session, and reason.

### 5.3 Attributes and verification states

Name, email, and phone are claims with source, observed time, and verification
state. They are not identity keys. Allowed states are `unverified`,
`provider_verified`, `challenge_verified`, `manually_verified`, `stale`, and
`revoked`.

Email or phone MUST NOT authorize account linking or high-risk approval unless
the required verification state and freshness policy are satisfied. Attribute
changes MUST invalidate dependent verification where required.

### 5.4 Sessions and tokens

Human sessions are opaque, short-lived, revocable records bound to `human_id`,
authentication method, assurance level, device context, issued-at, expiry, and
session version. Refresh rotation MUST detect reuse and revoke the token family.

Endpoint bearer tokens are separate from human sessions, endpoint-scoped, and
stored hashed at the relay and in host-native secure storage at the connector.
Creation is one-time; rotation requires the current endpoint key or approved
recovery, invalidates the old token immediately, and emits an audit event.

## 6. MFA and approval

### 6.1 WebAuthn/passkey enrollment and recovery

WebAuthn credentials MUST be registered with an explicit relay RP ID and origin
policy. Enrollment and assertion verification MUST validate challenge, origin,
RP ID, credential ID, user binding, signature, sign count policy, and
credential status. Attestation is optional only under an explicit deployment
policy; credential ownership is not inferred from an endpoint key.

Recovery MUST require an already authorized recovery method or a documented
multi-party/manual recovery process. Recovery MUST NOT silently replace all
credentials based on email, phone, or connector possession.

### 6.2 Phone fallback and reset

SMS/phone is a limited recovery or low-assurance factor, never a substitute for
WebAuthn for high-risk approval. It MUST have rate limits, attempt limits,
cooldowns, fraud signals, and explicit assurance labeling. SIM-swap, number
porting, carrier-change, and recent-attribute-change signals MUST block or
degrade phone-based recovery.

MFA reset requires fresh authentication, recovery policy checks, notification
to existing channels, an audit event, and a cooling period for high-risk
actions. Support personnel MUST NOT bypass these controls through an informal
request.

### 6.3 Step-up and approval ceremony binding

Step-up is required for account linking/unlinking, credential enrollment or
reset, endpoint registration or token rotation, capability escalation,
external disclosure, destructive tools, and policy-defined high-risk actions.

An approval record MUST bind:

```text
human_id + credential_id + session_id + endpoint_id + action_hash
+ capability scope + target/context + contract version + expiry + nonce
```

The relay recomputes `action_hash` from canonical unsigned action data and
authorizes delivery only when the decision is approved, unexpired, single-use,
scope-matching, and not revoked. Changed envelopes, changed targets, replayed
result tokens, and mismatched endpoints MUST fail closed.

Until a deployment profile fixes the exact profile, action canonicalization
MUST use RFC 8785 JCS over a versioned object containing `action_type`,
`target`, `context_refs`, `requested_capabilities`, `arguments`, `endpoint_id`,
`contract_version`, and `policy_version`; omitted optional fields are omitted
consistently and binary values use base64url. The hash algorithm and encoding
MUST be explicit in the approval record and test fixtures. Any change to this
profile is a Tier 1 decision.

## 7. Privacy and data protection

Secrets MUST use envelope encryption with a deployment-managed key hierarchy.
Connector private keys and local tokens MUST use OS-native secure storage.
Plaintext secrets MUST NOT enter application logs, test fixtures, telemetry, or
error messages.

PII records MUST declare purpose, retention period, deletion behavior, legal
hold behavior, and owning component. Account deletion MUST unlink identities,
revoke sessions/credentials/tokens, delete or cryptographically erase PII
where permitted, and retain only minimally necessary audit evidence.

Lookup hashes MUST use documented Unicode normalization, trimming, case-folding,
and field-specific rules. Reversible encryption is required where the value
must later be displayed; hashes are for exact lookup only and MUST NOT be
treated as identity proof.

Logs MUST use stable opaque IDs, redaction, structured security events, and
access controls. Plugins and hosts receive only the minimum data required for
the granted capability. Human names, emails, phones, OIDC claims, raw tokens,
WebAuthn material, and unrelated context MUST NOT be disclosed by default.

## 8. Conformance and threat model

An implementation is conformant only if it passes shared fixtures and all
applicable negative tests. Required attacks include:

- plugin impersonation: reject unsigned, altered, revoked, or publisher-mismatch
  packages;
- forged host identity: reject connector requests without valid endpoint
  authentication and local caller authorization;
- account-link attacks: reject email/phone matching, stolen link tokens,
  nonce/state reuse, and unlink-to-lockout flows;
- phone takeover: reject or downgrade SIM-swap, porting, replayed OTP, and
  excessive-attempt recovery;
- replay and downgrade: reject reused challenges/tokens, expired grants,
  unsupported major versions, stale decisions, and changed action hashes;
- revoked credentials: reject revoked users, credentials, endpoints, tokens,
  package publishers, and grants before delivery;
- connector compromise: limit disclosure and execution to connector-local
  allow-lists, require relay authorization, and prevent a plugin from reading
  unrelated secrets or broadening scope.

Required gates are contract fixtures, unit tests, real HTTP and WebSocket
boundary tests, WebAuthn positive/negative tests, persistence/restart tests,
failure injection, revocation race tests, package signature tests, and an
authenticated staging run. All security-sensitive operations MUST apply a
configured clock-skew tolerance; relay time is authoritative, connectors MUST
use synchronized time, and expired/replayed challenges MUST remain invalid
after restart. The deployment profile MUST define maximum tolerated skew and
NTP/time-source requirements. If connector time is unavailable or outside the
allowed skew, the connector MUST fail closed for approval, enrollment,
rotation, and high-risk execution, while relay-side expiry remains decisive.
Focused tests do not establish production readiness.

### 8.1 Requirement traceability

| Requirement | Threat/control | Enforcement data or field | Required proof |
|---|---|---|---|
| CON-01 package authenticity | Plugin impersonation | `package_records.publisher_key_id`, `digest`, `status` | signature, digest, revocation tests |
| CON-02 endpoint authenticity | Forged host identity | endpoint key/token records | HTTP/WS negative boundary tests |
| CON-03 link authorization | Account-link attack | `account_links`, link nonce/state | link/replay/lockout tests |
| CON-04 recovery assurance | Phone takeover | attribute verification, recovery audit | SIM-swap/rate-limit tests |
| CON-05 approval binding | Replay/downgrade | `approval_decisions.action_hash`, `nonce`, `contract_version` | changed-action and replay tests |
| CON-06 revocation | Revoked credentials | status/revoked-at fields, `audit_events` | revocation race/restart tests |
| CON-07 least privilege | Connector compromise | capability grant and disclosure fields | scope/disclosure tests |
| CON-08 retry safety | Duplicate execution | idempotency keys and delivery IDs | conflicting retry tests |

## 9. Required data objects

The executable schema MUST represent at least:

```text
oidc_identities(issuer, subject, human_id, status)
human_attributes(human_id, kind, value_or_ciphertext, verification_state)
human_sessions(session_id, human_id, authentication_method, assurance,
               device_context, issued_at, version, expires_at, revoked_at)
human_credentials(credential_id, human_id, type, public_key, rp_id, origin,
                  sign_count, last_used_at, status, revoked_at)
account_links(link_id, human_id, issuer, subject, nonce_hash, state_hash,
              issued_at, expires_at, consumed_at, status, created_at)
endpoint_tokens(token_id, endpoint_id, token_hash, status, expires_at)
package_records(package_id, publisher_key_id, digest, contract_version, status)
capability_grants(grant_id, subject, scope, purpose, provenance, issuer,
                  issued_at, expires_at, revoked_at)
approval_decisions(decision_id, human_id, credential_id, endpoint_id,
                   action_hash, action_hash_algorithm, target, context_refs,
                   scope, contract_version, policy_version, nonce, expires_at,
                   status)
audit_events(event_id, event_type, actor_human_id, endpoint_id, subject_id,
             object_type, object_id, action_hash, outcome, reason, created_at,
             metadata_redacted)
idempotency_records(key, endpoint_id, action_hash, contract_version, result,
                    created_at, expires_at)
recovery_attempts(attempt_id, human_id, factor_type, assurance, phone_hash,
                  sim_swap_signal, attempt_count, cooldown_until, status,
                  created_at, expires_at)
```

Foreign keys, uniqueness constraints, expiry checks, ownership checks, and
transactional revocation are enforcement requirements, not documentation-only
claims.

`idempotency_records` MUST enforce uniqueness on `(endpoint_id, key)` and bind
the stored result to action hash and contract version. Conflicting reuse MUST
fail without executing the action. Nonce/state hashes MUST be single-use and
expire with the link transaction.

### 9.1 Required state machines

Allowed `approval_decisions.status` transitions are:

```text
pending -> approved | denied | expired | cancelled | revoked
approved -> consumed | expired | revoked
```

`consumed`, `denied`, `expired`, `cancelled`, and `revoked` are terminal. A
pending approval MUST transition to `revoked` when its capability grant,
endpoint, human credential, human session, package publisher, or account link
is revoked or suspended. This invalidation MUST be transactional with the
revocation event and MUST prevent a concurrent approval from becoming
authorized.
Only one transaction may transition `approved` to `consumed`.

`oidc_identities.status` is `active | suspended | unlinked | revoked`;
`package_records.status` is `staged | active | suspended | revoked`.
Transitions MUST be authorized, transactional, and audited. Unknown status
values MUST fail closed.

### 9.2 Retry, queue, and downgrade behavior

Unsupported major versions MUST hard-fail before mutation, quarantine the
request with a redacted diagnostic, and emit an audit/security event. They MUST
NOT silently negotiate down. Minor-version negotiation MUST be explicit.

`submit_envelope` idempotency keys and delivery IDs MUST survive connector and
relay restart. Queue bounds and backpressure limits are deployment parameters,
but a profile MUST specify maximum pending count, maximum bytes, maximum age,
and per-endpoint approval rate before staging. Quarantined requests MUST have a
redacted reason, owner, created-at, expiry, alert status, and release decision;
quarantine expiry MUST reject the request rather than reactivate it. Only an
authorized operator or policy-controlled retry may release quarantine, and the
release MUST be audited.

## 10. Open decisions and release gates

Locked policy decisions for this v1 implementation are: deployments MUST
provide an explicit non-empty OIDC issuer allow-list; endpoint tokens default to
24 hours and MUST NOT exceed 24 hours; assurance levels are `low`, `standard`,
and `high` with phone/SMS at `low`, OIDC sessions at `standard`, and
user-verified WebAuthn at `high`; account-link ceremonies require single-use
nonce and state values with a maximum 10-minute lifetime. Tier 1 still must
approve provider membership, phone fallback operations, attestation policy,
encryption/key-management deployment, PII retention schedule, package
publisher trust roots, and remote connector deployment model. Tier 1 must also
approve the exact action-hash canonicalization profile, clock-skew tolerance,
connector/envelope/approval rate limits, queue bounds, idempotency retention
period, and major-version quarantine behavior.

Deployment-managed encryption keys MUST have a documented KEK/root rotation
procedure, overlap window, rewrap strategy, access-control owner, compromise
response, and audit evidence. Rotation MUST NOT require exposing plaintext PII
to plugins or hosts.

This draft is not a production-readiness approval. Before implementation is
declared complete, update the implementation spec and handoff with evidence
for every normative control, then pass full conformance, failure-injection,
staging, and Tier 1 approval gates.
