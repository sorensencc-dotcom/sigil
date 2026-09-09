-- Generalize durable relay work. Existing federation rows retain their payloads
-- and become the first typed relay jobs.

ALTER TABLE federation_outbox RENAME TO relay_jobs;

ALTER TABLE relay_jobs
  ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'federation';
ALTER TABLE relay_jobs
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE relay_jobs DROP CONSTRAINT IF EXISTS federation_outbox_state_check;

UPDATE relay_jobs
   SET state = CASE state
                 WHEN 'forwarded' THEN 'done'
                 WHEN 'forward_rejected' THEN 'rejected'
                 ELSE state
               END,
       completed_at = CASE
                        WHEN state IN ('forwarded', 'forward_rejected', 'dead_letter')
                          THEN COALESCE(completed_at, updated_at)
                        ELSE completed_at
                      END;

ALTER TABLE relay_jobs
  ADD CONSTRAINT relay_jobs_state_check
  CHECK (state IN ('pending', 'processing', 'done', 'rejected', 'dead_letter'));
ALTER TABLE relay_jobs
  ADD CONSTRAINT relay_jobs_job_type_check
  CHECK (job_type <> '');

ALTER INDEX IF EXISTS federation_outbox_message_idem_uidx
  RENAME TO relay_jobs_message_idem_uidx;
ALTER INDEX IF EXISTS federation_outbox_state_next_attempt_idx
  RENAME TO relay_jobs_state_next_attempt_idx;
ALTER INDEX IF EXISTS federation_outbox_state_claimed_idx
  RENAME TO relay_jobs_state_claimed_idx;

DROP INDEX IF EXISTS relay_jobs_message_idem_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS relay_jobs_job_type_message_idem_uidx
  ON relay_jobs (job_type, message_id, idempotency_key);
