CREATE TABLE IF NOT EXISTS agentmail_ingress_control (
  control_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('enabled', 'draining', 'disabled')),
  version BIGINT NOT NULL CHECK (version > 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  reason TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO agentmail_ingress_control (control_id, state, version, reason, updated_by)
VALUES ('agentmail', 'disabled', 1, 'bootstrap requires explicit resume', 'system')
ON CONFLICT (control_id) DO NOTHING;
