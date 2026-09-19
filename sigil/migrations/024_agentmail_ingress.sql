CREATE TABLE agentmail_ingress_events (
  event_id TEXT PRIMARY KEY,
  provider_event_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('received', 'quarantined', 'accepted', 'dispatched', 'completed', 'rejected', 'dead_lettered')),
  provenance JSONB NOT NULL DEFAULT '{}',
  rejection_code TEXT,
  envelope_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (provider_event_id, provider_message_id, inbox_id)
);

CREATE INDEX agentmail_ingress_state_idx ON agentmail_ingress_events(state, updated_at);
