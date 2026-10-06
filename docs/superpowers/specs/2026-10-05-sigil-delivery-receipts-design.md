# Sigil delivery receipts design

Status: draft for review, 2026-10-05.
Related: `docs/superpowers/specs/2026-10-05-sigil-rooms-phase-4a-relay-browser-surface-design.md` (shares the multi-socket and after-commit work), `docs/meta/sigil-host-inbox-wait-convention.md` (the wait convention this extends).

## Goal

A sender learns what happened to a message without asking, the way a text message shows delivered and read. Today it does not. On 2026-10-06 a review request to Codex sat unread after the listener recorded it, and the sender saw nothing.

## Problem

The data exists. `deliveries` stores `state`, `delivered_at`, `acknowledged_at`, `processing_at`, and `processed_at` per recipient (`sigil/migrations/001_initial.sql`). Three things are missing:

- No sender-facing read path. `lookupMessageSender` routes live frames and nothing else.
- The live `delivery.receipt` frame is fire-and-forget. `notifyReceipt` sends only if the sender has a socket at that instant, with no storage and no retry.
- `sigil send` and `sigil inbox --wait` print nothing about receipts. `inbox-wait.mjs` handles only `resend` and `sequence_reset` frames.

Rooms make it worse. One room message has one delivery per member and agent, so a receipt must name its recipient.

## Scope

In scope:

- A sender-only receipts route with a sender-facing state mapping.
- A frame that names its recipient, treated as a hint.
- `inbox --until message|receipt|any` and a reported-states cursor.
- Reconnect reconcile from a bounded sent-message ledger.
- `send --wait-receipt`.
- Multi-socket support for bearer sockets, so a waiting `inbox` and the listener stop evicting each other.
- Docs, the `sigil-consult` skill, and `relay-api.json`.

Out of scope, with the reason:

- Read receipts shown between room members. Only the sender sees receipt rows.
- A typing indicator. No phase asks for it.
- Any change to how recipients ack. The recipient protocol is unchanged.
- An explicit human-read signal. `read` means the recipient's client acked; no agent can emit anything stronger today.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Sender-facing states | Map the existing `deliveries` states | No schema change; one join on `message_id`. |
| Delivery mechanism | Authoritative pull route, push frame as a hint | The table is already the durable record. A second receipt queue would duplicate it. |
| Host wake-up | Opt-in `inbox --until`, default `message` | Existing adapters keep today's behavior. A host that wants text-message feel arms `any`. |

## States

| Sender sees | Source `deliveries.state` |
|---|---|
| `queued` | `queued` |
| `delivered` | `delivered` |
| `read` | `acknowledged`, `processing` |
| `processed` | `processed` |
| `failed` | `delivery_rejected`, `processing_failed`, `dead_letter` |

`read` means the recipient's client picked the message up and acked it. It does not prove a person or an LLM read it. `processing_failed` can still retry (`delivery-state.mjs` allows `processing_failed` to `processing`), so `failed` can be current-state rather than final. The route returns the raw state next to the mapped one.

Agent receipts can be missing. `agent-daemon.mjs` reports `processing`, `processed`, and `processing_failed` with `.catch(() => {})`, so a failed report is silently dropped and the delivery stays at `read`. A client must treat a stuck `read` as unknown, not as proof the agent is working.

## The receipts route

`GET /v1/messages/{message_id}/receipts` returns `{message_id, receipts: [{recipient_endpoint_id, state, raw_state, at}]}`, one row per `deliveries` row for the message. `at` is the timestamp that matches the state: `delivered_at`, `acknowledged_at`, `processed_at`, or `updated_at` for failures.

- **Authorization.** Only the original sender endpoint (from `lookupMessageSender`) may call it. Any other caller, and any unknown `message_id`, gets the same `404` body, so message IDs cannot be probed. This holds for every message type, including `room.event` IDs.
- **Rooms.** The sender of a room message sees every member and agent. A recipient sees nothing from this route.
- **Repositories.** The Postgres repository and the in-memory repository behind `sigil relay up` both implement `listReceiptsForMessage(messageId)`. A repository without it answers `503`, matching the existing pattern.
- **Empty and bounded.** A message with no deliveries returns `200` with an empty list. Room size bounds the row count.

## The `delivery.receipt` frame

The frame keeps its fields (`message_id`, `delivery_id`, `state`, `at`, `stream_seq`) and gains `recipient_endpoint_id` and `mapped_state`. It stays a hint. A missed frame is repaired by the route or by reconnect reconcile, never by replay.

Timing: the ack route calls `repository.acknowledgeDelivery`, which runs its own transaction and commits before the frame is sent (`postgres-repository.mjs`, `http-server.mjs`). The frame therefore does not announce an uncommitted state, and this design does not depend on the 4a after-commit queue. The plan adds a test that forces the commit to fail and asserts no frame, so the property stays true.

## Sockets

`createStreamServer` keeps one socket per endpoint, so a second connection evicts the first. The sender's `inbox --wait` and the long-running listener share one endpoint and evict each other. The 4a spec adds a multi-socket map for browser (ticket) sockets only and leaves bearer-socket behavior unchanged, so it does not fix this.

This spec therefore owns the bearer change: `clients` becomes `Map<endpoint_id, Set<socket>>`, and `notify`, `notifyReceipt`, `notifyResend`, and `notifySequenceReset` send to every open socket in the set. A closing socket removes only itself. Frame contents do not change. The risk is double handling: a resend or reset frame reaching two clients that both act on it. The plan decides per frame type whether to send to all sockets or to the most recent one, and tests each.

If this ships before 4a, the 4a spec's `browserClients` map is folded into this one set structure.

## `inbox --wait --until`

`--until message|receipt|any`. The default is `message`, so every existing adapter and the convention doc behave as today.

- `message`: receipt lines are printed as they arrive, but only a real message ends the wait. A one-shot wait shows its stdout to the host only on exit, so printed receipts surface late, together with the message. The docs say so.
- `receipt`: a receipt ends the wait and messages are ignored. In this mode the wait does not poll the inbox and does not ack. The existing 30-second fallback poll in `inbox-wait.mjs` acks what it prints, so it is disabled here, and messages stay queued and unacked.
- `any`: whichever arrives first ends the wait.

**Wake rule.** A receipt wakes the host only if its `(message_id, mapped_state)` pair has not been reported before. One room message to five members wakes the host once for `delivered`, once for `read`, and so on. Later receipts for a reported pair print but do not end the wait. A `failed` receipt always wakes.

**Reported-states cursor.** A one-shot wait exits on wake and the host re-arms a new process, so an in-process set would be lost on every re-arm and the same pair would wake the host again. The cursor is persisted in `reported-receipts.json` beside `inbox.jsonl`, keyed by `message_id` and holding the reported `mapped_state` values. It is written before the process exits and pruned to the messages in the sent ledger.

## Sent ledger and reconnect reconcile

`inbox.jsonl` records messages a listener received. No store records messages this identity sent. `sigil send` therefore appends `{message_id, sent_at}` to `sent.jsonl` beside the identity file, bounded to the most recent 50 entries.

On connect, `inbox --wait` and `--watch` call the receipts route for each message in the sent ledger and print any `(message_id, mapped_state)` pair not in the cursor. The bound keeps a long-lived identity from turning every reconnect into an unbounded burst. Reconcile requests run sequentially.

## `send --wait-receipt`

`send --wait-receipt <delivered|read|processed>` posts the message, then polls the receipts route every 500 ms for 30 seconds until every recipient is at or past the target.

- Exit `0` when all recipients reach the target, printing one line per recipient.
- Exit `2` on timeout, printing who is still behind.
- Exit `6`, new, when any recipient is `failed`. Codes 3 to 5 are taken by auth, connection, and malformed.

It polls the route and opens no socket, so it cannot evict anyone. `--wait-receipt processed` times out for any recipient that never reaches `processed`, which includes agents whose reports were swallowed. The docs recommend `read` as the default target.

## Tests

- State mapping, including `processing_failed` being current-state.
- The route returns one row per recipient with `raw_state` and `at`, against both repositories.
- A non-sender caller and an unknown `message_id` get an identical `404` body, for both `room.message` and `room.event` IDs.
- The frame carries `recipient_endpoint_id` and `mapped_state`. A forced commit failure on ack produces no frame.
- Wake rule: one wake per pair, `failed` always wakes, and `--until message` is unchanged. A regression test pins the default.
- Cursor: a re-armed wait does not re-wake on a reported pair. Kill the process mid-write and assert the cursor stays valid JSON.
- Receipt mode does not poll or ack: queue a message, run `--until receipt`, assert the delivery is still unacked.
- Room: one message to a human, two agents, and the router gives the sender four rows and a recipient none.
- Reconcile: a receipt sent while the sender is disconnected is recovered on reconnect, with no duplicate wake.
- Multi-socket: two bearer sockets on one endpoint both receive `delivered` and receipt frames, and closing one leaves the other open. Each frame type's all-sockets or latest-socket rule is pinned.
- `send --wait-receipt` exits `0`, `2`, and `6` in the right cases and opens no socket.

## Docs, skill, contracts

- Update `docs/meta/sigil-host-inbox-wait-convention.md` with `--until`, the late-surfacing limit, and the cursor file.
- State that `read` means the recipient's client acked, and that a stuck `read` for an agent can mean a swallowed report.
- Update the `sigil send` and `sigil inbox` help text.
- Update the `sigil-consult` skill to send with `--wait-receipt read`, arm the wait for the reply with `--until any`, and report the receipt. This is the failure that prompted the spec. The skill lives at `C:\dev\.claude\skills\sigil-consult`, outside this repository's tracked docs, so the plan names that location.
- Add the receipts route and the extended frame to `relay-api.json`.

## Sequencing

The multi-socket change is shared with the 4a spec. Either order works if the later spec folds in the earlier map. The plan picks the order and records it.

## Risks

- Multi-socket delivery of `resend` and `sequence_reset` frames can make two clients act on one frame. The per-frame-type rule and its tests address this.
- The cursor file is a new piece of local state. A corrupt or deleted file causes at most repeated wakes, never a missed one.
- `read` can overstate what happened. The docs and the raw state next to the mapped one limit the damage.
