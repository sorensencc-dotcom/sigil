# Sigil delivery receipts design

Status: draft for review, 2026-10-05 (revised after finding existing `--wait-for-receipt`; revised again 2026-10-06 after code review; Part 1 shipped in PR #26, this revision covers the open Part 2 and Part 3 items).
Related: `docs/superpowers/specs/2026-10-05-sigil-rooms-phase-4a-relay-browser-surface-design.md` (shares the multi-socket work), `docs/meta/sigil-host-inbox-wait-convention.md` (the wait convention Part 3 extends), `docs/specs/sigil-v1-conformance-gap-closure-design.md` section H (the original receipt design).

## Goal

A sender learns what happened to a message without asking, the way a text message shows delivered and read, including after the sender has disconnected and for room messages with many recipients.

## What already exists

- The relay pushes a `delivery.receipt` frame to the sender when a delivery is accepted and when it changes state (`http-server.mjs`, `stream.notifyReceipt`). Since Part 1 the accept-time frame carries `persisted.deliveryState` (`http-server.mjs:69`), which `acceptEnvelopeAsync` sets from `repository.initialDeliveryState` (`accept-envelope.mjs:438`): `queued` on Postgres, `delivered` on the in-memory repository. The in-memory repository still inserts `delivered` before the recipient polls, so there the row is wrong for the reason given under States. Ack and processing transitions send `acknowledged`, `processing`, `processed`, and so on.
- `sigil send --wait-for-receipt` (`sigil/cli/send-with-receipt.mjs`, with tests) opens the stream before sending, prints `-> <state> (<time>)` for each new state, and returns on the first terminal receipt (`acknowledged`, `processed`, `processing_failed`, `dead_letter`) or after 60 seconds.
- The `deliveries` table stores per-recipient `state` and timestamps (`001_initial.sql`).

The 2026-10-06 incident was not a missing relay feature. The listener acked the message automatically and the relay emitted the receipt. The sender never saw it because the `sigil-consult` skill sent without `--wait-for-receipt`, and `sigil send` exited before any receipt arrived. The skill now uses the flag.

## What is still missing

1. **No durable read path.** `notifyReceipt` sends only if the sender has a socket at that instant. A sender that sent without the flag, or whose wait timed out, cannot find out later.
2. **Frames do not name the recipient.** The frame carries `delivery_id` and `state` only. A room message has one delivery per recipient (see Recipient set in Part 1), so the sender cannot tell whose state changed.
3. **`--wait-for-receipt` ends on the first terminal receipt.** In a room, the first member's ack ends the wait while the others are pending. For direct messages, a timeout also returns success silently: `finish()` resolves on the 60-second timer, so the caller sees exit 0 with only `delivered` printed.
4. **Sockets evict each other.** `createStreamServer` keeps one socket per endpoint, and every frame goes only to the latest one. A new connection replaces the old socket in the map but never closes it, so the replaced socket stays open and keeps receiving pongs. `--wait-for-receipt` opens a bearer socket for the sender's endpoint, which takes frame delivery from a running `inbox --wait` or the listener on that endpoint. When the wait ends, `--wait-for-receipt` does not restore the listener: the listener only gets frames back if it reconnects on its own.
5. **Hosts cannot wake on a later receipt.** After `send` returns, nothing wakes a host session when a state changes.
6. **Room recipients are not a fixed set.** See Recipient set below.

## Scope

Part 1, the route and frame (items 1 and 2). Part 2, `--wait-for-receipt` for rooms and timeouts, plus multi-socket (items 3 and 4). Part 3, `inbox --until` (item 5). Each part is independently shippable and testable.

Out of scope, with the reason:

- Read receipts shown between room members. Only the sender sees receipt rows.
- A typing indicator. No phase asks for it.
- Any change to how recipients ack.
- An explicit human-read signal. `read` means the recipient's client acked; no agent emits anything stronger today.

## States

| Sender sees | Source `deliveries.state` |
|---|---|
| `queued` | `queued` |
| `delivered` | `delivered` |
| `read` | `acknowledged`, `processing` |
| `processed` | `processed` |
| `failed` | `delivery_rejected`, `processing_failed`, `dead_letter` |

`queued` and `delivered` stay separate. A receipt that says `delivered` before the recipient ever polled tells the sender something untrue, and telling the sender the truth is the reason receipts exist. On Postgres a delivery is inserted `queued`, and `listInbox` flips it to `delivered` when the recipient polls (`postgres-repository.mjs:389`). The rule: send a `queued` frame at accept, then send a `delivered` frame when `listInbox` flips the state. The in-memory store still writes `delivered` before the recipient polls, so on `sigil relay up` a sender sees `delivered` for a message nobody has picked up. This spec does not fix that. It leaves the fix to the plan, which decides whether the in-memory repository inserts `queued` and flips on poll, as Postgres will. Part 1 changes the accept-time frame to send the row's real state instead of the hard-coded `delivered`.

`read` means the recipient's client picked the message up and acked it. It does not prove a person or an LLM read it. `processing_failed` can retry (`delivery-state.mjs` allows `processing_failed` to `processing`), so `failed` can be current-state rather than final. The route returns the raw state next to the mapped one.

Agent receipts can be missing. `agent-daemon.mjs` reports `processing`, `processed`, and `processing_failed` with `.catch(() => {})`, so a failed report is dropped silently and the delivery stays at `read`. A stuck `read` for an agent means unknown, not working.

## Part 1: receipts route and frame

`GET /v1/messages/{message_id}/receipts` returns `{message_id, receipts: [{recipient_endpoint_id, state, raw_state, at}]}`, one row per `deliveries` row for the message, ordered by `queued_at` then `recipient_endpoint_id`. Neither repository defines an order today, so the plan adds the `ORDER BY` and sorts the in-memory result the same way.

- `at` is the timestamp that matches the state: `queued_at`, `delivered_at`, `acknowledged_at`, `processed_at`, or `updated_at` for failures. The in-memory repository inserts direct deliveries in `delivered` with no `delivered_at`, so `at` falls back to `queued_at`.
- Only the original sender endpoint (from `lookupMessageSender`) may call it. Any other caller, and any unknown `message_id`, gets the same `404` body, so message IDs cannot be probed. This holds for every message type, including `room.event` IDs.
- Forwarded federation messages return `404` to their sender. The origin relay never writes an `envelopes` row for a message it forwards, so `lookupMessageSender` finds nothing. Receipts for federated sends are out of scope; the docs say so.
- The sender of a room message sees each delivery row that exists for it (see Recipient set). A recipient sees nothing from this route.
- `listReceiptsForMessage(messageId)` does not exist in either repository. The plan adds it to the Postgres repository and to the in-memory repository behind `sigil relay up`. A repository without it answers `503`, matching the existing pattern.
- A message with no deliveries returns `200` with an empty list. Room size bounds the row count.

Recipient set. A room message does not create a delivery for every member. Deliveries go to unblocked other humans, to invoked agents, and to router members. Agents the router has queued but not yet promoted get a delivery when they are promoted, so the set of rows grows after accept. The route reports the rows that exist at call time and makes no claim that the list is complete while a room message still has queued agents. Part 2's "wait until every recipient is terminal" must account for this (see Part 2).

The `delivery.receipt` frame keeps its existing fields and gains `recipient_endpoint_id` and `mapped_state`. It stays a hint. A missed frame is repaired by the route, never by replay.

Frame per fan-out target. For a room message, the accept-time frame names a delivery ID that does not exist: the frame goes out for the message, but the rows are per recipient. Part 1 sends one frame per fan-out target, each naming that target's real `delivery_id` and `recipient_endpoint_id`. A promoted agent gets its own frame when its delivery row is created.

State-change frames on Postgres. `listInbox` runs its `UPDATE ... SET state = 'delivered'` as a single statement. The inbox route sends one `delivered` frame per flipped row after the statement returns, looking up the sender with `lookupMessageSender`. The repository returns which rows it flipped, because the route cannot tell a flipped row from one that was already `delivered`.

Frame timing: the ack route calls `repository.acknowledgeDelivery`, which runs its own transaction and commits before the frame is sent. The frame does not announce an uncommitted state, and this design does not depend on the 4a after-commit queue. The ack route sends its `delivery.receipt` frame and the 4a `room.updated` frame each in its own `try`/`catch`. A failed sender lookup after the commit then logs and does not turn an already-committed ack into a `409`. The `/processing` route has the same shape (`repository.transitionDelivery` commits, then the frame is sent) and gets the same isolation: its frame is sent after the transition and a failed lookup never changes the response. A test forces the commit to fail and asserts no frame, so the property stays true. The accept-time `delivered` frame is sent from `createOnPersisted`, inside the accept transaction (`accept-envelope.mjs` calls `onPersisted` before `COMMIT`). That frame can announce a message a failed `COMMIT` discards. Part 1 does not change it, and the route makes the discrepancy repairable. The plan decides whether to move it onto the 4a after-commit queue.

## Part 2: `--wait-for-receipt` and sockets

`--wait-for-receipt` stays a boolean flag.

- **Direct messages.** Behavior stays as today: return on the first terminal receipt. Existing tests keep passing.
- **Room messages.** `sigil send` has no room path yet, so this mode depends on adding one. The plan either adds a room destination to `sigil send` or ships room mode after a separate room-send change; it does not assume one exists. Once a room send exists, the command, after the first terminal receipt, calls the receipts route and waits until every recipient is terminal, then prints one line per recipient. The recipient list can grow while the wait runs, because queued agents get deliveries when promoted. The command therefore re-reads the route on each new receipt and on a 5-second timer, and finishes only when a read shows every row terminal and no invocation started by this message is still queued. The wait covers only agent runs whose trigger is this message: a queued run triggered by a different message does not hold it open, so a busy room cannot stall a send. The command finds those runs through `GET /v1/rooms/{room_id}/invocations`; the plan checks whether that route filters by `trigger_message_id` and adds the filter if it does not. Rows that appear mid-wait for those runs join the set.
- **Timeout.** Today a timeout resolves silently with exit `0`. The command now prints the message ID, states that the message was sent and must not be resent, lists which recipients are still behind, and exits with a dedicated code. The code must not be `2`: a timeout here happens after the relay accepted the message, and retry wrappers treat `2` as a failed send and would send a duplicate. The proposed code is `8` (`RECEIPT_TIMEOUT`), outside the `INBOX_WAIT_EXIT_CODES` range. The plan confirms `8` is free. No existing test covers the timeout path, so the plan adds one rather than updating one.
- **Failure.** Any `processing_failed` or `dead_letter` receipt exits `7`, with the same "sent, do not resend" line. The values 2 to 6, 130, and 143 are taken by `INBOX_WAIT_EXIT_CODES` (`RELAY_UNREACHABLE` is 6). `cmdSend` does no mapping of its own today: it exits `0` on success or timeout and `1` on everything else. The plan adds the mapping, and a send that was rejected before acceptance keeps exit `1`.
- `--wait-for-receipt processed` is not added. Waiting for `processed` times out for any agent whose reports were swallowed. The docs describe `read` as the practical ceiling.

Multi-socket. `--wait-for-receipt` does not restore a listener it displaced, so the multi-socket change is what stops the eviction. `clients` in `stream-server.mjs` becomes `Map<endpoint_id, Set<socket>>`, and a closing socket removes only itself. Frame contents do not change. Each frame type has one delivery rule, because two clients on one endpoint both acting on one `resend` or `sequence_reset` frame would double-handle it:

| Frame | Sockets that receive it |
|---|---|
| `delivery.receipt` | every open socket on the endpoint |
| `room.updated` (4a) | every open socket on the endpoint |
| `delivered` | the latest socket only |
| `resend` | the latest socket only |
| `sequence_reset` | the latest socket only |

Receipts and room updates are idempotent hints, so every client may see them. `delivered`, `resend`, and `sequence_reset` drive a client's inbox or sequence state, so exactly one client acts on each. The latest socket is the most recently connected socket that is still open. When it closes, the latest becomes the most recently connected socket that remains open, so a listener that connected earlier resumes receiving those frames. An endpoint with no open socket receives nothing, and `notify*` returns `false` as it does today. Today a replaced socket is never closed and keeps receiving pongs. With the set, a socket that is not the latest keeps receiving receipts and room updates until it closes, and leaves the set when it does. The plan tests each row of the table, and the close-promotes-previous case.

The 4a spec adds a multi-socket map for browser (ticket) sockets only and leaves bearer behavior unchanged, so it does not fix item 4. This spec owns the bearer change. If this ships before 4a, the 4a `browserClients` map folds into the same set structure. If 4a ships first, this part replaces its map.

## Part 3: `inbox --wait --until`

`--until message|receipt|any`. The default is `message`, so every existing adapter and the convention doc behave as today.

- `message`: receipt lines print as they arrive, but only a real message ends the wait. A one-shot wait shows its stdout to the host only on exit, so printed receipts surface late. The docs say so.
- `receipt`: a receipt ends the wait and messages are ignored. In this mode the wait skips the initial poll and the 30-second fallback poll, because `waitForOneInboxMessage` acks whatever it prints (`inbox-wait.mjs`). Messages stay queued and unacked.
- `any`: whichever arrives first ends the wait.

Wake rule. A receipt wakes the host only if its `(message_id, mapped_state)` pair has not been reported before. One room message to five members wakes the host once for `delivered`, once for `read`, and so on. Later receipts for a reported pair print but do not end the wait. A `failed` receipt always wakes.

Reported-states cursor. A one-shot wait exits on wake and the host re-arms a new process, so an in-process set is lost on every re-arm and the same pair would wake the host again. The cursor persists in `reported-receipts.json` beside `inbox.jsonl`, keyed by `message_id` and holding the reported `mapped_state` values, written before the process exits and pruned to the sent ledger.

Sent ledger and reconcile. `inbox.jsonl` records messages a listener received. No store records messages this identity sent. `sigil send` appends `{message_id, sent_at}` to `sent.jsonl` beside the identity file, bounded to the last 50 entries. On connect, `inbox --wait` and `--watch` call the receipts route for each ledger message, sequentially, and print any pair not in the cursor.

## Tests

- State mapping, including `processing_failed` being current-state, and the `at` fallback to `queued_at`.
- The route returns one row per recipient with `raw_state` and `at`, against both repositories.
- A non-sender caller and an unknown `message_id` get an identical `404` body, for `room.message` and `room.event` IDs.
- The frame carries `recipient_endpoint_id` and `mapped_state`. A forced commit failure on ack produces no frame.
- Direct `--wait-for-receipt`: the existing tests pass unchanged. New test: a timeout prints the message ID and the "do not resend" line and exits `8`, not `0` or `2`. No timeout test exists today, so this one is added.
- Room `--wait-for-receipt` (after a room send path exists): one message to a human and two agents waits for all three, a timeout names the missing recipient, and an agent promoted mid-wait joins the set before the wait finishes.
- Failure exit: a `dead_letter` receipt exits `7`, and a retry wrapper that retries only on exit `2` does not resend.
- Postgres state frames: `queued` is sent at accept and `delivered` is sent once, when `listInbox` flips the row, with none for rows already `delivered`.
- Room fan-out: one frame per target, each with a real `delivery_id`.
- Ack route: a sender lookup that throws after commit leaves the ack committed and returns success.
- Federation: a forwarded message returns `404` to its sender.
- Receipts order: rows come back by `queued_at` then `recipient_endpoint_id` from both repositories.
- Multi-socket: two bearer sockets on one endpoint both receive `delivery.receipt` frames, only the latest receives `delivered`, `resend`, and `sequence_reset`, closing the latest hands those three to the previous socket, and closing a non-latest socket changes nothing.
- Room wait scope: a queued run triggered by another message does not hold the wait open.
- Wake rule: one wake per pair, `failed` always wakes, and the default `message` mode is unchanged.
- Cursor: a re-armed wait does not re-wake on a reported pair, and a mid-write kill leaves valid JSON.
- Receipt mode does not poll or ack: queue a message, run `--until receipt`, assert the delivery is still unacked.
- Reconcile: a receipt sent while the sender is disconnected is recovered on reconnect with no duplicate wake.

## Docs, contracts

- Update `docs/meta/sigil-host-inbox-wait-convention.md` with `--until`, the late-surfacing limit, and the cursor file.
- State that `read` means the recipient's client acked, and that a stuck agent `read` can mean a swallowed report.
- Update the `sigil send` and `sigil inbox` help text.
- Add the receipts route and the extended frame to `relay-api.json`.
- The `sigil-consult` skill (`C:\dev\.claude\skills\sigil-consult\SKILL.md`, tracked in the `C:\dev` repository, not this one) already sends with `--wait-for-receipt`. After Part 2 it needs no change.

## Sequencing

Part 1 first. It is the only part with no dependency on 4a and it closes the lost-receipt gap. Part 2 follows, and its multi-socket change is shared with 4a: whichever spec ships second folds in the other's map. Part 3 is last and optional until a host needs wake-on-receipt.

## Risks

- Multi-socket delivery of `resend` and `sequence_reset` frames can make two clients act on one frame. The per-frame-type rule and its tests address this.
- Changing `--wait-for-receipt` to exit `8` on timeout and `7` on failure can break a script that relied on exit `0`. The README and docs call it out. No in-repo caller depends on it, which the plan confirms with a search.
- The cursor and sent ledger are new local state. A corrupt or deleted file causes repeated wakes at worst, never a missed one.
- `read` can overstate what happened. The docs and the raw state beside the mapped one limit the damage.
