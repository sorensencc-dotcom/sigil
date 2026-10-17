# Sigil rooms phase 6: Floor Warden bridge - design

Status: draft for review, 2026-10-16.
Parent spec: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` ("Grok bots through the Floor Warden", "Reply route", delivery phase 6).
Builds on: phases 1-4 (relay rooms, bridges and guards, router, browser surface and web client) and the multi-human foundation (trusted endpoint lookup, custodial key wrap, invocation policy).
Inputs also read: the 2026-10-16 Hyperagent Rooms gap analysis and the last-30-days rooms brief. Both are working notes outside the repo; this spec quotes what it uses.

## Goal

A person in a room can @mention Chief or Helix CI Triage, or the router can pick them, and the bot's answer appears in the thread of that message as a signed `room.message` from the bot's own endpoint. The bots live in the Grok Bot app. Nothing on this machine starts them, and the Floor Warden never answers a room itself.

Phase 6 also adds the loop guards and catch-up state that every bridge needs once a bot that Sigil cannot kill joins a room.

## Scope

In scope:

- Roster-to-endpoint mapping for Grok bots, and the two bot endpoints' relay-held signing keys.
- An outbound bridge that forwards an invoked room message to the one "Sigil rooms" webhook.
- The inbound reply route `POST /v1/rooms/{room_id}/replies` fixed in the parent spec.
- Reply token and webhook secret storage, idempotency, and tests.
- Loop guards that are visible: a cap event, a Continue action, a signed halt event, and a pin on agent-to-agent mention-only.
- A per-bot watermark so a bot that lost context gets a bounded catch-up.

Out of scope, with the reason:

- Creating `ep_chief` and `ep_helix_ci` or touching the Grok routine. Chris declined endpoint setup as a diversion. This phase ships the mechanism and tests it with fixture ids.
- Ironbots requests. They are the other half of the parent spec's phase 6 and get their own design.
- Reaching the reply route from Grok's cloud. That waits on the phase 7 tunnel, and the rooms MCP (phase 8) is not the reply path.
- Everything in "Hyperagent comparison" marked later.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Bot identity | Each bot is its own agent endpoint and room member | The parent spec keeps roles, response modes, `invokable_by` and the guards per bot. |
| Mapping store | Postgres table `floor_warden_bots`, not a config file | The foundation made Postgres the only trust source. The table is also the reply allowlist. |
| Signing | Relay-held key per bot endpoint, in a new table, under a separate wrap key | The Floor Warden cannot mint a signature. A separate table and wrap key keep the human send route and the reply route from sharing key material. |
| Inbound delivery | A normal agent daemon per bot, with a receive-only identity file | Reuses delivery polling, ack and retry. The identity file holds a relay token and no private key. |
| Bot replies carry no mentions | `mentions` is empty | A bot cannot start a handoff chain. Handoff from bots is a later opt-in. |
| Reply must answer the running invocation | `in_reply_to` must equal the trigger of the bot's running invocation | The dispatch check compares only the thread root, so a late reply to an older message in the same thread would complete a newer invocation. |
| Reply deadline | The bridge fails a forwarded invocation after a timeout | The bot may never answer. Without a deadline the one-in-flight rule blocks the bot until Stop. |
| No reply URL, no forward | The bridge refuses to forward when no public reply URL is set | A message the bot cannot answer should fail visibly, not wait for the deadline. Until phase 7 this is the expected state. |
| Route when unconfigured | 404, as if absent | The AgentMail ingress uses the same rule, so an unconfigured relay exposes no new surface. |

## Components

### Flow

1. A human or agent @mentions `ep_chief`, or the router picks it. The relay creates a running `room_invocations` row and a room delivery for `ep_chief`. Nothing here changes.
2. `sigil agent run --room-bridge floor-warden` for that endpoint receives the delivery and calls the Floor Warden bridge handler (`bridges/v1/floor-warden-bridge.mjs`).
3. The handler confirms the relay still has that invocation running for that trigger, builds the payload, and POSTs it to the webhook.
4. On `2xx` the handler advances the watermark, starts the reply deadline, and returns `forwarded`. The delivery is acked and the invocation stays `running`.
5. The Floor Warden routine hands the work to the named bot inside the Grok Bot app. When the bot answers, the Floor Warden calls the reply route.
6. The relay signs the answer as the bot endpoint and accepts it through the `POST /v1/envelopes` accept path. That path completes the invocation, promotes the next queued one, fans out to humans, and sends `room.updated`.

### Roster-to-endpoint mapping

`floor_warden_bots(bot_id PK, endpoint_id UNIQUE REFERENCES endpoints, display_name, status, created_at)`. `bot_id` is the Grok Bot id, which is not a secret. `status` is `active` or `disabled`.

Proposed rows, created by an operator step outside this plan:

| Grok bot | `bot_id` | Endpoint |
|---|---|---|
| Chief | `016f0b34-f0da-49b2-a32f-482d6e635825` | `ep_chief` |
| Helix CI Triage | `28782df8-9cf6-48a8-ad0c-97c510c66e38` | `ep_helix_ci` |

Both endpoints have kind `agent`, response mode `mentions_only`, and the operator as owner. The owner id comes from the `--room-human-identity` file, so it needs no literal. The Floor Warden's `usr_soren` should equal it (assumption 4).

Adding a bot is a row, an endpoint, a key, and a roster edit in the Grok app. It never needs a new URL, and the allowlist is the table.

### Bridge payload

One JSON object per forward. Fields from other room members are untrusted data and are listed in `untrusted_fields`, so the Floor Warden can fence them in its prompt.

```json
{
  "schema": "sigil.floor_warden/1",
  "type": "room.message",
  "delivery_key": "inv_<uuid>",
  "room": { "id": "room_<uuid>", "name": "..." },
  "target_bot": { "bot_id": "016f0b34-...", "endpoint_id": "ep_chief", "display_name": "Chief" },
  "invocation": { "id": "inv_<uuid>", "decided_by": "mention" },
  "trigger": { "message_id": "msg_<uuid>", "room_seq": 41, "thread_root_id": "msg_<uuid>",
               "sender": { "endpoint_id": "...", "kind": "human", "display_name": "..." },
               "text": "...", "created_at": "..." },
  "thread": [ { "room_seq": 40, "message_id": "...", "sender_endpoint_id": "...", "text": "..." } ],
  "catch_up": { "from_seq": 35, "to_seq": 41, "truncated": false, "reset": false },
  "reply": { "url": "<public origin>/v1/rooms/<room_id>/replies", "in_reply_to": "msg_<uuid>",
             "idempotency_key": "msg_<uuid>:016f0b34-...", "text_max": 16000 },
  "limits": { "agent_turns_left": 5 },
  "untrusted_fields": ["trigger.text", "thread[].text"],
  "sent_at": "..."
}
```

- `thread` holds messages of the trigger's thread with `room_seq` above the watermark, at most 20 (the same limit as the CLI bridges), each clipped to 4000 characters. `trigger.text` is not clipped below the schema maximum.
- The payload never carries the reply token, the sender key, relay tokens, or the subject human id. `trigger.sender` names who asked.
- `type: "halt"` is the second frame. It carries `delivery_key: "halt:<invocation_id>"`, `target_bot`, `invocation.id`, `trigger.message_id`, and `halt: { room_seq, message_id, reason }` for the signed `room_halted` event (see Loop guards).
- Payload size is capped at 256 KiB. Over the cap the bridge drops the oldest `thread` entries first and sets `truncated`.

### Outbound delivery and failures

| Outcome | Bridge action |
|---|---|
| `2xx` | Advance the watermark, start the deadline, return `forwarded`. |
| `4xx` except `408` and `429` | The webhook will never accept this. Fail the invocation with `FLOOR_WARDEN_REJECTED`. |
| `408`, `429`, `5xx`, network error, timeout | Throw. The daemon leaves the delivery unacked and retries with the same `delivery_key`. After 5 attempts the bridge fails the invocation with `FLOOR_WARDEN_UNREACHABLE`. |
| No reply URL configured | Fail with `REPLY_URL_UNSET` before any POST. |
| Deadline passes (default 15 minutes, `--reply-timeout-ms`) | Fail with `REPLY_TIMEOUT`. A later reply gets `403 ROOM_NOT_INVOKED`. |

The deadline survives a restart: on start the bridge lists its running invocations and fails those whose `started_at` is older than the deadline. A halt frame is sent by an in-process poll after the delivery is acked, so a restart between the cancel and the poll would lose it. `recover()` therefore also lists invocations cancelled since the stored forward time and sends any halt frame not yet recorded in the session store. Invocation failures use the existing `POST /v1/rooms/{room_id}/invocations/fail` route, which now emits a visible event (see Loop guards).

The webhook call authenticates with the sender key from the routine panel. The header form is an assumption (assumption 1).

### Reply route

`POST /v1/rooms/{room_id}/replies`. Auth, body, success and error codes are as fixed in the parent spec. This section adds the checks in order.

1. Not configured: `404`.
2. `Authorization: Bearer` equals the reply token (digest compare, constant time): continue. Another valid endpoint bearer: `403 ROUTE_NOT_AUTHORIZED`. Anything else: `401 UNAUTHENTICATED`.
3. Body at most 96 KiB. Strict shape: unknown fields, a `room_id` that differs from the path, or `text` empty or over 16000 characters after trimming: `400 INVALID_REQUEST`.
4. `floor_warden_bots` has an active row for `target_bot_id` whose `endpoint_id` equals `sender`: otherwise `403 BOT_NOT_ON_ROSTER`.
5. Room exists: `404 ROOM_NOT_FOUND`. The bot's endpoint is an active member: `403 BOT_NOT_A_MEMBER`.
6. `in_reply_to` is a message in the room: `404 MESSAGE_NOT_FOUND`. The thread root is `body.thread_root_id ?? message_id` of that message.
7. A stored `idempotency_key` replays the first result (see Idempotency). This check runs before the invocation check because the first reply completed the invocation, so a legitimate replay finds none running.
8. The bot has a running invocation whose trigger is `in_reply_to`: otherwise `403 ROOM_NOT_INVOKED`. This is the code the accept path already returns for an agent that posts uninvoked.
9. Sign `room.message` with `{text, thread_root_id, mentions: []}`, `correlation_id = in_reply_to`, and the bot's key, then call `acceptEnvelopeAsync`. A `401` from accept for `UNKNOWN_ENDPOINT` or `INVALID_SIGNATURE` is a relay fault and becomes `500 INTERNAL`, as in the human send route. Other accept errors pass through.
10. `202 {request_id, message_id, room_seq, duplicate}`.

Two codes are additions to the parent spec's list: `403 ROOM_NOT_INVOKED` and `503 BOT_SIGNING_UNAVAILABLE` (no wrapped key, no wrap key configured, or key mismatch). A suspended or revoked bot endpoint answers `403 ENDPOINT_REVOKED`. The route records a `room.floor_warden_reply` audit row (bot, endpoint, room, message id, outcome) and never records the token or the text.

### Relay-held signing

`sigil init` cannot create these endpoints: it forces `ep_<name>@<domain>` and a federated owner id. The new `sigil bot add` creates the endpoint row, an `endpoint_keys` row, a `bot_signing_keys` row holding the Ed25519 private key wrapped with AES-256-GCM (the `key-wrap.mjs` format, AAD `endpoint_id + "\0" + key_id`), the `floor_warden_bots` row, and a receive-only identity file. The private key is never written to disk. `createRoomBotSigner` mirrors `createRoomHumanSigner`: it re-reads trust state on every call, so a revoked endpoint stops signing at once, and it memoizes only the public-key match check.

The wrap key is a different environment variable from the human one (`--room-bot-key-wrap-key`). Without it the relay still runs and the reply route answers `503 BOT_SIGNING_UNAVAILABLE`.

### Secrets and token storage

| Secret | Where it lives | Rules |
|---|---|---|
| `floor_warden_reply_token` | Environment variable named by `--floor-warden-reply-token-env`; optional second name for rotation | At least 32 characters or the relay refuses to start. The relay keeps only the SHA-256 digest. No token in argv, config, audit rows or logs. |
| Webhook URL and sender key | Environment variables named by `--floor-warden-url-env` and `--floor-warden-key-env`, read by the bridge process | The URL is a secret because it addresses the routine. Logs show the origin only, and fetch errors are scrubbed of the URL. |
| Bot wrap key | `--room-bot-key-wrap-key` environment variable | 32 random bytes, base64, same loader as the human wrap key. |
| Bot relay token | Receive-only identity file made by `sigil bot add` | Holds a relay token and no private key. Never printed. |
| Watermarks | Session store file | Sequence numbers only. |

No secret is written to `.sigil/*.json` by this phase except the bot relay token, which follows the existing identity-file rule. Doppler injects the environment variables, as for the wrap key.

### Idempotency

- **Floor Warden to relay.** The key is `<in_reply_to>:<target_bot_id>`, 1-128 characters. The route stores it in `idempotency_keys` under the bot endpoint, scoped `room:<room_id>:fw_reply:<key>`. A replay returns the first `message_id` and `room_seq` with `duplicate: true` and ignores any change in `text`. It needs no running invocation (reply route step 7 runs before step 8). A racing duplicate that loses the insert re-reads the winner, as the human send route does.
- **Accept path.** Completing an invocation is single-shot. A second reply under a different key answers `403 ROOM_NOT_INVOKED`.
- **Relay to Floor Warden.** `delivery_key` is the invocation id. A retry after a failure resends the same key. The routine may not dedupe (assumption 2), so the reply idempotency above is the real guarantee: at most one reply is posted per invocation.

### Loop guards

Already in the relay and unchanged: `max_agent_turns` (default 6) agent turns per thread after the latest human message, one in-flight invocation per agent per room, and Stop. Router picks run only for human messages without mentions (`humanSender && noMentions` in `room-dispatch.mjs`), so agent-to-agent traffic is mention-only today. Phase 6 pins that with tests and adds what the research found missing:

1. **A cap that is visible.** When the budget refuses a handoff, the relay posts one `room.event` of kind `agent_cap_reached` per thread per budget epoch, naming the cap and the refused agents. Hermes bots capped silently and a handoff looked abandoned. The event keeps that from happening. `room_threads` gains `cap_epoch`, which `resetAgentTurns` increments, and `last_reset_at`.
2. **Continue.** `POST /v1/rooms/{room_id}/continue` with `{thread_root_id, idempotency_key}`. A human member only. The relay posts a signed human `room.message` ("Continue.") into the thread, as the caller, mentioning the endpoints refused for `hop_budget` since `last_reset_at`. Because it is an ordinary human message it refills the budget under the existing rule (only if the caller is the subject of every active invocation in the thread) and dispatches through `mayInvoke`. Nothing is reset behind the room's back, and the resume is signed and attributable. No refused agents: `409 NOTHING_TO_CONTINUE`. The web client shows a Continue button on the cap row.
3. **Signed halt.** Work is cancelled at two sites in `room-routes.mjs`: the Stop route and member removal (a human who leaves loses the work they started). Each emits `invocation_stopped` per row. Both now go through one helper that also emits one `room_halted` event per call that cancelled work (`reason` `stopped` or `left`), signed by the relay system identity, with `endpoint_ids` for the cancelled agents. Its `room_seq` is the line: work started before it is void. The relay enforces this (a late reply gets `403 ROOM_NOT_INVOKED`). The Floor Warden bridge, which cannot kill a cloud bot, sends the `halt` frame so the routine can drop queued work. "In-band" here means an event in the room's sequence, not a message an agent must choose to obey.
4. **Visible failure.** `POST .../invocations/fail` emits `invocation_failed` with the clamped reason, so a bridge failure or a reply timeout is a row in the room. This helps every bridge, not only this one.
5. **Bot replies are leaves.** A bot reply carries no mentions, so a bot cannot hand off to another agent in phase 6. A later opt-in can parse mentions from bot text.

`room.event` kinds `agent_cap_reached`, `room_halted` and `invocation_failed` join `ROOM_EVENT_KINDS`. The web `RowView` already renders `kind: reason` for any kind, so only the Continue button needs client work.

### Catch-up watermarks

Each bot endpoint has its own session store (`last_seq_by_thread`, the format the CLI bridges use). The bridge advances a thread's watermark only after the webhook returns `2xx`, so a failed forward re-sends the same catch-up. The first forward in a thread has no watermark: `catch_up.reset` is true and `thread` is the last 20 messages. A bot that lost context in the Grok app still receives the most recent 20 messages and can ask for more by replying in the thread. Per-agent watermarks follow Portal and Threadlines in the research.

## Data

New migration `035_floor_warden_bridge.sql` (re-check the number against `main` at execution):

- `floor_warden_bots(bot_id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL UNIQUE REFERENCES endpoints(endpoint_id), display_name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','disabled')), created_at TIMESTAMPTZ NOT NULL)`
- `bot_signing_keys(key_id TEXT PRIMARY KEY REFERENCES endpoint_keys(key_id), wrapped_private_key BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL)`
- `room_threads` gains `cap_epoch INTEGER NOT NULL DEFAULT 0` and `last_reset_at TIMESTAMPTZ`.

The memory repository gets matching methods, as every room method has one.

## CLI

- `sigil bot add --bot-id <grok id> --endpoint <ep_id> --name <display name> [--identity path] [--database-url url] [--room-bot-key-wrap-key env_var]`. The owner is the operator identity's owner. Rejects a duplicate bot id or endpoint.
- `sigil bot disable --bot-id <id>`. Sets `status = 'disabled'`; the reply route then answers `403 BOT_NOT_ON_ROSTER`.
- `sigil agent run --room-bridge floor-warden --floor-warden-url-env N --floor-warden-key-env N [--floor-warden-key-header name] --floor-warden-reply-url <public url> [--reply-timeout-ms n]`.
- `sigil relay up` gains `--floor-warden-reply-token-env`, `--floor-warden-reply-token-next-env`, and `--room-bot-key-wrap-key`.

## Hyperagent comparison: what lands here and what waits

Sigil already matches Hyperagent's roster and response modes and goes past it on signed identity and CLI bridges. The table lists only items that touch this phase.

| Item | Phase 6 | Where it goes |
|---|---|---|
| Loop caps, visible pause, human stop (research: Hermes) | Yes: cap event, Continue, halt event, failure event | n/a |
| Per-agent catch-up (Portal, Threadlines) | Yes: watermarks | n/a |
| Cryptographic per-agent identity (Buzz) | Yes: relay-held bot keys | n/a |
| Signed webhooks beat a shared secret (O-2) | Partly: the reply route uses a bearer token on a narrow route. Replay protection and per-source identity wait. | A room automation phase after phase 7 |
| Schedules with "only post when notable" (O-8) | No | Same automation phase |
| Approval cards via WebAuthn (O-1) | No. Bots hold no capability grants, so they never need approval. | Own spec, about 4c |
| Notes, Canvas, decision log (O-3) | No | New phase |
| Enforced room cost budgets, usage view (O-4) | No. Bot invocations record no `cost_units` because Grok reports none. | Rooms polish phase |
| Web @mention, archive, self-leave, find-in-room (O-12) | No | Rooms polish phase |
| Reactions (O-9), transcript export (O-5), private history scope (O-7), federated rooms (O-6) | No | Later phases per the gap analysis |
| Router with a visible moderator (endue) | No. `router_decision` events already show the pick. | n/a |
| Per-message delivery state for bots (O-11) | No | Web polish |

## Testing

- **Migration:** tables, constraints, `cap_epoch` default.
- **Bot signer:** wrap and unwrap round trip, AAD binding, revoked endpoint, key mismatch, missing wrap key, no cross-use with `human_signing_keys`.
- **Reply route:** every status and code in the parent spec and the additions; strict body; the bearer matrix (reply token, member bearer, none, unconfigured); sender and bot mismatch; non-member bot; stale `in_reply_to`; idempotent replay, racing duplicate, and changed text on replay; invocation completed, queue promoted, thread placement under the trigger; empty `mentions`; text at 16000 and 16001; audit row without token or text. Postgres cases sit in `*.pg.test.mjs` files.
- **Token handling:** a weak token refuses to start; rotation accepts both; no log line or error contains the token, the sender key, or the webhook URL.
- **Bridge:** fake `fetch` for each outcome row, watermark advance only on `2xx`, same `delivery_key` on retry, deadline and restart recovery, halt frame, payload size cap, `REPLY_URL_UNSET`.
- **Loop guards:** one `agent_cap_reached` per epoch, Continue happy path and `409`, refill rule for a guest, `room_halted` once per Stop, `invocation_failed`, and regression tests that an agent message never reaches the router and a bot reply never dispatches.
- **End to end:** the relay on a disposable Postgres, a fake Floor Warden HTTP server that receives the payload and calls the reply route, then Stop and timeout runs. No real Grok call runs in this phase. The live smoke test waits for the phase 7 tunnel.

## Assumptions

1. **Webhook sender key header.** The routine panel format is not known. The bridge sends `Authorization: Bearer <key>` and takes the header name and scheme from `--floor-warden-key-header`.
2. **Routine behavior.** The routine hands work to the named bot, calls the reply route once per answer, and may deliver the same payload twice. Dedupe is not assumed.
3. **Webhook payload limit.** 256 KiB is a guess. Confirm against the routine's limit before the live test.
4. **Owner id.** The Floor Warden's `usr_soren` is the operator's human id. The design reads the owner from the operator identity and does not depend on the literal.
5. **Token loading.** New bot relay tokens need a relay restart, because `tokenHashes` is built at startup from the registry file (`sigil.mjs`). Whether the admin NOTIFY path refreshes it is unverified; plan Task 1 checks.
6. **Daemon ack.** The agent daemon acks a delivery when the room handler returns without throwing, whatever the `outcome` string. Plan Task 1 confirms.
7. **Postgres only.** Bot signing needs Postgres. In memory mode the reply route answers `503 BOT_SIGNING_UNAVAILABLE`; tests inject a signer.
8. **Timeouts and caps.** The 15-minute deadline, 5 forward attempts, 20-message context and 4000-character clip are starting values to tune after the live test.

## Open questions

1. Should a Floor Warden reply be allowed to carry mentions once phase 6 is proven? That would let a bot hand off, and it needs its own loop analysis.
2. Does the routine panel offer a delivery receipt or run id? If so the bridge could record it on the invocation for debugging.
