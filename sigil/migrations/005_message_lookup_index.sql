-- Composite index for the scoped (sender_endpoint_id, message_id) replay
-- lookup (design §6 blocker 3). Uniqueness is already guaranteed by
-- envelopes.message_id PRIMARY KEY (001_initial.sql); this index exists so
-- lookupAcceptedMessageId's WHERE clause -- scoped to both columns, never a
-- bare message_id lookup -- doesn't fall back to a full PK-only scan plan
-- that ignores the endpoint filter.
CREATE INDEX IF NOT EXISTS envelopes_sender_message_idx ON envelopes(sender_endpoint_id, message_id);
