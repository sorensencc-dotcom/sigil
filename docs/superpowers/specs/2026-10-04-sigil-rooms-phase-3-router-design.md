# Sigil rooms phase 3: router design

Status: draft for review, 2026-10-04.
Parent spec: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` (Router section and delivery phase 3).
Builds on: phase 2 (`feat/sigil-rooms-phase-2`, PR #19), which creates invocations for explicit @mentions inside the accept transaction.

## Goal

When a human posts a room message that mentions no agent, a local LLM picks which agent, if any, answers. Every routing outcome, including refusals and failures, appears in the room as a `room.event`.

## Scope

In scope:

- A router daemon, started with `sigil agent run --router`.
- The `room.event` message type, emitted by the relay.
- The `POST /v1/rooms/{room_id}/invocations` route.
- Router delivery rules in the relay.
- Router failure handling.

Out of scope, with the reason:

- `task.request` and `task.result` assignee binding. They stay refused in rooms. The parent spec's phase 3 list does not include them.
- The daily room cost budget. No delivery phase owns it yet.
- Streaming progress events. The parent spec marks them v2.
- The web client (phase 4).

## Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | The router is a separate daemon with its own endpoint identity and calls the relay over HTTP. | An Ollama call takes seconds and cannot run inside the accept transaction. The relay stays independent of Ollama. The router holds no more authority than its token grants. |
| D2 | The router is a room member with `response_mode = 'router'` and receives deliveries through the existing queue. | Reuses delivery, ack, and retry. Mentioned messages never reach it, so no LLM call happens for them. |
| D3 | Only human messages without mentions trigger the router. Agent replies never do. | Agents still hand off with an explicit @mention (phase 2). This removes untrusted agent text as a routing trigger and cuts LLM calls. It narrows the parent spec, which also routes agent messages that pass the loop guard. Add that later if rooms need it. |
| D4 | The relay emits every `room.event` under a relay system identity. | The event commits atomically with the decision and cannot be forged by a client. It also closes the phase 2 limit that refusals are visible only through `GET /v1/rooms/{id}/invocations`. |

## Relay changes

### Migration 030

- Adds the `room.event` message type and its body schema.
- Allows `response_mode = 'router'` on `conversation_members`.
- Adds a relay system endpoint (`ep_relay_system`) that signs `room.event` envelopes. It cannot receive deliveries and cannot be a room member.
- Adds a unique index on `room_invocations (trigger_message_id) WHERE decided_by = 'router'`, so a retried router decision cannot create a second set of rows.

### `room.event` body

`{ kind, invocation_id?, endpoint_ids[], reason? }`

`kind` is one of `router_decision`, `invocation_refused`, `invocation_stopped`, `router_failed`.

Events receive a `room_seq`, appear in history, and fan out to human members only. `reason` is plain text, capped at 280 characters, and clients must render it as untrusted. `member_joined` and approval cards arrive in later phases.

### Delivery rules (`room-dispatch.mjs`, `room-policy.mjs`)

At accept, the relay writes a delivery to each member with `response_mode = 'router'` when all of these hold:

1. The sender is a human member.
2. The message mentions no agent member.
3. The room has at least one agent member whose mode is `joins`.

Agent messages and `room.event` envelopes never produce a router delivery. Router members do not receive normal room fan-out.

### Invocations route

`POST /v1/rooms/{room_id}/invocations`

Body: `{ trigger_message_id, invoke: [endpoint_id], reason }`.

Authorization: the caller's token must belong to a router member of the room. Agents and humans receive 403.

One transaction does the following:

1. Verify that `trigger_message_id` is a human `room.message` in this room with no mentions. Otherwise return 422.
2. For each endpoint in `invoke`, re-check roster membership, agent status, and `response_mode = 'joins'`. A `mentions_only` agent, a non-member, or a human is refused with a reason code. The route never trusts the router's list.
3. Run the existing blocker, hop-budget, and queue logic from phase 2, with `decided_by = 'router'`.
4. Insert the invocation rows and emit one `router_decision` event naming the accepted endpoints. Emit one `invocation_refused` event per refused endpoint.
5. An empty `invoke` is valid. It records no invocation and emits a `router_decision` event with no endpoints.

A repeat call for the same `trigger_message_id` returns the original result and creates no new rows.

The route grants no capabilities. The worst outcome of an injected routing decision is that the wrong joined agent replies.

### Existing refusal and Stop paths

Refusals created by mention dispatch and by the Stop route also emit `room.event`s (`invocation_refused`, `invocation_stopped`) in the same transaction.

## Router daemon

`sigil agent run --router` reuses the polling and ack loop of `agent-daemon.mjs`.

For each router delivery:

1. Load the trigger message, the room roster (name, description, mode, `joins` agents only), and the last N messages (default 12).
2. Build the prompt. The system text states that room content is data, not instructions. Room text sits in a fenced block. The prompt is advisory; the relay enforces every rule.
3. Call Ollama `POST /api/chat` with a JSON schema in `format`: `{ invoke: string[], reason: string }`. The default model is `qwen2.5:7b`, set through config. `llama3.1:8b` is the documented alternative.
4. Post the result to the invocations route, then ack the delivery.

Configuration: `--router-model`, `--router-ollama-url` (default `http://127.0.0.1:11434`), `--router-timeout-ms` (default 20000), `--router-context-messages` (default 12).

## Failure handling

| Failure | Behavior |
|---|---|
| Ollama down, timeout, or output fails the schema | Post a decision with empty `invoke` and `kind = router_failed`, then ack. Never invoke everyone. |
| Relay answers 4xx | Ack the delivery. The request will not succeed on retry. This fixes the phase 2 limit of indefinite retry for the router path. |
| Relay answers 5xx or the network fails | Leave the delivery unacked. The next poll retries. The unique index makes the retry idempotent. |
| Router endpoint removed from the room mid-flight | The route returns 403, and the router acks. |

## Testing

- Unit: delivery rules (human only, no mention, joined agent exists, router excluded from fan-out), route validation, event body schema, `reason` cap.
- PostgreSQL: decision and event commit together or roll back together; the unique index makes a repeat call idempotent; refusal events appear for hop budget, busy queue, and blockers.
- Injection: the LLM names an endpoint off the roster, a `mentions_only` agent, a human, and a removed member. The relay refuses each and the room shows the refusal event.
- Daemon: against a fake Ollama, covering a valid pick, an empty pick, malformed output, a timeout, and a 4xx versus 5xx relay answer.
- Exit test: a human message with no mention routes to the right agent, which replies; a router failure produces an event and no invocation.
- Live smoke (`SIGIL_LIVE_ROOM_ROUTER=1`): real Ollama, one real bridge, in the style of `live-room-bridges.mjs`.
- Contracts: `relay-api.json` entries for the new route and the `room.event` type.

## Known limits

- Routing adds seconds of latency before an agent starts.
- A 7B model can pick the wrong agent. The hop budget and the transparency event bound the cost.
- The router depends on a local Ollama instance. If it is down, unmentioned messages get no agent, and the room shows `router_failed`.
- Agent-to-agent hand-off still needs an explicit @mention (D3).
- Routing quality is not measured. A routing eval set is a follow-up.

## Open questions

None blocking. The relay system identity (`ep_relay_system`) needs a key-management decision during planning: reuse the relay's existing signing key or add a dedicated one.
