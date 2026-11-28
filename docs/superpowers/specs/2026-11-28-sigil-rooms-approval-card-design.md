# Sigil rooms: in-timeline approval card (#269)

Status: built in two PRs, the relay part (sections 1 to 3 and 2a) and the web part (sections 2, 4 to 6). Build notes below mark where the build departs from the proposal. Date: 2026-11-28.

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
| `challenge_id` | `approval_challenges.challenge_id` | approver only |
| `message_id` | `approval_challenges.message_id` | room members |
| `sender_endpoint_id`, `sender_name` | envelope sender | room members |
| `capabilities` | `approval_challenges.capabilities` | room members |
| `created_at`, `expires_at` | challenge row | room members |
| `approver_name` | as today | room members |
| `approval_url` | as today | approver only |

The envelope body is not returned. Members see that something is held and for
what capability, not the held content. `challenge_id` goes only to the
approver, because today `GET /approve?challenge=...` renders the challenge for
anyone who holds the id. Everyone else keys the card on `message_id`, which
the approval page doesn't accept. (That page's own access rule is a separate,
existing gap and is listed under Out of scope.) `listPendingRoomApprovals` already
selects most of this; it gains `message_id`, `capabilities`, `created_at`,
`expires_at` and the sender.

### 2. Live delivery of hold state (the open item in story 11)

Add `changed: 'approvals'` to the `notifyRoomHumans` frames. The relay sends
it when a room challenge is created, approved (`finalizeApprovalDecision`),
cancelled (`cancelApprovalChallenge`) or expired (section 2a). `'approvals'` is
added to the `RoomUpdatedFrame.changed` union, and `useLive` gets its own
branch that invalidates `['room', id, 'approvals']`. Today any unknown value
falls through to the messages branch, which would leave the card stale.

The 5-second poll stays as a fallback but slows to 30 seconds while the socket
is live, and stays at 5 seconds while it is off.

### 2a. Expiry

Expiry has no event today. The client flips the card to "Expired" at
`expires_at` on its own, so the screen is right without a round trip. The
relay record comes from a small sweep, in the style of the existing reapers:
each pass locks due rows (`status = 'pending' AND expires_at <= now`,
`FOR UPDATE SKIP LOCKED`), moves each to the `expired` status, writes its
outcome event and notifies, all in one transaction.

*Build note (relay PR):* `expired` was already an allowed status in
`approval_challenges`, so no migration. The sweep takes one row per
transaction, so a room whose emit fails is rolled back and retried on the
next pass without blocking other rooms. It runs every 30 seconds. The status change is the
once-only marker, so two passes can't both emit for one challenge.

A lazy emit on the next read was the first idea, and it fails: an idle room
never gets that read, and `listPendingRoomApprovals` already filters expired
rows out, so the record would often never be written.

### 3. Signed outcome in the timeline

Decided 2026-11-28: included.

Add relay-signed room events so a hold leaves a record after the card goes:

- `approval_requested` (challenge created)
- `approval_granted` (decision finalized)
- `approval_cancelled` (agent or approver cancelled)
- `approval_expired` (written by the sweep in 2a)

Each carries `held_message_id` (the held envelope's `message_id`), the
sender's `endpoint_ids` and a short `reason` (capability names).

*Build note (relay PR):* the first draft had these events carry
`challenge_id`. Room events reach every member, and section 1 keeps the
challenge id to the approver because of #338, so the events name the held
message instead, and the event's idempotency key uses a hash of the
challenge id rather than the id itself (the key is part of the signed
envelope). The client joins the event to the approvals item on
`message_id`, which it already uses. They go through `emitRoomEvent` in the same transaction
as the state change, so the record can't drift from the challenge row. Today
`createApprovalChallenge`, `finalizeApprovalDecision` and
`cancelApprovalChallenge` each open and commit their own transaction, so they
change to take an `onChange(client, challenge)` hook that runs before commit.
A failed emit rolls the state change back.

`emitRoomEvent` gives every event a 24-hour `expires_at`. These four keep
it.

*Build note (relay PR):* the first draft gave these events the room's
message retention instead. The relay has no such setting: room envelopes
stay in the timeline whatever their `expires_at`, which only bounds
delivery, and client-sent room messages also use 24 hours. So the record
lasts as long as any other room row without a per-kind TTL.

This adds four values to `ROOM_EVENT_KINDS` and `held_message_id` to the
allowed fields in `room-event-schema.mjs` (required on these four kinds and
refused on the others), which is a contract change.

### 4. Where the card sits

The held envelope isn't in the timeline until it is approved and resent, so
there is no row to attach to. The `approval_requested` event is that row: it
has a `room_seq` like any message, and the client renders it as the card
while the challenge is pending, not as a separate event row, so the hold shows
once. After it ends, the same row shows the outcome line.

*Build note (web PR):* the outcome event is folded into the request's row
and not drawn again. An outcome whose request is older than the loaded
history still shows, on its own row. A pending hold with no request event in
the loaded history (history not loaded that far, or a relay that predates
these events) still shows after the timeline, as the old row did, so no hold
is ever invisible. A hold that has just left the approvals list keeps the
last item seen for it until its outcome event loads, so the countdown can
still flip to Expired.

The approved message lands at its own, later `room_seq`. The client does not
move it back to the hold's position, because the timeline's order is the
signed order. The outcome row says "Approved" and links to the message.

### 5. What the card shows

- Header: "{sender} needs approval" with the `--trust-held` mark (hue 310).
- One line: capability names and "Waiting for {approver}".
- A countdown to `expires_at`.
- For the approver only: "Approve on the relay page" link (opens
  `approval_url`). Everyone else sees no link.
- After it ends: one muted line (Approved, Cancelled, Expired) from the
  signed event.

*Build note (web PR):* the outcome line reads "{sender}'s held message:
Approved" (or Cancelled, Expired), and an approved one links to the
message by its anchor. The link reads "Approve on the relay page (opens in
a new tab)".

### 6. Fold rule

`groupAgentStretches` calls `isForcedOpen` only for agent rows in a stretch's
body, and the held message is never one of them. So the grouping gets a
second input, the pending approvals, and a stretch is forced open when either
its range of rows contains a pending card (section 4), or the hold's sender
has a stretch that ends at or after the hold's `created_at`. The check covers
event rows and trailing rows, not just the body. If the user has folded a
stretch and a new hold arrives, it unfolds. This satisfies "a folded exchange
never hides a hold" without a separate pinned badge.

*Build note (web PR):* the second input is an `isHeld(runIds)` option that
gets every row id in the run, trailing event rows included. An open stretch
shows the existing fold notice, "Agent exchange shown in full: an approval
is pending". In `RoomsPlan.tla` the hold arriving now sets the fold open,
which is what makes `HoldNeverHidden` hold in p1.

## Tests to write first

Relay:
- approvals route returns the new fields and no envelope body;
  `approval_url` and `challenge_id` only for the approver (existing test
  extended).
- `changed: 'approvals'` is sent on create, finalize and cancel, to room
  humans only.
- each outcome writes exactly one signed room event in the same transaction;
  a rolled-back finalize writes none, and a failed emit rolls the finalize
  back.
- two concurrent sweep passes emit `approval_expired` once for one challenge;
  an idle room still gets it.
- outcome events name the held message, never the challenge id, in the
  body or the idempotency key.

Schema:
- `room-event-schema` accepts the four kinds with `held_message_id` and
  rejects unknown fields.

Web:
- the card renders in time order, not at the tail.
- non-approvers see no link; the approver sees it.
- the card flips to Expired at `expires_at` without a refetch.
- an approvals frame refetches the approvals query, not only messages; the
  poll slows to 30 s while live.
- a pending `approval_requested` event renders once, as the card.
- a folded stretch with a pending hold renders open, including when the card
  sits after the stretch's body.
- statechart: `RoomsPlan.tla` p1.cfg passes the fold invariant once the fold
  rule is modeled.

## Out of scope

- Approving inside the room (#255).
- Agent questions (AG-UI interrupt cards). Same card shell later, separate
  issue.
- Push notifications for the approver.
- Who can open `GET /approve?challenge=...`. It renders the challenge for any
  holder of the id today. This design avoids handing the id out, but the page
  itself should check the viewer; worth its own issue.

## Decisions

- 2026-11-28, Chris: add the signed hold events (section 3), accepting the
  room event contract change and the change to the three approval repository
  methods.
