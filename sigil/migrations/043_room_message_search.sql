-- Substring search for room.message bodies. Room membership and sequence filters
-- remain in the query; this index supplies the case-insensitive text match.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS envelopes_room_message_text_trgm_idx
  ON envelopes USING GIN ((body->>'text') gin_trgm_ops)
  WHERE message_type = 'room.message';
