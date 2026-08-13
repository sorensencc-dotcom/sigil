import pg from 'pg';
import crypto from 'node:crypto';

export class PostgresRepository {
  constructor({ pool = new pg.Pool(), schema = 'public' } = {}) { this.pool = pool; this.schema = schema; }
  async query(text, values = []) { return this.pool.query(text, values); }
  async lookupIdempotency(endpointId, idempotencyKey) {
    const result = await this.pool.query(
      'SELECT message_id, canonical_hash FROM idempotency_keys WHERE endpoint_id = $1 AND idempotency_key = $2 AND expires_at > NOW()',
      [endpointId, idempotencyKey]
    );
    return result.rows[0] ?? null;
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
         UPDATE deliveries d SET lease_until = $2, updated_at = $1
         FROM candidate c WHERE d.delivery_id = c.delivery_id
         RETURNING d.*`,
        [timestamp, new Date(new Date(timestamp).getTime() + leaseSeconds * 1000).toISOString()]
      );
      return result.rows[0] ? { ...result.rows[0], worker_id: workerId ?? null } : null;
    });
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
      return result.rows[0];
    });
  }
  async withTransaction(work) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async persistAcceptedEnvelope(row) {
    return this.withTransaction(async (client) => {
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
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, payload, created_at)
         VALUES ($1, 'envelope.accepted', $2, $3, $4, $5)`,
        [`audit_${crypto.randomUUID()}`, row.envelope.message_id, row.envelope.sender.endpoint_id, JSON.stringify({ recipient_endpoint_id: row.envelope.recipient?.endpoint_id ?? null }), row.envelope.created_at]
      );
      return result.rows[0];
    });
  }
  async close() { await this.pool.end(); }
}
