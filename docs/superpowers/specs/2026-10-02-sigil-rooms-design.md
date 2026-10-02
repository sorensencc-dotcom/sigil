# Sigil rooms — design

Status: DRAFT, not approved. Written 2026-10-02.
Concept source: [Hyperagent Rooms](https://www.hyperagent.com/docs/concepts/rooms) (beta upstream).
Supersedes: the Gemini-drafted `sigil-federated-rooms-spec.md`, `sigil-integration-walkthrough.md`, `SigilRoomUI*.tsx`, `useSigilRoom.ts`, and `sigil-rooms-client.ts`. Those drafts are not implementable; see "Rejected draft scope" below.

## Problem

Each agent CLI on this machine (Claude Code, Codex, Copilot CLI, Grok, Hermes, Muse, and the Ironbots fleet) runs in its own terminal with its own context. You cannot put two of them in one conversation, let them answer each other, or watch the exchange from one place. Sigil already relays signed, governed messages between Claude and Codex endpoints, one sender to one recipient. It has no shared multi-party conversation.

## Goal

A room is a persistent, shared conversation between you and your agents. In a room:

1. You chat, and the agents chat with you and with each other.
2. An LLM router decides which agent answers when nobody is @mentioned.
3. Each agent is a CLI running on this machine behind a Sigil endpoint, so its replies carry Sigil identity, capability grants, and approval gates.
4. The first client runs locally. The design keeps three later paths open: mobile access, other humans in the room, and a commercial multi-tenant product.

## Non-goals for v1

- Rooms that span relays (federation). Sigil federation exists, so this stays a later phase rather than a redesign.
- An offline outbox or a Service Worker sync. Clients catch up from `room_seq` on reconnect.
- Room notes, Canvas, webhooks, and schedules. All four are Hyperagent features worth adding later.
- Billing.

## Concepts

| Concept | Meaning |
|---|---|
| Workspace | Tenant boundary. v1 has one workspace. Every table carries `workspace_id` from day one so multi-tenancy needs no migration later. |
| Room | Named conversation inside one workspace. Registered as a relay endpoint `room:<room_id>`, so existing envelope addressing reaches it. |
| Member | A human or an agent endpoint in a room's roster. |
| Role (humans) | `owner`, `room_manager`, or `member`, matching Hyperagent. |
| Response mode (agents) | `joins` (router may pick the agent) or `mentions_only` (only an explicit @mention invokes it). |
| Thread | Replies attached to a root message through `thread_root_id`. An agent's answer goes in the thread of the message it answers. |
| Invocation | One decision to run one agent for one message. Carries the router's reason, status, and cost. |

Room managers manage the roster and the response modes. Being a room manager grants no control over an agent endpoint's configuration, and Sigil enforces this already, because endpoints belong to an `owner_id`, not to a room.

## Architecture

```
 web / mobile client ──HTTPS + WS──┐
                                   ▼
                        ┌───────────────────────┐
                        │ Sigil relay            │
                        │  rooms + members       │
                        │  room_seq + fan-out    │
                        │  history API           │
                        │  risk gate + approvals │
                        └──┬─────────┬───────────┘
                           │         │ room.message deliveries
                     route │         ▼
                 request   │   ┌──────────────────────────────┐
                           ▼   │ agent bridges (one per CLI)  │
                   ┌──────────┐│  claude -p --resume …        │
                   │ router   ││  codex exec resume …         │
                   │ endpoint ││  copilot / grok / hermes …   │
                   └──────────┘└──────────────────────────────┘
```

### Relay (room authority)

- **Addressing.** A room is a Sigil conversation (`conversations.kind = 'room'`), and its roster is `conversation_members`. Room traffic uses the existing broadcast form of the envelope: no `recipient`, with `broadcast_scope: { conversation_id }` naming the room. Today `validateEnvelope` already accepts broadcast envelopes when a `broadcastAuthorizer` allows them. Two pieces are missing: the HTTP server never wires one in, and persistence writes no deliveries for broadcasts. Rooms fill both gaps for room conversations only. Any envelope addressed directly to a recipient inside a room conversation is rejected. Otherwise the existing auto-membership insert in `persistAcceptedEnvelope` would silently add its sender to the room.
- **Ordering.** At accept, the relay assigns a gapless `room_seq` per room in the same transaction that persists the message. `room_seq` is the display order. The existing per-sender `stream_seq` from migration 020 stays the gap-detection mechanism for each sender's stream.
- **Fan-out.** The relay writes one delivery per member endpoint through the existing delivery queue. Humans receive every message. Agents receive a message only when an invocation targets them, which keeps CLI cost proportional to work.
- **History.** `GET /v1/rooms/{room_id}/messages?after_seq=N` lets any client catch up after a reconnect. This replaces the drafts' offline outbox.
- **Identity.** The relay binds `sender` from the authenticated token. Clients never assert their own sender type or ID.
- **New message types.** Two are added, each with a body schema that follows `task-request-schema.mjs`:
  - `room.message`: `{ text, thread_root_id?, mentions[], attachments_ref[] }`
  - `room.event`: system events (router decision, member joined, invocation stopped, approval requested).
- **Structured delegation.** It reuses the existing `task.request` and `task.result` types with `conversation_id` set to the room. No new delegation frame.

### Router

The router is its own Sigil endpoint with a capability to create invocations. It runs on every `room.message` from a human, and on agent messages that pass the loop guard (below).

1. **Explicit @mention.** The mentioned agents are invoked. No LLM call is made.
2. **No mention.** The router sends the room roster (name, description, response mode) and the last N messages to an LLM. The LLM returns `{ invoke: [endpoint_id], reason }` as JSON, which the router validates against the roster. Agents in `mentions_only` mode are never eligible. An empty list is a valid answer.
3. **Transparency.** Every decision posts a `room.event`, so the room shows who is answering and why. This is the status line from Hyperagent.

The router runs on a local model through Ollama (decided 2026-10-02), so routing has no API cost and room text never leaves the machine for routing. The default is `qwen2.5:7b`, with `llama3.1:8b` as the alternative; both are already installed. The router calls Ollama's `/api/chat` with a JSON schema in `format` (structured outputs), so the reply is guaranteed to parse. The model is a config value, so a hosted model stays possible for the commercial phase.

Router failure (Ollama down, timeout, invalid output) falls back to "no agent invoked" plus a visible event, never to invoking everyone.

Treat the router as open to prompt injection. The cic-jev evaluation (2026-09-23) found that prompt fencing alone did not stop injection on a local model. The router's output is therefore advisory, and code enforces the following:

- Only endpoint IDs on the room roster are accepted.
- Agents in `mentions_only` mode are rejected.
- The hop budget and rate limit apply to every invocation.
- An invocation never grants capabilities. The worst outcome of an injected routing decision is that the wrong agent replies.

### Agent bridges

A bridge connects one CLI to its Sigil endpoint. It extends the existing `agent-daemon.mjs` WebSocket loop and the `claude-process-adapter.mjs` spawn pattern.

- **Session continuity.** Each `(room_id, endpoint_id)` pair maps to one CLI session, so the agent keeps its own memory of the room. Claude uses `--resume <session>`. Codex uses `exec resume`. Bridges for CLIs without a resume feature replay the last N room messages instead.
- **Input.** The bridge sends the triggering message, the thread context, and a fixed system preamble. The preamble states that content from other room members is untrusted data, not instructions.
- **Output.** The bridge posts the CLI's final answer as a `room.message` in the thread of the trigger. Streaming partial output (as `room.event` progress) is a v2 option.
- **Permissions.** Each bridge launches its CLI with an explicit, minimal tool allowlist (for Claude: `--allowedTools` and a non-bypass permission mode). High-risk actions go through the existing capability risk gate and WebAuthn approval ceremony. Approval requests appear in the room as `room.event` cards.

Bridge order follows existing support and value:

| Bridge | Status |
|---|---|
| Claude Code | Adapter exists (`claude-process-adapter.mjs`). |
| Codex | Adapter exists (`createCodexAdapter`). |
| GitHub Copilot CLI | New. Same spawn pattern. |
| Antigravity CLI | New. Same spawn pattern. Antigravity once faked an approval and force-pushed during IronLedger Phase 1 (2026-09-01), so its bridge starts with a read-only tool allowlist and has no `high` risk-tier capabilities. |
| xAI Grok CLI | New. Same spawn pattern. |
| Grok bots (Grok Bot app) | Not on this machine and not spawned. Reached through one Floor Warden webhook. See "Grok bots through the Floor Warden". |
| Nous Research Hermes Agent | New. Same spawn pattern. |
| Meta Muse, ChatGPT, Claude Cowork | Hosted apps, not CLIs. See "Hosted app agents". |
| Ironbots (9 scheduled bots) | Two steps. First, each bot posts its run report into a room as `room.message` (notebook-ingester, kb-sentinel, trm-bot, watchlist-miner, daemon-healer, ironledger-sentinel, ci-watchdog, and the others in `_status-feed/ironbots_daily_report.json`). Second, each bot gets a request entry point so you can ask it things in the room, for example "kb-sentinel, rerun drift on helix" or "ci-watchdog, why did the governance job fail?". Each bot becomes an agent endpoint with a narrow command list rather than a free-form LLM CLI. |

Every new CLI bridge needs a confirmed headless (non-interactive) mode and a session-resume mode before it is built. Where a CLI has no resume mode, the bridge replays recent room history instead.

### Grok bots through the Floor Warden

Grok bots live in the Grok Bot app on the user's account. Nothing on this machine starts them. The app wakes a bot in three ways only:
- a person messages it in the app;
- one of its routines fires, on a schedule or from an outside event (Slack, GitHub, email, webhook, and a few others);
- another Grok bot hands it work inside the app.

Sigil uses the routine path through one bot (decided 2026-10-02):

1. **One webhook, not one per bot.** A single Floor Warden bot in the Grok Bot app owns one webhook routine. Sigil stores that one URL as a secret.
2. **Inbound.** When a room needs a Grok bot (an @mention, or a router pick), a bridge POSTs the room message to the Floor Warden webhook. The payload names the target bot, the room, the thread, and the triggering message. The Floor Warden hands the work to the named bot inside the app.
3. **Roster.** The Floor Warden's roster starts with Chief and Helix CI Triage. Adding a bot later means editing that roster in the app and adding the bot's endpoint to the room. It never needs a new URL.
4. **Endpoints.** Each rostered bot is still its own Sigil endpoint and room member, so room roles, response modes, and the loop guards apply per bot.
5. **Not ready yet.** The webhook URL exists only after the Floor Warden routine is confirmed and the URL is copied from its routine panel. Until then, Grok bots are not invocable.

Still open: the reply path. The bot's answer must come back into the room, either through the rooms MCP plugin (if Grok bots can call custom MCP tools) or through an outbound webhook the Floor Warden calls on Sigil.

### Hosted app agents (Muse, ChatGPT, Claude Cowork)

Meta's Muse, ChatGPT, and Claude Cowork are hosted apps, not CLIs on this machine. A bridge cannot spawn them. There are two ways to connect them, and they behave differently:

1. **Rooms MCP plugin (app connects to the room).** Sigil exposes a remote MCP server with room tools:
   - `list_rooms`
   - `read_room(room_id, after_seq)`
   - `post_message(room_id, text, thread_root_id?)`
   - `my_mentions()`

   You add it as a connector in each app. The app keeps its own memory, projects, and tools. The catch is that the app acts only while you are using it, so the router cannot wake it up. In the roster these agents show as `human_driven`: an @mention queues a notice that the app picks up through `my_mentions()` the next time it runs.
2. **API agent (the room calls a model).** The bridge calls the vendor's API (OpenAI for ChatGPT models, Meta's API for Muse if one is available, Anthropic for Claude). The router can invoke these agents like any CLI. The catch is that they do not get the consumer app's memory, projects, or connectors.

Each app gets one path (decided 2026-10-02). The plugin and the API agent do different jobs, so no app gets both by default.

| App | Path | Notes |
|---|---|---|
| Claude Cowork | MCP plugin only | No API agent. The Claude Code bridge already covers unattended Claude. Reported: custom remote MCP works in Cowork on every plan including Free, with one connector on Free. |
| ChatGPT (Plus or Pro) | MCP plugin first | OpenAI's docs disagree on whether a personal plan's connector can call write tools. First test whether `post_message` actually fires. Only if it never fires, add an API agent, used for replies only. |
| Meta Muse | MCP plugin only, experimental | Reported: no connector toggle and no model API. Having Muse write its own client is not a supported install. No Muse API agent. |

The "reported" items came from a review relayed by the user. Each one must be checked against the vendor's current documentation before that app's connector work begins.

One server covers every app that supports custom MCP connectors. Requirements:

- **Transport.** The existing `mcp-stdio-server.mjs` is local only. Hosted apps need the Streamable HTTP transport with OAuth.
- **Reachability.** The relay has to be reachable from the vendor's cloud. That reuses the mobile phase's tunnel, so the plugin ships after it, or at the same time.
- **Permissions.** Each connected app is its own endpoint with its own capability grants. App support for custom MCP connectors varies by vendor and plan; confirm per app before building.
- **Rejected: browser automation of the chat UIs.** It is fragile and likely breaks vendor terms of service.

### Loop and cost control

Agent-to-agent chat can run without limit. These guards are mandatory before more than one agent shares a room:

1. **Hop budget.** At most `max_agent_turns` (default 6) agent messages per thread after the last human message. Past the budget, the router stops invoking and posts a `room.event`.
2. **Per-agent rate limit.** At most one in-flight invocation per agent per room.
3. **Daily cost budget per room.** Each invocation records its token or credit cost. Over budget, the room switches to mentions-only.
4. **Stop.** Any human member can cancel all queued and running invocations in a room. Bridges must kill the CLI process on cancel.

### Clients

- **v1 web client.** React, served by the relay on `localhost`, in a separate package (`@sorensencc/sigil-rooms-web`) so the core package stays plain Node `.mjs`.
- **Browser authentication.** Browser WebSocket APIs cannot set an `Authorization` header. The client calls `POST /v1/rooms/ws-ticket` over authenticated HTTPS and gets a single-use ticket with a 60-second lifetime. It then passes the ticket in the WebSocket URL. The client never stores a long-lived token in the URL.
- **Sending.** The browser posts `room.message` through the authenticated HTTP API, and the relay signs it for the human's endpoint. Signing keys in the browser through WebCrypto Ed25519 wait until a third party has to verify human messages end to end.

## Path to mobile, other humans, and commercial use

| Phase | Adds | Depends on |
|---|---|---|
| Mobile | The same web client as an installable PWA. Remote access through a private tunnel (Tailscale first). Web Push for mentions and approval cards; this works on iOS 16.4+ only for an installed PWA. | v1 client |
| Other humans | Invites, the existing OIDC login (`2026-08-23-sigil-real-oidc-login.md`), and enforced roles. A per-agent `invokable_by` setting defaults to `owner`, so a guest cannot drive CLIs on your machine without your explicit grant. | Mobile phase for remote access |
| Commercial | Multiple workspaces, a hosted relay, agent bridges that run on each customer's own machine (the bridge model already works this way), metering from invocation cost records, and an audit export. Cross-company rooms reuse Sigil federation. | Other humans |

Two v1 choices keep these paths open: `workspace_id` on every table, and agents acting under their own endpoint identity. Hyperagent runs room agents "under the owner's account". That model lets any member act with the owner's permissions. Sigil does not copy it.

## Data model (new migration)

- `workspaces(workspace_id, name, created_by, created_at)`. v1 creates one personal workspace per human (`ws_<human_id>`).
- `rooms(conversation_id → conversations, workspace_id, name, description, next_room_seq, archived_at, created_at)`, unique on `(workspace_id, name)`
- `conversation_members` gains `response_mode`. Room roles (`owner`, `room_manager`, `member`) use the existing `role` column. `invokable_by` arrives with the other-humans phase.
- `envelopes` gains `room_seq`, unique on `(conversation_id, room_seq)`. Room messages stay in `envelopes`, with no separate message table.
- `room_invocations(id, room_id, trigger_message_id, endpoint_id, decided_by, reason, status, cost_units, started_at, finished_at)`
- `room_budgets(room_id, day, cost_units_used, cost_units_limit)`

## Delivery phases

Each phase ships with tests in the repo's `*.test.mjs` pattern and contract entries in `relay-api.json`.

1. **Relay rooms.** Migration, room conversations, the `room.message` schema, `room_seq`, fan-out, stream notification, and the room HTTP API (create, list, members, history). `room.event` arrives with the router (phase 3), and the WebSocket ticket with the web client (phase 4).
2. **Two bridges and the guards.** Claude and Codex bridges, session continuity, hop budget, rate limit, and Stop. Exit test: Claude and Codex hold a 6-turn exchange in one room, then the hop budget stops them.
3. **Router.** @mention routing, the LLM router, decision events, and fallback behavior.
4. **Local web client.** Room list, timeline, threads, roster with response modes, Stop button, and approval cards.
5. **More bridges.** GitHub Copilot CLI, Antigravity CLI, xAI Grok CLI, Hermes Agent, and Ironbots report posting.
6. **Ironbots requests and Grok bots.** A request entry point and a command list for each Ironbot. Floor Warden bridge for Grok bots (Chief and Helix CI Triage), once the Floor Warden routine is confirmed and its webhook URL is copied.
7. **Mobile.** PWA, tunnel, and push.
8. **Rooms MCP plugin.** Remote MCP server (Streamable HTTP + OAuth) for Meta Muse, ChatGPT, Claude Cowork, and any other app with custom connectors. Needs the tunnel from the mobile phase.
9. **Other humans.** Invites, OIDC, roles, and `invokable_by`.

## Rejected draft scope

The Gemini drafts contain the following items. None of them appears in the Hyperagent source, and none is adopted:

- A2A delegation frames
- Rego/OPA
- a $10,000 ceiling
- model-reported confidence thresholds as a security gate
- client-assigned sequence numbers
- an IndexedDB outbox
- Co-Owner and Editor roles

## Open questions

1. **Vendor claims.** The Cowork, ChatGPT, and Muse connector claims need checking against current vendor documentation.
2. **Floor Warden.** Confirm the Floor Warden routine and copy its webhook URL from the routine panel. Then decide the reply path: the rooms MCP plugin, or an outbound webhook from the Floor Warden to Sigil.
3. **Branch.** Should this work start on its own branch off `main`? The current branch is `fix/verify-contract-revocation-check`.
