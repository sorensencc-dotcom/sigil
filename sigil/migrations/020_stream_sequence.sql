-- sigil/migrations/020_stream_sequence.sql
-- Add relay-assigned, per-sender conversation sequence persistence.

CREATE TABLE IF NOT EXISTS stream_sequences (
  sender_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  conversation_id    TEXT NOT NULL REFERENCES conversations(conversation_id),
  next_seq           BIGINT NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (sender_endpoint_id, conversation_id)
);

ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS stream_seq BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS envelopes_stream_seq_idx
  ON envelopes (sender_endpoint_id, conversation_id, stream_seq)
  WHERE stream_seq IS NOT NULL;
