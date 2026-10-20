-- Per-bot bearer tokens for the Floor Warden reply ingress.

CREATE TABLE IF NOT EXISTS floor_warden_reply_tokens (
  token_id     TEXT PRIMARY KEY,
  bot_id       TEXT NOT NULL REFERENCES floor_warden_bots(bot_id),
  token_sha256 BYTEA NOT NULL UNIQUE,
  status       TEXT NOT NULL CHECK (status IN ('active', 'retired', 'revoked')),
  created_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS floor_warden_reply_tokens_bot_status_idx
  ON floor_warden_reply_tokens (bot_id, status);

ALTER TABLE quota_usage DROP CONSTRAINT quota_usage_scope_kind_check;
ALTER TABLE quota_usage ADD CONSTRAINT quota_usage_scope_kind_check CHECK (scope_kind IN (
  'endpoint', 'owner', 'conversation',
  'directory_invite_create', 'directory_invite_redeem', 'directory_match_create', 'directory_match_attempt',
  'federation_origin', 'federation_directory_invite_create', 'federation_directory_redeem',
  'federation_directory_redemption_inbound',
  'invite', 'oauth_provider_subject', 'oauth_start', 'floor_warden_reply'));
