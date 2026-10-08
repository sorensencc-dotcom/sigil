-- sigil/migrations/029_agent_grant_revocation.sql
-- Agents may revoke their own capability grants (never create them). Agent
-- tokens carry no human_id, so a revocation must be attributable to an
-- endpoint instead of a humans(human_id) row.

ALTER TABLE capability_revocations ALTER COLUMN revoked_by DROP NOT NULL;

ALTER TABLE capability_revocations
  ADD COLUMN IF NOT EXISTS revoked_by_endpoint TEXT REFERENCES endpoints(endpoint_id);

ALTER TABLE capability_revocations
  ADD CONSTRAINT capability_revocations_actor_check
  CHECK (revoked_by IS NOT NULL OR revoked_by_endpoint IS NOT NULL);
