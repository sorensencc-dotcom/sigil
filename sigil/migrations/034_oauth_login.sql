-- OAuth login: invites, verified identities, cookie sessions.

ALTER TABLE oidc_identities
  ADD COLUMN verified_via TEXT,
  ADD COLUMN endpoint_id TEXT,
  ADD CONSTRAINT oidc_identities_verified_via_check CHECK (verified_via IN ('oauth')),
  ADD CONSTRAINT oidc_identities_verified_endpoint_check CHECK (verified_via IS NULL OR endpoint_id IS NOT NULL),
  ADD CONSTRAINT oidc_identities_endpoint_owner_fk
    FOREIGN KEY (endpoint_id, human_id) REFERENCES endpoints (endpoint_id, owner_id);

ALTER TABLE human_sessions
  ADD COLUMN endpoint_id TEXT,
  ADD COLUMN last_seen_at TIMESTAMPTZ,
  ADD COLUMN identity_issuer TEXT,
  ADD COLUMN identity_subject TEXT,
  ADD CONSTRAINT human_sessions_identity_pair_check
    CHECK ((identity_issuer IS NULL) = (identity_subject IS NULL)),
  ADD CONSTRAINT human_sessions_cookie_row_check
    CHECK (endpoint_id IS NULL OR (last_seen_at IS NOT NULL AND identity_issuer IS NOT NULL)),
  ADD CONSTRAINT human_sessions_endpoint_owner_fk
    FOREIGN KEY (endpoint_id, human_id) REFERENCES endpoints (endpoint_id, owner_id);
CREATE INDEX human_sessions_identity_idx ON human_sessions (identity_issuer, identity_subject);

CREATE TABLE room_invites (
  invite_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by_human_id TEXT NOT NULL REFERENCES humans (human_id),
  target_human_id TEXT,
  target_endpoint_id TEXT,
  target_issuer TEXT,
  target_subject TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_human_id TEXT REFERENCES humans (human_id),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT room_invites_consumed_pair_check CHECK ((consumed_at IS NULL) = (consumed_by_human_id IS NULL)),
  CONSTRAINT room_invites_not_both_check CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT room_invites_target_all_or_none_check CHECK (
    (target_human_id IS NULL AND target_endpoint_id IS NULL AND target_issuer IS NULL AND target_subject IS NULL)
    OR (target_human_id IS NOT NULL AND target_endpoint_id IS NOT NULL AND target_issuer IS NOT NULL AND target_subject IS NOT NULL)),
  CONSTRAINT room_invites_target_endpoint_fk
    FOREIGN KEY (target_endpoint_id, target_human_id) REFERENCES endpoints (endpoint_id, owner_id)
);

CREATE TABLE room_invite_rooms (
  invite_id TEXT NOT NULL REFERENCES room_invites (invite_id),
  room_id TEXT NOT NULL REFERENCES rooms (conversation_id),
  role TEXT NOT NULL CHECK (role IN ('member', 'room_manager')),
  PRIMARY KEY (invite_id, room_id)
);

ALTER TABLE quota_usage DROP CONSTRAINT quota_usage_scope_kind_check;
ALTER TABLE quota_usage ADD CONSTRAINT quota_usage_scope_kind_check CHECK (scope_kind IN (
  'endpoint', 'owner', 'conversation',
  'directory_invite_create', 'directory_invite_redeem', 'directory_match_create', 'directory_match_attempt',
  'federation_origin', 'federation_directory_invite_create', 'federation_directory_redeem',
  'federation_directory_redemption_inbound',
  'invite', 'oauth_provider_subject', 'oauth_start'));
