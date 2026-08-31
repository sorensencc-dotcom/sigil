import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { acceptFederatedEnvelope } from './accept-federated-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { buildForwardRequest, signForwardRequest } from './federation-router.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const ORIGIN = 'a.example';
const RELAY = 'b.example';

// R10 + R11 live-DB pin: a federated envelope whose sender is absent from this
// relay's humans / endpoints / endpoint_keys must still be accepted -- the
// accept path shadow-registers the foreign sender so the envelope's FK chain
// resolves, and stamps endpoints.origin_domain so the shadow row is
// identifiable. Skips locally (no SIGIL_TEST_DATABASE_URL); CI live-DB runs it.
test('federated envelope with an unregistered foreign sender is accepted and shadow-registers the sender', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = {
    owner: `usr_chris_${suffix}@primary.example`,
    sender: `ep_codex_${suffix}@${ORIGIN}`,
    recipient: `ep_claude_${suffix}@${RELAY}`,
    senderKey: `key_ep_codex_${suffix}@${ORIGIN}`,
    recipientKey: `key_ep_claude_${suffix}@${RELAY}`,
    conversation: `conv_${suffix}`,
    message: `msg_fed_${suffix}`,
    idempotency: `idem_fed_${suffix}`,
  };

  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }

  const senderKeys = crypto.generateKeyPairSync('ed25519');
  const relayKeys = crypto.generateKeyPairSync('ed25519');
  const relayIdentity = { key_id: `relay-a-${suffix}`, private_key_pem: relayKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const relayPub = relayKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const senderPub = senderKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

  // Recipient identity is real; the sender is deliberately absent.
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.owner}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.recipient}', '${ids.owner}', 'claude', 'install_claude_${suffix}', 'Claude', 'active', NOW());
    INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
      VALUES ('${ids.recipientKey}', '${ids.recipient}', 'Ed25519', decode('00', 'hex'), 'active', NOW());
  `);

  const repository = new PostgresRepository({ pool });
  await repository.upsertPeer({ domain: ORIGIN, relayUrl: 'https://a.example/relay', keys: [{ kid: relayIdentity.key_id, alg: 'Ed25519', publicKey: relayPub }], trustMode: 'tofu' });

  const base = {
    protocol: 'sigil/1', message_id: ids.message, conversation_id: ids.conversation, message_type: 'chat.message',
    sender: { owner_id: ids.owner, endpoint_id: ids.sender, kind: 'agent' },
    recipient: { owner_id: ids.owner, endpoint_id: ids.recipient, kind: 'agent' },
    body: { text: 'hi' }, context_refs: [], capabilities: [], idempotency_key: ids.idempotency,
    created_at: '2029-12-31T12:00:00.000Z', expires_at: '2029-12-31T12:10:00.000Z',
  };
  const value = crypto.sign(null, signedBytes({ ...base, signature: undefined }), senderKeys.privateKey).toString('base64url');
  const envelope = { ...base, signature: { algorithm: 'Ed25519', key_id: ids.senderKey, value } };

  const { body, canonicalBytes } = buildForwardRequest(envelope, {
    originDomain: ORIGIN,
    senderKey: { kid: ids.senderKey, alg: 'Ed25519', publicKey: senderPub },
    senderOwnerId: ids.owner,
    now: new Date('2029-12-31T12:00:05.000Z'),
  });
  const { signature, keyId } = signForwardRequest(canonicalBytes, relayIdentity);
  const headers = { 'sigil-relay-signature': signature, 'sigil-relay-key-id': keyId };

  const r = await acceptFederatedEnvelope(body, headers, {
    repository, registered: new Map(), relayDomain: RELAY, request_id: 'req_pg_1', now: new Date('2029-12-31T12:00:30.000Z'),
  });
  assert.equal(r.status, 202);
  assert.equal(r.body.code, 'ACCEPTED');

  // (a) the envelopes row exists afterward
  const persisted = await pool.query('SELECT message_id, federation_hop, sender_endpoint_id FROM envelopes WHERE message_id = $1', [ids.message]);
  assert.equal(persisted.rowCount, 1);
  assert.equal(persisted.rows[0].federation_hop, true);
  assert.equal(persisted.rows[0].sender_endpoint_id, ids.sender);

  // (b) endpoints.origin_domain for the shadow endpoint equals the origin domain
  const shadow = await pool.query('SELECT owner_id, runtime, origin_domain FROM endpoints WHERE endpoint_id = $1', [ids.sender]);
  assert.equal(shadow.rowCount, 1);
  assert.equal(shadow.rows[0].origin_domain, ORIGIN);
  assert.equal(shadow.rows[0].owner_id, ids.owner);
  assert.equal(shadow.rows[0].runtime, 'federated');

  // Locally-registered endpoints keep origin_domain NULL, so shadow rows stay identifiable.
  const local = await pool.query('SELECT origin_domain FROM endpoints WHERE endpoint_id = $1', [ids.recipient]);
  assert.equal(local.rows[0].origin_domain, null);

  const shadowKey = await pool.query('SELECT algorithm, status FROM endpoint_keys WHERE key_id = $1', [ids.senderKey]);
  assert.equal(shadowKey.rowCount, 1);
  assert.equal(shadowKey.rows[0].status, 'active');
});
