-- Join request queue for human room invites (#272, design
-- docs/superpowers/specs/2026-11-28-sigil-rooms-join-requests-design.md).
-- An invite room is either 'direct' (redeeming adds the membership, the
-- behaviour of every invite before this migration) or 'request' (redeeming
-- queues a join request that a room owner or manager accepts or declines).
ALTER TABLE room_invite_rooms
  ADD COLUMN admission TEXT NOT NULL DEFAULT 'direct'
  CHECK (admission IN ('direct', 'request'));

CREATE TABLE room_join_requests (
  request_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms (conversation_id) ON DELETE CASCADE,
  requester_human_id TEXT NOT NULL REFERENCES humans (human_id),
  requester_endpoint_id TEXT NOT NULL REFERENCES endpoints (endpoint_id),
  invite_id TEXT NOT NULL REFERENCES room_invites (invite_id),
  offered_role TEXT NOT NULL CHECK (offered_role IN ('member', 'room_manager')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
  decided_role TEXT CHECK (decided_role IN ('member', 'room_manager')),
  decided_by_human_id TEXT REFERENCES humans (human_id),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  CHECK (request_id ~ '^jreq_[0-9a-f]{32}$'),
  CHECK (expires_at > created_at),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'accepted') = (decided_role IS NOT NULL))
);

-- One open request per person per room.
CREATE UNIQUE INDEX room_join_requests_open_idx
  ON room_join_requests (room_id, requester_human_id) WHERE status = 'pending';

CREATE INDEX room_join_requests_room_created_idx
  ON room_join_requests (room_id, created_at DESC);

CREATE INDEX room_join_requests_requester_idx
  ON room_join_requests (requester_human_id, created_at DESC);
