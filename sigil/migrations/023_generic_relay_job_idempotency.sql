-- Generic relay jobs require a stable caller-supplied idempotency key. Jobs
-- created before this contract receive a derived, immutable legacy key.

UPDATE relay_jobs
   SET idempotency_key = 'legacy:' || id::text
 WHERE job_type <> 'federation';

ALTER TABLE relay_jobs
  ADD CONSTRAINT relay_jobs_generic_idempotency_key_check
  CHECK (
    job_type = 'federation' OR
    (idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '')
  );

CREATE UNIQUE INDEX IF NOT EXISTS relay_jobs_generic_job_type_idempotency_uidx
  ON relay_jobs (job_type, idempotency_key)
  WHERE job_type <> 'federation';
