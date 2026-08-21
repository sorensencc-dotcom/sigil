import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

/**
 * ConnectorDatabase handles all local state management, profile indexing,
 * durable inbox/outbox pipelines, content-addressed context caches, and human approvals.
 */
export class ConnectorDatabase {
  constructor(dbPath, schemaSqlPath) {
    this.db = new Database(dbPath);
    
    // Enable WAL mode for parallel read/write performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Run schema migrations
    const schemaSql = readFileSync(schemaSqlPath, 'utf8');
    this.db.exec(schemaSql);

    // Prepare optimized statements
    this._prepareStatements();
  }

  /**
   * Closes the database connection.
   */
  close() {
    this.db.close();
  }

  /**
   * Prepares and caches SQL statements to avoid re-compiling SQL under high concurrency loops.
   */
  _prepareStatements() {
    this.statements = {
      // Profiles
      upsertProfile: this.db.prepare(`
        INSERT INTO connector_profiles (profile_id, owner_id, endpoint_id, display_name, relay_url, status, secure_key_reference, secure_token_reference)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          relay_url = EXCLUDED.relay_url,
          status = EXCLUDED.status,
          secure_key_reference = EXCLUDED.secure_key_reference,
          secure_token_reference = EXCLUDED.secure_token_reference
      `),
      getProfile: this.db.prepare(`SELECT * FROM connector_profiles WHERE profile_id = ?`),
      getProfileByEndpoint: this.db.prepare(`SELECT * FROM connector_profiles WHERE endpoint_id = ?`),
      
      // Durable Inbox Intake ("Durable-Before-Ack")
      insertInboxMessage: this.db.prepare(`
        INSERT INTO inbox_messages (
          message_id, profile_id, conversation_id, message_type, sender_endpoint_id,
          body_json, canonical_hash, signature_value, expires_at, created_at, reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO NOTHING
      `),
      updateInboxProcessingState: this.db.prepare(`
        UPDATE inbox_messages 
        SET processing_state = ? 
        WHERE message_id = ?
      `),
      getInboxMessage: this.db.prepare(`SELECT * FROM inbox_messages WHERE message_id = ?`),
      listInboxForConversation: this.db.prepare(`
        SELECT * FROM inbox_messages 
        WHERE conversation_id = ? 
        ORDER BY created_at ASC
      `),

      // Outbox / Idempotent Retries & Progress tracking
      insertOutboxMessage: this.db.prepare(`
        INSERT INTO outbox_messages (
          outbox_id, profile_id, message_id, conversation_id, message_type,
          recipient_endpoint_id, body_json, canonical_hash, signature_value,
          idempotency_key, expires_at, delivery_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `),
      updateOutboxDeliveryState: this.db.prepare(`
        UPDATE outbox_messages
        SET delivery_state = ?, attempts = attempts + ?, last_attempt_at = ?, failure_code = ?
        WHERE message_id = ?
      `),
      getPendingOutboundQueue: this.db.prepare(`
        SELECT * FROM outbox_messages
        WHERE delivery_state IN ('queued', 'submitted') AND expires_at > ?
        ORDER BY created_at ASC
      `),

      // Content-Addressed Cache
      upsertContextCache: this.db.prepare(`
        INSERT INTO context_cache (integrity_hash, kind, scope, local_storage_path, size_bytes, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(integrity_hash) DO UPDATE SET
          last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          expires_at = EXCLUDED.expires_at
      `),
      updateContextCacheAccess: this.db.prepare(`
        UPDATE context_cache SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE integrity_hash = ?
      `),
      readContextCache: this.db.prepare(`SELECT * FROM context_cache WHERE integrity_hash = ?`),
      deleteContextCache: this.db.prepare(`DELETE FROM context_cache WHERE integrity_hash = ?`),
      sweepExpiredCache: this.db.prepare(`
        DELETE FROM context_cache 
        WHERE expires_at <= ?
        RETURNING local_storage_path
      `),

      // Local Human Approvals
      insertApproval: this.db.prepare(`
        INSERT INTO local_approvals (approval_id, profile_id, action_hash, capability, scope, requested_by, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `),
      decideApproval: this.db.prepare(`
        UPDATE local_approvals
        SET status = ?, decision_signature = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE approval_id = ?
      `),
      getApproval: this.db.prepare(`SELECT * FROM local_approvals WHERE approval_id = ?`)
    };
  }

  /**
   * Registers or updates a local connector identity profile.
   */
  upsertProfile(profile) {
    this.statements.upsertProfile.run(
      profile.profile_id,
      profile.owner_id,
      profile.endpoint_id,
      profile.display_name,
      profile.relay_url,
      profile.status || 'active',
      profile.secure_key_reference,
      profile.secure_token_reference
    );
  }

  /**
   * Fetches a profile by ID.
   */
  getProfile(profileId) {
    return this.statements.getProfile.get(profileId) || null;
  }

  /**
   * Fetches a profile by endpoint ID.
   */
  getProfileByEndpoint(endpointId) {
    return this.statements.getProfileByEndpoint.get(endpointId) || null;
  }

  /**
   * Durable-Before-Ack execution path.
   * Commits the incoming envelope into durable local storage before acknowledgement.
   */
  commitDurableInboxIntake(envelope, profileId, reconciledAt) {
    const transaction = this.db.transaction((env) => {
      this.statements.insertInboxMessage.run(
        env.message_id,
        profileId,
        env.conversation_id,
        env.message_type,
        env.sender,
        JSON.stringify(env.body),
        env.canonical_hash || '',
        env.signature_value || '',
        env.expires_at || '',
        env.created_at,
        reconciledAt
      );
    });
    transaction(envelope);
  }

  /**
   * Retrieves an inbox message by ID.
   */
  getInboxMessage(messageId) {
    return this.statements.getInboxMessage.get(messageId) || null;
  }

  /**
   * Transitions the local processing state of an inbox envelope.
   */
  updateInboxProcessingState(messageId, state) {
    this.statements.updateInboxProcessingState.run(state, messageId);
  }

  /**
   * Registers a newly constructed message to the outbox queue, ready for transport.
   */
  queueOutboundMessage(outboxId, profileId, envelope) {
    this.statements.insertOutboxMessage.run(
      outboxId,
      profileId,
      envelope.message_id,
      envelope.conversation_id,
      envelope.message_type,
      envelope.recipient?.endpoint_id || null,
      JSON.stringify(envelope.body),
      envelope.canonical_hash || '',
      envelope.signature_value || '',
      envelope.idempotency_key,
      envelope.expires_at,
      'queued'
    );
  }

  /**
   * Tracks progression of outbound delivery states fed by the real-time WebSocket receipts.
   */
  updateOutboxDeliveryState(messageId, { state, attemptIncrement = 0, lastAttemptAt = null, failureCode = null }) {
    this.statements.updateOutboxDeliveryState.run(state, attemptIncrement, lastAttemptAt, failureCode, messageId);
  }

  /**
   * Retrieves active items from the outbox that require delivery processing or retry sweeps.
   */
  getPendingOutboundQueue(now = new Date()) {
    return this.statements.getPendingOutboundQueue.all(now.toISOString());
  }

  /**
   * Sets or refreshes a local content-addressed context reference cache entry.
   */
  setContextCache(cacheEntry) {
    this.statements.upsertContextCache.run(
      cacheEntry.integrity_hash,
      cacheEntry.kind,
      cacheEntry.scope,
      cacheEntry.local_storage_path,
      cacheEntry.size_bytes,
      cacheEntry.expires_at
    );
  }

  /**
   * Retrieves a cached context reference, dynamically updating its last_accessed_at timestamp.
   */
  getContextCache(integrityHash) {
    const transaction = this.db.transaction((hash) => {
      this.statements.updateContextCacheAccess.run(hash);
      return this.statements.readContextCache.get(hash);
    });
    return transaction(integrityHash) || null;
  }

  /**
   * Sweeps expired local cache references from the database.
   * Returns an array of file paths that should be unlinked from the physical filesystem.
   */
  sweepExpiredCache(now = new Date()) {
    return this.statements.sweepExpiredCache.all(now.toISOString()).map(row => row.local_storage_path);
  }

  /**
   * Registers a local approval requirement (e.g. step-up prompting for high-risk capabilities).
   */
  createApprovalPrompt(approvalId, profileId, actionHash, capability, scope, requestedBy) {
    this.statements.insertApproval.run(approvalId, profileId, actionHash, capability, scope, requestedBy);
  }

  /**
   * Commits a user's local approval or denial decision.
   */
  commitApprovalDecision(approvalId, status, decisionSignature = null) {
    this.statements.decideApproval.run(status, decisionSignature, approvalId);
  }

  /**
   * Retrieves an approval prompt status.
   */
  getApproval(approvalId) {
    return this.statements.getApproval.get(approvalId) || null;
  }
}
