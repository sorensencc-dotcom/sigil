-- sigil/migrations/017_federation_outbox.sql
-- Sub-project #3 (inter-relay routing).
--
-- Requires PostgreSQL 13+: federation_outbox.id defaults to gen_random_uuid(),
-- a core builtin only since PG13. No migration in sigil/migrations/ runs
-- CREATE EXTENSION pgcrypto, so on PG12 and earlier this migration fails.
--
-- federation_hop: a stored envelope / delivery that arrived over the
-- federated-inbound path (POST /v1/federation/envelopes). Set true by
-- acceptFederatedEnvelope; treated as a hard "never forward onward" stop by
-- decideRoute. NOT NULL with a false default so existing rows are unaffected.
ALTER TABLE envelopes  ADD COLUMN IF NOT EXISTS federation_hop BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS federation_hop BOOLEAN NOT NULL DEFAULT FALSE;

-- origin_domain: set by acceptFederatedEnvelope's shadow-registration of a
-- foreign federated sender (design R10) so the accepted envelope's FK chain
-- resolves. NULL for every locally-registered endpoint, so shadow rows stay
-- identifiable and sweepable.
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS origin_domain TEXT;

-- Widen the rolling-window rate-limit scope set once more (design §8) for the
-- federation_origin scope acceptFederatedEnvelope reserves against on check 9.
-- Same drop/re-add-by-name pattern as 012_directory_trust.sql:83-87 (Postgres
-- has no ADD CONSTRAINT IF NOT EXISTS for CHECK); DROP ... IF EXISTS keeps a
-- re-run idempotent. Base list is 012's (the newest prior toucher) plus
-- 'federation_origin'.
ALTER TABLE quota_usage DROP CONSTRAINT IF EXISTS quota_usage_scope_kind_check;
ALTER TABLE quota_usage ADD CONSTRAINT quota_usage_scope_kind_check
  CHECK (scope_kind IN ('endpoint', 'owner', 'conversation',
                         'directory_invite_create', 'directory_invite_redeem',
                         'directory_match_create', 'directory_match_attempt',
                         'federation_origin'));

-- federation_outbox: queue-mode forward jobs. One row per foreign-domain
-- envelope accepted by a --federation-mode=queue relay. Drained by the
-- federation reaper (sigil/relay/v1/federation-reaper.mjs).
CREATE TABLE IF NOT EXISTS federation_outbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  recipient_domain  TEXT NOT NULL,
  origin_domain     TEXT NOT NULL,
  envelope          JSONB NOT NULL,
  sender_key        JSONB NOT NULL,
  sender_owner_id   TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'processing', 'forwarded', 'forward_rejected', 'dead_letter')),
  attempt_count     INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at        TIMESTAMPTZ,
  claim_token       UUID,
  last_reason_code  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS federation_outbox_message_idem_uidx
  ON federation_outbox (message_id, idempotency_key);
CREATE INDEX IF NOT EXISTS federation_outbox_state_next_attempt_idx
  ON federation_outbox (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS federation_outbox_state_claimed_idx
  ON federation_outbox (state, claimed_at);
