# Sigil FIX session layer — Plan 1 design

Status: draft for review
Date: 2026-09-08
Companion: `2026-09-08-sigil-fix-session-layer-ceo-plan.md` (scope decisions)
Builds on: `docs/specs/sigil-v1-conformance-gap-closure-design.md` section 10

## Problem

A sender and receiver in a Sigil conversation cannot tell whether messages were
lost, and cannot recover them. Section 10 of the conformance-gap design shipped
the sender-side half — delivery receipts and a session heartbeat, borrowed from
FIX — and explicitly parked the receiver-side half: sequence-numbered gap
detection and resend (FIX `MsgSeqNum` plus `ResendRequest`). This design builds
that parked work as **Plan 1**.

Sigil already has durable persistence, retry, and dead-letter in `deliveries`,
and `listInbox(since)` returns every queued delivery, so a receiver that polls
its inbox already gets a complete set. The residual gap is narrower: a receiver
consuming the stream incrementally cannot distinguish "nothing new yet" from
"I missed a push," and there is no per-sender ordering. A relay-assigned
sequence number is the direct path to both.

`business.reject` (a receiver-driven negative acknowledgement) and federated
cross-relay sequencing are **out of scope** for Plan 1 — see "Not in scope".

## Locked decisions

| Decision | Choice |
|---|---|
| Sequence scope | Per-`(sender_endpoint_id, conversation_id)` monotonic stream |
| Gap handling | Detect and request, non-blocking — the receiver keeps processing what it has |
| Sequence authority | Relay-assigned at accept, outside the sender's envelope signature |
| Federation | Single-relay only; federated inbound envelopes carry no `stream_seq` |
| Resend transport | Signed envelope for the request; fulfilment is asynchronous, off the accept transaction |
| Job queue | Generalize `federation_outbox` plus `federation-reaper` into a shared `relay_jobs` queue |
| `stream_seq` stamping | Behind a relay config flag, default off, for a bake period |
| Permanent recovery failure | Release held messages out of order with an explicit unrecoverable-gap event |

## Architecture

```
                      SENDER CONNECTOR                RECEIVER CONNECTOR
                            |                                |
                       send envelope                    read stream / inbox
                            v                                ^
        +-------------------------------------------------------------------+
        |                          RELAY                                   |
        |                                                                  |
        |  accept-envelope.mjs (transaction)                               |
        |   - validate, replay, capability, recipient checks (unchanged)   |
        |   - IF flag on AND message_type is a normal message:             |
        |       stamp stream_seq via stream_sequences upsert  ... [S2]     |
        |   - IF message_type == session.resend_request:                   |
        |       validate + enqueue relay_jobs row (job_type=resend) [S4]   |
        |       (no delivery row; no fan-out in the transaction)           |
        |   - persist envelope + deliveries (unchanged)                    |
        |                                                                  |
        |  relay_jobs queue  ... [S3]  (generalized from federation_outbox)|
        |   - federation-reaper drains job_type=federation (unchanged)     |
        |   - resend worker drains job_type=resend:                        |
        |       look up envelopes in [begin,end], re-push over requester   |
        |       stream; emit sequence_reset for aged-out ranges            |
        |                                                                  |
        |  stream-server.mjs  ... [S2]                                     |
        |   - delivered / delivery.receipt frames gain stream_seq          |
        |   - new frames: resend, sequence_reset                           |
        |                                                                  |
        |  metrics + structured logs  ... [S8]                            |
        +-------------------------------------------------------------------+
                            |                                |
                            v                                v
                   delivery.receipt                  stream-gap-tracker.mjs [S6]
                   (stream_seq echoed)               - contiguous advance
                                                     - buffer + debounced
                                                       session.resend_request
                                                     - honor sequence_reset
                                                     - reload high-water on restart
                                                     - permanent fail: release
                                                       out of order + gap event
```

New components: `stream_sequences` table, `envelopes.stream_seq` column,
`relay_jobs` table (generalized), a resend worker, `stream-gap-tracker.mjs` in
the connector, and three CLI subcommands. Everything else extends code that
already exists.

## S1 — Sequence assignment

Migration `020_stream_sequence.sql`:

```sql
CREATE TABLE IF NOT EXISTS stream_sequences (
  sender_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  conversation_id    TEXT NOT NULL REFERENCES conversations(conversation_id),
  next_seq           BIGINT NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (sender_endpoint_id, conversation_id)
);

ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS stream_seq BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS envelopes_stream_seq_idx
  ON envelopes (sender_endpoint_id, conversation_id, stream_seq)
  WHERE stream_seq IS NOT NULL;
```

Stamping happens inside `acceptWithRepository` (`sigil/relay/v1/accept-envelope.mjs`),
in the existing transaction, after every validation, replay, capability, and
recipient check passes, and before the envelope `INSERT`. It runs only when:

- the relay config flag `stream_seq.enabled` is true, and
- `message_type` is a normal conversational message — not `session.resend_request`
  and not any future session or admin type, and
- `route.action` is `local` — federated inbound envelopes
  (`accept-federated-envelope.mjs`) leave `stream_seq` NULL.

```sql
INSERT INTO stream_sequences (sender_endpoint_id, conversation_id, next_seq, updated_at)
VALUES ($sender, $conv, 2, now())
ON CONFLICT (sender_endpoint_id, conversation_id)
  DO UPDATE SET next_seq = stream_sequences.next_seq + 1, updated_at = now()
RETURNING next_seq - 1 AS assigned_seq;
```

The `ON CONFLICT` upsert row-locks a single `stream_sequences` row per
`(sender, conversation)`, so concurrent accepts from the same sender in the same
conversation serialize on that one row and nothing else. A rolled-back accept
consumes no number because the upsert is in the same transaction as the insert.

`stream_seq` is not in the sender's signed `canonical_bytes`. For Plan 1
(single-relay), the receiver trusts the one relay's numbering. The federated
integrity story is a separate later plan (see "Not in scope").

Config flag: `stream_seq.enabled` (relay config, same mechanism as the section 8
quota limits and the section 10 heartbeat constants — not hardcoded). Default
false. The rollout enables it after migration `020` is confirmed applied and the
`relay_jobs` refactor is green in staging. The flag is removed one release after
enablement.

Shadow paths:

```
INPUT: accepted local conversational envelope
  flag off        -> stream_seq stays NULL; connector treats NULL as
                     "sequencing disabled", falls back to queued_at ordering
  first in stream -> stream_sequences row created, assigned_seq = 1
  concurrent      -> row lock serializes; assigned_seq values are contiguous
  upsert deadlock -> Postgres 40P01; caller retries the accept once, then 500
  rolled-back txn -> no row change, number not consumed
```

## S2 — Exposure surfaces

`stream_seq` becomes visible to both parties:

- **Inbox listing** — `listInbox` (`sigil/relay/v1/postgres-repository.mjs`) adds
  `e.stream_seq` to its projection. NULL for pre-flag and federated envelopes.
- **`delivery.receipt` push** — `notifyReceipt` in `stream-server.mjs` adds
  `stream_seq` to the payload. The sender sees which stream position landed.
- **`delivered` stream frame** — `notify` in `stream-server.mjs` adds
  `stream_seq`, so a live receiver can gap-check without a full inbox poll.

Two new frame types on the same socket channel (`resend`, `sequence_reset`) are
defined in S4.

Payloads stay small — a status update, never a body resend — consistent with
section 10.

## S3 — Generalized `relay_jobs` queue

`federation_outbox` (migration `017`) and `federation-reaper.mjs` already
implement a claim / retry / dead-letter job loop: `pending -> processing ->
forwarded | forward_rejected | dead_letter`, with `attempt_count`,
`next_attempt_at`, and `claim_token`. Plan 1 needs the same loop for resend
fulfilment. Rather than a parallel copy, extract the loop into a shared
`relay_jobs` queue with a `job_type` discriminator.

Sequence this as two commits (make the change easy, then make the easy change):

1. **Refactor federation onto the shared queue.** Rename `federation_outbox` to
   `relay_jobs`, add `job_type TEXT NOT NULL` (existing rows get
   `'federation'`), keep the federation-specific columns nullable. Extract the
   claim / retry / dead-letter helper. `federation-reaper.mjs` drains
   `job_type = 'federation'` through the shared helper. **The full federation
   test suite must stay green — this is the critical regression gate.**
2. **Add resend as a second `job_type`.** A `resend` worker drains
   `job_type = 'resend'`.

`relay_jobs` shape after the refactor:

```
relay_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type          TEXT NOT NULL,        -- 'federation' | 'resend'
  state             TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending','processing','done',
                                       'rejected','dead_letter')),
  attempt_count     INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at        TIMESTAMPTZ,
  claim_token       UUID,
  last_reason_code  TEXT,
  payload           JSONB NOT NULL,       -- job_type-specific
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

The federation columns (`message_id`, `idempotency_key`, `recipient_domain`,
`origin_domain`, `envelope`, `sender_key`, `sender_owner_id`) either move into
`payload` or stay as nullable columns — implementation choice, as long as the
federation tests pass unchanged. A `resend` job's `payload` is
`{ requester_endpoint_id, target_sender_endpoint_id, conversation_id, begin_seq,
end_seq }`.

`done` and `rejected` are the generalized terminal names; the federation reaper
maps its old `forwarded` / `forward_rejected` semantics onto them.

## S4 — Resend flow

New envelope `message_type: session.resend_request`, signed like any envelope.
Contract schema `sigil/contracts/v1/session-resend-request-schema.mjs`, wired
into `validateEnvelope`. Body:

```json
{
  "target_sender_endpoint_id": "ep_...",
  "conversation_id": "conv_...",
  "begin_seq": 12,
  "end_seq": 15
}
```

`end_seq: 0` means "from `begin_seq` to the current high-water mark" (FIX
convention). The relay caps `end_seq - begin_seq` at a configurable maximum
(default 500); over the cap is `INVALID_ENVELOPE` with
`details: { field: "end_seq", reason: "range too wide" }`.

**Accept path (transactional, bounded):** when `message_type ==
session.resend_request`, `acceptWithRepository`:

1. Validates the body shape.
2. Checks the requester is an active `conversation_members` row for
   `conversation_id` (not `removed_at`). Otherwise `CAPABILITY_DENIED`.
3. Records the request and enqueues one `relay_jobs` row
   (`job_type = 'resend'`).
4. Emits an audit event `session.resend_request` bound to the conversation
   (migration `008` pattern).
5. Returns `202 Accepted`. It does **not** create a delivery row and does
   **not** re-push anything — no fan-out inside the transaction (this is the
   incident I1 rule: no unbounded or slow work on the accept path).

**Resend worker (asynchronous, `job_type = 'resend'`):**

1. Look up `envelopes` where `(sender_endpoint_id, conversation_id) = (target,
   conv)` and `stream_seq BETWEEN begin_seq AND effective_end`, ordered by
   `stream_seq`. Uses `envelopes_stream_seq_idx`.
2. For each surviving envelope with `expires_at > now`: push
   `{ type: "resend", stream_seq, envelope: <full canonical envelope +
   signature> }` over the requester's stream (`stream-server.mjs` client map).
   The relay never re-signs a body; the receiver re-verifies the original
   sender signature.
3. For any seq in the requested range with no surviving `envelopes` row (past
   the 24h `expires_at`, or `expires_at <= now` even if the row is not yet
   purged): collapse into one control frame
   `{ type: "sequence_reset", conversation_id, target_sender_endpoint_id,
   gap_fill_from, new_seq, reason: "expired" }`. No fabricated messages.
4. If the requester's stream socket is not open (`readyState !== 1`): the job
   re-queues with backoff, up to `attempt_count` max, then `dead_letter`. A
   first miss is not a dead-letter.
5. On completion emit audit event `session.resend_fulfilled` with the served
   and reset ranges.

Duplicate suppression: resent envelopes carry their original `message_id` and
`idempotency_key`, so the receiver's existing dedup (section 6) drops anything
already processed. This is effectively FIX `PossDupFlag`.

## S5 — Retention

Envelope durable lifetime is `expires_at`, hard-capped at `created_at + 24h`
(migration `001` CHECK). Resend serves only within that window. `sequence_reset`
covers everything older or already expired. `stream_sequences.next_seq` is never
decremented, so purging old `envelopes` rows never reopens a sequence. No
retention change in Plan 1.

## S6 — Connector gap tracker

One shared module `sigil/connectors/v1/stream-gap-tracker.mjs`, used by the CLI
and by host adapters. Storage is injected: the CLI persists the high-water mark
in the `inbox-wait.mjs` ledger; adapters inject their host store.

Per `(conversation_id, sender_endpoint_id)` the tracker keeps
`last_contiguous_seq`. On each envelope seen (inbox poll result, or a
`delivered` / `resend` stream frame):

```
seq == last_contiguous + 1   -> advance last_contiguous; deliver to app
seq >  last_contiguous + 1   -> gap:
                                 buffer this envelope (bounded, default 200)
                                 emit ONE session.resend_request for
                                   [last_contiguous + 1, seq - 1]
                                 debounce: one outstanding request per stream;
                                   retry with backoff (heartbeat-style constants
                                   from relay-config.mjs) up to a max
seq <= last_contiguous        -> duplicate / resend echo: drop
sequence_reset frame          -> record permanent loss; set
                                   last_contiguous = new_seq - 1; flush buffer
stream_seq is NULL            -> sequencing disabled (flag off / federated):
                                   deliver in queued_at order, no gap tracking
```

**Permanent recovery failure.** When the debounced resend retries exhaust, or
the buffer bound is hit, the tracker stops holding: it delivers every buffered
envelope in `stream_seq` order and emits one `unrecoverable_gap` event to the
app — `{ conversation_id, sender_endpoint_id, missing_seq_from,
missing_seq_to }`. The app is never blocked and never blind. It then advances
`last_contiguous` past the gap.

**Restart.** A fresh connector process reloads `last_contiguous_seq` from the
ledger before processing anything, so it does not re-request the whole stream.
Any single outstanding `session.resend_request` is reissued once.

Default `sigil inbox` output is contiguous-only per stream. Buffered
out-of-order envelopes are visible through `sigil inbox --gaps` (which also
prints known missing ranges) and, for adapters, an explicit option.

## S7 — CLI

- `sigil inbox` — unchanged flags; now contiguous-ordered per stream.
- `sigil inbox --gaps` — prints known missing ranges per stream.
- `sigil resend --conversation C --from N --to M --sender ep_X` — sends one
  `session.resend_request`.

`sigil session-status <conversation>` is deferred (see `TODOS.md`).

## S8 — Observability

New relay metrics (same registry as the section 8 quota metrics). The relay
cannot see a connector-side gap directly, so it uses `session.resend_request`
volume as the gap proxy; a true gap-detected counter is connector-local and out
of scope for the relay dashboard.

| Metric | Type | Meaning |
|---|---|---|
| `sigil_resend_request_total` | counter | `session.resend_request` accepted (the relay's gap proxy, labeled by conversation kind) |
| `sigil_resend_fulfilled_total` | counter | resend jobs completed |
| `sigil_resend_latency_seconds` | histogram | accept-to-last-push per resend job |
| `sigil_sequence_reset_total` | counter | permanent-loss ranges reported |
| `sigil_relay_jobs_depth` | gauge | `pending` + `processing` rows, labeled by `job_type` |
| `sigil_relay_jobs_oldest_age_seconds` | gauge | age of the oldest un-terminal job, labeled by `job_type` |

Structured log lines at: `stream_seq` assignment (debug), resend request accept
(info, with range), each resend push (debug), `sequence_reset` emission (warn,
with range and reason), resend job dead-letter (error).

Dashboard panel spec (day one): resend request rate, resend latency p50/p99,
`sequence_reset` rate (this is the "real loss" signal), `relay_jobs` depth and
oldest-age by `job_type`. An alert fires when `relay_jobs` oldest-age for
`job_type = 'resend'` crosses a threshold, or when `sequence_reset` rate
spikes.

## S9 — Deployment

1. Apply migration `020` (additive: new table, new nullable column, partial
   index — no table rewrite, no lock of consequence).
2. Apply the `relay_jobs` rename/add-column migration. `federation_outbox`
   existing rows become `job_type = 'federation'`.
3. Deploy relay code with `stream_seq.enabled = false`. Federation drains
   through the shared queue; confirm the federation suite and the live drain
   are green in staging.
4. Enable `stream_seq.enabled` in staging, then production. Watch the accept-path
   latency and the new metrics.
5. One release later, remove the flag and its dead branch.

Rollback: disable the flag (no redeploy) stops stamping immediately. Full
revert is a code revert plus `DROP COLUMN stream_seq` / `DROP TABLE
stream_sequences`; the `relay_jobs` rename is not reverted once federation rides
it (documented one-way door, reversibility 3/5).

Deploy-time risk window: old relay code writes no `stream_seq`; new code with
the flag off also writes none. Connectors treat NULL as "sequencing disabled",
so a mixed fleet is safe.

## Error and rescue registry

```
CODEPATH                          | FAILURE                    | RESCUED? | RESCUE ACTION                       | USER SEES
----------------------------------|----------------------------|----------|------------------------------------|------------------------------
accept: stream_sequences upsert   | deadlock (40P01)           | Y        | retry accept once, then surface    | 500 on the rare double-retry
accept: session.resend_request    | requester not a member     | Y        | reject CAPABILITY_DENIED           | "not authorized for this conversation"
accept: session.resend_request    | range over cap             | Y        | reject INVALID_ENVELOPE            | "resend range too wide"
relay_jobs refactor               | federation drain regression | Y (test) | CRITICAL regression test gates it  | (must not reach prod)
resend worker: envelope lookup    | none in range, all aged out| Y        | emit sequence_reset frame          | gap marker, cursor advances
resend worker: push               | requester socket closed    | Y        | re-queue with backoff; dead_letter | resend arrives on reconnect, or gap event
resend worker                     | exhausted retries          | Y        | dead_letter + metric + error log   | connector eventually emits unrecoverable_gap
connector: gap                    | resend never fills         | Y        | release out of order + gap event   | messages arrive, explicit unrecoverable_gap
connector: restart                | ledger unreadable          | Y        | start from empty; poll inbox once  | brief re-request, deduped by relay
```

No row is RESCUED=N. The one row that is audit-only rather than actively
mitigated is `sequence_reset` for a range that still exists (a relay bug) —
accepted under the single-relay trust assumption, with an audit event on every
`sequence_reset`.

## Test plan

Colocated `*.test.mjs` per existing convention, plus one case each in
`sigil/integration/vertical-slice.test.mjs`.

Sequence assignment:
1. Concurrent accepts, same `(sender, conversation)` — assigned seqs are
   contiguous `1..N`, no gaps, no duplicates.
2. Rolled-back accept (e.g. capability denied after the upsert would run) —
   consumes no number.
3. Flag off — no `stream_seq` written; connector orders by `queued_at`.
4. Federated inbound envelope — `stream_seq` stays NULL; gap tracker skips it.
5. Broadcast envelope (`recipient_endpoint_id` NULL) — gets a per-sender seq;
   two recipients in the conversation track the same sender stream.

`relay_jobs`:
6. **CRITICAL regression** — full federation suite green after the rename and
   the shared-helper extraction; live drain unchanged.
7. `resend` job enqueued, claimed, completed.
8. `resend` job: requester socket closed — job re-queues, does not dead-letter
   on first miss; dead-letters after the retry max.

Resend fulfilment:
9. Range fully within retention — envelopes re-pushed in `stream_seq` order.
10. A seq in range with no surviving envelope — `sequence_reset` frame, cursor
    advances.
11. Envelope row exists but `expires_at <= now` — treated as aged out, folded
    into `sequence_reset`.
12. Requester not an active member — `CAPABILITY_DENIED`.
13. Range over the cap — `INVALID_ENVELOPE`.
14. Resent envelope with an already-processed `message_id` — dropped, app not
    re-invoked.

Connector gap tracker:
15. `seq == last + 1` — advance.
16. `seq > last + 1` — buffer, one debounced `session.resend_request`.
17. `seq <= last` — drop.
18. `sequence_reset` frame — cursor advances, buffer flushes.
19. Restart — reloads `last_contiguous` from the ledger, does not re-request
    the whole stream; one outstanding request reissued once.
20. Buffer bound hit / retries exhausted — held messages released in order,
    one `unrecoverable_gap` event, cursor advances.

End to end (`vertical-slice.test.mjs`):
21. Drop message 3 of 5 at the connector — assert `session.resend_request` for
    `[3, 3]`, assert relay re-push, assert the app sees `1..5` contiguous.
22. Observability — assert `sigil_resend_request_total` and
    `sigil_sequence_reset_total` move on the relevant paths.

## Not in scope

- **`business.reject` NAK envelope** — Plan 2. Additive, ~3 files, shares only
  the audit pattern. Tracked in `TODOS.md`.
- **Federated `stream_seq` and a signed per-stream checkpoint** — later plan. A
  relay-assigned seq outside the sender signature has no cross-relay
  attestation. Tracked in `TODOS.md`.
- **`sigil session-status <conversation>` CLI** — deferred (P3). Tracked in
  `TODOS.md`.
- **Strict in-order blocking delivery** — rejected in brainstorming; detect and
  request only.
- **Sender-assigned seq inside the signature** — rejected in brainstorming.
- **Retention extension beyond 24h** — resend rides the existing `expires_at`
  guarantee; `sequence_reset` covers older gaps.

## What already exists (reused, not rebuilt)

| Sub-problem | Existing mechanism | This design |
|---|---|---|
| Per-recipient delivery states incl. `delivery_rejected` | migration `001` | untouched (NAK is Plan 2) |
| Sender receipt push, `stream-server.mjs` notify/notifyReceipt | shipped section 10 | payload gains `stream_seq` |
| Durable idempotent positive ack | `delivery_acknowledgements` | untouched |
| Duplicate / replay safety (PossDup) | `message_id` + `idempotency_key`, section 6 | resend dedup rides it |
| Async job queue (claim / retry / dead-letter) | `federation_outbox` + `federation-reaper` | generalized to `relay_jobs` |
| Rate quota scopes | migration `007`, `quota_usage` | `session.resend_request` counts against sender quota |
| Conversation membership + `removed_at` | migration `001` | resend auth check |
| Heartbeat interval / timeout config | `relay-config.mjs` | gap-tracker resend debounce reuses the constants |
| Config-flag pattern | section 8 quota limits | `stream_seq.enabled` |
| Audit events bound to a conversation | migration `008` | `session.resend_request`, `session.resend_fulfilled` |

## Parallelization

```
Lane A: relay_jobs refactor (commit 1) -> resend envelope + worker (S3, S4, S8-relay)
Lane B: stream_seq assignment + exposure + flag (S1, S2) -> connector gap tracker + CLI (S6, S7)
Then:  resend worker (Lane A) also depends on S1/S2 landing (needs stream_seq on the wire)
       vertical-slice E2E depends on both lanes
```

Conflict flag: S1/S2 and S3/S4 both touch `postgres-repository.mjs` — land the
S2 projection change first, rebase the resend work.
