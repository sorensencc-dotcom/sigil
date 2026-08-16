# Sigil `inbox --wait` — design

## Problem

Sigil messages only surface to a human-run terminal (`sigil inbox --watch`). Getting a
message into an actual agent turn (Claude Code, Codex CLI) requires a human to manually
relay "check your inbox" — demonstrated live in the 2026-08-15 session, twice, both
directions.

## Decision

Approach A (converged with Codex over Sigil itself, 2026-08-15): add `sigil inbox --wait`,
a one-shot command that blocks until exactly one message is available, prints it,
acknowledges it, and exits 0. Each host backgrounds this after finishing a turn; when the
process exits, the host's own background-task-completion notification (proven working in
this session for `relay up`) surfaces the message into the live session. The host then
re-backgrounds `inbox --wait` to arm for the next message.

Rejected: a real inbound webhook per host (B) — neither host exposes a stable inbound-HTTP
surface for this today, so it'd mean building and keeping alive a helper daemon per host
for no gain over the exit-triggered notification. Cron polling (C) — reintroduces the
latency `stream-server.mjs` already exists to avoid.

**Important scope boundary:** background-task-completion-on-process-exit is host
behavior, not a Sigil protocol guarantee. This design documents it as an *adapter
convention* per host, not something the relay or CLI core can promise. Confirmed for
Claude Code this session; Codex CLI's equivalent mechanism is not yet confirmed and is
out of scope here (see Follow-ups).

## Command

```
sigil inbox --wait --identity <path> --relay-url <url> [--stream-url <url>] [--timeout ms]
```

- `--identity`, `--relay-url`, `--stream-url` resolve exactly like `send`/`inbox` today
  (flag > env > `.sigil/config.json` > default, from the just-shipped `config-resolver.mjs`).
- `--timeout` (default 300000 = 5 min): if no message arrives before the timeout, exit
  code `2` with no output on stdout (a message on stderr is fine). Lets a host convention
  detect "still waiting" vs "something broke" vs "got a message" by exit code alone.

## Behavior

1. On start, do one immediate `reconcileInbox('')` poll (reuses the existing `poll()` used
   by non-watch `inbox`). This catches a message that arrived before this process started
   (e.g. during the gap between the previous `--wait` exiting and this one launching).
2. If the poll returns one or more delivered-unacked items, take the **first** item only.
   Print it. Only after the print call returns successfully, acknowledge that one
   `delivery_id`. Exit 0. Any remaining items stay unacknowledged in the inbox — the next
   `--wait` invocation's step 1 poll will pick them up. (This is what makes "exactly one
   message per invocation" safe: `acknowledgeDelivery` already scopes to a single
   `delivery_id`, and `listInbox` already filters to `state === 'delivered'`, so unacked
   items simply persist for the next call — no new relay/repository code needed.)
   **Cursor requirement:** `--wait` must call `reconcileInbox('')` every time — an empty
   cursor, never advanced to `page.nextSince`. Ack state (not the cursor) is what
   determines what the next invocation sees; advancing the cursor past the consumed
   item's `queued_at` would silently skip any other unconsumed items still in that same
   page (`listInbox`'s filter is `queued_at > since`, so a cursor sitting exactly on or
   after a skipped item's timestamp hides it forever). This is a distinct code path from
   `--watch`'s `poll()`, which legitimately advances `since` because it drains and acks
   every item in the page, not just the first.
3. If step 1 finds nothing, open the WebSocket stream (same `connect()`/reconnect-backoff
   logic already in `cmdInbox --watch`) and wait for a `delivered` event, then repeat step
   1's poll (the event just tells us to re-poll; the poll is what's authoritative).
4. If the socket drops and reconnects while waiting, no special handling needed beyond
   what already exists in `--watch`: reconnect keeps the same wait open, and if a message
   arrived during the gap, the eventual reconnect (or the 30s fallback poll timer already
   in `cmdInbox`) still finds it via step 1 semantics on the next scheduled poll — a
   message never becomes invisible because acknowledgement, not polling frequency, is what
   consumes it.

## Error handling

- **Auth failure (401 from initial poll or socket handshake):** exit code `3`, stderr
  message, no retry — matches "fail loud on auth" precedent already in this session (the
  stale-relay-snapshot incident).
- **Connection failure (relay unreachable):** exit code `4`, stderr message, no retry —
  host convention decides whether to back off and re-launch `--wait` itself.
- **Malformed message (JSON parse failure on the delivered item):** exit code `5`, stderr
  message, **do not acknowledge** the malformed item (leave it for a human to inspect via
  plain `sigil inbox`, not silently drop it).
- **SIGINT/SIGTERM while waiting:** close the socket cleanly, exit `130`/`143`
  respectively, do not acknowledge anything (nothing was printed yet in this path by
  construction — acknowledge only happens after a successful print, per step 2).

## Files touched

- `sigil/cli/sigil.mjs` — new `--wait` branch in `cmdInbox`, reusing existing `poll()`,
  `connect()`/reconnect-backoff, and `resolveConfig()`. No new files needed; this is an
  addition to an existing command's flag handling, matching the file's existing shape.
- `docs/meta/sigil-cli-roadmap.md` — update roadmap item 4/5 to reflect `--wait` shipping
  and the adapter-convention caveat.
- New: a short per-host adapter note (where CLAUDE.md-equivalent conventions live for each
  host) describing "background `inbox --wait`, act on its exit, re-background." Claude
  Code side can go in this repo's own docs; Codex CLI side is Codex's own follow-up (see
  below) since only Codex can confirm its own automation surface.

## Testing

- Unit: extend `sigil/cli/` tests (`node --test`) for the new poll-then-ack-first-only
  logic — mock repository with 2+ queued items, assert only the first is acked and printed,
  second remains in a subsequent `listInbox` call.
- Unit: timeout path (no messages, timeout fires, exit code 2, nothing acked).
- Unit: malformed-message path does not acknowledge.
- Manual/live: repeat this session's Claude↔Codex round trip, but with `--wait` backgrounded
  on both sides instead of manually telling Codex to check its inbox — success criterion is
  zero manual "check your inbox" messages needed for one full round trip.

## Follow-ups (explicitly out of scope here)

- Confirming Codex CLI's own background-task-completion / notify mechanism, and writing
  its adapter convention — Codex's own task, flagged for Codex to pick up.
- A `/sigil-consult` skill wrapping "send context to a Sigil peer, wait for reply" —
  deferred per user, tracked in Claude's memory
  (`project-sigil-consult-skill-backlog-2026-08-15.md`), depends on `--wait` landing first.
