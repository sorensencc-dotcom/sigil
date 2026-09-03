-- sigil/migrations/018_federation_directory.sql
-- Sub-project #4 (cross-federation directory) -- design
-- docs/superpowers/specs/2026-09-02-sigil-cross-federation-directory-design.md.
-- Requires PostgreSQL 13+ (gen_random_uuid() core builtin), same floor as 017.

CREATE TABLE IF NOT EXISTS federation_directory_invites (
  invite_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_ref                 UUID NOT NULL UNIQUE,
  issuer_endpoint_id       TEXT NOT NULL,
  issuer_owner_id          TEXT NOT NULL,
  peer_domain              TEXT NOT NULL,
  code_hash                TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'redeemed', 'expired', 'revoked')),
  redeemed_by_owner_id     TEXT,
  redeemed_by_endpoint_id  TEXT,
  redeemed_at              TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS federation_directory_invites_peer_codehash_uidx
  ON federation_directory_invites (peer_domain, code_hash);
CREATE INDEX IF NOT EXISTS federation_directory_invites_status_expiry_idx
  ON federation_directory_invites (status, expires_at);

CREATE TABLE IF NOT EXISTS federation_directory_links (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_ref             UUID NOT NULL UNIQUE,
  local_owner_id       TEXT NOT NULL,
  local_endpoint_id    TEXT NOT NULL,
  remote_owner_id      TEXT NOT NULL,
  remote_endpoint_id   TEXT NOT NULL,
  remote_domain        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('issuer', 'redeemer')),
  initiated_via        TEXT NOT NULL DEFAULT 'invite'
                         CHECK (initiated_via IN ('invite', 'oidc_match')),
  status               TEXT NOT NULL
                         CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  local_confirmed_at   TIMESTAMPTZ,
  remote_confirmed_at  TIMESTAMPTZ,
  source_invite_id     UUID,
  peer_domain          TEXT NOT NULL,
  revoked_at           TIMESTAMPTZ,
  revoked_by           TEXT CHECK (revoked_by IN ('local', 'remote')),
  last_reason_code     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT federation_directory_links_distinct_owners
    CHECK (local_owner_id <> remote_owner_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS federation_directory_links_live_pair_uidx
  ON federation_directory_links (local_owner_id, remote_owner_id, remote_domain)
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS federation_directory_links_step8_idx
  ON federation_directory_links (status, local_owner_id, remote_owner_id, remote_domain);

ALTER TABLE federation_outbox
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'envelope';
ALTER TABLE federation_outbox
  ADD COLUMN IF NOT EXISTS directory_payload JSONB;

ALTER TABLE federation_outbox DROP CONSTRAINT IF EXISTS federation_outbox_kind_check;
ALTER TABLE federation_outbox ADD CONSTRAINT federation_outbox_kind_check
  CHECK (kind IN ('envelope', 'directory_redemption', 'directory_confirmation', 'directory_revocation'));

ALTER TABLE federation_outbox ALTER COLUMN envelope        DROP NOT NULL;
ALTER TABLE federation_outbox ALTER COLUMN sender_key      DROP NOT NULL;
ALTER TABLE federation_outbox ALTER COLUMN sender_owner_id DROP NOT NULL;

ALTER TABLE federation_outbox DROP CONSTRAINT IF EXISTS federation_outbox_envelope_present_check;
ALTER TABLE federation_outbox ADD CONSTRAINT federation_outbox_envelope_present_check
  CHECK (kind <> 'envelope' OR envelope IS NOT NULL);
ALTER TABLE federation_outbox DROP CONSTRAINT IF EXISTS federation_outbox_sender_key_present_check;
ALTER TABLE federation_outbox ADD CONSTRAINT federation_outbox_sender_key_present_check
  CHECK (kind <> 'envelope' OR sender_key IS NOT NULL);
ALTER TABLE federation_outbox DROP CONSTRAINT IF EXISTS federation_outbox_sender_owner_present_check;
ALTER TABLE federation_outbox ADD CONSTRAINT federation_outbox_sender_owner_present_check
  CHECK (kind <> 'envelope' OR sender_owner_id IS NOT NULL);
ALTER TABLE federation_outbox DROP CONSTRAINT IF EXISTS federation_outbox_directory_payload_present_check;
ALTER TABLE federation_outbox ADD CONSTRAINT federation_outbox_directory_payload_present_check
  CHECK (kind = 'envelope' OR directory_payload IS NOT NULL);

ALTER TABLE quota_usage DROP CONSTRAINT IF EXISTS quota_usage_scope_kind_check;
ALTER TABLE quota_usage ADD CONSTRAINT quota_usage_scope_kind_check
  CHECK (scope_kind IN ('endpoint', 'owner', 'conversation',
                        'directory_invite_create', 'directory_invite_redeem',
                        'directory_match_create', 'directory_match_attempt',
                        'federation_origin',
                        'federation_directory_invite_create',
                        'federation_directory_redeem',
                        'federation_directory_redemption_inbound'));
