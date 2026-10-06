# Sigil delivery receipts design

Status: draft for review, 2026-10-05 (revised after finding existing `--wait-for-receipt`).
Related: `docs/superpowers/specs/2026-10-05-sigil-rooms-phase-4a-relay-browser-surface-design.md` (shares the multi-socket work), `docs/meta/sigil-host-inbox-wait-convention.md` (the wait convention Part 3 extends), `docs/specs/sigil-v1-conformance-gap-closure-design.md` section H (the original receipt design).

## Goal

A sender learns what happened to a message without asking, the way a text message shows delivered and read, including after the sender has disconnected and for room messages with many recipients.

## What already exists

- The relay pushes a `delivery.receipt` frame to the sender when a delivery is accepted and when it changes state (`http-server.mjs`, `stream.notifyReceipt`). The accept-time frame has state `delivered`. Ack and processing transitions send `acknowledged`, `processing`, `processed`, and so on.
- `sigil send --wait-for-receipt` (`sigil/cli/send-with-receipt.mjs`, with tests) opens the stream before sending, prints `-> <state> (<time>)` for each new state, and returns on the first terminal receipt (`acknowledged`, `processed`, `processing_failed`, `dead_letter`) or after 60 seconds.
- The `deliveries` table stores per-recipient `state` and timestamps (`001_initial.sql`).

The 2026-10-06 incident was not a missing relay feature. The listener acked the message automatically and the relay emitted the receipt. The sender never saw it because the `sigil-consult` skill sent without `--wait-for-receipt`, and `sigil send` exited before any receipt arrived. The skill now uses the flag.

## What is still missing

1. **No durable read path.** `notifyReceipt` sends only if the sender has a socket at that instant. A sender that sent without the flag, or whose wait timed out, cannot find out later.
2. **Frames do not name the recipient.** The frame carries `delivery_id` and `state` only. A room message has one delivery per member and agent, so the sender cannot tell whose state changed.
3. **`--wait-for-receipt` ends on the first terminal receipt.** In a room, the first member's ack ends the wait while the others are pending. For direct messages, a timeout also returns success silently: `finish()` resolves on the 60-second timer, so the caller sees exit 0 with only `delivered` printed.
4. **Sockets evict each other.** `createStreamServer` keeps one socket per endpoint. `--wait-for-receipt` opens a bearer socket for the sender's endpoint, which evicts a running `inbox --wait` or the listener on that endpoint, and their reconnects evict it back.
5. **Hosts cannot wake on a later receipt.** After `send` returns, nothing wakes a host session when a state changes.

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

`read` means the recipient's client picked the message up and acked it. It does not prove a person or an LLM read it. `processing_failed` can retry (`delivery-state.mjs` allows `processing_failed` to `processing`), so `failed` can be current-state rather than final. The route returns the raw state next to the mapped one.

Agent receipts can be missing. `agent-daemon.mjs` reports `processing`, `processed`, and `processing_failed` with `.catch(() => {})`, so a failed report is dropped silently and the delivery stays at `read`. A stuck `read` for an agent means unknown, not working.

## Part 1: receipts route and frame

`GET /v1/messages/{message_id}/receipts` returns `{message_id, receipts: [{recipient_endpoint_id, state, raw_state, at}]}`, one row per `deliveries` row for the message.

- `at` is the timestamp that matches the state: `delivered_at`, `acknowledged_at`, `processed_at`, or `updated_at` for failures. Direct deliveries are inserted in `delivered` with no `delivered_at` (the in-memory repository also does this), so `at` falls back to `queued_at`.
- Only the original sender endpoint (from `lookupMessageSender`) may call it. Any other caller, and any unknown `message_id`, gets the same `404` body, so message IDs cannot be probed. This holds for every message type, including `room.event` IDs.
- The sender of a room message sees every member and agent. A recipient sees nothing from this route.
- The Postgres repository and the in-memory repository behind `sigil relay up` both implement `listReceiptsForMessage(messageId)`. A repository without it answers `503`, matching the existing pattern.
- A message with no deliveries returns `200` with an empty list. Room size bounds the row count.

The `delivery.receipt` frame keeps its existing fields and gains `recipient_endpoint_id` and `mapped_state`. It stays a hint. A missed frame is repaired by the route, never by replay.

Frame timing: the ack route calls `repository.acknowledgeDelivery`, which runs its own transaction and commits before the frame is sent. The frame does not announce an uncommitted state, and this design does not depend on the 4a after-commit queue. A test forces the commit to fail and asserts no frame, so the property stays true. The accept-time `delivered` frame is sent from `createOnPersisted`, inside the accept transaction (`accept-envelope.mjs` calls `onPersisted` before `COMMIT`). That frame can announce a message a failed `COMMIT` discards. Part 1 does not change it, and the route makes the discrepancy repairable. The plan decides whether to move it onto the 4a after-commit queue.

## Part 2: `--wait-for-receipt` and sockets

`--wait-for-receipt` stays a boolean flag.

- **Direct messages.** Behavior stays as today: return on the first terminal receipt. Existing tests keep passing.
- **Room messages.** After the first terminal receipt, the command calls the receipts route to learn the recipient list and waits until every recipient is terminal, then prints one line per recipient.
- **Timeout.** Today a timeout resolves silently. The command now prints which recipients are still behind and exits `2`, matching `inbox --wait` timeouts. This changes existing behavior, so the existing timeout test is updated deliberately.
- **Failure.** Any `processing_failed` or `dead_letter` receipt exits `7`. The values 2 to 6, 130, and 143 are taken by `INBOX_WAIT_EXIT_CODES` (`RELAY_UNREACHABLE` is 6). The plan checks how `cmdSend` maps errors to exit codes before choosing the mapping.
- `--wait-for-receipt processed` is not added. Waiting for `processed` times out for any agent whose reports were swallowed. The docs describe `read` as the practical ceiling.

Multi-socket. `clients` in `stream-server.mjs` becomes `Map<endpoint_id, Set<socket>>`, and `notify`, `notifyReceipt`, `notifyResend`, and `notifySequenceReset` send to every open socket. A closing socket removes only itself. Frame contents do not change. The risk is double handling: two clients on one endpoint both acting on one `resend` or `sequence_reset` frame. The plan decides per frame type whether to send to all sockets or to the most recent one, and tests each.

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
- Direct `--wait-for-receipt`: the existing tests pass unchanged except the timeout case, which now expects exit `2`.
- Room `--wait-for-receipt`: one message to a human and two agents waits for all three, and a timeout names the missing recipient.
- Failure exit: a `dead_letter` receipt exits `7`.
- Multi-socket: two bearer sockets on one endpoint both receive receipt frames, closing one leaves the other open, and the per-frame-type rule is pinned.
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
- Changing `--wait-for-receipt` to exit `2` on timeout and `7` on failure can break a script that relied on exit `0`. The README and docs call it out. No in-repo caller depends on it, which the plan confirms with a search.
- The cursor and sent ledger are new local state. A corrupt or deleted file causes repeated wakes at worst, never a missed one.
- `read` can overstate what happened. The docs and the raw state beside the mapped one limit the damage.
