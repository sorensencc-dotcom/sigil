CREATE TABLE room_agent_invites (
  invite_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(conversation_id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_human_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX room_agent_invites_open_target_idx
  ON room_agent_invites (room_id, endpoint_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX room_agent_invites_room_created_idx
  ON room_agent_invites (room_id, created_at DESC);
