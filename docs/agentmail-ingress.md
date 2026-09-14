# AgentMail ingress

Sigil accepts selectively forwarded AgentMail messages through three configured inboxes. AgentMail remains a transport provider; Sigil remains authoritative for endpoint identity, capability grants, approval, routing, audit, idempotency, and relay jobs.

## Provision the service identity

Create a normal Sigil identity with endpoint id `ep_ingress`, then provision it explicitly:

```text
sigil init ingress --owner usr_operator --registry .sigil/registry.json
sigil agentmail provision --identity .sigil/ingress.identity.json --installation-id install_ingress --registry .sigil/registry.json
```

Provisioning writes a normal endpoint record and a redacted audit event. It does not create a mailbox mapping, capability grant, or implicit approval. Keep the identity file private.

## Configure inbox mappings

Set `SIGIL_AGENTMAIL_INBOX_MAPPINGS` to a JSON array containing exactly three immutable provider-to-endpoint mappings:

```json
[
  {"providerInboxId":"inbox_triage","endpointId":"ep_triage"},
  {"providerInboxId":"inbox_judgment","endpointId":"ep_judgment"},
  {"providerInboxId":"inbox_iron","endpointId":"ep_iron"}
]
```

The adapter rejects duplicate provider IDs, duplicate endpoint IDs, unknown inboxes, and placeholder active mappings. `ep_ingress` never receives an AgentMail inbox.

Required configuration also includes a secret reference in `SIGIL_AGENTMAIL_API_KEY_REF`, webhook secret records, an exact sender allowlist, and forwarding tokens. Store values in the deployment secret manager; do not put them in source control, fixtures, logs, or CI artifacts.

## Forwarding aliases

The deterministic forwarding grammar is `endpoint-or-workflow+workflow+token@domain`, where the token matches `[A-Za-z0-9_-]{22,128}`. For example, `triage+trm+<token>@agentmail.test` resolves to workflow `trm`. Tokens are checked before content processing, never logged, and never copied into task instructions.

Triage accepts `trm`, `roadmap`, and `eval`. Judgment accepts `review` and `approval`, then remains in review quarantine until the existing approval flow authorizes further work. Iron accepts internal receipts and test events only; external mail is rejected.

## Processing and safety boundaries

The webhook pipeline verifies provider authenticity, exact authenticated sender identity, inbox mapping, forwarding token, provider event idempotency, attachment quarantine, MIME and size limits, classification, workflow policy, signed envelope construction, and durable enqueue. The webhook is acknowledged only after durable registration and enqueue.

Attachments stream to encrypted quarantine storage and receive SHA-256 references. Active HTML and DOCX macro markers are removed during normalization. Parser and OCR work is bounded by the configured timeout. Prompt-injection text remains untrusted reference material and cannot grant authorization.

Financial-sensitive content is classified fail-closed. The default adapter rejects it until explicit handling approval is configured. If an approved local-only policy is enabled, no cloud or frontier invocation, external webhook fan-out, or automatic cross-tier rerouting is allowed; retention must be short and deletion must be verified.

Real financial documents and personal email exports are prohibited from source control, tests, logs, CI artifacts, and canaries.

## Operations

Use the adapter ledger states `received`, `quarantined`, `accepted`, `dispatched`, `completed`, `rejected`, and `dead_lettered`. Only operator-approved replay may return a rejected or dead-lettered event to `quarantined`. Use existing Sigil `relay_jobs` leases, retries, terminal states, and job-type-scoped idempotency for durable work.

Rotate webhook secrets and the provider API key through the secret manager. Register each webhook against its configured inbox and retain the provider registration receipt with the inbox mapping proof. Disable ingress with the adapter kill switch before secret rotation or quarantine maintenance.

This implementation has local focused-test evidence only. A live non-sensitive canary, secret rotation, retention deletion, operational alerting, privacy/compliance approval, and Tier 1 approval remain required before production activation.
