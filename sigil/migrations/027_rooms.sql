-- Rooms: multi-party conversations with relay-assigned room_seq ordering.
-- A room is a conversations row (kind = 'room'); its roster is conversation_members.

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_by   TEXT NOT NULL REFERENCES humans(human_id),
  created_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(conversation_id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id),
  name            TEXT NOT NULL,
  description     TEXT,
  next_room_seq   BIGINT NOT NULL DEFAULT 1,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, name)
);

ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS response_mode TEXT
  CHECK (response_mode IS NULL OR response_mode IN ('joins', 'mentions_only'));

ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS room_seq BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS envelopes_room_seq_idx
  ON envelopes (conversation_id, room_seq)
  WHERE room_seq IS NOT NULL;
