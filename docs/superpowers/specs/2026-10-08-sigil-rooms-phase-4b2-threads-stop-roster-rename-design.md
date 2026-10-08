# Sigil rooms phase 4b-2: threads, Stop, roster modes, and rename design

Status: draft for review, 2026-10-08.
Parent spec: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` (Clients section and delivery phase 4).
Builds on: phase 4a (relay browser surface, PR #33) and phase 4b-1 (web client, PR #37), plus the create-room form (PR #39) and pinned rooms (PR #40).

## Goal

A human working in the web client can reply in a thread, stop a runaway room, see which agents are in a room and how each responds, change an agent's response mode, and rename a room. Threads and Stop need no relay change. Rename and response-mode editing need two new relay routes, because the relay has neither.

## Scope

In scope:

- Relay: `POST /v1/rooms/{room_id}/rename`, `POST /v1/rooms/{room_id}/members/{endpoint_id}/response-mode`, and a third `room.updated` `changed` value, `room`.
- Client: thread side panel, Stop button, roster panel with response-mode editing, and inline rename.
- Contract entries in `sigil/contracts/v1/relay-api.json` and the web package's contract test.

Out of scope, with the reason:

- Adding and removing members from the UI. The routes exist, but the UI needs an endpoint picker and no route lists the caller's endpoints.
- A `room.event` row for rename. It would consume a `room_seq`, and the sidebar title refresh does not need one.
- Approval cards, mention autocomplete, and thread unread badges. Approval cards depend on the WebAuthn design. The other two are polish.
- A `GET /v1/me` route. The client keeps learning its own endpoint ID from its first successful send, as in 4b-1 (see Limits).

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Response modes | Editable by room managers | The parent spec says room managers manage response modes. A display-only roster leaves the only change path as remove and re-add, and re-adding an existing member answers `409 ROOM_MEMBER_EXISTS`. |
| Rename | New relay route, never faked client-side | The room name lives in `conversations.name` with `UNIQUE (workspace_id, name)`. Only the relay can enforce that. |
| Rename frame | New `changed: 'room'` value | `messages` and `members` do not describe a title change, and overloading either makes clients refetch the wrong data. |
| Rename audit row | None | See Scope. |
| Threads | Side panel derived from the cached history | Replies are already `room.message` rows with `thread_root_id`, so no fetch route is needed. |
| Stop | Button in the room header, no confirm dialog | The action is cheap, and the relay emits a `room.event` that the timeline renders. |

## Relay changes

Both routes sit in `sigil/relay/v1/room-routes.mjs` next to the member add and remove handlers and follow their guards.

### Rename

`POST /v1/rooms/{room_id}/rename` with body `{name}`.

- The caller must be a room member (`404 ROOM_NOT_FOUND` otherwise), not an agent endpoint (`403 HUMAN_CONTEXT_REQUIRED`), and hold the `owner` or `room_manager` role (`403 ROUTE_NOT_AUTHORIZED`).
- `name` follows the create rules: a string, trimmed, 1 to `NAME_MAX` characters (`400 INVALID_REQUEST`).
- The new repository method `renameRoom({conversationId, name, now})` runs one `UPDATE conversations SET name = $2 WHERE conversation_id = $1`. A unique violation on `(workspace_id, name)` throws `ROOM_NAME_TAKEN`, which the route maps to `409`, as create does.
- Renaming to the current name answers `200` and changes nothing.
- The memory repository applies the same uniqueness rule that its `createRoom` applies (`memory-repository.mjs:292`).
- Response: `200 {code: 'OK', room}`, with the same room shape as create.
- After commit, `notifyRoomHumans` sends `room.updated` with `changed: 'room'` and no `room_seq`.

### Response mode

`POST /v1/rooms/{room_id}/members/{endpoint_id}/response-mode` with body `{response_mode}`.

- Same caller guards as rename.
- `response_mode` must be `joins`, `mentions_only`, or `router`, the values the add route accepts (`400 INVALID_REQUEST`).
- The target must be an active member (`404 ROOM_MEMBER_NOT_FOUND`) and an agent. A human target answers `400 INVALID_REQUEST`, matching the add route's rule that `response_mode` applies only to agent endpoints. The room owner's role is unchanged, and the owner is a human, so the same rule covers it.
- The new repository method `setRoomMemberResponseMode({conversationId, endpointId, responseMode})` runs one `UPDATE conversation_members` on the member's active row.
- Response: `200 {code: 'OK', member}`.
- After commit, the route sends `room.updated` with `changed: 'members'`.

Open item for the plan: when a room already has a `router` member and a manager sets a second agent to `router`, decide whether the relay refuses it. Read the router-selection code (`room-policy.mjs:99`) first and pin the behavior with a test either way.

### Frame and contract

- `room.updated` `changed_values` becomes `["messages","members","room"]`. A `room` frame omits `room_seq`, like `members`.
- `notifyRoomHumans` accepts `changed: 'room'`. Its commit-point rule is unchanged: the frame fires after commit, never inside the transaction.
- `relay-api.json` gains both routes with their errors and request and response fields, and the new `changed` value. `relay-api.test.mjs` keeps checking the entries.

### Relay tests

- Rename: success, no-op rename, name conflict in both repositories, non-member, agent caller, non-manager, name length bounds, and one `room.updated` frame with `changed: 'room'` after commit. A forced rollback sends none.
- Response mode: success, invalid value, human target, non-member target, non-manager, and a `members` frame after commit.
- The Postgres cases sit in a `*.pg.test.mjs` file behind `assert-disposable-test-db.mjs`.

## Client changes

All changes are in `packages/sigil-rooms-web/`.

### API and live updates

- `api/client.ts` gains `renameRoom`, `setResponseMode`, `listMembers`, and `stopRoom`.
- `api/types.ts` gains `Member` and widens `RoomUpdatedFrame.changed` to `'messages' | 'members' | 'room'`.
- `live/useLive.ts` handles the frames:
  - `room` invalidates `['rooms']`.
  - `members` invalidates `['room', id, 'members']`.
  - A reconnect refetches the roster with everything else.
- `api/contract.spec.ts` asserts the new routes, field names, and error codes.

### Threads

- Each message row gets a "Reply" action that opens `ThreadPanel` beside the timeline.
- The panel shows the root row and every row whose `body.thread_root_id` equals the root's `message_id`, grouped from the history cache the timeline already holds.
- The panel's composer uses `useSend` with an optional `threadRootId`, sent as `thread_root_id`.
- The main timeline shows top-level rows only. A root with replies shows an "N replies" link that opens the panel.
- One thread is open at a time. Opening another replaces it, and switching rooms closes it.
- A reply whose root is missing from the cache (an unloaded page) shows under a placeholder root. The panel never drops it.
- Agent answers land in the trigger's thread, so they appear here without extra work.

### Stop

- A Stop button in the room header calls `stopRoom`. It is disabled while the request runs.
- The relay emits the `room.event`, and the timeline already renders it.
- `404 ROOM_NOT_FOUND` follows the existing path back to the room list.

### Roster panel

- `RosterPanel`, collapsible in the room header, lists members with role and response-mode badges.
- A manager sees a mode `<select>` on agent rows. Changing it calls `setResponseMode` and refetches the roster. Non-managers see badges only.
- The owner row and human rows carry no controls.

### Inline rename

- A pencil button next to the room title swaps the title for an input with Save and Cancel, for managers only.
- `409 ROOM_NAME_TAKEN` shows the same message as the create form. `404 ROOM_NOT_FOUND` returns to the list.
- On success the client invalidates `['rooms']`. Other tabs update through the `room` frame.

## Limits

- The client learns its own endpoint ID only after its first successful send, and keeps it in `sessionStorage` (4b-1). Until then it cannot find its own roster row, so the roster panel is read-only and the rename button is hidden. Sending any message unlocks both. A `GET /v1/me` route would remove the limit and is a separate, auth-adjacent change.
- The relay stays the authority. A client that shows a control to a non-manager still gets `403 ROUTE_NOT_AUTHORIZED` and shows "Only room managers can do this".

## Error handling

| Case | Behavior |
|---|---|
| `409 ROOM_NAME_TAKEN` on rename | Keep the input open and show the relay's message. |
| `403 ROUTE_NOT_AUTHORIZED` on rename or mode | Show "Only room managers can do this" and refetch the roster. |
| `404 ROOM_NOT_FOUND` on any room call | Drop the room from the list and return to the list. |
| `404 ROOM_MEMBER_NOT_FOUND` on mode | Refetch the roster. |
| `400 INVALID_REQUEST` on rename or mode | Show the relay's message. No retry. |
| Network or CORS failure | The existing banner. |

## Testing

- **Relay:** see Relay tests.
- **Web unit (Vitest and Testing Library):**
  - New `client` methods, including error mapping.
  - Thread grouping with a missing root and out-of-order replies.
  - `ThreadPanel` sending with `thread_root_id`.
  - Stop, including the disabled state.
  - Roster edits for a manager and the read-only view for others.
  - Rename success and each error row above.
  - `useLive` handling of the `room` and `members` frames.
- **Contract:** as above.
- **End-to-end (Playwright):** rename a room and see the sidebar update, reply in a thread, and press Stop. The mode change runs end to end only if the harness can seed a human-owned agent endpoint. Otherwise unit and relay tests cover it, and the plan records which.
- **Gates:** the web package stays outside the root workspace and core gates, as in 4b-1. The relay changes run under the core suite.

## Delivery

1. Spec review.
2. Implementation plan through the writing-plans skill, in `docs/superpowers/plans/`. The relay work lands first, then the client, as separate tasks in one plan.
3. Plan execution through subagent-driven development, in a fresh worktree off `main`.
