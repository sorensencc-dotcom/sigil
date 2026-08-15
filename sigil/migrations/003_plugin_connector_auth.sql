-- Forward-only migration implementing the §9 "Required data objects" of
-- docs/specs/sigil-plugin-connector-auth-spec-v1.0.md, on top of 001/002.
--
-- Tables not literally named in the §9 code block (idempotency_records,
-- recovery_attempts) are derived from normative prose elsewhere in the spec
-- (§3 idempotency binding; §6.1/§6.2 recovery ceremony) — see the review
-- report for the field-by-field rationale. Every new/altered column here is
-- additive and nullable where an existing table already has rows written by
-- code this migration must not touch, so this migration is safe to apply
-- without a coordinated app-code deploy.

-- 5.1 OIDC issuer/subject identity model. PK is the exact (issuer, subject)
-- pair per spec: "An OIDC identity is identified by the exact pair
-- (issuer, subject)."
CREATE TABLE oidc_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  human_id TEXT NOT NULL REFERENCES humans(human_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'unlinked', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (issuer, subject)
);

CREATE INDEX oidc_identities_human_idx ON oidc_identities(human_id);

-- 5.3 Attributes are claims with source, observed time, and verification
-- state -- not identity keys. Modeled append-only (one row per observation)
-- so attribute history and "stale" transitions are preserved rather than
-- overwritten, matching "Attribute changes MUST invalidate dependent
-- verification where required."
CREATE TABLE human_attributes (
  attribute_id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL REFERENCES humans(human_id),
  kind TEXT NOT NULL CHECK (kind IN ('name', 'email', 'phone')),
  value_or_ciphertext BYTEA NOT NULL,
  verification_state TEXT NOT NULL CHECK (verification_state IN
    ('unverified', 'provider_verified', 'challenge_verified', 'manually_verified', 'stale', 'revoked')),
  source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX human_attributes_human_kind_idx ON human_attributes(human_id, kind, observed_at);

-- 5.4 Human sessions. `assurance` is intentionally free-text: §10 leaves the
-- exact assurance-level taxonomy as a Tier 1 open decision, so this schema
-- does not pre-commit to an enum the business hasn't approved yet.
CREATE TABLE human_sessions (
  session_id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL REFERENCES humans(human_id),
  authentication_method TEXT NOT NULL,
  assurance TEXT NOT NULL,
  device_context JSONB NOT NULL DEFAULT '{}',
  issued_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > issued_at)
);

CREATE INDEX human_sessions_human_idx ON human_sessions(human_id, expires_at);

-- 5.2 Account linking. Links a human to a second OIDC identity; FK back to
-- oidc_identities enforces that a link can only point at an identity that
-- actually completed its own issuer validation.
CREATE TABLE account_links (
  link_id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL REFERENCES humans(human_id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  nonce_hash TEXT,
  state_hash TEXT,
  issued_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('active', 'unlinked')),
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (issuer, subject) REFERENCES oidc_identities(issuer, subject),
  UNIQUE (human_id, issuer, subject),
  CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at > issued_at)
);

CREATE INDEX account_links_human_idx ON account_links(human_id);

-- 5.4 Endpoint bearer tokens: separate from human sessions, stored hashed,
-- one-time creation with rotation superseding the row's status rather than
-- deleting it (audit trail).
CREATE TABLE endpoint_tokens (
  token_id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (token_hash),
  CHECK (expires_at > created_at)
);

CREATE INDEX endpoint_tokens_endpoint_idx ON endpoint_tokens(endpoint_id, status);

-- 2.3 Packaging. One row per installed package version; publisher revocation
-- is checked against publisher_key_id at install time by app code, not by a
-- DB constraint (revocation lists are policy state, not a fixed enum here).
CREATE TABLE package_records (
  package_id TEXT PRIMARY KEY,
  publisher_key_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'active', 'suspended', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX package_records_publisher_idx ON package_records(publisher_key_id, status);

-- §3 capability_grants completion. 001_initial.sql already created this
-- table (capability, granted_to, granted_by, granted_at); this migration
-- adds the remaining §3-required columns additively rather than renaming the
-- existing ones, since nothing in this migration may touch the app code that
-- reads/writes them. `revoked_at` is added alongside the existing
-- capability_revocations table (kept as-is) so both the fast status check
-- and the detailed revocation record remain available.
ALTER TABLE capability_grants
  ADD COLUMN subject TEXT,
  ADD COLUMN purpose TEXT,
  ADD COLUMN provenance TEXT,
  ADD COLUMN issuer TEXT,
  ADD COLUMN issued_at TIMESTAMPTZ,
  ADD COLUMN revoked_at TIMESTAMPTZ;

CREATE INDEX capability_grants_subject_idx ON capability_grants(subject);

-- 6.3 Approval decisions: the full step-up approval-ceremony binding.
-- `nonce` is UNIQUE because the relay recomputes action_hash and authorizes
-- delivery "only when the decision is ... single-use" -- a reused nonce must
-- fail at the constraint layer, not just app logic.
CREATE TABLE approval_decisions (
  decision_id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL REFERENCES humans(human_id),
  credential_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  action_hash TEXT NOT NULL,
  action_hash_algorithm TEXT NOT NULL,
  target JSONB NOT NULL,
  context_refs JSONB NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  policy_version TEXT,
  nonce TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'approved', 'denied', 'expired', 'cancelled', 'consumed', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (human_id, credential_id) REFERENCES human_credentials(human_id, credential_id),
  UNIQUE (nonce),
  CHECK (expires_at > created_at)
);

CREATE INDEX approval_decisions_endpoint_idx ON approval_decisions(endpoint_id, status);
CREATE INDEX approval_decisions_action_hash_idx ON approval_decisions(action_hash);

-- §9 audit_events completion. 001_initial.sql already created this table
-- (event_id, event_type, subject_id, actor_id, payload, created_at); the
-- existing relay code (sigil/relay/v1/postgres-repository.mjs) still inserts
-- only those columns, so every column added here is nullable and additive.
-- `actor_id`/`payload` are kept rather than renamed to `actor_human_id`/
-- `metadata_redacted` so that code is untouched by this migration.
ALTER TABLE audit_events
  ADD COLUMN actor_human_id TEXT,
  ADD COLUMN endpoint_id TEXT,
  ADD COLUMN object_type TEXT,
  ADD COLUMN object_id TEXT,
  ADD COLUMN action_hash TEXT,
  ADD COLUMN outcome TEXT,
  ADD COLUMN reason TEXT,
  ADD COLUMN metadata_redacted JSONB;

CREATE INDEX audit_events_object_idx ON audit_events(object_type, object_id);

-- §3 general connector-operation idempotency ledger. 001_initial.sql's
-- idempotency_keys table is scoped narrowly to envelope submission
-- (endpoint_id, idempotency_key -> message_id); this table generalizes the
-- same "idempotency key bound to the endpoint, envelope/action hash, and
-- contract version" binding (§3) to any of the §2.2 canonical operations, so
-- ack_delivery/begin_approval/etc. retries can be persisted the same way
-- without touching the envelope-specific table or the relay code that owns
-- it.
CREATE TABLE idempotency_records (
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  action_hash TEXT,
  contract_version TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (endpoint_id, idempotency_key),
  CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_records_expiry_idx ON idempotency_records(expires_at);

-- §6.1/§6.2 recovery ceremony attempts: rate limiting, cooldowns, and fraud
-- signals for MFA/account recovery. Not named as a table in the §9 code
-- block; derived from "MUST have rate limits, attempt limits, cooldowns,
-- fraud signals" (§6.2) and "Recovery MUST require an already authorized
-- recovery method or a documented multi-party/manual recovery process"
-- (§6.1). `initiated_by` is required so an informal support-driven reset
-- (explicitly forbidden by §6.2) is always attributable.
CREATE TABLE recovery_attempts (
  attempt_id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL REFERENCES humans(human_id),
  method TEXT NOT NULL CHECK (method IN ('phone', 'email', 'multi_party', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('attempted', 'succeeded', 'blocked', 'rate_limited')),
  fraud_signal TEXT CHECK (fraud_signal IN ('sim_swap', 'porting', 'carrier_change', 'attribute_change')),
  initiated_by TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  cooldown_until TIMESTAMPTZ
);

CREATE INDEX recovery_attempts_human_idx ON recovery_attempts(human_id, created_at);
