-- Floor Warden bridge: bot roster, relay-held bot signing keys, per-thread cap epoch.

CREATE TABLE IF NOT EXISTS floor_warden_bots (
  bot_id       TEXT PRIMARY KEY,
  endpoint_id  TEXT NOT NULL UNIQUE REFERENCES endpoints(endpoint_id),
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_signing_keys (
  key_id              TEXT PRIMARY KEY REFERENCES endpoint_keys(key_id),
  wrapped_private_key BYTEA NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL
);

ALTER TABLE room_threads ADD COLUMN IF NOT EXISTS cap_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_threads ADD COLUMN IF NOT EXISTS last_reset_at TIMESTAMPTZ;
