-- sigil/migrations/019_federation_directory_security.sql
-- Sub-project #4 security hardening -- design
-- docs/superpowers/specs/2026-09-06-sigil-federation-directory-security-design.md.
-- Additive EXCEPT two deliberate CHECK-constraint replacements on
-- federation_directory_links. That table is empty on this branch, so the
-- ADD CONSTRAINT validation scan carries no lock or backfill cost.

-- 1. Relay-to-relay request replay guard. Mirrors login_jti_replays
--    (migrations 013 / 015): a PRIMARY KEY uniqueness violation on a second
--    insert of the same nonce is mapped to RELAY_REPLAYED in the repository.
CREATE TABLE IF NOT EXISTS federation_relay_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS federation_relay_nonces_expires_at_idx
  ON federation_relay_nonces (expires_at);

-- 2. CHECK-constraint replacements. Fail loudly if 018's constraint names are
--    not what this migration expects, rather than letting a silent
--    DROP ... IF EXISTS no-op leave a stale constraint in place. Both probes
--    pin `table_name` as well as `constraint_name`: constraint names are unique
--    per schema, not globally, so without the table predicate a same-named
--    constraint on some other table would satisfy the check and let this
--    migration run against a federation_directory_links that never had it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'federation_directory_links_distinct_owners'
                   AND table_name = 'federation_directory_links') THEN
    RAISE EXCEPTION 'migration 019: expected constraint federation_directory_links_distinct_owners not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'federation_directory_links_initiated_via_check'
                   AND table_name = 'federation_directory_links') THEN
    RAISE EXCEPTION 'migration 019: expected constraint federation_directory_links_initiated_via_check not found';
  END IF;
END $$;

ALTER TABLE federation_directory_links
  DROP CONSTRAINT federation_directory_links_initiated_via_check;
ALTER TABLE federation_directory_links
  ADD CONSTRAINT federation_directory_links_initiated_via_check
  CHECK (initiated_via IN ('invite', 'oidc_match', 'self_pair'));

ALTER TABLE federation_directory_links
  DROP CONSTRAINT federation_directory_links_distinct_owners;
ALTER TABLE federation_directory_links
  ADD CONSTRAINT federation_directory_links_distinct_owners
  CHECK (local_owner_id <> remote_owner_id OR initiated_via = 'self_pair');

-- 3. Scrub the plaintext invite code from any pre-019 directory_redemption
--    outbox row. This branch is unpushed and pre-GA, so in practice this only
--    affects local dev databases. The rows are left to dead-letter and the
--    operator re-runs the redeem command (design Section 4).
UPDATE federation_outbox
   SET directory_payload = directory_payload - 'code'
 WHERE kind = 'directory_redemption'
   AND directory_payload ? 'code';

DO $$
DECLARE remaining INT;
BEGIN
  SELECT count(*) INTO remaining FROM federation_outbox WHERE kind = 'directory_redemption';
  IF remaining > 0 THEN
    RAISE NOTICE 'migration 019: % directory_redemption outbox row(s) present; operators must re-run those redemptions after upgrade', remaining;
  END IF;
END $$;
