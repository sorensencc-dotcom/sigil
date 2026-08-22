-- sigil/migrations/012_directory_trust.sql
-- Endpoint directory/trust spec (docs/specs/sigil-endpoint-directory-trust-spec-v1.0.md).
-- All four tables ship together: directory_links FKs into both
-- directory_invites and directory_match_requests as its optional source.

CREATE TABLE IF NOT EXISTS oidc_issuer_allowlist (
  issuer TEXT PRIMARY KEY,
  display_label TEXT NOT NULL,
  discovery_url TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  assurance_level TEXT NOT NULL DEFAULT 'standard' CHECK (assurance_level = 'standard'),
  added_by TEXT,
  added_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS directory_invites (
  invite_id TEXT PRIMARY KEY,
  issuer_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  issuer_human_id TEXT NOT NULL REFERENCES humans(human_id),
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'redeemed', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_by_human_id TEXT REFERENCES humans(human_id),
  redeemed_at TIMESTAMPTZ,
  home_relay TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS directory_invites_code_hash_idx ON directory_invites(code_hash);

CREATE TABLE IF NOT EXISTS directory_match_requests (
  request_id TEXT PRIMARY KEY,
  issuer_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  issuer_human_id TEXT NOT NULL REFERENCES humans(human_id),
  issuer TEXT NOT NULL REFERENCES oidc_issuer_allowlist(issuer),
  match_target_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'matched', 'consumed', 'expired', 'revoked')),
  matched_human_id TEXT REFERENCES humans(human_id),
  matched_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  home_relay TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS directory_match_requests_target_idx ON directory_match_requests(issuer, match_target_hash);

CREATE TABLE IF NOT EXISTS directory_links (
  link_id TEXT PRIMARY KEY,
  endpoint_a TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  endpoint_b TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  human_a TEXT NOT NULL REFERENCES humans(human_id),
  human_b TEXT NOT NULL REFERENCES humans(human_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  initiated_via TEXT NOT NULL CHECK (initiated_via IN ('invite', 'oidc_match')),
  source_invite_id TEXT REFERENCES directory_invites(invite_id),
  source_request_id TEXT REFERENCES directory_match_requests(request_id),
  a_confirmed_at TIMESTAMPTZ,
  b_confirmed_at TIMESTAMPTZ,
  a_confirmed_by TEXT REFERENCES humans(human_id),
  b_confirmed_by TEXT REFERENCES humans(human_id),
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT REFERENCES humans(human_id),
  home_relay TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (endpoint_a <> endpoint_b),
  CHECK (human_a <> human_b)
);

CREATE UNIQUE INDEX IF NOT EXISTS directory_links_active_pair_idx
  ON directory_links(endpoint_a, endpoint_b) WHERE status IN ('pending', 'active');

-- Reverse-direction lookup (sender/recipient order is not fixed at query
-- time; spec §4 fixes storage order only, the accept-transaction check
-- looks up both directions).
CREATE INDEX IF NOT EXISTS directory_links_endpoint_b_idx ON directory_links(endpoint_b, endpoint_a);

-- Widen the existing rolling-window rate-limit scope set (design §8) to
-- cover the four directory abuse-surface scopes (spec §6). Constraint is
-- dropped/re-added by name since Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS for CHECK constraints; re-running this migration is still safe
-- because DROP CONSTRAINT IF EXISTS makes the drop itself idempotent.
ALTER TABLE quota_usage DROP CONSTRAINT IF EXISTS quota_usage_scope_kind_check;
ALTER TABLE quota_usage ADD CONSTRAINT quota_usage_scope_kind_check
  CHECK (scope_kind IN ('endpoint', 'owner', 'conversation',
                         'directory_invite_create', 'directory_invite_redeem',
                         'directory_match_create', 'directory_match_attempt'));
