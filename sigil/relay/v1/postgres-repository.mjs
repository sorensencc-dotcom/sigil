import pg from 'pg';
import crypto from 'node:crypto';
import { canTransition } from './delivery-state.mjs';
import { assertAssurance } from './auth-policy.mjs';
import { withTransaction } from './with-transaction.mjs';

export class PostgresRepository {
  constructor({ pool = new pg.Pool(), schema = 'public' } = {}) { this.pool = pool; this.schema = schema; }
  async query(text, values = []) { return this.pool.query(text, values); }
  async lookupIdempotency(endpointId, idempotencyKey, client = this.pool) {
    const result = await client.query(
      'SELECT message_id, canonical_hash FROM idempotency_keys WHERE endpoint_id = $1 AND idempotency_key = $2 AND expires_at > NOW()',
      [endpointId, idempotencyKey]
    );
    return result.rows[0] ?? null;
  }
  async lookupTaskRequest(taskId, conversationId, client = this.pool) {
    const result = await client.query(
      `SELECT message_id FROM envelopes WHERE conversation_id = $1 AND message_type = 'task.request' AND body->>'task_id' = $2 AND envelope_status = 'accepted' LIMIT 1`,
      [conversationId, taskId]
    );
    return result.rows[0] ?? null;
  }
  async lookupAcceptedMessageId(senderEndpointId, messageId, client = this.pool) {
    const result = await client.query(
      'SELECT message_id, idempotency_key FROM envelopes WHERE sender_endpoint_id = $1 AND message_id = $2 AND envelope_status = $3',
      [senderEndpointId, messageId, 'accepted']
    );
    return result.rows[0] ?? null;
  }
  async lookupCapabilityRegistration(capability, client = this.pool) {
    const result = await client.query('SELECT capability, namespace, risk_tier FROM capability_registry WHERE capability = $1', [capability]);
    return result.rows[0] ?? null;
  }
  // No `client = this.pool` default here, unlike the other lookups above --
  // design §3 requires this one to always run on the transaction's client
  // since it takes a row lock; a lock taken on a throwaway pool connection
  // outside the transaction would be meaningless and immediately released.
  async lookupActiveCapabilityGrants(endpointId, now, client) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await client.query(
      'SELECT capability, scope FROM capability_grants WHERE granted_to = $1 AND expires_at > $2 AND revoked_at IS NULL FOR UPDATE',
      [endpointId, timestamp]
    );
    return result.rows;
  }
  async registerHumanCredential({ humanId, endpointId, credentialId, type = 'webauthn', publicKey, algorithm, coseKey, now = new Date() } = {}) {
    if (type !== 'webauthn' || !humanId || !endpointId || !credentialId || !publicKey) throw Object.assign(new Error('Endpoint-bound WebAuthn credential is required'), { code: 'INVALID_ATTESTATION' });
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await this.pool.query(
      `INSERT INTO human_credentials (credential_id, human_id, endpoint_id, type, public_key, status, valid_from, created_at)
       SELECT $1, h.human_id, $6, $2, $3, 'active', $4, $4
       FROM humans h JOIN endpoints e ON e.owner_id = h.human_id
       WHERE h.human_id = $5 AND e.endpoint_id = $6 AND h.status = 'active' AND e.status = 'active'
       RETURNING credential_id, human_id, type, status, valid_from, created_at`,
      [credentialId, type, publicKey, timestamp, humanId, endpointId]
    );
    if (!result.rows[0]) throw Object.assign(new Error('Human is not active or credential already exists'), { code: 'CREDENTIAL_UNAVAILABLE' });
    return { ...result.rows[0], algorithm: algorithm ?? null, coseKey: coseKey ?? null };
  }
  async lookupHumanCredential(credentialId, endpointId) {
    const result = await this.pool.query(
      `SELECT c.credential_id, c.human_id, c.type, c.public_key, c.status,
              c.valid_from, c.valid_until, c.endpoint_id, h.status AS human_status
       FROM human_credentials c JOIN humans h ON h.human_id = c.human_id
       WHERE c.credential_id = $1 AND c.endpoint_id = $2`, [credentialId, endpointId]
    );
    const row = result.rows[0];
    return row ? { credentialId: row.credential_id, humanId: row.human_id, endpointId: row.endpoint_id, type: row.type, publicKey: row.public_key, status: row.status, humanStatus: row.human_status, validFrom: row.valid_from, validUntil: row.valid_until } : null;
  }

  async createApprovalChallenge(challenge) {
    const result = await this.pool.query(
      `INSERT INTO approval_challenges (challenge_id, endpoint_id, action_hash, webauthn_challenge, callback_url, token_hash, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
       RETURNING challenge_id, endpoint_id, action_hash, webauthn_challenge, callback_url, status, created_at, expires_at`,
      [challenge.id, challenge.endpointId, challenge.actionHash, challenge.webauthnChallenge, challenge.callbackUrl, crypto.createHash('sha256').update(challenge.token).digest('hex'), new Date().toISOString(), challenge.expiresAt]
    );
    return result.rows[0];
  }

  async getApprovalChallenge(challengeId) {
    const result = await this.pool.query('SELECT * FROM approval_challenges WHERE challenge_id = $1', [challengeId]);
    const row = result.rows[0];
    return row ? { id: row.challenge_id, endpointId: row.endpoint_id, actionHash: row.action_hash, webauthnChallenge: row.webauthn_challenge, callbackUrl: row.callback_url, expiresAt: row.expires_at, used: row.status === 'consumed', consuming: row.status === 'consuming' } : null;
  }

  async finalizeApprovalDecision({ challengeId, humanId, credentialId, endpointId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const locked = await client.query('SELECT * FROM approval_challenges WHERE challenge_id = $1 FOR UPDATE', [challengeId]);
      const challenge = locked.rows[0];
      if (!challenge || challenge.status !== 'pending' || challenge.endpoint_id !== endpointId || new Date(challenge.expires_at) <= new Date(timestamp)) throw Object.assign(new Error('Approval challenge expired or already consumed'), { code: 'APPROVAL_EXPIRED' });
      await client.query(`UPDATE approval_challenges SET status = 'consumed', consumed_at = $2 WHERE challenge_id = $1`, [challengeId, timestamp]);
      const decision = await client.query(
        `INSERT INTO approval_decisions (decision_id, human_id, credential_id, endpoint_id, action_hash, action_hash_algorithm, target, context_refs, scope, contract_version, nonce, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'sha256', '{}', '[]', 'approval', 'sigil/1', $6, 'approved', $7, $8)
         RETURNING decision_id, action_hash, status, created_at, expires_at`,
        [`decision_${crypto.randomUUID()}`, humanId, credentialId, endpointId, challenge.action_hash, challenge.challenge_id, timestamp, challenge.expires_at]
      );
      return decision.rows[0];
    });
  }
  async listInbox(endpointId, since = '') {
    const result = await this.pool.query(
      `SELECT d.delivery_id, d.message_id, d.recipient_endpoint_id, d.state, d.attempts, d.queued_at,
              e.protocol, e.message_type, e.body, e.context_refs, e.capabilities, e.correlation_id,
              e.sender_endpoint_id, e.expires_at, e.created_at
       FROM deliveries d JOIN envelopes e ON e.message_id = d.message_id
       WHERE d.recipient_endpoint_id = $1 AND d.state = 'queued' AND ($2 = '' OR d.queued_at > $2)
       ORDER BY d.queued_at, d.delivery_id`, [endpointId, since]
    );
    return result.rows;
  }
  async getDelivery(deliveryId, endpointId) {
    const result = await this.pool.query('SELECT * FROM deliveries WHERE delivery_id = $1 AND recipient_endpoint_id = $2', [deliveryId, endpointId]);
    if (!result.rows[0]) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
    return result.rows[0];
  }
  async claimDelivery({ workerId, leaseSeconds = 30, now = new Date() } = {}) {
    return this.withTransaction(async (client) => {
      const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
      const result = await client.query(
        `WITH candidate AS (
           SELECT delivery_id FROM deliveries
           WHERE state = 'queued' AND next_attempt_at <= $1 AND (lease_until IS NULL OR lease_until <= $1)
           ORDER BY next_attempt_at, queued_at, delivery_id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE deliveries d SET lease_until = $2, lease_owner = $3, updated_at = $1
         FROM candidate c WHERE d.delivery_id = c.delivery_id
         RETURNING d.*`,
        [timestamp, new Date(new Date(timestamp).getTime() + leaseSeconds * 1000).toISOString(), workerId]
      );
      return result.rows[0] ? { ...result.rows[0], worker_id: workerId ?? null } : null;
    });
  }
  async saveDeliveryTransition(deliveryId, next, { workerId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await this.pool.query(
      `UPDATE deliveries SET state = $1, attempts = $2, updated_at = $3, next_attempt_at = $4,
       lease_until = NULL, lease_owner = NULL, delivered_at = $5, acknowledged_at = $6, processing_at = $7,
       processed_at = $8, failure_reason = $9 WHERE delivery_id = $10 AND lease_owner = $11 AND lease_until > $12 RETURNING *`,
      [next.state, next.attempts ?? 0, next.updated_at, next.next_attempt_at ?? next.updated_at,
        next.delivered_at ?? null, next.acknowledged_at ?? null, next.processing_at ?? null,
        next.processed_at ?? null, next.failure_reason ?? null, deliveryId, workerId, timestamp]
    );
    if (!result.rows[0]) throw Object.assign(new Error('Delivery lease lost or expired'), { code: 'DELIVERY_LEASE_LOST' });
    return result.rows[0];
  }
  async transitionDelivery(deliveryId, endpointId, state, fields = {}) {
    return this.withTransaction(async (client) => {
      const current = await client.query(
        'SELECT * FROM deliveries WHERE delivery_id = $1 AND recipient_endpoint_id = $2 FOR UPDATE', [deliveryId, endpointId]
      );
      if (!current.rows[0]) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
      const next = fields.next ?? { ...current.rows[0], state };
      const result = await client.query(
        `UPDATE deliveries SET state = $1, attempts = $2, updated_at = $3, delivered_at = $4,
         acknowledged_at = $5, processing_at = $6, processed_at = $7, failure_reason = $8
         WHERE delivery_id = $9 RETURNING *`,
        [next.state, next.attempts ?? current.rows[0].attempts, next.updated_at ?? new Date().toISOString(), next.delivered_at ?? null, next.acknowledged_at ?? null, next.processing_at ?? null, next.processed_at ?? null, next.failure_reason ?? null, deliveryId]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, endpoint_id, conversation_id, payload, reason, created_at)
         SELECT $1, $2, $3, $4, e.conversation_id, '{}', $5, $6
         FROM deliveries d JOIN envelopes e ON e.message_id = d.message_id WHERE d.delivery_id = $3`,
        [`audit_${crypto.randomUUID()}`, `delivery.${next.state}`, deliveryId, endpointId, next.failure_reason ?? null, next.updated_at ?? new Date().toISOString()]
      );
      return result.rows[0];
    });
  }
  async withTransaction(work) {
    return withTransaction(this.pool, work);
  }
  // Recipient inbox-depth limit (design §18 #23): derived live from
  // non-terminal deliveries rows rather than a separate counter, so it
  // never drifts from the actual outstanding queue.
  async countOpenDeliveries(recipientEndpointId, client) {
    const result = await client.query(
      `SELECT count(*) FROM deliveries WHERE recipient_endpoint_id = $1
       AND state NOT IN ('acknowledged', 'processed', 'delivery_rejected', 'dead_letter')`,
      [recipientEndpointId]
    );
    return Number(result.rows[0].count);
  }
  async reserveRateLimit(scopeKind, scopeId, windowStart, limit, client) {
    const result = await client.query(
      `INSERT INTO quota_usage (scope_kind, scope_id, window_start, count) VALUES ($1, $2, $3, 1)
       ON CONFLICT (scope_kind, scope_id, window_start) DO UPDATE SET count = quota_usage.count + 1
       RETURNING count`,
      [scopeKind, scopeId, windowStart]
    );
    const count = result.rows[0].count;
    return { count, allowed: count <= limit };
  }
  async persistAcceptedEnvelope(row, client) {
    if (client) return this.#insertAcceptedEnvelope(row, client);
    try {
      return await this.withTransaction((txClient) => this.#insertAcceptedEnvelope(row, txClient));
    } catch (error) {
      if (error.code === '23505') {
        const existing = await this.lookupIdempotency(row.envelope.sender.endpoint_id, row.envelope.idempotency_key);
        if (existing) return { message_id: existing.message_id, duplicate: true };
      }
      throw error;
    }
  }
  async #insertAcceptedEnvelope(row, client) {
    const result = await client.query(
      `INSERT INTO envelopes (message_id, conversation_id, protocol, message_type, sender_endpoint_id, sender_owner_id, recipient_endpoint_id, broadcast_scope, body, context_refs, capabilities, correlation_id, idempotency_key, expires_at, created_at, signature_algorithm, signature_key_id, signature_value, canonical_bytes, action_hash, envelope_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'accepted') RETURNING message_id`,
      [row.envelope.message_id, row.envelope.conversation_id, row.envelope.protocol, row.envelope.message_type, row.envelope.sender.endpoint_id, row.envelope.sender.owner_id, row.envelope.recipient?.endpoint_id ?? null, row.envelope.broadcast_scope ?? null, row.envelope.body, row.envelope.context_refs, row.envelope.capabilities, row.envelope.correlation_id, row.envelope.idempotency_key, row.envelope.expires_at, row.envelope.created_at, row.envelope.signature.algorithm, row.envelope.signature.key_id, row.envelope.signature.value, row.canonical_bytes ?? null, row.action_hash ?? null]
    );
    const deliveryId = row.delivery_id ?? `del_${crypto.randomUUID()}`;
    if (row.envelope.recipient?.endpoint_id) {
      await client.query(
        `INSERT INTO deliveries (delivery_id, message_id, recipient_endpoint_id, state, attempts, queued_at, updated_at, next_attempt_at)
         VALUES ($1,$2,$3,'queued',0,$4,$4,$4)`,
        [deliveryId, row.envelope.message_id, row.envelope.recipient.endpoint_id, row.envelope.created_at]
      );
    }
    await client.query(
      `INSERT INTO idempotency_keys (idempotency_key, endpoint_id, message_id, canonical_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.envelope.idempotency_key, row.envelope.sender.endpoint_id, row.envelope.message_id, row.canonical_hash ?? row.action_hash ?? '', row.envelope.created_at, row.envelope.expires_at]
    );
    await client.query(
      `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, conversation_id, payload, created_at)
       VALUES ($1, 'envelope.accepted', $2, $3, $4, $5, $6)`,
      [`audit_${crypto.randomUUID()}`, row.envelope.message_id, row.envelope.sender.endpoint_id, row.envelope.conversation_id, JSON.stringify({ recipient_endpoint_id: row.envelope.recipient?.endpoint_id ?? null }), row.envelope.created_at]
    );
    return { message_id: result.rows[0].message_id, duplicate: false };
  }
  async acknowledgeDelivery({ deliveryId, endpointId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO delivery_acknowledgements (delivery_id, endpoint_id, acknowledged_at)
         VALUES ($1, $2, $3) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
        [deliveryId, endpointId, timestamp]
      );
      if (!inserted.rows[0]) {
        const existing = await client.query(
          'SELECT delivery_id, endpoint_id, acknowledged_at FROM delivery_acknowledgements WHERE delivery_id = $1',
          [deliveryId]
        );
        const receipt = existing.rows[0];
        if (!receipt) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
        if (receipt.endpoint_id !== endpointId) throw Object.assign(new Error('Delivery already acknowledged by a different endpoint'), { code: 'DELIVERY_UNAVAILABLE' });
        return { delivery_id: deliveryId, duplicate: true, acknowledged_at: receipt.acknowledged_at };
      }
      const current = await client.query('SELECT * FROM deliveries WHERE delivery_id = $1 AND recipient_endpoint_id = $2 FOR UPDATE', [deliveryId, endpointId]);
      if (!current.rows[0]) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
      if (current.rows[0].state !== 'acknowledged' && !canTransition(current.rows[0].state, 'acknowledged')) {
        throw Object.assign(new Error(`Invalid delivery transition: ${current.rows[0].state} -> acknowledged`), { code: 'INVALID_STATE_TRANSITION' });
      }
      const result = await client.query(
        `UPDATE deliveries SET state = 'acknowledged', updated_at = $1, acknowledged_at = $1 WHERE delivery_id = $2 RETURNING *`,
        [timestamp, deliveryId]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, endpoint_id, conversation_id, payload, created_at)
         SELECT $1, $2, $3, $4, e.conversation_id, '{}', $5
         FROM deliveries d JOIN envelopes e ON e.message_id = d.message_id WHERE d.delivery_id = $3`,
        [`audit_${crypto.randomUUID()}`, 'delivery.acknowledged', deliveryId, endpointId, timestamp]
      );
      return { delivery_id: deliveryId, duplicate: false, delivery: result.rows[0] };
    });
  }
  async createOidcIdentity({ issuer, subject, humanId, status = 'active', now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await this.pool.query(
      `INSERT INTO oidc_identities (issuer, subject, human_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING issuer, subject, human_id, status, created_at`,
      [issuer, subject, humanId, status, timestamp]
    );
    return result.rows[0];
  }
  async lookupOidcIdentity(issuer, subject) {
    const result = await this.pool.query(
      'SELECT issuer, subject, human_id, status, created_at FROM oidc_identities WHERE issuer = $1 AND subject = $2',
      [issuer, subject]
    );
    return result.rows[0] ?? null;
  }
  async revokeOidcIdentity(issuer, subject, { now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const updated = await this.pool.query(
      `UPDATE oidc_identities SET status = 'revoked' WHERE issuer = $1 AND subject = $2 AND status <> 'revoked'
       RETURNING issuer, subject, human_id, status, created_at`,
      [issuer, subject]
    );
    if (updated.rows[0]) return { ...updated.rows[0], duplicate: false };
    const existing = await this.lookupOidcIdentity(issuer, subject);
    if (!existing) throw Object.assign(new Error('OIDC identity not found'), { code: 'IDENTITY_UNAVAILABLE' });
    return { ...existing, duplicate: true };
  }
  async linkAccount({ linkId, humanId, issuer, subject, nonceHash = null, stateHash = null, issuedAt = null, expiresAt = null, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    if (!nonceHash || !stateHash || !issuedAt || !expiresAt) throw Object.assign(new Error('Account-link ceremony is required'), { code: 'ACCOUNT_LINK_CEREMONY_REQUIRED' });
    const result = await this.pool.query(
      `INSERT INTO account_links (link_id, human_id, issuer, subject, nonce_hash, state_hash, issued_at, expires_at, consumed_at, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $9) RETURNING link_id, human_id, issuer, subject, nonce_hash, state_hash, issued_at, expires_at, consumed_at, status, created_at`,
      [linkId, humanId, issuer, subject, nonceHash, stateHash, new Date(issuedAt).toISOString(), new Date(expiresAt).toISOString(), timestamp]
    );
    return result.rows[0];
  }
  async unlinkAccount(linkId, { now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const current = await client.query('SELECT * FROM account_links WHERE link_id = $1 FOR UPDATE', [linkId]);
      const link = current.rows[0];
      if (!link) throw Object.assign(new Error('Account link not found'), { code: 'LINK_UNAVAILABLE' });
      if (link.status === 'unlinked') return { ...link, duplicate: true };
      const remaining = await client.query(
        `SELECT
           (SELECT count(*) FROM account_links WHERE human_id = $1 AND status = 'active' AND link_id <> $2) AS other_links,
           (SELECT count(*) FROM human_credentials WHERE human_id = $1 AND status = 'active') AS credentials`,
        [link.human_id, linkId]
      );
      const { other_links: otherLinks, credentials } = remaining.rows[0];
      if (Number(otherLinks) === 0 && Number(credentials) === 0) {
        throw Object.assign(new Error('Unlinking would leave no recoverable authentication method'), { code: 'LOCKOUT_REFUSED' });
      }
      const updated = await client.query(
        `UPDATE account_links SET status = 'unlinked' WHERE link_id = $1 RETURNING link_id, human_id, issuer, subject, status, created_at`,
        [linkId]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  async createHumanSession({ sessionId, humanId, authenticationMethod, assurance, deviceContext = {}, issuedAt = new Date(), expiresAt, now = new Date() } = {}) {
    assertAssurance(assurance);
    const issued = issuedAt instanceof Date ? issuedAt.toISOString() : new Date(issuedAt).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    const result = await this.pool.query(
      `INSERT INTO human_sessions (session_id, human_id, authentication_method, assurance, device_context, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING session_id, human_id, authentication_method, assurance, device_context, issued_at, version, expires_at, revoked_at`,
      [sessionId, humanId, authenticationMethod, assurance, JSON.stringify(deviceContext), issued, expires]
    );
    return result.rows[0];
  }
  async revokeHumanSession(sessionId, { now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const updated = await this.pool.query(
      `UPDATE human_sessions SET revoked_at = $1 WHERE session_id = $2 AND revoked_at IS NULL
       RETURNING session_id, human_id, authentication_method, assurance, device_context, issued_at, version, expires_at, revoked_at`,
      [timestamp, sessionId]
    );
    if (updated.rows[0]) return { ...updated.rows[0], duplicate: false };
    const existing = await this.pool.query('SELECT * FROM human_sessions WHERE session_id = $1', [sessionId]);
    if (!existing.rows[0]) throw Object.assign(new Error('Session not found'), { code: 'SESSION_UNAVAILABLE' });
    return { ...existing.rows[0], duplicate: true };
  }
  async issueEndpointToken({ tokenId, endpointId, now = new Date(), expiresAt } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt ?? new Date(timestamp).getTime() + 24 * 60 * 60 * 1000).toISOString();
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await this.pool.query(
      `INSERT INTO endpoint_tokens (token_id, endpoint_id, token_hash, status, created_at, expires_at)
       VALUES ($1, $2, $3, 'active', $4, $5) RETURNING token_id, endpoint_id, status, created_at, expires_at`,
      [tokenId, endpointId, tokenHash, timestamp, expires]
    );
    return { ...result.rows[0], token };
  }
  async rotateEndpointToken({ oldTokenId, newTokenId, endpointId, now = new Date(), expiresAt } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt ?? new Date(timestamp).getTime() + 24 * 60 * 60 * 1000).toISOString();
    return this.withTransaction(async (client) => {
      const current = await client.query(
        `UPDATE endpoint_tokens SET status = 'revoked', revoked_at = $1
         WHERE token_id = $2 AND endpoint_id = $3 AND status = 'active' RETURNING token_id`,
        [timestamp, oldTokenId, endpointId]
      );
      if (!current.rows[0]) throw Object.assign(new Error('Token to rotate is not active for this endpoint'), { code: 'TOKEN_UNAVAILABLE' });
      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const inserted = await client.query(
        `INSERT INTO endpoint_tokens (token_id, endpoint_id, token_hash, status, created_at, expires_at)
         VALUES ($1, $2, $3, 'active', $4, $5) RETURNING token_id, endpoint_id, status, created_at, expires_at`,
        [newTokenId, endpointId, tokenHash, timestamp, expires]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, endpoint_id, payload, created_at)
         VALUES ($1, 'endpoint_token.rotated', $2, $3, $4, $5, $6)`,
        [`audit_${crypto.randomUUID()}`, newTokenId, endpointId, endpointId, JSON.stringify({ old_token_id: oldTokenId, new_token_id: newTokenId }), timestamp]
      );
      return { ...inserted.rows[0], token };
    });
  }
  async revokeEndpointToken(tokenId, { endpointId, now = new Date(), reason = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE endpoint_tokens SET status = 'revoked', revoked_at = $1
         WHERE token_id = $2 AND ($3::text IS NULL OR endpoint_id = $3) AND status = 'active'
         RETURNING token_id, endpoint_id, status, created_at, expires_at, revoked_at`,
        [timestamp, tokenId, endpointId ?? null]
      );
      if (!updated.rows[0]) throw Object.assign(new Error('Token not found or already revoked'), { code: 'TOKEN_UNAVAILABLE' });
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, endpoint_id, reason, payload, created_at)
         VALUES ($1, 'endpoint_token.revoked', $2, $3, $3, $4, '{}', $5)`,
        [`audit_${crypto.randomUUID()}`, tokenId, updated.rows[0].endpoint_id, reason, timestamp]
      );
      return updated.rows[0];
    });
  }
  async createCapabilityGrant({ grantId, subject, capability, scope, purpose, provenance, issuer, grantedTo, grantedBy, now = new Date(), expiresAt } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    const result = await this.pool.query(
      `INSERT INTO capability_grants (grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $6)
       RETURNING grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at, revoked_at`,
      [grantId, capability, scope, grantedTo, grantedBy, timestamp, expires, subject ?? grantedTo, purpose ?? null, provenance ?? null, issuer ?? null]
    );
    return result.rows[0];
  }
  async revokeCapabilityGrant(grantId, { revokedBy, reason, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE capability_grants SET revoked_at = $1 WHERE grant_id = $2 AND revoked_at IS NULL
         RETURNING grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at, revoked_at`,
        [timestamp, grantId]
      );
      if (!updated.rows[0]) {
        const existing = await client.query('SELECT * FROM capability_grants WHERE grant_id = $1', [grantId]);
        if (!existing.rows[0]) throw Object.assign(new Error('Capability grant not found'), { code: 'GRANT_UNAVAILABLE' });
        return { ...existing.rows[0], duplicate: true };
      }
      await client.query(
        `INSERT INTO capability_revocations (revocation_id, capability_grant_id, revoked_by, reason, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [`revocation_${crypto.randomUUID()}`, grantId, revokedBy, reason, timestamp]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  // --- Audit-atomic variants -----------------------------------------
  // Each of these wraps its mutation and its audit_events insert in the
  // same withTransaction() call, using the same client for both, so a
  // failure writing the audit row rolls back the mutation instead of
  // leaving an unaudited state change committed. Idempotent-replay
  // detection is unchanged from the standalone method: a replay never
  // performs the mutation and never writes a second audit row, so it
  // doesn't need the transaction at all beyond the read-modify check.
  async revokeOidcIdentityWithAudit(issuer, subject, { now = new Date(), actorHumanId = null, endpointId = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE oidc_identities SET status = 'revoked' WHERE issuer = $1 AND subject = $2 AND status <> 'revoked'
         RETURNING issuer, subject, human_id, status, created_at`,
        [issuer, subject]
      );
      if (!updated.rows[0]) {
        const existing = await client.query('SELECT issuer, subject, human_id, status, created_at FROM oidc_identities WHERE issuer = $1 AND subject = $2', [issuer, subject]);
        if (!existing.rows[0]) throw Object.assign(new Error('OIDC identity not found'), { code: 'IDENTITY_UNAVAILABLE' });
        return { ...existing.rows[0], duplicate: true };
      }
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, endpoint_id, object_type, object_id, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`audit_${crypto.randomUUID()}`, 'oidc_identity.revoked', `${issuer}|${subject}`, actorHumanId, endpointId, 'oidc_identity', subject, 'success', timestamp]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  async unlinkAccountWithAudit(linkId, { now = new Date(), actorHumanId = null, endpointId = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const current = await client.query('SELECT * FROM account_links WHERE link_id = $1 FOR UPDATE', [linkId]);
      const link = current.rows[0];
      if (!link) throw Object.assign(new Error('Account link not found'), { code: 'LINK_UNAVAILABLE' });
      if (link.status === 'unlinked') return { ...link, duplicate: true };
      const remaining = await client.query(
        `SELECT
           (SELECT count(*) FROM account_links WHERE human_id = $1 AND status = 'active' AND link_id <> $2) AS other_links,
           (SELECT count(*) FROM human_credentials WHERE human_id = $1 AND status = 'active') AS credentials`,
        [link.human_id, linkId]
      );
      const { other_links: otherLinks, credentials } = remaining.rows[0];
      if (Number(otherLinks) === 0 && Number(credentials) === 0) {
        throw Object.assign(new Error('Unlinking would leave no recoverable authentication method'), { code: 'LOCKOUT_REFUSED' });
      }
      const updated = await client.query(
        `UPDATE account_links SET status = 'unlinked' WHERE link_id = $1 RETURNING link_id, human_id, issuer, subject, status, created_at`,
        [linkId]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, endpoint_id, object_type, object_id, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`audit_${crypto.randomUUID()}`, 'account_link.unlinked', linkId, actorHumanId, endpointId, 'account_link', linkId, 'success', timestamp]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  async revokeHumanSessionWithAudit(sessionId, { now = new Date(), actorHumanId = null, endpointId = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE human_sessions SET revoked_at = $1 WHERE session_id = $2 AND revoked_at IS NULL
         RETURNING session_id, human_id, authentication_method, assurance, device_context, issued_at, version, expires_at, revoked_at`,
        [timestamp, sessionId]
      );
      if (!updated.rows[0]) {
        const existing = await client.query('SELECT * FROM human_sessions WHERE session_id = $1', [sessionId]);
        if (!existing.rows[0]) throw Object.assign(new Error('Session not found'), { code: 'SESSION_UNAVAILABLE' });
        return { ...existing.rows[0], duplicate: true };
      }
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, endpoint_id, object_type, object_id, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`audit_${crypto.randomUUID()}`, 'human_session.revoked', sessionId, actorHumanId, endpointId, 'human_session', sessionId, 'success', timestamp]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  async createCapabilityGrantWithAudit({ grantId, subject, capability, scope, purpose, provenance, issuer, grantedTo, grantedBy, now = new Date(), expiresAt, actorHumanId = null, endpointId = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO capability_grants (grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $6)
         RETURNING grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at, revoked_at`,
        [grantId, capability, scope, grantedTo, grantedBy, timestamp, expires, subject ?? grantedTo, purpose ?? null, provenance ?? null, issuer ?? null]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, endpoint_id, object_type, object_id, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`audit_${crypto.randomUUID()}`, 'capability_grant.created', grantId, actorHumanId, endpointId ?? grantedTo, 'capability_grant', grantId, 'success', timestamp]
      );
      return result.rows[0];
    });
  }
  async revokeCapabilityGrantWithAudit(grantId, { revokedBy, reason, now = new Date(), actorHumanId = null, endpointId = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE capability_grants SET revoked_at = $1 WHERE grant_id = $2 AND revoked_at IS NULL
         RETURNING grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at, revoked_at`,
        [timestamp, grantId]
      );
      if (!updated.rows[0]) {
        const existing = await client.query('SELECT * FROM capability_grants WHERE grant_id = $1', [grantId]);
        if (!existing.rows[0]) throw Object.assign(new Error('Capability grant not found'), { code: 'GRANT_UNAVAILABLE' });
        return { ...existing.rows[0], duplicate: true };
      }
      await client.query(
        `INSERT INTO capability_revocations (revocation_id, capability_grant_id, revoked_by, reason, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [`revocation_${crypto.randomUUID()}`, grantId, revokedBy, reason, timestamp]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, endpoint_id, object_type, object_id, outcome, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [`audit_${crypto.randomUUID()}`, 'capability_grant.revoked', grantId, actorHumanId, endpointId, 'capability_grant', grantId, 'success', reason ?? null, timestamp]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  async recordAuditEvent({ eventId = `audit_${crypto.randomUUID()}`, eventType, subjectId, actorId = null, actorHumanId = null, endpointId = null, objectType = null, objectId = null, actionHash = null, outcome = null, reason = null, payload = {}, metadataRedacted = null, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await this.pool.query(
      `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, actor_human_id, endpoint_id, object_type, object_id, action_hash, outcome, reason, payload, metadata_redacted, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING event_id, event_type, subject_id, actor_id, actor_human_id, endpoint_id, object_type, object_id, action_hash, outcome, reason, created_at`,
      [eventId, eventType, subjectId, actorId, actorHumanId, endpointId, objectType, objectId, actionHash, outcome, reason, JSON.stringify(payload), metadataRedacted ? JSON.stringify(metadataRedacted) : null, timestamp]
    );
    return result.rows[0];
  }
  async close() { await this.pool.end(); }
}
