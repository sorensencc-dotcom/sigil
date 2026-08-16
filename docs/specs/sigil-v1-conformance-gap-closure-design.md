# Sigil v1 Conformance Gap Closure — Design

**Date:** 2026-08-16
**Status:** Draft for review (Codex + Claude)
**Repo:** `sorensencc-dotcom/sigil`, canonical checkout `C:\dev\sigil-repo`
**Source spec:** `docs/specs/sigil-protocol-spec-v1.0.0-draft.md` §18 (v1 conformance profile)

## 1. Scope

Audit of the current implementation against the 25-item §18 conformance
profile found 15 IMPLEMENTED, and a set of gaps requiring work. This design
closes 8 of them:

| Item | Requirement |
|---|---|
| #8 | Reject unauthorized routing / capability escalation |
| #10 | Capability grant, revocation, post-revocation denial |
| #13 | Replay detection distinct from ordinary duplicate delivery |
| #14 | Signature verification across reordered keys / alternate encodings, JCS canonical bytes |
| #19 | Audit events sufficient to replay message lifecycle |
| #21 | Task request/result body field and type validation |
| #22 | Sender owner mismatch, display-name collision, unverified endpoint presentation |
| #23 | Rate/quota limits preventing one endpoint from exhausting another's inbox |

(Original audit listed 9 candidate gaps; #18/#24, key rotation, are already
IMPLEMENTED — confirmed by `validate-envelope.mjs:38-43` and
`validate-envelope.test.mjs:43-51` — and are excluded here.)

Out of scope: WebAuthn/OIDC/account-link code, connector host-runtime
adapters, npm packaging. None of the 8 items require touching them.

## 2. Build order

**D → F → B → A → C → E → G**

Canonicalization (D) changes the bytes every signature, action hash, and
approval binding is computed over. Every other workstream either hashes
something (B, A) or asserts about hashes in tests (F). Locking D first
means later workstreams are written against final canonical bytes instead
of being re-verified twice. F (task schema) is next because B's replay
logic and A's capability logic both dispatch on `message_type`-specific
body shape, which F formalizes. Rationale for the tail: B and A both need
a transactional/async foundation (§3), so they follow F together; C reuses
A's per-endpoint accounting hooks; E instruments A/B/C's transaction
boundaries directly, so it must follow them; G is independent and lowest
risk, done last.

## 3. Cross-cutting: async + transactional boundary

`validateEnvelope` (`sigil/relay/v1/validate-envelope.mjs:24`) is
synchronous today. Workstreams A (capability grant lookup) and B (replay
/ message_id uniqueness) both need a DB read, and B additionally needs a
DB write that must not race a concurrent duplicate submission.

Decision: **`validateEnvelope` stays synchronous and stateless** (pure
function: given a snapshot of registry/grants/idempotency, decide
accept/reject — this is what makes it unit-testable without a DB). All
new state (`capabilityGrants` snapshot, `messageIdIndex` snapshot) is
loaded by the caller (`acceptEnvelopeAsync` in `accept-envelope.mjs`)
*inside* a single repository transaction, passed into `validateEnvelope`
as already-resolved maps/sets (same shape as the existing `idempotency`
param), and the resulting accept decision is persisted in that same
transaction.

**Isolation (revised per Codex review round 2):** default READ COMMITTED
does not make the above atomic on its own — a grant `SELECT` can read
committed data, a concurrent `revoke` can commit afterward, and the
envelope `INSERT` can still commit using the now-stale snapshot, because
plain reads take no lock. The transaction explicitly takes
`SELECT ... FOR UPDATE` on every `capability_grants` row it relies on to
authorize the envelope's requested capabilities, *before* deciding
accept/deny. `revokeCapabilityGrant`'s `UPDATE` on that same row acquires
the same row-level lock, so the two transactions serialize on that row
via ordinary Postgres MVCC locking: whichever started its row-lock wait
first wins, and the other blocks until it commits — a revoke either
completes before the accept transaction's lock is granted (accept then
sees `revoked` and denies) or after it commits (accept legitimately used
the grant that was still active when it acquired the lock). No
`SERIALIZABLE` isolation level or app-level version column is needed;
the explicit row lock is the guarantee.

`message_id` uniqueness (workstream B) is additionally enforced as a
**database unique constraint** on `(sender_endpoint_id, message_id)` in
the envelopes/messages table, not just an app-level lookup — the
transaction's commit is the source of truth; a racing duplicate insert
fails on the constraint and is caught and translated to
`DUPLICATE_MESSAGE`/`REPLAY_DETECTED` by the caller, not prevented by a
pre-check that can itself race.

## 4. D — Real JCS canonicalization (do first)

Replace the hand-rolled `canonicalize()` in `validate-envelope.mjs:5-8`
and the separate one in `action-hash.mjs` with the `canonicalize` npm
package (RFC 8785), per the Tier-1-locked
`sigil-implementation-decisions-v1.0.md`.

Before adding `@noble/ed25519`: write a probe test confirming whether
`node:crypto`'s `crypto.verify(null, bytes, key, sig)` (already in use at
`validate-envelope.mjs:47`) has any actual gap against the decision
doc's intent (e.g., does it support all the key formats/algorithms the
spec requires, or was `@noble/ed25519` chosen for a reason `node:crypto`
doesn't satisfy). Only add the dependency if the probe finds a real gap;
otherwise update the decisions doc to reflect `node:crypto` as the
conforming choice and record that as a decision amendment, not silent
drift.

New tests: RFC 8785 canonicalization test vectors (from the RFC or a
reference test suite) run through both `signedBytes()` and
`canonicalAction()`. A signature-verification test that takes one
envelope, re-serializes it with reordered keys AND alternate whitespace,
and confirms the signature still verifies (this is the literal §18 #14
requirement — "reordered JSON keys and alternate transport encodings").

Every existing fixture in `sigil/contracts/v1/` that embeds a
precomputed hash or signature must be regenerated against the new
canonicalizer as part of this workstream, with a test asserting fixture
hashes match freshly computed ones (catches silent fixture drift).

## 5. F — Task body schema validation

New validators, consistent with the repo's no-heavy-dependency style:
`sigil/contracts/v1/task-request-schema.mjs`,
`sigil/contracts/v1/task-result-schema.mjs`.

- `task.request` body: `task_id` and `instruction` required (strings,
  non-empty); `success_criteria`/`dependencies` if present must be
  arrays; `deadline` if present must parse as ISO 8601.
- `task.result` body: `task_id`, `status`, `summary` required; `status`
  must be one of `accepted | in_progress | completed | blocked |
  rejected | expired` (§8.3); `findings`/`artifacts`/`verification` if
  present must be arrays.
- **Cross-reference check (Codex's point 7):** a `task.result` MUST
  reference a `task_id` that corresponds to a `task.request` the relay
  has actually accepted and delivered into a conversation visible to the
  sender. This is a repository-backed check (`lookupTaskRequest(task_id,
  conversation_id)`), not a pure body-shape check — it lives in
  `accept-envelope.mjs` alongside the other repository-backed checks
  from §3, not in the schema validator itself. Missing/foreign
  `task_id` throws `INVALID_ENVELOPE` with `details: { field: 'task_id',
  reason: 'no visible task.request' }`.

Invoked from `validateEnvelope`'s caller when `message_type` is
`task.request` or `task.result` (schema part is pure/sync, inlined into
`validateEnvelope`; the cross-reference part runs in the transactional
caller per §3).

## 6. B — Replay detection

**Revised per Codex review round 2** — the original wording let
`expires_at <= now` alone trigger `REPLAY_DETECTED`, which cannot
distinguish a first-ever expired submission (never accepted, ordinary
`MESSAGE_EXPIRED`) from a genuine resurrection of a previously-accepted
envelope. The distinguishing signal is *whether `message_id` was ever
previously accepted*, not the envelope's current expiry state. Four
outcomes, precisely defined, checked in this order:

1. **First-time expired:** `message_id` has no prior accepted record,
   and `expires_at <= now` at receipt. `MESSAGE_EXPIRED` — existing
   check, unchanged (`validate-envelope.mjs:52`).
2. **Duplicate:** `(sender.endpoint_id, idempotency_key)` seen again,
   same canonical body hash. Safe retry — existing behavior, unchanged
   (`accept-envelope.mjs:42-46`).
3. **Conflicting idempotency reuse:** same `(sender.endpoint_id,
   idempotency_key)`, different canonical hash. Existing behavior,
   unchanged (`DUPLICATE_MESSAGE`, `validate-envelope.mjs:61`).
4. **Replay:** `message_id` *does* have a prior accepted record (any
   state — delivered, acknowledged, processed, expired-since-acceptance,
   whatever), and this submission uses a *different* `idempotency_key`
   than the one it was originally accepted under. This is the only
   condition that produces `REPLAY_DETECTED` — a signed envelope that
   was already live in the system, resubmitted as if new. Current
   expiry state of the resubmission is irrelevant to this classification
   (a replay of an envelope that's now also expired is still a replay,
   not `MESSAGE_EXPIRED`).

Enforcement: `message_id` lookup happens first, inside the accept
transaction, before the expiry check — `lookupAcceptedMessageId(message_id)`
against the same repository. If found with a different `idempotency_key`,
raise `REPLAY_DETECTED` immediately and skip the expiry/duplicate checks
entirely. If not found, fall through to the existing expiry check, then
the existing idempotency-key duplicate/conflict check. The
`(sender_endpoint_id, message_id)` unique index from §3 remains as a
defense-in-depth constraint (belt-and-suspenders against a race between
the lookup and the insert within the same transaction), but the lookup
itself — not a caught constraint-violation — is the primary
classification path, since the lookup must run before the expiry check
regardless.

New test: submit a validly-signed envelope, let it get accepted, then
resubmit the identical signed envelope bytes with a manually-changed
`idempotency_key` — must get `REPLAY_DETECTED`, not `DUPLICATE_MESSAGE`
and not silent acceptance as a new message. Second new test: submit an
envelope whose `expires_at` is already in the past and whose
`message_id` has never been seen before — must get `MESSAGE_EXPIRED`,
not `REPLAY_DETECTED`.

## 7. A — Capability enforcement at accept

New repository method `lookupActiveCapabilityGrants(endpointId, now)` —
returns all grants for the endpoint that are unexpired and unrevoked as
of the transaction snapshot, row-locked per §3 (`SELECT ... FOR UPDATE`).
`validateEnvelope` gains a `capabilityGrants` param (array of
`{capability, scope}`); for each capability in `envelope.capabilities`,
requires a grant whose `capability` matches and whose `scope` is an
ancestor of the **target scope**.

**Target scope derivation (Codex review round 2, point 3) —** the
envelope carries only capability *names* (strings); nothing in the wire
format states a target scope directly, so this design fixes the
derivation rule explicitly rather than leaving it implicit:

- If the capability is `sigil.core/read_shared_context`, the target
  scope is the `scope` field of each entry in `envelope.context_refs`
  (§12 already puts `scope` on every context reference) — the grant
  must cover *every* referenced scope, checked per-reference, not just
  one.
- For every other capability, the target scope is
  `scope:conversation/<conversation_id>` derived from the envelope's own
  `conversation_id` field. This covers `task.request`/`task.result`/
  `chat.message` capabilities (`sigil.task/submit`,
  `sigil.core/broadcast_message`, etc.), which act on the conversation
  they're sent into, not on a separately-declared target.

**Ancestor matcher:** scopes are `/`-delimited segment paths
(`scope:<kind>/<id>[/<kind>/<id>]...`). Grant scope `G` is an ancestor of
target scope `T` iff `T`'s segments start with all of `G`'s segments,
compared segment-by-segment (not string-prefix) — e.g.
`scope:project/proj_123` is an ancestor of
`scope:project/proj_123/thread/thread_456` but NOT of
`scope:project/proj_1234` (string-prefix would wrongly match the
latter). Extract this as a shared `isAncestorScope(grantScope,
targetScope)` helper in `sigil/relay/v1/scope.mjs`, used by both this
workstream and `context-resolver.mjs`'s existing (currently
connector-local, not relay-shared) scope check — de-duplicating rather
than reimplementing it a second time.

Missing coverage for any requested capability's target scope throws
`CAPABILITY_DENIED`.

This closes #8 (escalation rejected at accept, inside the same
transaction as persistence — no separate check that can go stale) and
#10 (a revoked grant is absent from the next transaction's snapshot by
construction, so the very next envelope after revocation is denied).

New test proving the exact #10 sequence: grant → send envelope requiring
it (succeeds) → revoke grant → resend an envelope requiring it (must
fail `CAPABILITY_DENIED`).

## 8. C — Rate / quota limits

Separate caps, not one combined number (Codex's point 4):

- **Per-endpoint** (sender): envelopes/time-window, guards one endpoint
  from being a firehose regardless of target.
- **Per-owner**: sum across all of an owner's endpoints, guards against
  spinning up endpoints to bypass per-endpoint caps.
- **Per-conversation**: guards one conversation from starving others.
- **Per-recipient inbox**: bounds a single inbox's outstanding
  undelivered/unacknowledged item count — this is the literal §18 #23
  wording ("prevents one endpoint from exhausting another endpoint's
  durable inbox") and is checked independently of the sender-side caps
  above, so a sender under its own quota can still be blocked from
  flooding a slow-draining recipient.

New table (migration `005_rate_quota.sql`): `quota_usage(scope_kind,
scope_id, window_start, count)` with `scope_kind` in `endpoint | owner |
conversation | recipient_inbox`. Reservation is atomic: `INSERT ...
ON CONFLICT (scope_kind, scope_id, window_start) DO UPDATE SET count =
count + 1 RETURNING count`, checked against the configured limit *before*
the envelope-accept transaction commits; if over limit, the transaction
rolls back (no reservation consumed) and `QUOTA_EXCEEDED` /
`RATE_LIMITED` is returned. This gives correct rollback semantics
(Codex's point 4) — a rejected envelope never consumes quota.

Limits are configuration, not hardcoded, with generous defaults
documented as "not tuned for production."

## 9. E — Audit lifecycle coverage

Move audit writes from the HTTP route layer (current pattern in
`http-server.mjs`, e.g. lines 171, 219) to the repository transaction
boundary, per Codex's point 6: every state-mutating repository method
that currently mutates-then-lets-the-route-call-`recordAuditEvent`
separately is changed to mutate-and-audit in one transaction
(`*WithAudit` variants already exist for several methods — e.g.
`createCapabilityGrantWithAudit`, `revokeOidcIdentityWithAudit` — this
workstream extends that existing pattern to `delivery-state.mjs`
transitions, which currently write no audit row at all, and to the new
capability/replay/quota rejection paths from workstreams A/B/C).

**Schema (Codex review round 2, point 4) —** `audit_events` currently
has no `conversation_id` column; several existing rows (identity/token/
grant events) legitimately have no conversation context at all. Add a
nullable `conversation_id TEXT REFERENCES conversations(conversation_id)`
column via migration `006_audit_conversation_binding.sql`, populated
whenever the audited action has one (envelope accept/reject, delivery
transitions, capability grant/revoke where the grant's scope resolves to
a conversation) and left `NULL` for account/identity-level events that
have no conversation.

New route: `GET /v1/audit?conversation_id=<id>` — returns audit events
where `conversation_id` matches, authorized against the requester's
conversation membership (reuse the membership check already used for
broadcast authorization, `validate-envelope.mjs:56`). Conversation-scoped
only in v1 (no cross-conversation or global audit query), consistent
with §10.1's conversation-authority model.

**Rejection-audit durability (Codex review round 2, point 4) —** an
audit row for a *rejected* envelope (capability denied, replay detected,
quota exceeded) cannot be written inside the same transaction that
rejects and rolls back — the audit row would roll back with it. Rejection
audits are written in a **separate, immediately-following transaction**:
the accept transaction runs, and if it throws a rejection error, the
caller (`acceptEnvelopeAsync`) catches it, opens a new short transaction
solely to insert the audit row (event type e.g.
`envelope.rejected`, reason = the rejection code), commits it
independently, and only then returns the rejection response to the
caller. This guarantees the audit trail survives regardless of the main
transaction's outcome, at the cost of the audit write not being atomic
with the rejection decision itself (acceptable: worst case is a
rejection whose audit row write itself fails and is logged to
stderr/dead-letter, not a rejection that's silently unaudited under
normal operation).

## 10. G — Owner / display-name integrity

- **Display-name collision:** normalized (case-folded, whitespace-
  trimmed) uniqueness constraint on `(owner_id, normalized_display_name)`
  enforced at the DB level (unique index + constraint violation ->
  `DISPLAY_NAME_COLLISION`, new error code added to §16's table), not an
  app-level pre-check — consistent with the transactional-integrity
  pattern used throughout this design.
- **Unverified endpoint presentation:** per Codex's point 8, this is
  explicit and viewer-relative, not a heuristic like key age. v1
  implementation: an endpoint carries a `first_contact_ack: boolean` per
  *viewer* (a small `endpoint_acknowledgements(viewer_owner_id,
  endpoint_id, acknowledged_at)` table), set only when that viewer's
  connector has shown them the full `endpoint_id`/owner/runtime/
  key-fingerprint inspection view required by §6 and they've proceeded.
  Until acknowledged by a given viewer, that viewer's connector marks the
  endpoint `unverified` in any UI-facing response.

  **Explicit mutation API (Codex review round 2, secondary point) —** a
  connector showing a UI cannot itself establish relay state by fiat; the
  acknowledgement must be a real authenticated relay mutation, not a
  client-local flag. New route: `POST /v1/endpoint-acknowledgements`,
  authenticated as the viewer's own endpoint (same bearer-token
  authentication as every other route), body `{ acknowledged_endpoint_id
  }`. The relay records `(viewer_owner_id, acknowledged_endpoint_id,
  now)` derived from the *authenticated caller's* `owner_id` — a caller
  cannot acknowledge on behalf of another owner — and writes an audit
  event (`endpoint_acknowledgement.created`) in the same transaction.
  `GET` responses that include endpoint identity (inbox listings,
  conversation membership) join against this table to set the
  `unverified` flag for the requesting viewer. This is deliberately
  per-viewer relay state, not a global "verified" flag on the endpoint
  itself, matching §6's requirement that it's the connector's job to
  make first contact visible — but the *record* that it happened lives
  in the relay, not solely in a connector-local UI state.

## 11. Testing summary

Each workstream: unit tests colocated per existing convention
(`*.test.mjs` next to source). Plus one addition per workstream to
`sigil/integration/vertical-slice.test.mjs` proving the specific §18
scenario end-to-end (revoked-grant denial, replay-vs-duplicate
distinction, quota rollback-on-reject, audit query returns full
lifecycle, display-name collision rejected, JCS reordered-key
signature verification).

## 12. Open items for reviewer

- Confirm the `node:crypto` vs `@noble/ed25519` probe result before D
  is implemented (§4) — this gates whether a new dependency is added at
  all.
- Confirm quota default limits (§8) are acceptable as "generous,
  reviewable later" rather than needing real capacity planning now.
- Confirm `endpoint_acknowledgements` (§10) is the right shape for
  per-viewer trust state, versus something simpler for v1.

## 13. Round 2 review resolution (Codex, 2026-08-16)

Four blockers raised, all addressed above:

1. §3 transaction isolation — resolved via explicit `SELECT ... FOR
   UPDATE` row locking on relied-upon `capability_grants` rows (§3),
   not `SERIALIZABLE` or a version column.
2. §6 expired-vs-replay ambiguity — resolved by making "was `message_id`
   previously accepted" the sole classifier, checked before the expiry
   comparison, not derived from `expires_at` at all (§6).
3. §7 capability target-scope — resolved with an explicit derivation
   rule (context_refs' own scope for `read_shared_context`,
   `scope:conversation/<conversation_id>` otherwise) and a shared
   segment-exact ancestor matcher (§7).
4. §9 audit conversation binding + rejection durability — resolved with
   a new nullable `conversation_id` column and a separate
   immediately-following transaction for rejection audits so they
   survive the main transaction's rollback (§9).

Secondary point (endpoint_acknowledgements needs a real authenticated
API, not connector-local UI state) — resolved with a new
`POST /v1/endpoint-acknowledgements` route, authenticated and audited
(§10).