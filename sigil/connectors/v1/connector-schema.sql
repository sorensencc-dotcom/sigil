PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS connector_profiles (
    profile_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    relay_url TEXT NOT NULL,
    status TEXT CHECK(status IN ('active', 'suspended', 'decommissioned')) DEFAULT 'active',
    secure_key_reference TEXT NOT NULL,
    secure_token_reference TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS inbox_messages (
    message_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES connector_profiles(profile_id),
    conversation_id TEXT NOT NULL,
    message_type TEXT NOT NULL,
    sender_endpoint_id TEXT NOT NULL,
    body_json TEXT NOT NULL,
    canonical_hash TEXT NOT NULL,
    signature_value TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reconciled_at TEXT NOT NULL,
    viewed_state TEXT CHECK(viewed_state IN ('unread', 'read')) DEFAULT 'unread',
    processing_state TEXT CHECK(processing_state IN ('received', 'processing', 'processed', 'failed')) DEFAULT 'received'
);

CREATE TABLE IF NOT EXISTS outbox_messages (
    outbox_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES connector_profiles(profile_id),
    message_id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    message_type TEXT NOT NULL,
    recipient_endpoint_id TEXT,
    body_json TEXT NOT NULL,
    canonical_hash TEXT NOT NULL,
    signature_value TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    attempts INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    failure_code TEXT,
    delivery_state TEXT CHECK(delivery_state IN ('queued', 'submitted', 'delivered', 'acknowledged', 'processing', 'processed', 'failed')) DEFAULT 'queued'
);

CREATE TABLE IF NOT EXISTS context_cache (
    integrity_hash TEXT PRIMARY KEY,
    kind TEXT CHECK(kind IN ('file', 'file_bundle', 'artifact', 'git_commit')) NOT NULL,
    scope TEXT NOT NULL,
    local_storage_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS local_approvals (
    approval_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES connector_profiles(profile_id),
    action_hash TEXT NOT NULL,
    capability TEXT NOT NULL,
    scope TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    status TEXT CHECK(status IN ('pending', 'approved', 'denied')) DEFAULT 'pending',
    decision_signature TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_conversation_state 
ON inbox_messages(conversation_id, viewed_state, processing_state);

CREATE INDEX IF NOT EXISTS idx_outbox_retry_lookup 
ON outbox_messages(delivery_state, expires_at);

CREATE INDEX IF NOT EXISTS idx_outbox_idempotency 
ON outbox_messages(profile_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_context_cache_ttl 
ON context_cache(expires_at);
