-- Make relay_jobs usable by job types other than federation. Federation
-- invariants remain enforced only for federation-typed rows.

ALTER TABLE relay_jobs
  ADD COLUMN IF NOT EXISTS payload JSONB;

ALTER TABLE relay_jobs ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE relay_jobs ALTER COLUMN idempotency_key DROP NOT NULL;
ALTER TABLE relay_jobs ALTER COLUMN recipient_domain DROP NOT NULL;
ALTER TABLE relay_jobs ALTER COLUMN origin_domain DROP NOT NULL;
ALTER TABLE relay_jobs ALTER COLUMN kind DROP NOT NULL;

ALTER TABLE relay_jobs DROP CONSTRAINT IF EXISTS federation_outbox_kind_check;
ALTER TABLE relay_jobs DROP CONSTRAINT IF EXISTS federation_outbox_envelope_present_check;
ALTER TABLE relay_jobs DROP CONSTRAINT IF EXISTS federation_outbox_sender_key_present_check;
ALTER TABLE relay_jobs DROP CONSTRAINT IF EXISTS federation_outbox_sender_owner_present_check;
ALTER TABLE relay_jobs DROP CONSTRAINT IF EXISTS federation_outbox_directory_payload_present_check;

ALTER TABLE relay_jobs
  ADD CONSTRAINT relay_jobs_federation_required_columns_check
  CHECK (
    job_type <> 'federation' OR (
      message_id IS NOT NULL AND idempotency_key IS NOT NULL AND
      recipient_domain IS NOT NULL AND origin_domain IS NOT NULL AND kind IS NOT NULL
    )
  );
ALTER TABLE relay_jobs
  ADD CONSTRAINT relay_jobs_federation_kind_check
  CHECK (
    job_type <> 'federation' OR
    kind IN ('envelope', 'directory_redemption', 'directory_confirmation', 'directory_revocation')
  );
ALTER TABLE relay_jobs
  ADD CONSTRAINT relay_jobs_federation_envelope_present_check
  CHECK (job_type <> 'federation' OR kind <> 'envelope' OR envelope IS NOT NULL);
ALTER TABLE relay_jobs
  ADD CONSTRAINT relay_jobs_federation_sender_key_present_check
  CHECK (job_type <> 'federation' OR kind <> 'envelope' OR sender_key IS NOT NULL);
ALTER TABLE relay_jobs
  ADD CONSTRAINT relay_jobs_federation_sender_owner_present_check
  CHECK (job_type <> 'federation' OR kind <> 'envelope' OR sender_owner_id IS NOT NULL);
ALTER TABLE relay_jobs
  ADD CONSTRAINT relay_jobs_federation_directory_payload_present_check
  CHECK (job_type <> 'federation' OR kind = 'envelope' OR directory_payload IS NOT NULL);

DROP INDEX IF EXISTS relay_jobs_state_next_attempt_idx;
DROP INDEX IF EXISTS relay_jobs_state_claimed_idx;
CREATE INDEX IF NOT EXISTS relay_jobs_job_type_state_next_attempt_idx
  ON relay_jobs (job_type, state, next_attempt_at);
CREATE INDEX IF NOT EXISTS relay_jobs_job_type_state_claimed_idx
  ON relay_jobs (job_type, state, claimed_at);
