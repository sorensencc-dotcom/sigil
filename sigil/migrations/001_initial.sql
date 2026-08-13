CREATE TABLE humans (
  human_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE human_credentials (
  credential_id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL REFERENCES humans(human_id),
  type TEXT NOT NULL CHECK (type = 'webauthn'),
  public_key BYTEA NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  UNIQUE (human_id, credential_id)
);

CREATE TABLE endpoints (
  endpoint_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES humans(human_id),
  runtime TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'revoked', 'decommissioned')),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (endpoint_id, owner_id)
);

CREATE TABLE endpoint_keys (
  key_id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
  public_key BYTEA NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retiring', 'retired')),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_scope TEXT,
  created_by TEXT NOT NULL REFERENCES humans(human_id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  role TEXT NOT NULL,
  added_by TEXT NOT NULL REFERENCES humans(human_id),
  added_at TIMESTAMPTZ NOT NULL,
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, endpoint_id)
);

CREATE TABLE envelopes (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  protocol TEXT NOT NULL CHECK (protocol = 'sigil/1'),
  message_type TEXT NOT NULL,
  sender_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  sender_owner_id TEXT NOT NULL REFERENCES humans(human_id),
  recipient_endpoint_id TEXT REFERENCES endpoints(endpoint_id),
  broadcast_scope JSONB,
  body JSONB NOT NULL,
  context_refs JSONB NOT NULL DEFAULT '[]',
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  idempotency_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  signature_algorithm TEXT NOT NULL CHECK (signature_algorithm = 'Ed25519'),
  signature_key_id TEXT NOT NULL REFERENCES endpoint_keys(key_id),
  signature_value TEXT NOT NULL,
  canonical_bytes BYTEA NOT NULL,
  action_hash TEXT,
  envelope_status TEXT NOT NULL DEFAULT 'accepted',
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + INTERVAL '24 hours'),
  CHECK ((recipient_endpoint_id IS NULL) <> (broadcast_scope IS NULL)),
  FOREIGN KEY (sender_endpoint_id, sender_owner_id)
    REFERENCES endpoints(endpoint_id, owner_id)
);

CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES envelopes(message_id),
  recipient_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'acknowledged', 'processing', 'processed', 'processing_failed', 'delivery_rejected', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  queued_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  processing_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  failure_reason TEXT,
  UNIQUE (message_id, recipient_endpoint_id)
);

CREATE TABLE approval_requests (
  request_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES envelopes(message_id),
  action_hash TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES approval_requests(request_id),
  actor_id TEXT NOT NULL REFERENCES humans(human_id),
  credential_id TEXT NOT NULL,
  auth_method TEXT NOT NULL CHECK (auth_method = 'webauthn'),
  action_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'expired')),
  scope TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (actor_id, credential_id)
    REFERENCES human_credentials(human_id, credential_id)
);

CREATE TABLE capability_grants (
  grant_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_to TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  granted_by TEXT NOT NULL REFERENCES humans(human_id),
  granted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE capability_revocations (
  revocation_id TEXT PRIMARY KEY,
  capability_grant_id TEXT NOT NULL REFERENCES capability_grants(grant_id),
  revoked_by TEXT NOT NULL REFERENCES humans(human_id),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE idempotency_keys (
  idempotency_key TEXT NOT NULL,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  message_id TEXT NOT NULL REFERENCES envelopes(message_id),
  canonical_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (endpoint_id, idempotency_key)
);

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX envelopes_conversation_created_idx ON envelopes(conversation_id, created_at);
CREATE INDEX deliveries_recipient_state_idx ON deliveries(recipient_endpoint_id, state);
CREATE INDEX idempotency_expiry_idx ON idempotency_keys(expires_at);
CREATE INDEX audit_subject_created_idx ON audit_events(subject_id, created_at);
