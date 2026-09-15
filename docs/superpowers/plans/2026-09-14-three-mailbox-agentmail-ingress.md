# Three-Mailbox AgentMail Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept selectively forwarded AgentMail messages through three inboxes and convert them into policy-checked Sigil envelopes without weakening existing identity, signing, approval, replay, or queue guarantees.

**Architecture:** Add one provider adapter with a separately registered, non-mailbox `ep_ingress` identity. The adapter verifies AgentMail webhook authenticity, sender/token policy, quarantine/classification, and provider-level idempotency, then creates ordinary Sigil `task.request` envelopes for the existing validator and relay-job pipeline. The three hosted inboxes remain mapped to `ep_triage`, `ep_judgment`, and `ep_iron` as destinations; `ep_iron` rejects external mail.

**Tech Stack:** Node.js ESM, existing Sigil contracts and relay validator, PostgreSQL `relay_jobs`, existing JCS/Ed25519 implementation, AgentMail TypeScript SDK, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-14-three-mailbox-agentmail-ingress.md` (repository-local authoritative specification).

## Global Constraints

- Reuse `sigil/relay/v1/validate-envelope.mjs`, `sigil/relay/v1/jcs.mjs`, existing endpoint registration, existing grant/approval records, and existing generic `relay_jobs`; do not create parallel implementations.
- Register `ep_ingress` as a normal Sigil endpoint with `endpoint_id`, `owner_id`, `installation_id`, `runtime`, `key_id`, and `public_key`; it has no AgentMail inbox.
- AgentMail inbox IDs are transport identifiers and map one-to-one to `ep_triage`, `ep_judgment`, and `ep_iron`.
- External mail is always signed by `ep_ingress`; email content never claims an agent endpoint identity or capability.
- Workflow aliases are explicit: `triage+trm`, `triage+roadmap`, and `triage+eval`; ambiguous or unknown aliases reject.
- Financial-sensitive content may transit AgentMail only under documented retention/security approval; after receipt it is local-only, cannot invoke cloud/frontier paths, and has short retention.
- Real financial documents and personal email exports are prohibited from source control, fixtures, logs, CI artifacts, and canaries.
- Default limits are 10 MB per message, 5 MB per attachment, 120 seconds parser/OCR time, 3 retries with exponential backoff, 100 queued messages per workflow, and 10 messages per minute per sender.
- Preserve existing dirty work in `sigil/relay/v1/http-server.mjs`, `docs/contracts/`, and `modules/`; stage only files belonging to the task.

---

### Task 1: Define ingress configuration, mapping, and provenance contracts

**Files:**
- Create: `sigil/ingress/v1/agentmail-config.mjs`
- Create: `sigil/ingress/v1/agentmail-config.test.mjs`
- Create: `sigil/ingress/v1/agentmail-provenance.mjs`
- Create: `sigil/ingress/v1/agentmail-provenance.test.mjs`
- Modify: `sigil/cli/identity.mjs` only if needed to expose the existing endpoint-registration helper for `ep_ingress`

**Interfaces:**
- `loadAgentMailConfig(env)` returns `{ webhookSecrets, apiKeyRef, inboxMappings, senderAllowlist, forwardingTokens, limits }` and rejects missing required values.
- `resolveInboxMapping(inboxMappings, providerInboxId)` returns `{ endpointId, workflowPolicy }` or throws `UNKNOWN_INBOX` / `MULTIPLE_INBOX_MAPPING`.
- `buildIngressProvenance(input)` returns a redacted, JSON-serializable object containing provider event ID, provider message ID, inbox ID, verified sender, workflow, classification, attachment hashes, and timestamps; it never returns raw credentials or message bodies.
- `deriveIngressIdempotencyKey({ providerEventId, providerMessageId, inboxId })` returns a stable nonblank string used as the Sigil `idempotency_key`.

- [ ] **Step 1: Write failing tests** for missing configuration, duplicate inbox mappings, unknown inboxes, stable key derivation, and provenance redaction.
- [ ] **Step 2: Run focused tests** with `node --test sigil/ingress/v1/agentmail-config.test.mjs sigil/ingress/v1/agentmail-provenance.test.mjs`; expected initial failure because modules do not exist.
- [ ] **Step 3: Implement** strict configuration parsing and deterministic provenance/key derivation with stable error codes.
- [ ] **Step 4: Run focused tests** again; expected PASS.
- [ ] **Step 5: Commit** with `git add sigil/ingress/v1 && git commit -m "feat: define AgentMail ingress contracts"`.

### Task 2: Implement signed envelope construction through existing Sigil contracts

**Files:**
- Create: `sigil/ingress/v1/build-task-request.mjs`
- Create: `sigil/ingress/v1/build-task-request.test.mjs`
- Modify: `sigil/contracts/v1/task-request-schema.mjs` only if the existing body contract lacks a required provenance field; preserve existing required fields and error codes.

**Interfaces:**
- `buildTaskRequest({ ingressEndpoint, ownerId, recipientEndpoint, taskId, instruction, contextRefs, capabilities, provenance, idempotencyKey, createdAt, expiresAt, signer })` returns an ordinary Sigil `task.request` envelope matching `envelope.example.json`.
- `signTaskRequest(envelope, signer)` uses the existing JCS byte helper and Ed25519 signing convention; it does not define a new signature shape.

- [ ] **Step 1: Write failing tests** proving the envelope has `protocol: sigil/1`, registered `sender.endpoint_id: ep_ingress`, exactly one recipient, `task_id`, non-empty `instruction`, `context_refs`, `capabilities`, `idempotency_key`, and existing signature metadata.
- [ ] **Step 2: Add negative tests** for raw body insertion, endpoint spoofing, missing recipient, blank instruction, and unsupported capability names.
- [ ] **Step 3: Run `node --test sigil/ingress/v1/build-task-request.test.mjs`**; expected FAIL before implementation.
- [ ] **Step 4: Implement the builder by delegating validation/signing to existing Sigil modules** and retaining user identity only in approved provenance/body metadata.
- [ ] **Step 5: Run focused tests plus `node sigil-jcs-audit.mjs`**; expected PASS with no canonicalizer drift.
- [ ] **Step 6: Commit** with `git add sigil/ingress/v1 sigil/contracts/v1 && git commit -m "feat: build Sigil envelopes from ingress mail"`.

### Task 3: Add quarantine, classification, and document normalization

**Files:**
- Create: `sigil/ingress/v1/quarantine.mjs`
- Create: `sigil/ingress/v1/quarantine.test.mjs`
- Create: `sigil/ingress/v1/classify.mjs`
- Create: `sigil/ingress/v1/classify.test.mjs`
- Create: `sigil/ingress/v1/document-normalize.mjs`
- Create: `sigil/ingress/v1/document-normalize.test.mjs`

**Interfaces:**
- `quarantineAttachment(stream, metadata, storage)` returns `{ reference, sha256, mediaType, byteLength }` or a stable rejection code.
- `classifyInboundMessage({ sender, workflow, body, attachments })` returns one of `public`, `internal`, `confidential`, `financial_sensitive` plus reasons.
- `normalizeDocument(reference, mediaType, parser)` returns sanitized text/reference metadata; macros, active HTML, unsupported MIME types, size violations, parser errors, and OCR timeouts reject or quarantine without exposing raw content.

- [ ] **Step 1: Create synthetic fixtures in test code** for plain text, malformed MIME, macro-bearing DOCX, valid DOCX, image OCR, oversized files, unreadable files, prompt-injection text, and synthetic financial data; include no real personal data.
- [ ] **Step 2: Write failing tests** for streaming limits, SHA-256 integrity, classification, macro stripping, OCR timeout, and financial-sensitive local-only policy.
- [ ] **Step 3: Run focused tests** with `node --test sigil/ingress/v1/quarantine.test.mjs sigil/ingress/v1/classify.test.mjs sigil/ingress/v1/document-normalize.test.mjs`; expected FAIL before implementation.
- [ ] **Step 4: Implement bounded streaming quarantine and provider-neutral normalization** behind injected storage, parser, scanner, and OCR interfaces.
- [ ] **Step 5: Run focused tests**; expected PASS, including proof that raw contents never enter logs or trusted envelope fields.
- [ ] **Step 6: Commit** with `git add sigil/ingress/v1 && git commit -m "feat: quarantine and classify inbound documents"`.

### Task 4: Implement AgentMail webhook adapter and workflow routing

**Files:**
- Create: `sigil/ingress/v1/agentmail-adapter.mjs`
- Create: `sigil/ingress/v1/agentmail-adapter.test.mjs`
- Create: `sigil/ingress/v1/agentmail-transport.mjs`
- Create: `sigil/ingress/v1/agentmail-transport.test.mjs`
- Modify: `package.json` and `package-lock.json` to add the pinned `agentmail` SDK version selected during implementation.

**Interfaces:**
- `createAgentMailTransport({ apiKey, clientFactory })` returns `registerWebhook`, `fetchMessage`, and `sendMessage` operations; provider errors map to stable adapter errors.
- `handleAgentMailWebhook({ rawBody, headers, inboxId, provider, registry, ingress, ledger, policy, quarantine, enqueue, clock })` returns `{ status: 202, eventId, state }` after durable registration/enqueue, or a stable rejection response.
- `resolveWorkflow(alias, tokenStore)` returns an allowlisted workflow or rejects invalid, missing, duplicate, or mismatched tokens.

- [ ] **Step 1: Add the exact AgentMail SDK dependency** after reviewing its current package metadata; commit the lockfile change with this task.
- [ ] **Step 2: Write failing adapter tests** for valid/invalid webhook signatures, sender allowlist, token grammar, inbox mapping, `ep_iron` rejection, workflow routing, provider timeout, and redacted errors.
- [ ] **Step 3: Write transport contract tests** against an injected fake client; no live credentials in tests.
- [ ] **Step 4: Run focused tests**; expected FAIL before implementation.
- [ ] **Step 5: Implement one adapter pipeline**: verify webhook → map inbox → authenticate sender/token → ledger registration → quarantine/classify → workflow policy → build/sign envelope → enqueue existing relay job → acknowledge.
- [ ] **Step 6: Run focused tests and `npm run audit:deps`**; expected PASS.
- [ ] **Step 7: Commit** with `git add package.json package-lock.json sigil/ingress/v1 && git commit -m "feat: add AgentMail webhook ingress"`.

### Task 5: Integrate existing relay jobs, endpoint registration, and receipts

**Files:**
- Create: `sigil/ingress/v1/agentmail-ledger.mjs`
- Create: `sigil/ingress/v1/agentmail-ledger.test.mjs`
- Create: `sigil/ingress/v1/agentmail-receipts.mjs`
- Create: `sigil/ingress/v1/agentmail-receipts.test.mjs`
- Modify: `sigil/relay/v1/http-server.mjs` only at the existing route-registration boundary.
- Modify: `sigil/cli/sigil.mjs` only to add explicit, audited `ep_ingress` provisioning/configuration; no implicit grants.
- Create: `sigil/ingress/v1/agentmail.integration.test.mjs`

**Interfaces:**
- `recordIngressEvent({ providerEventId, providerMessageId, inboxId, state, provenance })` is durable and idempotent.
- `transitionIngressState(eventId, nextState)` enforces `received → quarantined → accepted → dispatched → completed`, with rejection/dead-letter exits and operator-approved replay only to `quarantined`.
- `emitIngressReceipt(event, outcome)` returns a signed receipt referencing the correlation ID and redacted rejection code.

- [ ] **Step 1: Write failing ledger tests** for duplicate/out-of-order events, restart-safe state, queue saturation, dead-letter replay, and no duplicate Sigil envelope.
- [ ] **Step 2: Write failing integration tests** covering triage → judgment, judgment quarantine, iron rejection, financial-sensitive local-only handling, and valid iron promotion evidence.
- [ ] **Step 3: Run focused integration tests**; expected FAIL before implementation.
- [ ] **Step 4: Implement the adapter ledger using existing PostgreSQL/relay-job patterns** and add the smallest migration required for provider event identity and provenance; preserve existing job-type-scoped idempotency.
- [ ] **Step 5: Wire explicit endpoint provisioning and ingress route registration** without changing existing routes or granting capabilities implicitly.
- [ ] **Step 6: Run `node --test sigil/ingress/v1/*.test.mjs` and the affected relay suites**; expected PASS.
- [ ] **Step 7: Commit** with `git add sigil/ingress/v1 sigil/relay/v1/http-server.mjs sigil/cli/sigil.mjs sigil/migrations && git commit -m "feat: integrate AgentMail ingress with Sigil relay"`.

### Task 6: Documentation, operational checks, and non-sensitive canary

**Files:**
- Create: `docs/agentmail-ingress.md`
- Create: `docs/contracts/agentmail-ingress-example.json`
- Modify: `README.md` with setup and safety boundaries.
- Modify: `STATUS.md` with focused/full/live evidence and remaining approval blockers.

- [ ] **Step 1: Document provisioning** for three AgentMail inboxes plus non-mailbox `ep_ingress`, webhook registration receipts, secret rotation, sender allowlist, forwarding aliases, and kill switch.
- [ ] **Step 2: Document data handling** for TRM, roadmap, evaluation, spec documents, images, DOCX, and financial-sensitive inputs; explicitly prohibit real financial fixtures.
- [ ] **Step 3: Add contract examples** containing only synthetic content and valid existing Sigil envelope fields.
- [ ] **Step 4: Run the complete local gate**: `npm test`, `npm run audit:deps`, `npm run audit:jcs`, and `git diff --check`.
- [ ] **Step 5: Run the disposable PostgreSQL live gate** with `npm run test:live` if its required database environment is available; otherwise record the exact skip reason.
- [ ] **Step 6: Run an opt-in AgentMail canary** with synthetic non-sensitive content only after local gates pass; verify webhook signature, routing, redacted receipt, secret rotation, retention deletion, and alerting.
- [ ] **Step 7: Commit** with `git add docs README.md STATUS.md && git commit -m "docs: document AgentMail ingress operations"`.

## Final verification

- `npm test` passes with final counts recorded.
- `npm run audit:deps` and `npm run audit:jcs` pass.
- Focused ingress and relay integration suites pass.
- Disposable PostgreSQL evidence is separated from staging, remote, and production evidence.
- Synthetic canary passes; no real financial document is used.
- Tier 1 and privacy/compliance approvals are recorded before production activation.
