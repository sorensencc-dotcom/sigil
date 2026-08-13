import pg from 'pg';

export class PostgresRepository {
  constructor({ pool = new pg.Pool(), schema = 'public' } = {}) { this.pool = pool; this.schema = schema; }
  async query(text, values = []) { return this.pool.query(text, values); }
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
      return result.rows[0];
    });
  }
  async close() { await this.pool.end(); }
}
