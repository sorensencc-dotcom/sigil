-- sigil/migrations/028_room_invocations.sql
-- Rooms phase 2: invocations (one decision to run one agent for one message),
-- the per-thread hop budget, and the per-room agent turn limit.

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS max_agent_turns INTEGER NOT NULL DEFAULT 6
  CHECK (max_agent_turns BETWEEN 1 AND 50);

CREATE TABLE IF NOT EXISTS room_invocations (
  invocation_id      TEXT PRIMARY KEY,
  room_id            TEXT NOT NULL REFERENCES rooms(conversation_id),
  workspace_id       TEXT NOT NULL REFERENCES workspaces(workspace_id),
  trigger_message_id TEXT NOT NULL,
  thread_root_id     TEXT NOT NULL,
  endpoint_id        TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  decided_by         TEXT NOT NULL CHECK (decided_by IN ('mention', 'router')),
  reason             TEXT,
  status             TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'refused')),
  cost_units         BIGINT,
  delivery_id        TEXT,
  reply_message_id   TEXT,
  created_at         TIMESTAMPTZ NOT NULL,
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  UNIQUE (trigger_message_id, endpoint_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS room_invocations_one_running_idx
  ON room_invocations (room_id, endpoint_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS room_invocations_queue_idx
  ON room_invocations (room_id, endpoint_id, created_at)
  WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS room_threads (
  room_id        TEXT NOT NULL REFERENCES rooms(conversation_id),
  thread_root_id TEXT NOT NULL,
  agent_turns    INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_id, thread_root_id)
);
