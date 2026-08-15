-- Security hardening: bind WebAuthn credentials to endpoints and persist
-- approval challenges so verification survives process restarts and races.
ALTER TABLE human_credentials
  ADD COLUMN endpoint_id TEXT REFERENCES endpoints(endpoint_id);

CREATE INDEX human_credentials_endpoint_idx ON human_credentials(endpoint_id, status);

CREATE TABLE approval_challenges (
  challenge_id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  action_hash TEXT NOT NULL,
  webauthn_challenge TEXT NOT NULL UNIQUE,
  callback_url TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consuming', 'consumed', 'expired', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE INDEX approval_challenges_pending_idx ON approval_challenges(status, expires_at);
