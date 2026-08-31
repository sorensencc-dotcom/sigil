-- sigil/migrations/017_federation_outbox.sql
-- Sub-project #3 (inter-relay routing).
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
