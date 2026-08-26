-- sigil/migrations/016_peer_relays.sql
-- Sub-project #2 (inter-relay trust/discovery): a relay operator's durably
-- pinned trust record for a foreign domain's relay -- endpoint URL(s) and
-- the Ed25519 key set to trust for it. `keys` is a JSONB array (not a
-- single-key column) so a peer's full trusted key set can be recorded and
-- inspected at once, rather than one key at a time.
CREATE TABLE IF NOT EXISTS peer_relays (
  domain            TEXT PRIMARY KEY,
  relay_url         TEXT NOT NULL,
  ws_url            TEXT,
  keys              JSONB NOT NULL,
  trust_mode        TEXT NOT NULL DEFAULT 'tofu' CHECK (trust_mode IN ('tofu', 'static')),
  discovered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_resolved_at  TIMESTAMPTZ
);
