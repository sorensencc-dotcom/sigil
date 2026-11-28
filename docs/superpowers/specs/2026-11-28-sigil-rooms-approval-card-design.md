# Sigil rooms: in-timeline approval card (#269)

Status: proposal, no code yet. Date: 2026-11-28.

## Problem

When an agent's message in a room needs a human's approval (a high-risk
capability hits the relay's risk gate), the web client shows a generic row
after the whole timeline: "Approval required / Waiting for {approver} / Open
approval page". It comes from a 5-second poll of `GET /v1/rooms/:id/approvals`.

That row has three gaps against the redesign plan (P1 item 1, story 11):

1. It sits at the bottom, not where the held work happened, and says nothing
   about what is being asked (which agent, which capability, how long it has).
2. Nothing tells the client when a hold appears or ends, so it lags by up to
   5 seconds and never shows an outcome. Once the challenge is approved,
   cancelled or expires, the row just disappears.
3. The fold rule for agent stretches doesn't know about holds, so a folded
   exchange can hide one (statechart invariant "a folded exchange never hides
   a hold" fails in P1).

## What stays the same

- The approval itself. The card opens the existing relay approval page and
  WebAuthn flow (Q11 option A). No in-room approve button, no second approval
  system (failure mode #4). In-room AG-UI approval stays with #255.
- Who can approve. Only the challenge's approver (the endpoint owner) gets the
  link. The route already sets `approval_url` only when
  `principal.human_id === approver_id`, with `cache-control: no-store`.
- The risk gate is the only consumer of an approval (`finalizeApprovalDecision`
  after `verifyWebAuthnApproval`).

## Proposal

### 1. Richer approvals route

`GET /v1/rooms/:id/approvals` returns, per pending challenge:

| field | source | who sees it |
|---|---|---|
| `challenge_id` | `approval_challenges.challenge_id` | room members |
| `message_id` | `approval_challenges.message_id` | room members |
| `sender_endpoint_id`, `sender_name` | envelope sender | room members |
| `capabilities` | `approval_challenges.capabilities` | room members |
| `created_at`, `expires_at` | challenge row | room members |
| `approver_name` | as today | room members |
| `approval_url` | as today | approver only |

The envelope body is not returned. Members see that something is held and for
what capability, not the held content. `listPendingRoomApprovals` already
selects most of this; it gains `message_id`, `capabilities`, `created_at`,
`expires_at` and the sender.

### 2. Live delivery of hold state (the open item in story 11)

Add `changed: 'approvals'` to the `notifyRoomHumans` frames. The relay sends
it when a room challenge is created, approved (`finalizeApprovalDecision`),
cancelled (`cancelApprovalChallenge`) or found expired. `useLive` invalidates
`['room', id, 'approvals']` on that frame.

The 5-second poll stays as a fallback but slows to 30 seconds while the socket
is live, and stays at 5 seconds while it is off.

Expiry has no event today. Two options:

- **Lazy (recommended):** the client already knows `expires_at` and hides the
  card's link at that moment, showing "Expired". The next read of the route,
  or the next notify for that room, confirms it. No new background job.
- **Reaper:** a periodic relay job marks expired challenges and notifies.
  More moving parts for a 5-minute TTL.

### 3. Signed outcome in the timeline

Add relay-signed room events so a hold leaves a record after the card goes:

- `approval_requested` (challenge created)
- `approval_granted` (decision finalized)
- `approval_cancelled` (agent or approver cancelled)
- `approval_expired` (seen expired, emitted lazily on the next read or notify
  for that room, once per challenge)

Each carries `challenge_id`, the sender's `endpoint_ids` and a short `reason`
(capability names). They go through `emitRoomEvent` in the same transaction
as the state change, so the record can't drift from the challenge row. This
adds four values to `ROOM_EVENT_KINDS` and `challenge_id` to the allowed
fields in `room-event-schema.mjs`, which is a contract change.

### 4. Where the card sits

The held envelope isn't in the timeline until it is approved and resent, so
there is no row to attach to. The card goes in the timeline in time order at
the challenge's `created_at`, not pinned after every row. When the approved
envelope lands with the same `message_id`, the message replaces the card and
the `approval_granted` event row stays.

### 5. What the card shows

- Header: "{sender} needs approval" with the `--trust-held` mark (hue 310).
- One line: capability names and "Waiting for {approver}".
- A countdown to `expires_at`.
- For the approver only: "Approve on the relay page" link (opens
  `approval_url`). Everyone else sees no link.
- After it ends: one muted line (Approved, Cancelled, Expired) from the
  signed event.

### 6. Fold rule

A stretch with a pending approval is forced open through `agentStretches`'s
existing `isForcedOpen`. If the user has folded it and a new hold arrives, it
unfolds. This satisfies "a folded exchange never hides a hold" without a
separate pinned badge.

## Tests to write first

Relay:
- approvals route returns the new fields and no envelope body; `approval_url`
  only for the approver (existing test extended).
- `changed: 'approvals'` is sent on create, finalize and cancel, to room
  humans only.
- each outcome writes exactly one signed room event in the same transaction;
  a rolled-back finalize writes none.
- an expired challenge emits `approval_expired` once, however many reads.

Schema:
- `room-event-schema` accepts the four kinds with `challenge_id` and rejects
  unknown fields.

Web:
- the card renders in time order, not at the tail.
- non-approvers see no link; the approver sees it.
- the card flips to Expired at `expires_at` without a refetch.
- an approvals frame refetches; the poll slows to 30 s while live.
- a folded stretch with a pending hold renders open.
- statechart: `RoomsPlan.tla` p1.cfg passes the fold invariant once the fold
  rule is modeled.

## Out of scope

- Approving inside the room (#255).
- Agent questions (AG-UI interrupt cards). Same card shell later, separate
  issue.
- Push notifications for the approver.

## Decision needed

Section 3 (signed outcome events) changes the room event contract. Without
it, the card still works, but a hold leaves no record in the timeline once it
ends.
