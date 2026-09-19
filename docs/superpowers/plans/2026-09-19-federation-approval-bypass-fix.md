# Federation Approval-Bypass Fix (Option A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two capability/risk-tier approval bypasses in Sigil relay envelope acceptance: (1) a forwarded envelope (sync or queue federation mode) never runs the high-risk-capability approval gate at all, and (2) a federated-inbound envelope (`accept-federated-envelope.mjs`) never runs the capability/risk-tier/approval gate or the task.request/task.result assignee-binding check.

**Architecture:** Extract the existing capability-registry + risk-tier + `consumeApprovalDecision` gate logic (currently duplicated nowhere, but only wired into one of three accept paths) into a single shared module, `capability-risk-gate.mjs`. Call it from all three points that currently skip it: `accept-envelope.mjs`'s Phase 1 sync-forward branch, `accept-envelope.mjs`'s Phase 2 queue-forward branch (both currently fall through the gate that only guards `route.action === 'local'`), and `accept-federated-envelope.mjs`'s inbound-accept transaction (which never calls it today). Also port the task.request/task.result assignee-binding check (originally added to `accept-envelope.mjs` as Finding #1/PR #4-#5) into `accept-federated-envelope.mjs`, and add the three missing rejection codes (`APPROVAL_REQUIRED`, `TASK_ASSIGNEE_MISMATCH`, `DUPLICATE_TASK_ID`) to that file's local `statusByCode` map so they don't collapse to a generic 400.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`), plain ESM modules, existing `PostgresRepository` / in-memory `createMemoryRepository` test doubles. No new dependencies.

**Spec:** This plan implements Option A ("trust-the-sending-relay") from the federation approval-bypass scope-out discussed in this session (no design doc — the scope-out itself is the spec). Base commit for all file/line references below: `736f7386` (`origin/main`, `chore(release): v2.66.3`). If `git blame`/line numbers have since drifted, re-read the cited file before editing — the code shown in each step is the authoritative target, not the line numbers.

**Amendment (SDD preflight ruling, recorded before Task 1 dispatch):** The execution branch (`spec/fix-session-layer`) forked from `origin/main` before the commit that added the risk-tier/approval gate and the task.request/task.result assignee-binding check to `accept-envelope.mjs`, and never merged it forward — confirmed via `git diff origin/main -- sigil/relay/v1/accept-envelope.mjs` returning a real diff. On this branch, `accept-envelope.mjs`'s Phase 2 capability check is a bare `CAPABILITY_DENIED`-only loop (no risk-tier tracking, no approval consumption anywhere), and there is no task-assignee-binding logic at all (only a bare `task.result` → `INVALID_ENVELOPE`-if-no-visible-request check). Task 2 below is corrected accordingly: it adds the gate without any "remove the old block" step (no such block exists to remove), and it intentionally does NOT restore the task-assignee-binding check in `accept-envelope.mjs` — that gap is a separate, third defect distinct from Bypass #1, out of this plan's authorized scope, and is called out to the human partner as a follow-up rather than silently fixed or silently ignored. `accept-federated-envelope.mjs` (Task 3) is confirmed byte-identical between this branch and `origin/main`, so Task 3 proceeds exactly as originally written.

## Global Constraints

- No new database schema and no new migration. Reuse `capability_registry`, `capability_grants`, `approval_decisions` (via `consumeApprovalDecision`), and the existing `lookupCapabilityRegistration` / `consumeApprovalDecision` / `lookupTaskRequest` repository methods verbatim.
- The Phase 1 sync-forward path in `accept-envelope.mjs` must never open a Postgres transaction (design constraint "I1": a slow/hung peer must not hold a pooled connection open across the `postForward` network call). The new gate calls on that path must use the repository's pool-default client (i.e. call the repository methods without a `client` argument, letting `client = this.pool` apply), never `repository.withTransaction`.
- Every existing passing test must keep passing. Where this plan's tests intentionally change externally-visible behavior (e.g. check ordering), the task calls it out explicitly.
- `APPROVAL_REQUIRED`, `CAPABILITY_DENIED`, `TASK_ASSIGNEE_MISMATCH`, and `DUPLICATE_TASK_ID` are rejection codes already defined by `validate-envelope.mjs`'s `reject()` helper and already present in `accept-envelope.mjs`'s `AUDITED_REJECTION_CODES` set and `statusByCode` map — reuse those exact code strings and status numbers everywhere in this plan.

---

## File structure

- **Create** `sigil/relay/v1/capability-risk-gate.mjs` — the shared capability-registry + risk-tier + approval-decision gate, extracted so both accept paths call the same logic instead of drifting independently.
- **Create** `sigil/relay/v1/capability-risk-gate.test.mjs` — unit tests for the extracted gate in isolation.
- **Modify** `sigil/relay/v1/accept-envelope.mjs` — replace the inline capability/risk-tier loop and approval-gate block with calls to the shared gate, and add gate calls to the two previously-ungated forward branches (Bypass #1).
- **Modify** `sigil/relay/v1/accept-envelope.test.mjs`, `sigil/relay/v1/accept-envelope.federation-sync.test.mjs`, `sigil/relay/v1/accept-envelope.federation-queue.test.mjs` — regression + new-behavior tests for Task 2.
- **Modify** `sigil/relay/v1/accept-federated-envelope.mjs` — call the shared gate inside the inbound-accept transaction, port the task.request/task.result assignee-binding + duplicate-task-id checks, and extend the local `statusByCode` map and the unique-constraint race translation (Bypass #2).
- **Modify** `sigil/relay/v1/accept-federated-envelope.test.mjs` — new tests for Task 3.

---

## Task 1: Extract the shared capability/risk-tier/approval gate

**Files:**
- Create: `sigil/relay/v1/capability-risk-gate.mjs`
- Test: `sigil/relay/v1/capability-risk-gate.test.mjs`

**Interfaces:**
- Consumes: `signedBytes(envelope)` and `reject(code, message, details)` from `./validate-envelope.mjs` (both already exported, unchanged signatures).
- Produces: `export async function enforceCapabilityRiskGate(envelope, repository, { client, now = new Date() } = {})` → returns `Promise<string[]>` (the list of high-risk capability names that were checked and approved), or throws a `reject()`-shaped `Error` with `.code` set to `'CAPABILITY_DENIED'` or `'APPROVAL_REQUIRED'`. Tasks 2 and 3 both call this exact function with this exact signature.

- [ ] **Step 1: Write the failing tests**

Create `sigil/relay/v1/capability-risk-gate.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signedBytes } from './validate-envelope.mjs';
import { enforceCapabilityRiskGate } from './capability-risk-gate.mjs';

function makeEnvelope(capabilities = []) {
  const keys = crypto.generateKeyPairSync('ed25519');
  const envelope = {
    protocol: 'sigil/1', message_id: 'msg_gate_1', conversation_id: 'conv_1', message_type: 'chat.message',
    sender: { endpoint_id: 'ep_codex', owner_id: 'usr_codex' }, recipient: { endpoint_id: 'ep_claude', owner_id: 'usr_claude' },
    body: { text: 'hi' }, context_refs: [], capabilities, idempotency_key: 'idem_1',
    created_at: '2026-08-30T12:00:00Z', expires_at: '2026-08-30T13:00:00Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_codex', value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  return envelope;
}

function fakeRepo({ registrations = new Map(), approvalDecisions = true } = {}) {
  const consumeCalls = [];
  const registrationCalls = [];
  return {
    consumeCalls,
    registrationCalls,
    async lookupCapabilityRegistration(capability, client) {
      registrationCalls.push({ capability, client });
      return registrations.get(capability) ?? null;
    },
    ...(approvalDecisions ? {
      async consumeApprovalDecision({ endpointId, actionHash, now, client }) {
        consumeCalls.push({ endpointId, actionHash, now, client });
        return { decision_id: 'dec_1', action_hash: actionHash, status: 'consumed' };
      },
    } : {}),
  };
}

test('no capabilities on the envelope: no repository calls, resolves with an empty list', async () => {
  const repository = fakeRepo();
  const result = await enforceCapabilityRiskGate(makeEnvelope([]), repository);
  assert.deepEqual(result, []);
  assert.equal(repository.registrationCalls.length, 0);
});

test('unregistered capability throws CAPABILITY_DENIED', async () => {
  const repository = fakeRepo({ registrations: new Map() });
  const envelope = makeEnvelope(['sigil.task/submit']);
  await assert.rejects(
    () => enforceCapabilityRiskGate(envelope, repository),
    (error) => { assert.equal(error.code, 'CAPABILITY_DENIED'); assert.equal(error.details.capability, 'sigil.task/submit'); return true; },
  );
});

test('standard-risk capability requires no approval decision', async () => {
  const repository = fakeRepo({ registrations: new Map([['sigil.task/submit', { capability: 'sigil.task/submit', risk_tier: 'standard' }]]) });
  const envelope = makeEnvelope(['sigil.task/submit']);
  const result = await enforceCapabilityRiskGate(envelope, repository);
  assert.deepEqual(result, []);
  assert.equal(repository.consumeCalls.length, 0);
});

test('high-risk capability with a consumable approval decision is approved', async () => {
  const repository = fakeRepo({ registrations: new Map([['sigil.approval/request', { capability: 'sigil.approval/request', risk_tier: 'high' }]]) });
  const envelope = makeEnvelope(['sigil.approval/request']);
  const now = new Date('2026-08-30T12:00:30Z');
  const result = await enforceCapabilityRiskGate(envelope, repository, { now, client: { id: 'client-1' } });
  assert.deepEqual(result, ['sigil.approval/request']);
  assert.equal(repository.consumeCalls.length, 1);
  assert.equal(repository.consumeCalls[0].endpointId, 'ep_codex');
  assert.equal(repository.consumeCalls[0].now, now);
  assert.deepEqual(repository.consumeCalls[0].client, { id: 'client-1' });
  assert.equal(repository.consumeCalls[0].actionHash, crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex'));
});

test('high-risk capability with no approval decision throws APPROVAL_REQUIRED', async () => {
  const repository = fakeRepo({ registrations: new Map([['sigil.approval/request', { capability: 'sigil.approval/request', risk_tier: 'high' }]]), approvalDecisions: false });
  const envelope = makeEnvelope(['sigil.approval/request']);
  await assert.rejects(
    () => enforceCapabilityRiskGate(envelope, repository),
    (error) => { assert.equal(error.code, 'APPROVAL_REQUIRED'); assert.deepEqual(error.details.capabilities, ['sigil.approval/request']); return true; },
  );
});

test('repository.consumeApprovalDecision returning null throws APPROVAL_REQUIRED', async () => {
  const repository = fakeRepo({ registrations: new Map([['sigil.approval/request', { capability: 'sigil.approval/request', risk_tier: 'high' }]]) });
  repository.consumeApprovalDecision = async () => null;
  const envelope = makeEnvelope(['sigil.approval/request']);
  await assert.rejects(() => enforceCapabilityRiskGate(envelope, repository), { code: 'APPROVAL_REQUIRED' });
});

test('no client argument: repository methods are called with undefined so their own pool default applies', async () => {
  const repository = fakeRepo({ registrations: new Map([['sigil.task/submit', { capability: 'sigil.task/submit', risk_tier: 'standard' }]]) });
  await enforceCapabilityRiskGate(makeEnvelope(['sigil.task/submit']), repository);
  assert.equal(repository.registrationCalls[0].client, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test sigil/relay/v1/capability-risk-gate.test.mjs`
Expected: FAIL — `Cannot find module './capability-risk-gate.mjs'` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `sigil/relay/v1/capability-risk-gate.mjs`:

```js
import crypto from 'node:crypto';
import { signedBytes, reject } from './validate-envelope.mjs';

// Capability-registry + risk-tier + human-approval gate (design §7/§9),
// shared by every envelope-accept entry point so a 'high' risk_tier
// capability requires a matching, unconsumed approval decision no matter
// which path an envelope takes -- local delivery, sync/queue federation
// forward (accept-envelope.mjs), or federated inbound accept
// (accept-federated-envelope.mjs). Before this extraction the gate only
// ran on the local-delivery branch, silently skipping forwarded and
// inbound-federated envelopes (the federation approval-bypass fixed by
// this plan).
//
// `client` is optional and intentionally left undefined by default: the
// two repository calls below (`lookupCapabilityRegistration`,
// `consumeApprovalDecision`) both default their own `client` parameter to
// `this.pool` when called with `undefined`, so a caller with no open
// transaction (accept-envelope.mjs's Phase 1 sync-forward path, which must
// never hold a Postgres connection open across the outbound `postForward`
// network call) gets a plain pool checkout per call instead of forcing a
// transaction into existence. A caller that already has an open
// transaction (Phase 2 local/queue-forward, or accept-federated-envelope's
// inbound transaction) MUST pass that transaction's `client` explicitly so
// the approval-decision consumption commits or rolls back atomically with
// the rest of the accept.
export async function enforceCapabilityRiskGate(envelope, repository, { client, now = new Date() } = {}) {
  const highRiskCapabilities = [];
  for (const capability of envelope.capabilities ?? []) {
    const registration = await repository.lookupCapabilityRegistration(capability, client);
    if (!registration) throw reject('CAPABILITY_DENIED', `Capability is not registered: ${capability}`, { capability });
    if (registration.risk_tier === 'high') highRiskCapabilities.push(capability);
  }
  if (highRiskCapabilities.length) {
    const canonicalHash = crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
    const consumed = repository.consumeApprovalDecision
      ? await repository.consumeApprovalDecision({ endpointId: envelope.sender.endpoint_id, actionHash: canonicalHash, now, client })
      : null;
    if (!consumed) {
      throw reject('APPROVAL_REQUIRED', 'A valid decision record is required before delivery for high-risk capabilities', { capabilities: highRiskCapabilities });
    }
  }
  return highRiskCapabilities;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test sigil/relay/v1/capability-risk-gate.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/capability-risk-gate.mjs sigil/relay/v1/capability-risk-gate.test.mjs
git commit -m "feat(sigil): extract shared capability/risk-tier/approval gate

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Wire the gate into accept-envelope.mjs's forward branches (Bypass #1)

**Files:**
- Modify: `sigil/relay/v1/accept-envelope.mjs` (Phase 1 sync-forward branch ~L150-190; Phase 2 top-of-transaction ~L220-264)
- Test: `sigil/relay/v1/accept-envelope.federation-sync.test.mjs`
- Test: `sigil/relay/v1/accept-envelope.federation-queue.test.mjs`
- Test: `sigil/relay/v1/accept-envelope.test.mjs`

**Interfaces:**
- Consumes: `enforceCapabilityRiskGate(envelope, repository, { client, now })` from Task 1 (`./capability-risk-gate.mjs`).
- Produces: no new exports — `acceptEnvelopeAsync` and `acceptEnvelope`'s existing signatures and response shapes are unchanged; only their internal gating behavior changes (forwarded envelopes with an unregistered or high-risk capability now reject instead of forwarding).

- [ ] **Step 1: Write the failing tests**

Append to `sigil/relay/v1/accept-envelope.federation-sync.test.mjs` (reuses that file's existing `makeEnvelope`, `fakeRepo`, `baseOptions` helpers):

```js
test('sync mode: an unregistered capability on a forwarded envelope is rejected with CAPABILITY_DENIED, not forwarded', async () => {
  const repository = fakeRepo();
  repository.lookupCapabilityRegistration = async () => null;
  let posted = false;
  const envelope = makeEnvelope();
  envelope.capabilities = ['sigil.task/submit'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    postForwardImpl: async () => { posted = true; return { ok: true, status: 202 }; },
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'CAPABILITY_DENIED');
  assert.equal(posted, false);
  assert.equal(repository.withTransactionCallCount, 0, 'the capability gate must not open a transaction on the sync forward path');
  assert.equal(repository.audits.at(-1).eventType, 'envelope.rejected.capability_denied');
});

test('sync mode: a high-risk capability on a forwarded envelope with no approval decision is rejected with APPROVAL_REQUIRED, not forwarded', async () => {
  const repository = fakeRepo();
  repository.lookupCapabilityRegistration = async (capability) => ({ capability, risk_tier: 'high' });
  let posted = false;
  const envelope = makeEnvelope();
  envelope.capabilities = ['sigil.approval/request'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    postForwardImpl: async () => { posted = true; return { ok: true, status: 202 }; },
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'APPROVAL_REQUIRED');
  assert.equal(posted, false);
  assert.equal(repository.withTransactionCallCount, 0, 'the approval gate must not open a transaction on the sync forward path');
});

test('sync mode: a high-risk capability on a forwarded envelope WITH a matching approval decision is forwarded', async () => {
  const repository = fakeRepo();
  repository.lookupCapabilityRegistration = async (capability) => ({ capability, risk_tier: 'high' });
  const consumeCalls = [];
  repository.consumeApprovalDecision = async (args) => { consumeCalls.push(args); return { decision_id: 'dec_1' }; };
  const envelope = makeEnvelope();
  envelope.capabilities = ['sigil.approval/request'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    postForwardImpl: async () => ({ ok: true, status: 202 }),
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.forwarded, true);
  assert.equal(consumeCalls.length, 1);
  assert.equal(consumeCalls[0].client, undefined, 'the sync forward path must consume the approval decision without an open transaction');
  assert.equal(repository.withTransactionCallCount, 0);
});
```

Append to `sigil/relay/v1/accept-envelope.federation-queue.test.mjs` (a self-contained fake-repo test, not gated on a live database):

```js
test('queue mode: an unregistered capability on a forwarded envelope is rejected with CAPABILITY_DENIED before it is enqueued', async () => {
  const enqueueCalls = [];
  const repository = {
    async withTransaction(fn) { return fn({ id: 'client-1' }); },
    async lookupAcceptedMessageId() { return null; },
    async getPeerByDomain(domain) { return domain === 'b.example' ? { domain: 'b.example', relayUrl: 'https://relay.b.example', wsUrl: null, keys: [], trustMode: 'pinned' } : null; },
    async lookupCapabilityRegistration() { return null; },
    async enqueueFederationForward(args) { enqueueCalls.push(args); return { row: { id: 'job_1' }, inserted: true }; },
    async recordAuditEvent() {},
  };
  const envelope = makeEnvelope();
  envelope.capabilities = ['sigil.task/submit'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    registered: new Map([['ep_codex@a.example', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_codex', public_key: senderKeys.publicKey }]]),
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'CAPABILITY_DENIED');
  assert.equal(enqueueCalls.length, 0, 'a rejected envelope must never be enqueued for federation forward');
});

test('queue mode: a high-risk capability on a forwarded envelope with no approval decision is rejected with APPROVAL_REQUIRED before it is enqueued', async () => {
  const enqueueCalls = [];
  const repository = {
    async withTransaction(fn) { return fn({ id: 'client-1' }); },
    async lookupAcceptedMessageId() { return null; },
    async getPeerByDomain(domain) { return domain === 'b.example' ? { domain: 'b.example', relayUrl: 'https://relay.b.example', wsUrl: null, keys: [], trustMode: 'pinned' } : null; },
    async lookupCapabilityRegistration(capability) { return { capability, risk_tier: 'high' }; },
    async enqueueFederationForward(args) { enqueueCalls.push(args); return { row: { id: 'job_1' }, inserted: true }; },
    async recordAuditEvent() {},
  };
  const envelope = makeEnvelope();
  envelope.capabilities = ['sigil.approval/request'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    registered: new Map([['ep_codex@a.example', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_codex', public_key: senderKeys.publicKey }]]),
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'APPROVAL_REQUIRED');
  assert.equal(enqueueCalls.length, 0);
});

test('queue mode: a high-risk capability WITH a matching approval decision, consumed on the transaction client, is enqueued', async () => {
  const enqueueCalls = [];
  const consumeCalls = [];
  const repository = {
    async withTransaction(fn) { return fn({ id: 'client-1' }); },
    async lookupAcceptedMessageId() { return null; },
    async getPeerByDomain(domain) { return domain === 'b.example' ? { domain: 'b.example', relayUrl: 'https://relay.b.example', wsUrl: null, keys: [], trustMode: 'pinned' } : null; },
    async lookupCapabilityRegistration(capability) { return { capability, risk_tier: 'high' }; },
    async consumeApprovalDecision(args) { consumeCalls.push(args); return { decision_id: 'dec_1' }; },
    async enqueueFederationForward(args) { enqueueCalls.push(args); return { row: { id: 'job_1' }, inserted: true }; },
    async recordAuditEvent() {},
  };
  const envelope = makeEnvelope();
  envelope.capabilities = ['sigil.approval/request'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    registered: new Map([['ep_codex@a.example', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_codex', public_key: senderKeys.publicKey }]]),
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.queued, true);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(consumeCalls.length, 1);
  assert.deepEqual(consumeCalls[0].client, { id: 'client-1' }, 'the queue-forward path must consume the approval decision on the accept transaction client');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test sigil/relay/v1/accept-envelope.federation-sync.test.mjs sigil/relay/v1/accept-envelope.federation-queue.test.mjs`
Expected: FAIL — the three sync-mode tests get `result.status === 202`/`forwarded: true` instead of the expected rejection (the gate does not run on the forward path yet), and the three queue-mode tests get `result.status === 202`/`queued: true` unconditionally.

- [ ] **Step 3: Write the implementation**

In `sigil/relay/v1/accept-envelope.mjs`, add the import at the top (after the existing `federation-router.mjs` import):

```js
import { decideRoute, buildForwardRequest, signForwardRequest, postForward } from './federation-router.mjs';
import { enforceCapabilityRiskGate } from './capability-risk-gate.mjs';
```

Replace the Phase 1 sync-forward branch's replay-check-to-forward tail (originally):

```js
      const priorMessage = await repository.lookupAcceptedMessageId(
        envelope.sender.endpoint_id, envelope.message_id, undefined
      );
      if (priorMessage && priorMessage.idempotency_key !== envelope.idempotency_key) {
        throw reject('REPLAY_DETECTED', 'message_id was already accepted under a different idempotency_key');
      }

      // client = null: forwardEnvelope passes it only to lookupRecipientEndpoint
      // (L210) for the sender-key lookup, handled by the existing `?? null`
      // guard. buildForwardRequest / signForwardRequest / postForward never
      // touch client. Queue mode is not reached here (gated above), so
      // enqueueForward's client-dependent INSERT is never called with null.
      return await forwardEnvelope(envelope, route, options, null);
```

with:

```js
      const priorMessage = await repository.lookupAcceptedMessageId(
        envelope.sender.endpoint_id, envelope.message_id, undefined
      );
      if (priorMessage && priorMessage.idempotency_key !== envelope.idempotency_key) {
        throw reject('REPLAY_DETECTED', 'message_id was already accepted under a different idempotency_key');
      }

      // Capability/risk-tier + approval gate (closes Bypass #1: a sync-forwarded
      // envelope previously skipped this check entirely, since it only ran on
      // the route.action === 'local' branch below). Called with no `client`
      // argument so lookupCapabilityRegistration/consumeApprovalDecision fall
      // through to their own pool-default client -- this path must never open
      // a transaction (I1: no held Postgres connection across postForward).
      await enforceCapabilityRiskGate(envelope, repository, { now });

      // client = null: forwardEnvelope passes it only to lookupRecipientEndpoint
      // (L210) for the sender-key lookup, handled by the existing `?? null`
      // guard. buildForwardRequest / signForwardRequest / postForward never
      // touch client. Queue mode is not reached here (gated above), so
      // enqueueForward's client-dependent INSERT is never called with null.
      return await forwardEnvelope(envelope, route, options, null);
```

In Phase 2, the transaction body currently reads (verified against the actual checked-out file — this branch's Phase 2 has a bare capability-registry loop, no risk-tier tracking, and no approval-gate block anywhere to delete):

```js
  return repository.withTransaction(async (client) => {
    // Replay check (design §6, §18 #13): must be serialised with
    // persistAcceptedEnvelope / enqueueFederationForward. A prior accepted
    // record under a *different* idempotency_key is a replay -- classified and
    // rejected immediately, skipping expiry entirely. Same idempotency_key
    // falls through to the ordinary duplicate path (lookupIdempotency below).
    const priorMessage = await repository.lookupAcceptedMessageId(envelope.sender.endpoint_id, envelope.message_id, client);
    if (priorMessage && priorMessage.idempotency_key !== envelope.idempotency_key) {
      throw reject('REPLAY_DETECTED', 'message_id was already accepted under a different idempotency_key');
    }

    // Queue-forward: enqueueForward's INSERT + audit are atomic inside this txn.
    if (route.action === 'forward') {
      if (envelope.message_type === 'session.resend_request') {
        throw reject('ROUTE_NOT_AUTHORIZED', 'Session resend requests are local-only');
      }
      return forwardEnvelope(envelope, route, options, client);
    }

    // route.action === 'local' -> fall through to recipient/capability/persist checks.
    // Every direct recipient must exist in the relay's endpoint directory
    // before any delivery row can be written. Keep this lookup on the
    // acceptance transaction's client so a concurrent endpoint change cannot
    // turn an accepted envelope into a lost dead letter. Federated addresses
    // are checked only after locality validation; non-federated addresses use
    // their exact bare endpoint id.
    if (envelope.recipient?.endpoint_id && repository.lookupRecipientEndpoint) {
      const recipientId = envelope.recipient.endpoint_id;
      const registered = (await repository.lookupRecipientEndpoint(recipientId, client)) ?? options.registered?.get(recipientId);
      if (!registered || registered.status !== 'active') {
        throw reject('RECIPIENT_NOT_FOUND', 'The recipient endpoint does not exist in this relay\'s registry.', { recipient_id: recipientId });
      }
    }

    // Capability registry fail-closed check (design §7): a capability not
    // found in the registry is rejected outright here, before target-scope
    // matching even runs -- it does NOT fall through to the
    // conversation-scope default inside validateEnvelope.
    for (const capability of envelope.capabilities ?? []) {
      const registered_ = await repository.lookupCapabilityRegistration(capability, client);
      if (!registered_) throw reject('CAPABILITY_DENIED', `Capability is not registered: ${capability}`, { capability });
    }
    const capabilityGrants = await repository.lookupActiveCapabilityGrants(envelope.sender.endpoint_id, now, client);
```

Replace it with (moves the gate before the `route.action === 'forward'` branch so both forward and local paths are gated identically, and replaces the bare capability loop with the shared gate call — there is no separate approval-gate block later in this file to delete):

```js
  return repository.withTransaction(async (client) => {
    // Replay check (design §6, §18 #13): must be serialised with
    // persistAcceptedEnvelope / enqueueFederationForward. A prior accepted
    // record under a *different* idempotency_key is a replay -- classified and
    // rejected immediately, skipping expiry entirely. Same idempotency_key
    // falls through to the ordinary duplicate path (lookupIdempotency below).
    const priorMessage = await repository.lookupAcceptedMessageId(envelope.sender.endpoint_id, envelope.message_id, client);
    if (priorMessage && priorMessage.idempotency_key !== envelope.idempotency_key) {
      throw reject('REPLAY_DETECTED', 'message_id was already accepted under a different idempotency_key');
    }

    // Capability/risk-tier + approval gate (closes Bypass #1: a
    // queue-forwarded envelope previously skipped this check entirely,
    // since it only ran further down on the route.action === 'local'
    // branch, after this function had already returned for a forward).
    // Runs before the forward/local branch so BOTH routes are gated
    // identically, on this transaction's client so approval consumption
    // commits or rolls back atomically with the rest of the accept.
    await enforceCapabilityRiskGate(envelope, repository, { client, now });

    // Queue-forward: enqueueForward's INSERT + audit are atomic inside this txn.
    if (route.action === 'forward') {
      if (envelope.message_type === 'session.resend_request') {
        throw reject('ROUTE_NOT_AUTHORIZED', 'Session resend requests are local-only');
      }
      return forwardEnvelope(envelope, route, options, client);
    }

    // route.action === 'local' -> fall through to recipient/persist checks.
    // Every direct recipient must exist in the relay's endpoint directory
    // before any delivery row can be written. Keep this lookup on the
    // acceptance transaction's client so a concurrent endpoint change cannot
    // turn an accepted envelope into a lost dead letter. Federated addresses
    // are checked only after locality validation; non-federated addresses use
    // their exact bare endpoint id.
    if (envelope.recipient?.endpoint_id && repository.lookupRecipientEndpoint) {
      const recipientId = envelope.recipient.endpoint_id;
      const registered = (await repository.lookupRecipientEndpoint(recipientId, client)) ?? options.registered?.get(recipientId);
      if (!registered || registered.status !== 'active') {
        throw reject('RECIPIENT_NOT_FOUND', 'The recipient endpoint does not exist in this relay\'s registry.', { recipient_id: recipientId });
      }
    }

    const capabilityGrants = await repository.lookupActiveCapabilityGrants(envelope.sender.endpoint_id, now, client);
```

The old bare `for (const capability of envelope.capabilities ?? []) { ... }` loop is gone — `enforceCapabilityRiskGate` performs the same registry lookups (plus risk-tier tracking and approval consumption) up front. `capabilityGrants` keeps its own separate `lookupActiveCapabilityGrants` call right after, unchanged — it's active grants, not registry entries, consumed later by `validateEnvelope`.

Do **not** touch the `task.result` block further down (`if (envelope.message_type === 'task.result') { ... }`) or add any `DUPLICATE_TASK_ID`/`TASK_ASSIGNEE_MISMATCH` logic — per the SDD preflight ruling recorded in this plan's Amendment above, task-assignee-binding restoration in `accept-envelope.mjs` is a separate, third defect outside this plan's authorized scope (Bypass #1 only), and is reported to the human partner as a follow-up rather than fixed here.

Also add `'APPROVAL_REQUIRED'` to the `AUDITED_REJECTION_CODES` set near the top of the file (currently `new Set(['CAPABILITY_DENIED', 'REPLAY_DETECTED', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'DIRECTORY_LINK_REQUIRED'])`) so a gate rejection gets the same audit-trail treatment as the other fail-closed rejection codes:

```js
const AUDITED_REJECTION_CODES = new Set(['CAPABILITY_DENIED', 'REPLAY_DETECTED', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'DIRECTORY_LINK_REQUIRED', 'APPROVAL_REQUIRED']);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test sigil/relay/v1/accept-envelope.federation-sync.test.mjs sigil/relay/v1/accept-envelope.federation-queue.test.mjs sigil/relay/v1/accept-envelope.test.mjs sigil/relay/v1/accept-envelope.resend.test.mjs sigil/relay/v1/accept-envelope.stream-sequence.test.mjs`
Expected: PASS — all new tests pass, and every pre-existing test in these five files still passes (confirms the local-delivery path's observable behavior is unchanged by the refactor).

- [ ] **Step 5: Run the full relay test suite to check for order-sensitive regressions**

Run: `node --test sigil/relay/v1/*.test.mjs`
Expected: PASS. This refactor moves the capability/risk-tier check earlier in Phase 2's local-delivery branch (now before the recipient-existence check, since it must also run before the forward branch above it). If any pre-existing test asserts `RECIPIENT_NOT_FOUND` wins over `CAPABILITY_DENIED` for an envelope that is invalid on both counts, it will fail here — if so, read that test, confirm whether the ordering assertion is load-bearing, and note the change in the commit message rather than silently reverting the fix.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/accept-envelope.federation-sync.test.mjs sigil/relay/v1/accept-envelope.federation-queue.test.mjs
git commit -m "fix(sigil): gate forwarded envelopes on capability risk-tier + approval (Bypass #1)

Both the sync-forward (Phase 1) and queue-forward (Phase 2) branches in
accept-envelope.mjs previously returned before the capability/risk-tier
lookup and consumeApprovalDecision approval gate, which only ran for
route.action === 'local'. A forwarded envelope carrying a high-risk
capability was relayed to the peer with no local approval-decision check
at all. Both forward branches now call the shared
enforceCapabilityRiskGate (extracted in the prior commit) before forwarding.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Wire the gate + task-assignee binding into accept-federated-envelope.mjs (Bypass #2)

**Files:**
- Modify: `sigil/relay/v1/accept-federated-envelope.mjs`
- Test: `sigil/relay/v1/accept-federated-envelope.test.mjs`

**Interfaces:**
- Consumes: `enforceCapabilityRiskGate(envelope, repository, { client, now })` from Task 1 (`./capability-risk-gate.mjs`); `repository.lookupTaskRequest(taskId, conversationId, client)` (already implemented by both `PostgresRepository` and `createMemoryRepository`, returns `{ message_id, recipientEndpointId }` on Postgres or `{ message_id }` on the in-memory test double — tests in this task supply their own `lookupTaskRequest` override where `recipientEndpointId` matters).
- Produces: no new exports — `acceptFederatedEnvelope`'s signature and response shape are unchanged; only its internal gating behavior changes.

- [ ] **Step 1: Write the failing tests**

Append to `sigil/relay/v1/accept-federated-envelope.test.mjs` (reuses that file's existing `makeWorld`, `senderEnvelope`, `forwardPayload`, `baseOpts` helpers):

```js
test('inbound federated envelope with an unregistered capability is rejected with CAPABILITY_DENIED', async () => {
  const world = makeWorld();
  world.repo.lookupCapabilityRegistration = async () => null;
  const { body, headers } = forwardPayload(world, { capabilities: ['sigil.task/submit'] });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'CAPABILITY_DENIED');
});

test('inbound federated envelope with a high-risk capability and no approval decision is rejected with APPROVAL_REQUIRED', async () => {
  const world = makeWorld();
  world.repo.lookupCapabilityRegistration = async (capability) => ({ capability, risk_tier: 'high' });
  const { body, headers } = forwardPayload(world, { capabilities: ['sigil.approval/request'] });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'APPROVAL_REQUIRED');
});

test('inbound federated envelope with a high-risk capability and a matching approval decision is accepted', async () => {
  const world = makeWorld();
  world.repo.lookupCapabilityRegistration = async (capability) => ({ capability, risk_tier: 'high' });
  const consumeCalls = [];
  world.repo.consumeApprovalDecision = async (args) => { consumeCalls.push(args); return { decision_id: 'dec_1' }; };
  const { body, headers } = forwardPayload(world, { capabilities: ['sigil.approval/request'] });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 202);
  assert.equal(r.body.code, 'ACCEPTED');
  assert.equal(consumeCalls.length, 1);
  assert.notEqual(consumeCalls[0].client, undefined, 'the inbound accept path must consume the approval decision on its open transaction client');
});

test('inbound federated task.request reusing an existing task_id in this conversation is rejected with DUPLICATE_TASK_ID', async () => {
  const world = makeWorld();
  world.repo.lookupTaskRequest = async () => ({ message_id: 'msg_existing', recipientEndpointId: `ep_claude@${RELAY}` });
  const { body, headers } = forwardPayload(world, { message_type: 'task.request', body: { task_id: 'task_dup', instructions: 'do it' } });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'DUPLICATE_TASK_ID');
  assert.equal(r.body.details.task_id, 'task_dup');
});

test('inbound federated task.result from an endpoint other than the task.request recipient is rejected with TASK_ASSIGNEE_MISMATCH', async () => {
  const world = makeWorld();
  world.repo.lookupTaskRequest = async () => ({ message_id: 'msg_request_1', recipientEndpointId: `ep_someone_else@${RELAY}` });
  const { body, headers } = forwardPayload(world, { message_type: 'task.result', body: { task_id: 'task_1', status: 'completed', summary: 'done' } });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'TASK_ASSIGNEE_MISMATCH');
  assert.equal(r.body.details.expected_endpoint_id, `ep_someone_else@${RELAY}`);
  assert.equal(r.body.details.actual_endpoint_id, `ep_codex@${ORIGIN}`);
});

test('inbound federated task.result from the correct task.request recipient is accepted', async () => {
  const world = makeWorld();
  world.repo.lookupTaskRequest = async () => ({ message_id: 'msg_request_1', recipientEndpointId: `ep_codex@${ORIGIN}` });
  const { body, headers } = forwardPayload(world, { message_type: 'task.result', body: { task_id: 'task_1', status: 'completed', summary: 'done' } });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 202);
  assert.equal(r.body.code, 'ACCEPTED');
});

test('inbound federated task.result referencing a task_id with no visible task.request is rejected with INVALID_ENVELOPE', async () => {
  const world = makeWorld();
  world.repo.lookupTaskRequest = async () => null;
  const { body, headers } = forwardPayload(world, { message_type: 'task.result', body: { task_id: 'task_never_sent', status: 'completed', summary: 'done' } });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_ENVELOPE');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test sigil/relay/v1/accept-federated-envelope.test.mjs`
Expected: FAIL. The capability tests get `r.status === 202` (accepted with no gate at all). The task.request/task.result tests get `r.body.code === 'INVALID_FEDERATION_REQUEST'` with `r.status === 400`, because `validateTaskRequestBody`/`validateTaskResultBody` (called inside `validateEnvelope`) reject the `{ task_id, instructions }` / `{ task_id, status, summary }` bodies used above as malformed for the current schema, OR — if those bodies happen to already validate — `DUPLICATE_TASK_ID`/`TASK_ASSIGNEE_MISMATCH` never fire because the check does not exist yet, so the requests are simply accepted (`202`). Either failure shape confirms the check is missing; if the task body shape itself needs adjusting to pass `validateTaskRequestBody`/`validateTaskResultBody`, check `sigil/contracts/v1/task-request-schema.mjs` and `task-result-schema.mjs` for the exact required fields and adjust the test bodies above accordingly before proceeding to Step 3.

- [ ] **Step 3: Write the implementation**

In `sigil/relay/v1/accept-federated-envelope.mjs`, add the import at the top:

```js
import { validateEnvelope, signedBytes, reject } from './validate-envelope.mjs';
import { resolveRateLimits, resolveRelayRequestFreshnessMs, DEFAULT_INBOX_DEPTH_LIMIT } from './relay-config.mjs';
import { enforceCapabilityRiskGate } from './capability-risk-gate.mjs';
```

Replace the block from the owner-assertion check through the recipient-existence check (originally):

```js
    const result = validateEnvelope(envelope, { now, registered: syntheticRegistered, idempotency: new Map(), relayDomain, skipSenderRegistration: true });
    // 6 (owner-assertion consistency): sender's own claim must agree.
    if (envelope.sender.owner_id !== senderOwnerId) {
      throw reject('SENDER_OWNER_ASSERTION_MISMATCH', 'envelope.sender.owner_id does not equal the relay-asserted sender_owner_id');
    }
    // 7: recipient exists and is active in the receiver's registry.
    const recipientId = envelope.recipient.endpoint_id;
    const recipient = (await repository.lookupRecipientEndpoint(recipientId, client)) ?? registered?.get(recipientId);
    // R11: both repos active-filter before returning a row, so a returned row
    // is already active; only the `registered` fallback carries a `status`
    // field that can be explicitly non-active. Reject on an explicit
    // non-active status only, never on an absent one.
    if (!recipient || (recipient.status !== undefined && recipient.status !== 'active')) {
      throw reject('RECIPIENT_NOT_FOUND', 'The recipient endpoint does not exist in this relay\'s registry.', { recipient_id: recipientId });
    }
```

with:

```js
    const result = validateEnvelope(envelope, { now, registered: syntheticRegistered, idempotency: new Map(), relayDomain, skipSenderRegistration: true });
    // 6 (owner-assertion consistency): sender's own claim must agree.
    if (envelope.sender.owner_id !== senderOwnerId) {
      throw reject('SENDER_OWNER_ASSERTION_MISMATCH', 'envelope.sender.owner_id does not equal the relay-asserted sender_owner_id');
    }
    // 6 (capability/risk-tier + approval gate, closes Bypass #2): the
    // federated inbound path previously never checked envelope.capabilities
    // against the local capability_registry at all -- a high-risk capability
    // arriving from a peer relay was delivered with no local approval-decision
    // check. Runs on this transaction's client so approval consumption commits
    // or rolls back atomically with the rest of the accept, mirroring the
    // local and queue-forward paths in accept-envelope.mjs.
    await enforceCapabilityRiskGate(envelope, repository, { client, now });
    // 7: recipient exists and is active in the receiver's registry.
    const recipientId = envelope.recipient.endpoint_id;
    const recipient = (await repository.lookupRecipientEndpoint(recipientId, client)) ?? registered?.get(recipientId);
    // R11: both repos active-filter before returning a row, so a returned row
    // is already active; only the `registered` fallback carries a `status`
    // field that can be explicitly non-active. Reject on an explicit
    // non-active status only, never on an absent one.
    if (!recipient || (recipient.status !== undefined && recipient.status !== 'active')) {
      throw reject('RECIPIENT_NOT_FOUND', 'The recipient endpoint does not exist in this relay\'s registry.', { recipient_id: recipientId });
    }
    // 7 (task-assignee binding, ported from accept-envelope.mjs Finding #1 /
    // PR #4-#5): closes the same self-addressed-task_id-reuse bypass and
    // uninvolved-conversation-member forged-result bypass on the federated
    // inbound path. A DB-level unique index
    // (024_task_request_id_uniqueness.sql) backs the DUPLICATE_TASK_ID branch
    // up against races; the 23505 translation in the .catch below mirrors
    // accept-envelope.mjs's handling of the same constraint.
    if (envelope.message_type === 'task.request') {
      const duplicate = await repository.lookupTaskRequest(envelope.body.task_id, envelope.conversation_id, client);
      if (duplicate) {
        throw reject('DUPLICATE_TASK_ID', 'task_id is already claimed by another task.request in this conversation', { task_id: envelope.body.task_id });
      }
    }
    if (envelope.message_type === 'task.result') {
      const visible = await repository.lookupTaskRequest(envelope.body.task_id, envelope.conversation_id, client);
      if (!visible) throw reject('INVALID_ENVELOPE', 'task.result references a task_id with no visible task.request', { field: 'task_id', reason: 'no visible task.request' });
      if (visible.recipientEndpointId && visible.recipientEndpointId !== envelope.sender.endpoint_id) {
        throw reject('TASK_ASSIGNEE_MISMATCH', 'task.result sender does not match the task.request recipient', {
          task_id: envelope.body.task_id, expected_endpoint_id: visible.recipientEndpointId, actual_endpoint_id: envelope.sender.endpoint_id,
        });
      }
    }
```

Extend the `.catch` block's `statusByCode` map and add the unique-constraint race translation (originally):

```js
  }).catch(async (error) => {
    // Only codes we recognise pass through as the response `code`. A raw
    // driver error (23503 / 23514 / 23502, etc.) is not a protocol enum
    // value and must never be echoed to the peer -- collapse anything
    // unrecognised to INVALID_FEDERATION_REQUEST / 400.
    const statusByCode = { RELAY_REPLAYED: 409, REPLAY_DETECTED: 409, MESSAGE_EXPIRED: 422, RECIPIENT_NOT_FOUND: 400, DIRECTORY_LINK_REQUIRED: 403, SENDER_OWNER_ASSERTION_MISMATCH: 403, RATE_LIMITED: 429, QUOTA_EXCEEDED: 429, INVALID_ENVELOPE: 400, INVALID_SIGNATURE: 401, VERSION_UNSUPPORTED: 400, CAPABILITY_DENIED: 403 };
    const known = Object.prototype.hasOwnProperty.call(statusByCode, error.code);
    const code = known ? error.code : 'INVALID_FEDERATION_REQUEST';
    const status = known ? statusByCode[error.code] : 400;
    return auditReject(status, code, known ? error.message : 'Federated envelope could not be accepted', error.details ?? {});
  });
```

with:

```js
  }).catch(async (error) => {
    // Devin review, PR #5 (ported): the app-level DUPLICATE_TASK_ID check
    // above reads via lookupTaskRequest inside this same transaction, so two
    // concurrent task.request submissions can both pass it before either
    // commits. The loser's INSERT then hits the unique index from
    // 024_task_request_id_uniqueness.sql and raises a raw Postgres 23505
    // here. Translate only that specific index's violation to the same
    // audited rejection the app-level check produces.
    if (error.code === '23505' && error.constraint === 'envelopes_task_request_lookup_idx') {
      error = reject('DUPLICATE_TASK_ID', 'task_id is already claimed by another task.request in this conversation', { task_id: envelope.body?.task_id });
    }
    // Only codes we recognise pass through as the response `code`. A raw
    // driver error (23503 / 23514 / 23502, etc.) is not a protocol enum
    // value and must never be echoed to the peer -- collapse anything
    // unrecognised to INVALID_FEDERATION_REQUEST / 400.
    const statusByCode = { RELAY_REPLAYED: 409, REPLAY_DETECTED: 409, MESSAGE_EXPIRED: 422, RECIPIENT_NOT_FOUND: 400, DIRECTORY_LINK_REQUIRED: 403, SENDER_OWNER_ASSERTION_MISMATCH: 403, RATE_LIMITED: 429, QUOTA_EXCEEDED: 429, INVALID_ENVELOPE: 400, INVALID_SIGNATURE: 401, VERSION_UNSUPPORTED: 400, CAPABILITY_DENIED: 403, APPROVAL_REQUIRED: 403, TASK_ASSIGNEE_MISMATCH: 403, DUPLICATE_TASK_ID: 409 };
    const known = Object.prototype.hasOwnProperty.call(statusByCode, error.code);
    const code = known ? error.code : 'INVALID_FEDERATION_REQUEST';
    const status = known ? statusByCode[error.code] : 400;
    return auditReject(status, code, known ? error.message : 'Federated envelope could not be accepted', error.details ?? {});
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test sigil/relay/v1/accept-federated-envelope.test.mjs`
Expected: PASS — all new tests pass, and every pre-existing test in this file still passes (`capabilities: []` in the file's existing `senderEnvelope` base means `enforceCapabilityRiskGate` is a no-op for all of them; no existing test sets `message_type` to `task.request`/`task.result`, so the new task-assignee block is inert for them too).

- [ ] **Step 5: Run the full relay test suite**

Run: `node --test sigil/relay/v1/*.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/accept-federated-envelope.mjs sigil/relay/v1/accept-federated-envelope.test.mjs
git commit -m "fix(sigil): gate federated-inbound envelopes on capability risk-tier + approval, port task-assignee binding (Bypass #2)

accept-federated-envelope.mjs never checked envelope.capabilities against
the local capability_registry, so a high-risk capability arriving from a
peer relay skipped the approval-decision gate entirely -- and never
enforced the task.request/task.result assignee binding added to
accept-envelope.mjs by Finding #1 (PR #4-#5), so an uninvolved federated
sender could fabricate a task.result for another agent's task. Both are
now enforced inside the inbound-accept transaction. The .catch's
statusByCode map gains APPROVAL_REQUIRED/TASK_ASSIGNEE_MISMATCH/
DUPLICATE_TASK_ID so these no longer collapse to a generic 400.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Bypass #1 (`accept-envelope.mjs` forward branches ungated) → Task 2, both Phase 1 (sync) and Phase 2 (queue) branches covered with dedicated tests.
- Bypass #2 (`accept-federated-envelope.mjs` fully ungated + missing task-assignee binding) → Task 3, capability/risk-tier/approval gate and task.request/task.result assignee binding both covered, plus the `statusByCode`/23505-race gaps that would otherwise silently collapse the new rejection codes to 400.
- "No new schema/migration" constraint → confirmed throughout: every repository method used (`lookupCapabilityRegistration`, `consumeApprovalDecision`, `lookupTaskRequest`, `lookupActiveCapabilityGrants`) already exists on `PostgresRepository` (verified against `sigil/relay/v1/postgres-repository.mjs`); no new table, column, or `sigil/migrations/*.sql` file is created anywhere in this plan.
- I1 (no held transaction across `postForward`) → explicitly preserved in Task 2's Phase 1 change and verified by the `withTransactionCallCount === 0` assertions carried over from the existing sync-forward tests plus the three new ones.
- DRY: the gate logic is written exactly once (Task 1) and called by all three previously-inconsistent sites (Task 2 ×2, Task 3 ×1) instead of being re-copied.

**2. Placeholder scan:** No TBD/TODO markers. Every step has literal, complete code (no "similar to Task N" — Tasks 2 and 3 each spell out their own full before/after blocks even though they call the same Task 1 function). The one deliberately open-ended note is in Task 3 Step 2, where the exact task-body schema fields are pointed at their source-of-truth schema files rather than guessed, since this plan's author did not read `task-request-schema.mjs`/`task-result-schema.mjs` in full — flagged for the executor to confirm at that step rather than silently guessing wrong field names.

**3. Type consistency:** `enforceCapabilityRiskGate(envelope, repository, { client, now })` is defined once in Task 1 and called with that exact name and argument shape in both Task 2 (twice) and Task 3 (once) — no renamed variants. `reject(code, message, details)` and `signedBytes(envelope)` are consumed with their existing `validate-envelope.mjs` signatures, unchanged. The three new rejection codes (`APPROVAL_REQUIRED`, `TASK_ASSIGNEE_MISMATCH`, `DUPLICATE_TASK_ID`) use the same string literals and status-code numbers (403, 403, 409) as `accept-envelope.mjs`'s existing `statusByCode` map, so a client sees identical behavior from either accept path.
