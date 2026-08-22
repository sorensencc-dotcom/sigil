import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { LocalInbox } from '../connectors/v1/local-inbox.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { acceptEnvelope } from '../relay/v1/accept-envelope.mjs';
import { DeliveryQueue } from '../relay/v1/delivery-queue.mjs';
import { signedBytes } from '../relay/v1/validate-envelope.mjs';
import { PostgresRepository } from '../relay/v1/postgres-repository.mjs';
import { createRelayServer } from '../relay/v1/http-server.mjs';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

// Live-Postgres bootstrap for the directory-trust vertical slice below: spins
// up a real createRelayServer backed by a real PostgresRepository against a
// disposable test database, seeds two DIFFERENT humans (each owning one
// endpoint) so the directory-link gate in accept-envelope.mjs's same-owner
// exemption never kicks in, and returns everything the scenario needs to
// drive the relay over real HTTP with real bearer tokens.
async function bootstrapLiveRelay(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fsPromises.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fsPromises.readFile(path.join(migrationsDir, file), 'utf8'));
  }

  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = { a: `usr_a_${suffix}`, b: `usr_b_${suffix}`, epA: `ep_a_${suffix}`, epB: `ep_b_${suffix}` };
  const keyA = crypto.generateKeyPairSync('ed25519');
  const keyIdA = `key_a_${suffix}`;

  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.a}', 'active', NOW()), ('${ids.b}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.epA}', '${ids.a}', 'claude', 'install_a_${suffix}', 'A', 'active', NOW()),
             ('${ids.epB}', '${ids.b}', 'codex', 'install_b_${suffix}', 'B', 'active', NOW());
    INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
      VALUES ('${keyIdA}', '${ids.epA}', 'Ed25519', decode('00', 'hex'), 'active', NOW());
  `);

  const repository = new PostgresRepository({ pool });

  // In-memory registry used solely for signature verification and the
  // sender/recipient owner_id resolution in accept-envelope.mjs -- separate
  // from the DB endpoint_keys row above, which only exists to satisfy the
  // envelopes.signature_key_id foreign key.
  const registry = new Map([
    [ids.epA, { owner_id: ids.a, key_id: keyIdA, status: 'active', public_key: keyA.publicKey }],
    [ids.epB, { owner_id: ids.b, key_id: `key_b_${suffix}`, status: 'active', public_key: crypto.generateKeyPairSync('ed25519').publicKey }]
  ]);

  const tokenHashToEndpoint = new Map();
  const endpointToToken = new Map();
  function tokenFor(endpointId) {
    if (!endpointToToken.has(endpointId)) {
      const token = `test_token_${endpointId}_${crypto.randomUUID()}`;
      endpointToToken.set(endpointId, token);
      tokenHashToEndpoint.set(hashBearerToken(token), endpointId);
    }
    return endpointToToken.get(endpointId);
  }
  tokenFor(ids.epA);
  tokenFor(ids.epB);

  async function authenticate(request) {
    const authorization = request.headers?.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) return null;
    const endpointId = tokenHashToEndpoint.get(hashBearerToken(token));
    if (!endpointId) return null;
    const endpoint = registry.get(endpointId);
    return { endpoint_id: endpointId, owner_id: endpoint?.owner_id, human_id: endpoint?.owner_id };
  }

  const server = createRelayServer({ registry, repository, authenticate, relayOrigin: 'https://relay.local' });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  return { baseUrl, server, pool, ids, tokenFor, senderPrivateKey: keyA.privateKey, senderKeyId: keyIdA };
}

function buildDirectEnvelope({ from, to, ids, privateKey, keyId }) {
  const ownerOf = { [ids.epA]: ids.a, [ids.epB]: ids.b };
  const envelope = {
    protocol: 'sigil/1',
    message_id: `msg_${crypto.randomUUID()}`,
    conversation_id: `conv_${crypto.randomUUID()}`,
    message_type: 'chat.message',
    sender: { endpoint_id: from, owner_id: ownerOf[from] },
    recipient: { endpoint_id: to },
    body: { text: 'hello' },
    context_refs: [],
    capabilities: [],
    correlation_id: null,
    idempotency_key: `send_${crypto.randomUUID()}`,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
    signature: { algorithm: 'Ed25519', key_id: keyId, value: '' }
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  return envelope;
}

test('Codex -> relay -> Claude -> relay -> Codex vertical slice', () => {
  const codexKeys = crypto.generateKeyPairSync('ed25519');
  const claudeKeys = crypto.generateKeyPairSync('ed25519');
  const codex = { owner_id: 'usr_codex', endpoint_id: 'ep_codex', key_id: 'key_codex', kind: 'agent' };
  const claude = { owner_id: 'usr_claude', endpoint_id: 'ep_claude', key_id: 'key_claude', kind: 'agent' };
  const registry = new Map([
    ['ep_codex', { ...codex, status: 'active', public_key: codexKeys.publicKey }],
    ['ep_claude', { ...claude, status: 'active', public_key: claudeKeys.publicKey }]
  ]);
  const outbox = new LocalOutbox({ privateKey: codexKeys.privateKey, endpoint: codex });
  const inbox = new LocalInbox();
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  const item = outbox.queue({ ...template, message_id: 'msg_task_1', conversation_id: 'conv_1', sender: codex, recipient: claude, body: { task_id: 'task_1', instruction: 'Review migration.' }, created_at: '2026-08-13T12:00:00Z', expires_at: '2026-08-14T00:00:00Z' });
  const accepted = acceptEnvelope(item.envelope, { now: new Date('2026-08-13T12:01:00Z'), registered: registry, persist: () => {} });
  assert.equal(accepted.status, 202);
  const queue = new DeliveryQueue(); queue.enqueue({ delivery_id: 'del_task_1', message_id: item.envelope.message_id, attempts: 0 });
  queue.transition('del_task_1', 'delivered'); queue.transition('del_task_1', 'acknowledged');
  assert.equal(inbox.receive(item.envelope).duplicate, false);
  queue.transition('del_task_1', 'processing');
  const result = { ...template, message_id: 'msg_result_1', conversation_id: 'conv_1', sender: claude, recipient: codex, message_type: 'task.result', body: { task_id: 'task_1', status: 'completed', summary: 'Migration reviewed.' }, created_at: '2026-08-13T12:02:00Z', expires_at: '2026-08-14T00:00:00Z', signature: { algorithm: 'Ed25519', key_id: claude.key_id, value: '' } };
  result.signature.value = crypto.sign(null, signedBytes(result), claudeKeys.privateKey).toString('base64url');
  assert.equal(acceptEnvelope(result, { now: new Date('2026-08-13T12:03:00Z'), registered: registry, persist: () => {} }).status, 202);
  queue.transition('del_task_1', 'processed');
  assert.equal(queue.get('del_task_1').state, 'processed');
});

test('replay of an already-accepted message under a new idempotency_key is rejected (§18 #13)', async () => {
  const { acceptEnvelopeAsync } = await import('../relay/v1/accept-envelope.mjs');
  const { createMemoryRepository } = await import('../cli/memory-repository.mjs');
  const keys = crypto.generateKeyPairSync('ed25519');
  const sender = { owner_id: 'usr_replay', endpoint_id: 'ep_replay', key_id: 'key_replay', kind: 'agent' };
  const registered = new Map([['ep_replay', { ...sender, status: 'active', public_key: keys.publicKey }]]);
  const repository = createMemoryRepository();
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  // Note: signature.key_id must be overridden to match the registered
  // endpoint's key_id ('key_replay') -- the template's default key_id
  // ('key_01JEXAMPLE') would otherwise fail signature-key lookup.
  const envelope = { ...template, message_id: 'msg_replay_1', conversation_id: 'conv_replay', sender, recipient: sender, message_type: 'chat.message', body: { text: 'hi' }, created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z', signature: { algorithm: 'Ed25519', key_id: sender.key_id, value: '' } };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  const first = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:00:30Z') });
  assert.equal(first.status, 202);
  const replayed = { ...envelope, idempotency_key: 'a-different-idempotency-key' };
  replayed.signature.value = crypto.sign(null, signedBytes(replayed), keys.privateKey).toString('base64url');
  const second = await acceptEnvelopeAsync(replayed, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'REPLAY_DETECTED');
});

test('grant -> send succeeds -> revoke -> resend denied (§18 #10)', async () => {
  const { acceptEnvelopeAsync } = await import('../relay/v1/accept-envelope.mjs');
  const { createMemoryRepository } = await import('../cli/memory-repository.mjs');
  const keys = crypto.generateKeyPairSync('ed25519');
  const sender = { owner_id: 'usr_revoke', endpoint_id: 'ep_revoke', key_id: 'key_revoke', kind: 'agent' };
  const registered = new Map([['ep_revoke', { ...sender, status: 'active', public_key: keys.publicKey }]]);
  const repository = createMemoryRepository();
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  const conversationId = 'conv_revoke';
  const grant = await repository.createCapabilityGrant({ grantId: 'grant_1', capability: 'sigil.task/submit', scope: `scope:conversation/${conversationId}`, grantedTo: 'ep_revoke', expiresAt: '2026-08-17T00:00:00Z', now: new Date('2026-08-16T12:00:00Z') });
  const envelope1 = { ...template, message_id: 'msg_revoke_1', conversation_id: conversationId, sender, recipient: sender, capabilities: ['sigil.task/submit'], body: { task_id: 'task_r1', instruction: 'x' }, created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z', signature: { algorithm: 'Ed25519', key_id: sender.key_id, value: '' } };
  envelope1.signature.value = crypto.sign(null, signedBytes(envelope1), keys.privateKey).toString('base64url');
  const first = await acceptEnvelopeAsync(envelope1, { registered, repository, now: new Date('2026-08-16T12:00:30Z') });
  assert.equal(first.status, 202);

  await repository.revokeCapabilityGrant(grant.grant_id, { now: new Date('2026-08-16T12:01:00Z') });

  const envelope2 = { ...template, message_id: 'msg_revoke_2', conversation_id: conversationId, sender, recipient: sender, capabilities: ['sigil.task/submit'], idempotency_key: 'send_revoke_2', body: { task_id: 'task_r2', instruction: 'y' }, created_at: '2026-08-16T12:02:00Z', expires_at: '2026-08-16T13:02:00Z', signature: { algorithm: 'Ed25519', key_id: sender.key_id, value: '' } };
  envelope2.signature.value = crypto.sign(null, signedBytes(envelope2), keys.privateKey).toString('base64url');
  const second = await acceptEnvelopeAsync(envelope2, { registered, repository, now: new Date('2026-08-16T12:02:30Z') });
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'CAPABILITY_DENIED');
});

test('a RATE_LIMITED rejection never consumes its own reservation (rollback-on-reject) (§18 #23)', async () => {
  const { acceptEnvelopeAsync } = await import('../relay/v1/accept-envelope.mjs');
  const { createMemoryRepository } = await import('../cli/memory-repository.mjs');
  const keys = crypto.generateKeyPairSync('ed25519');
  const sender = { owner_id: 'usr_quota', endpoint_id: 'ep_quota', key_id: 'key_quota', kind: 'agent' };
  const registered = new Map([['ep_quota', { ...sender, status: 'active', public_key: keys.publicKey }]]);
  const repository = createMemoryRepository();
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  const send = async (n) => {
    const envelope = { ...template, message_id: `msg_quota_${n}`, conversation_id: 'conv_quota', sender, recipient: sender, idempotency_key: `send_quota_${n}`, body: { task_id: `task_q${n}`, instruction: 'x' }, created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z', signature: { algorithm: 'Ed25519', key_id: sender.key_id, value: '' } };
    envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
    return acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:00:00Z'), rateLimits: { endpoint: 2 } });
  };
  assert.equal((await send(1)).status, 202);
  assert.equal((await send(2)).status, 202);
  const third = await send(3);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'RATE_LIMITED');
  // A 4th send in the SAME window must see the count still at 2 (rejected #3
  // never incremented past what #1/#2 already reserved) -- not 3 or 4.
  const fourthOverLimit = await send(4);
  assert.equal(fourthOverLimit.status, 429);
});

test('directory trust: invite issued, redeemed, confirmed, then direct delivery succeeds; revocation blocks it again', { skip: !connectionString }, async (t) => {
  const { baseUrl, server, ids, tokenFor, senderPrivateKey, senderKeyId } = await bootstrapLiveRelay(t);
  t.after(() => server.close());

  const sendEnvelope = () => buildDirectEnvelope({ from: ids.epA, to: ids.epB, ids, privateKey: senderPrivateKey, keyId: senderKeyId });

  const inviteResponse = await fetch(`${baseUrl}/v1/directory/invites`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epA)}` }, body: '{}' });
  assert.equal(inviteResponse.status, 201);
  const { invite } = await inviteResponse.json();

  const redeemResponse = await fetch(`${baseUrl}/v1/directory/invites/redeem`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epB)}` }, body: JSON.stringify({ code: invite.code }) });
  assert.equal(redeemResponse.status, 201);
  const { link } = await redeemResponse.json();
  assert.equal(link.status, 'pending');

  const preConfirmDelivery = await fetch(`${baseUrl}/v1/envelopes`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epA)}` }, body: JSON.stringify(sendEnvelope()) });
  assert.equal(preConfirmDelivery.status, 403);
  const preConfirmBody = await preConfirmDelivery.json();
  assert.equal(preConfirmBody.code, 'DIRECTORY_LINK_REQUIRED');

  const confirmResponse = await fetch(`${baseUrl}/v1/directory/links/${link.link_id}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epA)}` }, body: '{}' });
  assert.equal(confirmResponse.status, 200);
  const { link: activated } = await confirmResponse.json();
  assert.equal(activated.status, 'active');

  const postConfirmDelivery = await fetch(`${baseUrl}/v1/envelopes`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epA)}` }, body: JSON.stringify(sendEnvelope()) });
  assert.equal(postConfirmDelivery.status, 202);

  const revokeResponse = await fetch(`${baseUrl}/v1/directory/links/${link.link_id}/revoke`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epB)}` }, body: '{}' });
  assert.equal(revokeResponse.status, 200);

  const postRevokeDelivery = await fetch(`${baseUrl}/v1/envelopes`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epA)}` }, body: JSON.stringify(sendEnvelope()) });
  assert.equal(postRevokeDelivery.status, 403);
});
