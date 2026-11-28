# Sigil rooms: join request queue (relay design)

Status: draft for Chris's review. Refs #272 (backlog story 14, P1 in `2026-11-22-sigil-rooms-web-redesign-plan.md`).

Story: as an owner, I see join requests and accept, assign a role, or revoke.

Sourcing: **VERIFIED** means read in code on main at `2183624`. **INFERRED** means a conclusion from that code. **PROPOSED** is new design.

## 1. What the relay does today

- **VERIFIED:** There is no knock or join-request state anywhere in the relay, the migrations, or rooms-web.
- **VERIFIED:** Humans enter rooms only through `room_invites` + `room_invite_rooms` (migration 034). A room manager mints one with `sigil relay invite create --room <id>:<member|room_manager>`; there is no HTTP route to mint or list human invites.
- **VERIFIED:** An invite is a bearer token in the URL fragment (`/invite#<token>`), single use, with a TTL. `InvitePage` posts it into the GitHub login.
- **VERIFIED:** `completeLogin` → `link()` adds the rooms with no owner step: it provisions a new human, calls `addHumanToRoomsTx`, then consumes the invite. `recheckCreator` re-checks that the minter still manages each room.
- **VERIFIED:** For a human who already has an active login, `existing()` only opens a session. The invite's rooms are never added and the invite is not consumed.
- **INFERRED:** So an existing user cannot be brought into a second room at all. `POST /v1/rooms/:id/members` only accepts endpoints the caller owns. This gap blocks the queue as much as the missing state does.
- **VERIFIED:** Agents join through `room_agent_invites` (migration 043) and `POST /v1/room-agent-invites/redeem`, scoped to one named endpoint. That path stays as it is; this design covers humans only (Q10: no guests, only users and their linked agents).

## 2. Rules (PROPOSED)

1. No open rooms. A request can only start from an invite link a manager minted. No room ID lookup, no directory, no "anyone with the link" without the queue (plan failure mode 2).
2. A request is not membership. Until accepted, the requester sees nothing of the room beyond what the invite names (see open question 2) and cannot read, post, or invoke.
3. Every decision is recorded twice: an `audit_events` row, and on accept a signed `member_joined` room event from the relay system identity, so the timeline carries the record (P1 goal: "leave a signed record").
4. The decider is re-checked at decision time under the room lock, the same way `recheckCreator` checks the minter.
5. Agents are never auto-added. A linked agent joins later through the existing agent invite flow.

## 3. Data (PROPOSED, migration 044)

```sql
ALTER TABLE room_invite_rooms
  ADD COLUMN admission TEXT NOT NULL DEFAULT 'direct'
  CHECK (admission IN ('direct', 'request'));

CREATE TABLE room_join_requests (
  request_id TEXT PRIMARY KEY,                       -- jreq_<hex>
  room_id TEXT NOT NULL REFERENCES rooms (conversation_id) ON DELETE CASCADE,
  requester_human_id TEXT NOT NULL REFERENCES humans (human_id),
  requester_endpoint_id TEXT NOT NULL,
  invite_id TEXT NOT NULL REFERENCES room_invites (invite_id),
  offered_role TEXT NOT NULL CHECK (offered_role IN ('member', 'room_manager')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
  decided_role TEXT CHECK (decided_role IN ('member', 'room_manager')),
  decided_by_human_id TEXT REFERENCES humans (human_id),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'accepted') = (decided_role IS NOT NULL))
);

CREATE UNIQUE INDEX room_join_requests_open_idx
  ON room_join_requests (room_id, requester_human_id) WHERE status = 'pending';
```

- `direct` keeps every existing invite working unchanged.
- `request` is the default for invites minted from the web panel (section 5).
- Expiry is lazy, like `room_invites`: a pending row past `expires_at` reads as `expired` and is written as such on the next lock. Proposed TTL is 7 days.

## 4. Login changes (PROPOSED)

In `completeLogin`, after the invite is locked and `recheckCreator` passes:

- `direct` rooms: unchanged (`addHumanToRoomsTx`).
- `request` rooms: insert one `pending` row per room instead. A room where the human is already a member is skipped.
- Existing active human: the same split now also runs in `existing()`, and the invite is consumed. This closes the gap in section 1. Targeted-invite pin checks stay exactly as they are.
- The login still succeeds. The client lands on a "Waiting for the room owner" state (InvitePage pending state in the plan).

## 5. Routes (PROPOSED)

Manager routes; caller must be a human with role `owner` or `room_manager` (`MANAGER_ROLES`):

| Route | Does |
|---|---|
| `POST /v1/rooms/:id/invites` | Mint a human invite for this room, `admission: 'request'` by default. Returns the `/invite#` link once, like the CLI. |
| `GET /v1/rooms/:id/invites` | Open and recent invites for this room (state as `listInvites` computes it). |
| `POST /v1/rooms/:id/invites/:invite_id/revoke` | Revoke an unused link (wraps `revokeInvite`). |
| `GET /v1/rooms/:id/join-requests` | Pending requests first, then the last 50 decisions. |
| `POST /v1/rooms/:id/join-requests/:rid/accept` | Body `{ role }`, default the invite's `offered_role`. Locks the room, re-checks the decider, adds the member, emits `member_joined`. |
| `POST /v1/rooms/:id/join-requests/:rid/decline` | Marks declined. No reason is stored or shown. |

Requester routes; caller is the requesting human:

| Route | Does |
|---|---|
| `GET /v1/join-requests` | The caller's own requests and their status. |
| `POST /v1/join-requests/:rid/withdraw` | Withdraw a pending request. |

"Revoke" in the story maps to two existing acts: revoking an unused link (above) and removing a member after accept (`POST /v1/rooms/:id/members/:endpoint/remove`, unchanged).

Errors follow the room-routes style: `JOIN_REQUEST_NOT_FOUND` (404, also for another room's request), `JOIN_REQUEST_DECIDED` (409), `ROUTE_NOT_AUTHORIZED` (403), `INVALID_REQUEST` (400 for a role outside `GRANTABLE_ROLES`).

Live updates: `notifyRoomChange(roomId, 'join_requests')` on create, decide, withdraw, so the owner panel refreshes without polling.

## 6. Limits (PROPOSED)

- At most 50 pending requests per room; a request past that fails the login's room step with a clear message, not a silent drop.
- At most 20 pending requests per requester across rooms.
- Invites stay single use, so one link yields at most one requester (see open question 1).

## 7. Client (rooms-web)

- `JoinRequestQueue` side panel, owners and managers only: requester display name, time, offered role, Accept with a role picker, Decline.
- Invite panel in the same place: mint a link, list open links, Revoke.
- `InvitePage` and a signed-in "pending" view for the requester, with Withdraw.
- Accepted joins show in the timeline as the signed `member_joined` event, labeled as relay-signed (plan failure mode 10).

## 8. Tests to write first

- A `request` invite never adds a membership before accept, for a new and for an existing human.
- An existing human redeeming a `direct` invite now joins the room (regression for the section 1 gap).
- Accept by a manager who lost the role between request and decision is refused.
- Accept and decline race: exactly one wins; the loser gets `JOIN_REQUEST_DECIDED`.
- A request for room A cannot be read or decided through room B's route.
- Pending requests past `expires_at` cannot be accepted.
- The `member_joined` event is signed by the system identity and verifies.

## 9. Open questions for Chris

1. Should request-mode links be multi-use (one link, many requesters, each queued), or stay single use like today? Multi-use is closer to "join requests"; single use keeps today's bearer-link risk.
2. Before accept, may the requester see the room's name, or only "a room on this relay"?
3. Should a `room_manager` be able to accept, or only the `owner`?
4. Should existing CLI invites keep defaulting to `direct`?
