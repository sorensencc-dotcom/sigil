# Sigil v1 Conformance Gap Closure — Design

**Date:** 2026-08-16
**Status:** Draft for review (Codex + Claude)
**Repo:** `sorensencc-dotcom/sigil`, canonical checkout `C:\dev\sigil-repo`
**Source spec:** `docs/specs/sigil-protocol-spec-v1.0.0-draft.md` §18 (v1 conformance profile)

## 1. Scope

Audit of the current implementation against the 25-item §18 conformance
profile found 15 IMPLEMENTED, and a set of gaps requiring work. This design
closes 8 of them, plus one design gap surfaced during review (workstream H,
§10) that's not a §18 item but is load-bearing for trusting any of the
others in practice:

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
| H | Sender-side delivery receipts + connector/relay heartbeat (not a §18 item — see §10) |

(Original audit listed 9 candidate gaps; #18/#24, key rotation, are already
IMPLEMENTED — confirmed by `validate-envelope.mjs:38-43` and
`validate-envelope.test.mjs:43-51` — and are excluded here.)

Out of scope: WebAuthn/OIDC/account-link code, connector host-runtime
adapters, npm packaging, and a durable/supervised relay process
(PostgreSQL-backed persistence + automatic restart/health monitoring for
`sigil relay up` itself) — real gap, surfaced by an actual incident during
this design's review cycle (in-memory relay died and lost queued state),
but it's an ops/process-supervision concern independent of the 8+1 items
here. Tracked as a separate backlog item, not this spec.

## 2. Build order

**D → F → B → A → C → E → H → G**

H is placed after E and before G: it reuses E's delivery-state
instrumentation (receipts fire off the same transitions E now audits) so
it needs E's transaction boundaries in place first; it's independent of
G (owner/display-name integrity), which stays last as the lowest-risk,
most isolated workstream.

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

**Single transaction-bound client (human review, blocker 4) —**
`FOR UPDATE` and constraint-driven serialization above are only
meaningful if every read and write inside the accept transaction runs on
the *same* database client/connection. A connection-pool repository
method that internally checks out a fresh connection per call (a real
risk in this codebase's repository pattern, where methods like
`lookupActiveCapabilityGrants`, `lookupAcceptedMessageId`, and the
envelope insert are separate calls) would silently defeat every
guarantee in this section — a `SELECT ... FOR UPDATE` on one connection
does not block a write on a different connection outside that row lock's
transaction. Requirement: `acceptEnvelopeAsync` acquires one client from
the pool (`pool.connect()` / equivalent) at the top of the transaction,
and every repository method it calls during that transaction — grant
lookup, message_id lookup, quota reservation (§8), the envelope insert
itself — takes that client as an explicit parameter and issues its
queries on it, not on the ambient pool. This is a repository-interface
change (methods that are transaction-participants take a `client` param;
methods that aren't stay pool-based) applied uniformly, not a per-call
opt-in.

**`withTransaction` helper (implementation guidance) —** rather than
each call site manually acquiring/releasing a client and remembering to
roll back on every error path, wrap the pattern once in
`sigil/relay/v1/with-transaction.mjs`:

```javascript
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

`acceptEnvelopeAsync` and every other multi-step transactional flow in
this design (rejection-audit fallback in §9, receipt emission in §10)
call `withTransaction(pool, async (client) => { ... })` rather than
open-coding connect/begin/commit/rollback/release — this is what
actually guarantees the `finally { client.release() }` runs on every
exit path, including the unexpected-error case that's easiest to leak a
connection on if hand-rolled per call site.

## 4. D — Real JCS canonicalization (do first)

Replace the hand-rolled `canonicalize()` in `validate-envelope.mjs:5-8`
and the separate one in `action-hash.mjs` with the `canonicalize` npm
package (RFC 8785), per the Tier-1-locked
`sigil-implementation-decisions-v1.0.md`.

**Pin and enforce single implementation (human review, hardening) —**
pin an exact version of `canonicalize` in `package.json` (no caret
range past the audited major/minor). Grep the full `sigil/` tree for
every hand-rolled canonicalization/JCS-shaped function before this
workstream is considered done — at minimum `validate-envelope.mjs:5-8`
and `action-hash.mjs`'s local `canonicalize()`, and any equivalent in
`sigil/contracts/v1/validate-contracts.mjs` if one exists there. Every
one of them is replaced with the same imported function; a lingering
second implementation anywhere is exactly the kind of silent drift this
workstream exists to close, so this is a completion gate, not a
suggestion.

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

**Ordering/visibility under concurrent delivery (human review,
hardening) —** "visible" for the cross-reference check means *accepted
and persisted at the relay* (exists in the transactional store as of
the lookup, per §3's transaction-bound client), not "delivered to" or
"acknowledged by" the recipient. This is deliberately the weakest bar
that's still checkable synchronously inside the accept transaction
without waiting on the recipient's delivery pipeline — a `task.result`
can be accepted the instant its `task.request` is durably accepted,
even if that request hasn't been pulled off the recipient's inbox yet.
Concurrent case: multiple `task.result`s referencing the same `task_id`
are all individually valid (each is a status update — `in_progress` then
`completed`, or a retried/corrected result) and are not deduplicated or
constrained beyond the existing per-envelope idempotency/replay rules in
§6; ordering between them for a reader is by `created_at`, not enforced
by the relay.

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

**Scoping (human review, blocker 3) —** the prior-record lookup MUST be
scoped to `(sender.endpoint_id, message_id)`, matching the unique index
from §3 exactly — never a bare `message_id` lookup. `message_id` is
generated client-side (`msg_<uuid>` per the CLI) and is not guaranteed
globally unique across unrelated endpoints; a global lookup could match
a different endpoint's unrelated message with a colliding ID and
misclassify legitimate traffic as replay. `lookupAcceptedMessageId`
takes both `senderEndpointId` and `messageId` and its query/index use
both columns together.

Enforcement: the scoped lookup happens first, inside the accept
transaction, before the expiry check —
`lookupAcceptedMessageId(senderEndpointId, messageId)` against the same
repository, on the same transaction-bound client (§3). If found with a
different `idempotency_key`, raise `REPLAY_DETECTED` immediately and
skip the expiry/duplicate checks entirely. If not found, fall through to
the existing expiry check, then the existing idempotency-key duplicate/
conflict check. The `(sender_endpoint_id, message_id)` unique index from
§3 remains as a defense-in-depth constraint (belt-and-suspenders against
a race between the lookup and the insert within the same transaction),
but the lookup itself — not a caught constraint-violation — is the
primary classification path, since the lookup must run before the
expiry check regardless.

New test: submit a validly-signed envelope, let it get accepted, then
resubmit the identical signed envelope bytes with a manually-changed
`idempotency_key` — must get `REPLAY_DETECTED`, not `DUPLICATE_MESSAGE`
and not silent acceptance as a new message. Second new test: submit an
envelope whose `expires_at` is already in the past and whose
`message_id` has never been seen before — must get `MESSAGE_EXPIRED`,
not `REPLAY_DETECTED`.

## 7. A — Capability enforcement at accept

**Capability registry, fail closed (human review, hardening) —** before
target-scope derivation runs at all, every capability named in
`envelope.capabilities` is checked against a capability registry: the
fixed `sigil.core/*` set from protocol §10 plus any extension
namespaces an administrator has explicitly registered (definitions,
scopes, risk policy — same requirement protocol §10 already states for
namespace registration, just not previously enforced in code). A
capability not found in the registry is rejected outright with
`CAPABILITY_DENIED` before scope matching — it does NOT fall through to
the "conversation scope" default below. Unregistered-namespace rejection
and unregistered-but-`sigil.core`-shaped-name rejection are the same
code path; the registry is authoritative, not just a namespace-prefix
check. New table `capability_registry(capability, namespace, risk_tier,
registered_by, registered_at)`, seeded with the `sigil.core/*` set from
§10 as part of this workstream's migration.

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

**Two different models, not one (human review, blocker 1) —** the
original design used a single rolling-window `quota_usage` counter for
all four scopes. That's correct for the first three (endpoint/owner/
conversation are genuine **rate** limits — "how many envelopes in the
last N seconds," monotonically counted per window, never decremented)
but wrong for the fourth: recipient-inbox is a **depth** limit —
"how many items are *currently* outstanding" — and depth must go down
when an item is acknowledged/processed/rejected, not just up. A rolling
counter with no decrement path would eventually latch permanently over
limit for any moderately active recipient.

- **Rate limits (endpoint/owner/conversation):** unchanged from the
  original design. New table (migration `005_rate_quota.sql`):
  `quota_usage(scope_kind, scope_id, window_start, count)` with
  `scope_kind` in `endpoint | owner | conversation`. Reservation is
  atomic: `INSERT ... ON CONFLICT (scope_kind, scope_id, window_start)
  DO UPDATE SET count = count + 1 RETURNING count`, on the transaction's
  bound client (§3), checked against the configured limit *before* the
  envelope-accept transaction commits; over limit → transaction rolls
  back (reservation never consumed) → `RATE_LIMITED`.
- **Inbox depth (recipient):** derived from delivery rows, not a
  separate counter table — `SELECT count(*) FROM deliveries WHERE
  recipient_endpoint_id = $1 AND state NOT IN ('acknowledged',
  'processed', 'delivery_rejected', 'dead_letter')`, evaluated inside
  the same accept transaction (on the same client, locked consistently
  with the delivery-row insert this envelope would create) before
  committing. Over the configured depth limit → transaction rolls back
  → `QUOTA_EXCEEDED`. Depth naturally decreases as workstream E's
  delivery-state transitions move rows into the excluded terminal
  states — no separate decrement logic to keep in sync with delivery
  state, since it's the same rows E already governs.

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

**Rejection-audit durability (Codex review round 2, point 4; refined per
human review, blocker 5) —** an audit row for a *rejected* envelope
(capability denied, replay detected, quota exceeded) cannot be written
inside the same transaction that rejects and rolls back — the audit row
would roll back with it. Rejection audits are written in a **separate,
immediately-following transaction** on a fresh client (not the rolled-
back one). That second transaction can also fail — a prior review round
left this undefined; it's resolved as an explicit two-tier fallback,
not open-ended retry:

1. Attempt the rejection-audit insert once, on a fresh transaction.
2. On failure, retry exactly once with a short fixed delay (handles a
   transient connection hiccup, not a sustained outage).
3. If the retry also fails, write the same event to a local append-only
   fallback log (a file or a lightweight outbox table with no foreign
   keys / minimal write requirements, so it can't itself fail the same
   way) and increment a metric/counter for "rejection audits degraded
   to fallback." This step is explicitly documented as **best-effort**
   — it is not further retried inline, and it does not block or fail
   the rejection response to the caller.

This is a firm, bounded contract (one retry, then a fallback path that's
allowed to be best-effort) rather than an unbounded or unspecified
retry loop — the rejection response to the sender is never delayed
waiting on audit durability past step 2.

## 10. H — Sender-side delivery receipts + heartbeat

Not a §18 item; surfaced during this design's own review cycle
(2026-08-16) when a sent message's fate was unknowable from the sender
side without a manual out-of-band check. Protocol §9 already defines
delivery states (`accepted → queued → delivered → acknowledged →
processing → processed`), but every transition past `accepted` is only
visible to the *recipient* — the relay never tells the *sender* their
message moved. Borrows three concepts from FIX (used in financial
trading for the same reliability problem) and one from chat-SDK-style
read receipts:

- **Two-stage ack (FIX order-ack → execution-report):** `sigil send`
  already gets a synchronous `202 Accepted` at send time (relay
  durably persisted it — this is the existing "sent properly"
  guarantee, unchanged). New: the relay additionally pushes a
  `delivery.receipt` notification back to the **sender's own**
  stream/inbox — not the recipient's — every time that message's
  delivery record transitions (`delivered`, `acknowledged`, `processed`,
  `processing_failed`, `dead_letter`). Reuses the existing
  `stream-server.mjs` push mechanism (`sigil/relay/v1/stream-server.mjs`),
  just adds the sender as a second notify target alongside the
  recipient, keyed off the same delivery-state transition E already
  instruments and audits.
- **Delivery/read receipts (Open Chat Widget / chat-SDK convention):**
  the receipt payload is intentionally small (`{ message_id,
  delivery_id, state, at }`) — a status update, not a resend of the
  message body — matching how chat-SDK read receipts are a lightweight
  side-channel event, not a duplicate of the original message.
- **Session heartbeat (FIX Heartbeat/TestRequest):** the connector
  (both CLI and future host adapters) sends a periodic ping to the relay
  over the existing WebSocket stream connection; if the relay misses N
  consecutive heartbeats, the connector surfaces "relay unreachable"
  locally instead of silently returning an empty inbox that's
  indistinguishable from "nothing new." This directly addresses
  tonight's incident: the relay died and restarted with no in-flight
  notification to either connector that state had been lost — a
  heartbeat timeout would have made that visible immediately instead of
  requiring a manual cross-check.

  **Defaults (approved):** heartbeat interval 15s, timeout after 3
  consecutive missed heartbeats (45s of silence). Both are
  configuration, not hardcoded, same pattern as §8's quota limits —
  these are starting defaults for local/single-host use, not tuned for
  a hosted-relay deployment.

  **Framing (implementation guidance) —** heartbeats use
  **application-level JSON frames**, not native WebSocket control
  frames (opcode `0x9`/`0xa` ping/pong): `{"type": "ping", "timestamp":
  "..."}` from connector to relay, `{"type": "pong", "timestamp":
  "..."}` in reply, over the same message channel `stream-server.mjs`
  already uses for `delivery.receipt` and inbox-notify events — not a
  separate control-frame path. Reason: browser WebSocket clients (a
  future connector target per protocol §19.1's Chat SDK/Open Chat
  Widget) don't expose raw control-frame ping/pong events to
  application code, so a JSON frame is the only framing that's
  inspectable identically on both Node.js and browser connectors.
- **CLI surface:** `sigil send --wait-for-receipt` blocks until the
  first receipt arrives (mirrors the existing `inbox --wait` pattern in
  `sigil/cli/inbox-wait.mjs`), printing `sent → delivered → acknowledged`
  progressively instead of only the initial `Sent.` line.

**Explicitly not in scope for H:** FIX-style sequence-numbered
gap-fill/resend (`MsgSeqNum` + `ResendRequest`). That's a real hardening
step for a *future* profile — detecting "I'm missing messages N..M" from
a persistent per-conversation sequence counter — but it's a bigger
change to the envelope/conversation model than this spec's scope, and
`message_id` + `idempotency_key` already give duplicate/replay safety
(§6) without it. Noted as a backlog candidate, not built here.

## 11. G — Owner / display-name integrity

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

  **Uniqueness/upsert, revocation, and viewer-key authorization (human
  review, hardening) —** `endpoint_acknowledgements` has a primary key
  of `(viewer_owner_id, acknowledged_endpoint_id)`; a repeat
  acknowledgement of the same endpoint by the same viewer is an
  `INSERT ... ON CONFLICT (viewer_owner_id, acknowledged_endpoint_id) DO
  UPDATE SET acknowledged_at = now`, not a new row and not a conflict
  error — re-acknowledging (e.g. after a key rotation, §17.1) is
  expected, ordinary usage. **Revocation:** acknowledgement means "this
  viewer has seen this endpoint's identity," not "this endpoint is
  currently trustworthy" — it is never treated as ongoing validation.
  Endpoint `status` (`active | suspended | revoked | decommissioned`,
  §6) is checked independently and live on every use, same as today; a
  revoked endpoint stays revoked regardless of any prior acknowledgement
  row, and an acknowledgement is never auto-cleared on revocation (the
  historical "I did see this identity" fact stays true even after the
  endpoint is later revoked — that's a separate, still-accurate audit
  fact). **Viewer-key authorization:** "authenticated as the viewer's
  own endpoint" above means the route's bearer-token principal's
  `owner_id` — the same authentication path every other route in
  `http-server.mjs` already uses (`createBearerAuthenticator`,
  `transport-auth.mjs`) — not a separate credential or key type; no new
  authentication mechanism is introduced for this route.

## 12. Testing summary

Each workstream: unit tests colocated per existing convention
(`*.test.mjs` next to source). Plus one addition per workstream to
`sigil/integration/vertical-slice.test.mjs` proving the specific §18
scenario end-to-end (revoked-grant denial, replay-vs-duplicate
distinction, quota rollback-on-reject, audit query returns full
lifecycle, display-name collision rejected, JCS reordered-key
signature verification, sender receipt on ack, heartbeat timeout
visibility).

**Migration idempotency (implementation guidance) —** every migration
this design adds (`005_rate_quota.sql`, `006_audit_conversation_binding.sql`,
`007_capability_registry.sql` for §7's registry table, plus the
`endpoint_acknowledgements` and `display_name` uniqueness migrations
from §11) is written idempotently — `CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` — consistent
with a repeatable-apply migration runner rather than a strictly
once-only one. Each migration's corresponding schema/behavior is tested
against **both** the live-PostgreSQL harness (`postgres-repository
.integration.test.mjs` pattern, gated on `SIGIL_TEST_DATABASE_URL` per
existing convention) **and** `memory-repository.mjs` (the in-memory
store the local CLI's `relay up` uses) — the two repository
implementations must agree on behavior (capability check, replay
lookup, quota/depth accounting, audit conversation binding) or the CLI
dev path silently diverges from the production-shaped path, which is
close to what caused tonight's actual confusion (different runtime
state between two nominally-equivalent repositories).

## 13. Open items — resolved

All four prior open items are now decided:

- **`node:crypto` vs `@noble/ed25519`:** run the §4 probe test first, as
  designed. If `node:crypto.verify(null, bytes, key, sig)` satisfies all
  signature vectors (standard Ed25519 PEM/DER), stay on `node:crypto`
  and update the decisions doc accordingly — do not add the dependency
  preemptively.
- **Rate-limit / inbox-depth defaults (§8):** approved as endpoint
  100/min, owner 500/min, conversation 200/min, recipient inbox depth
  500 outstanding (unacknowledged/undelivered) items.
- **Heartbeat defaults (§10):** approved as specified — 15s interval,
  45s (3 missed) timeout.
- **Capability registry seed (§7):** the protocol §10 seed set
  (`sigil.core/*`, `sigil.task/*`, `sigil.approval/*`) is complete for
  v1 — no additional namespaces to seed before the fail-closed check
  ships.

## 14. Round 2 review resolution (Codex, 2026-08-16)

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
(§11).

## 15. Round 3 review resolution (human, 2026-08-16)

Five blockers raised, all addressed above:

1. §8 quota model wrong for inbox depth — resolved by splitting rate
   limits (rolling-window counter, endpoint/owner/conversation) from
   inbox depth (derived live from non-terminal delivery rows,
   recipient), instead of one counter model for all four scopes (§8).
2. H heartbeat defaults unspecified / build-order-testing inconsistency
   — heartbeat defaults now concrete (15s interval, 45s/3-miss timeout,
   §10); build order (§2) and testing summary (§12) already included H
   consistently as of this revision.
3. §6 replay lookup not endpoint-scoped — resolved: lookup is now
   explicitly `(sender.endpoint_id, message_id)`, matching the §3
   unique index, never a bare `message_id` lookup (§6).
4. Transaction-bound client requirement — resolved: §3 now states every
   repository method participating in the accept transaction (grant
   lookup, message_id lookup, quota/depth check, envelope insert) must
   take and use the same client, not the ambient pool, or `FOR UPDATE`
   is meaningless (§3).
5. Rejection-audit durability underspecified — resolved with a bounded
   contract: one retry, then an explicitly best-effort fallback log,
   never blocking the rejection response (§9).

Hardening items, all addressed: capability registry + fail-closed for
unregistered capabilities (§7); acknowledgement upsert semantics,
revocation independence, and viewer-key auth path (§11); task
request/result visibility/ordering under concurrent delivery (§5); JCS
package pin + single-implementation completion gate (§4).

## 16. Round 4 — implementation guidance + open items resolved (human, 2026-08-16)

All open items decided (§13). Three pieces of implementation guidance
locked in for the executing agent:

1. **`withTransaction` helper** (§3) — standardizes connect/BEGIN/
   fn/COMMIT/ROLLBACK/release so the single-client requirement from
   blocker 4 can't be defeated by a hand-rolled call site that forgets
   to release on an error path.
2. **Heartbeat framing** (§10) — JSON application frames, not native
   WS control frames, so browser-based future connectors (§19.1) can
   inspect them identically to Node connectors.
3. **Migration idempotency + dual-repository testing** (§12) —
   `IF NOT EXISTS` throughout, every new migration's behavior verified
   against both `postgres-repository` and `memory-repository.mjs` so
   the CLI dev path and the production path can't silently diverge.

No further open items. Spec is ready for writing-plans.