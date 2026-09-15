# Three-Mailbox Sigil Integration Specification

Status: Draft for Tier 1 approval
Date: 2026-09-14

## Objective

Accept selectively forwarded email through three AgentMail inboxes while preserving Sigil as the authority for endpoint identity, capability grants, routing, audit, and promotion gates.

## Scope

In scope: AgentMail transport adapter, three inbox mappings, workflow aliases, signed envelopes, document quarantine, data classification, idempotency, queues, receipts, and tests.

Out of scope: changing Sigil cryptography, creating new agent identities implicitly, automatic cross-provider failover, production deployment, and sending real financial documents to cloud agents.

## Canonical identities

| AgentMail inbox | Sigil endpoint | Role | Allowed workflow |
|---|---|---|---|
| configured inbox A | `ep_triage` | Tier 2 muscle | `trm`, `roadmap`, `eval` |
| configured inbox B | `ep_judgment` | Tier 1 judgment | `review`, `approval` |
| configured inbox C | `ep_iron` | Tier 3 iron | internal receipts and test events only |

The adapter also has one non-mailbox service identity, `ep_ingress`. It has no user-facing inbox and exists only to sign envelopes created from verified human email.

AgentMail inbox IDs are transport identifiers. They must map one-to-one to immutable `endpoint_id` values in the registry. Display names and provider account names are never authorization identities.

## Sigil alignment

This integration reuses existing Sigil primitives. It must not add a second envelope validator, canonicalizer, signature format, capability evaluator, approval mechanism, or durable relay-job queue.

- Endpoint registration requires `endpoint_id`, `owner_id`, `installation_id`, `runtime`, `key_id`, and `public_key`.
- Envelope validation delegates to the existing Sigil validator for JCS, Ed25519, key validity, clock skew, recipient checks, capability coverage, approval action hashes, and replay checks.
- Capabilities use the existing Sigil namespace, such as `sigil.task/read_inbox`, `sigil.task/send`, `sigil.approval/request`, and `sigil.core/read_shared_context`.
- Accepted work uses existing generic `relay_jobs` lifecycle and job-type-scoped idempotency.

## Registry record

```yaml
endpoint_id: ep_triage
owner_id: usr_operator
domain: local
status: active
installation_id: <installation-id>
runtime: agentmail-ingress-adapter
key_id: <key-id>
public_key: <registered-public-key-object>
agentmail_inbox_id: <provider-id>
workflow_policy_ref: <adapter-policy-id>
policy_version: three-tier-multi-agent/v1
created_at: <RFC3339>
expires_at: <RFC3339-or-null>
```

Registry writes require explicit authorization. Unknown, paused, revoked, expired, or multiply mapped records fail closed.

Activation requires a provisioning receipt containing the real provider inbox ID, verified webhook registration ID, secret reference, and one-to-one mapping proof. Placeholder IDs are invalid in active configuration.

## Inbound processing contract

1. Receive AgentMail webhook.
2. Verify provider webhook signature and event authenticity.
3. Resolve inbox ID through the registry.
4. Parse and check sender authentication plus per-mailbox forwarding token.
5. Register provider event ID plus message ID plus inbox ID in the adapter idempotency ledger; derive the Sigil `idempotency_key` from that record and use `ep_ingress` as sender.
6. Stream attachments to encrypted quarantine storage.
7. Validate MIME type and size; strip active HTML and DOCX macros; scan and hash content.
8. Classify data as `public`, `internal`, `confidential`, or `financial_sensitive`.
9. Resolve workflow only from an explicit alias such as `triage+trm@...`; enforce alias mapping in adapter policy, not endpoint registration metadata.
10. Emit a signed `task.request` containing references, hashes, provenance, and policy metadata.
11. Acknowledge the webhook after durable registration/enqueue, not after full processing.

Financial-sensitive data may transit AgentMail only if the operator accepts AgentMail retention and security terms; the adapter must record that transport exposure. After receipt, processing is local-only: no cloud-agent or frontier invocation, no external webhook fan-out, encrypted quarantine, short retention, and explicit approval for any release. Real financial documents are prohibited from source control, test fixtures, logs, CI artifacts, and live canaries.

## Envelope construction

```yaml
protocol: sigil/1
message_id: <unique-id>
conversation_id: <unique-id>
message_type: task.request
sender:
  owner_id: usr_operator
  endpoint_id: ep_ingress
  kind: agent
recipient:
  owner_id: usr_operator
  endpoint_id: ep_judgment
body:
  task_id: <unique-id>
  instruction: <sanitized-or-referenced-instruction>
correlation_id: <unique-id>
origin_principal: <verified-sender>
context_refs: []
capabilities: []
idempotency_key: <sender-scoped-key>
created_at: <RFC3339>
expires_at: <RFC3339>
signature:
  algorithm: Ed25519
  key_id: <registered-key-id>
  value: <base64url-signature>
```

User-originated email is converted into a registered `ep_ingress`-originated envelope; verified human sender data stays in adapter provenance and approved body metadata. The envelope must contain exactly one `recipient` or `broadcast_scope`, and its body must satisfy the existing `task.request` validator (`task_id` and non-empty `instruction`). JCS, Ed25519, timestamp, key, and rejection behavior come from the existing validator. Raw email bodies and credentials must not appear in trusted authorization fields.

Forwarding grammar is `local-part = endpoint-or-workflow "+" token`, with token matching `[A-Za-z0-9_-]{22,128}`. The adapter parses the recipient address before content classification; duplicate aliases, missing tokens, invalid tokens, and token/workflow mismatches are rejected. Tokens are never copied into task content or logs.

For user-originated mail, `origin_principal` identifies the verified sender. Direct mail to `ep_triage` creates a triage request; direct mail to `ep_judgment` enters review quarantine and cannot execute; direct mail to `ep_iron` is rejected. External mail always uses `ep_ingress`; only signed internal envelopes may claim an agent endpoint sender.

## Capability evaluation

The existing Sigil grant and approval system is the sole authorization implementation. Adapter policy may reject workflow/transport mismatches before envelope submission, but may not grant capabilities:

```text
unknown capability → existing grant check fails
missing grant      → CAPABILITY_DENIED
high-risk action   → existing approval action-hash flow
valid grant        → existing capability coverage check
```

Use existing names and grant records: triage gets ingestion/submission capabilities, judgment gets planning/proposal capabilities plus explicitly approved frontier access, and iron gets test/lint/canonicalization/queue/receipt capabilities. High-risk actions use existing WebAuthn approval and action-hash consumption.

## Reliability and operations

- Per-workflow bounded queues and quotas.
- Default limits: 10 MB total message, 5 MB per attachment, 120 seconds OCR/parser time, 3 retries with exponential backoff, 100 queued messages per workflow, and 10 messages/minute per sender.
- Adapter ledger states: `received` → `quarantined` → `accepted` → `dispatched` → `completed`; any non-terminal state may become `rejected` or `dead_lettered`; only operator-approved replay may return to `quarantined`.
- Sigil relay work uses existing `relay_jobs` leases, retries, terminal states, and job-type-scoped idempotency.
- Stable rejection codes and redacted structured logs.
- Correlation IDs on all receipts.
- Bounded retries; no automatic cross-tier rerouting.
- Manual dead-letter replay after policy and classification checks.
- Per-registration webhook secrets and provider credential rotation.
- Streaming attachment handling with size/time limits and classification-based retention.

## Acceptance criteria

- Three inbox IDs resolve deterministically to three distinct mailbox endpoint IDs; `ep_ingress` is separately registered and has no mailbox mapping.
- Invalid signatures, unknown inboxes, spoofed senders, missing tokens, replayed events, and ambiguous aliases are rejected.
- Synthetic DOCX, image, OCR, macro, malformed MIME, oversized, and prompt-injection fixtures follow documented outcomes.
- Financial-sensitive fixtures never reach a cloud or frontier execution path.
- Duplicate and out-of-order events produce at most one adapter submission and one Sigil envelope for the derived `ep_ingress`-scoped idempotency key.
- Capability tests prove default-deny, deny precedence, and step-up behavior.
- Promotion requires valid test, lint, JCS, and receipt evidence.
- Provider outage and queue saturation preserve messages through retry or dead-letter states.
- No production claim is made until live non-sensitive canary, secret rotation, retention deletion, and operational alerting are verified.
- Sender acceptance is based on webhook authenticity, exact allowlisted sender identity, valid forwarding token, and configured authentication evidence; `From:` alone is never sufficient.

## Alternatives considered

- Direct AgentMail integration in each agent: rejected due to duplicated authorization and identity logic.
- One generic mailbox: rejected because workflow and tier routing become ambiguous.
- LLM-based workflow classification: rejected because authorization must be deterministic.
- Automatic provider failover: deferred until equivalent policy and data-classification guarantees exist.

## Required decisions before implementation

1. AgentMail domain, inbox provisioning owner, and retention terms.
2. Secret manager and deployment target for adapter/webhook secrets.
3. Exact forwarding-token format and sender allowlist administration.
4. Local quarantine scanner/OCR/parser implementations.
5. Adapter provenance schema and deterministic `ep_ingress` idempotency-key derivation.
6. Tier 1 approval of financial-sensitive handling and frontier restrictions.
