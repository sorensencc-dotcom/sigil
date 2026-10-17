-- Migration 035: Floor Warden Bridge & Room Reply Idempotency
-- Implements Phase 6 Floor Warden specification and reply idempotency table

CREATE TABLE IF NOT EXISTS room_reply_idempotency (
  room_id TEXT NOT NULL,
  reply_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  received_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, reply_id)
);

CREATE TABLE IF NOT EXISTS floor_warden_bots (
  bot_id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL UNIQUE REFERENCES endpoints(endpoint_id),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_signing_keys (
  key_id TEXT PRIMARY KEY REFERENCES endpoint_keys(key_id),
  wrapped_private_key BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for speedy room lookup
CREATE INDEX IF NOT EXISTS idx_room_reply_idempotency_room ON room_reply_idempotency(room_id);
