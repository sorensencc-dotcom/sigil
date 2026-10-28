// Task 9 membership + Task 10 report_only post path against disposable Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { createRelayServer } from './http-server.mjs';
import { REPORT_RATE_LIMIT, REPORT_RATE_WINDOW_MS, REPORT_TEXT_MAX } from './room-dispatch.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { RelayClient } from '../../connectors/v1/relay-client.mjs';
import {
  createReportState,
  createReportPolicy,
  postReport as postIronbotReport,
  reportIdempotencyKey,
  FRESH_MS,
} from '../../bridges/v1/ironbot-report.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const NOW = new Date('2029-12-31T12:01:00.000Z');

async function seed(pool, suffix, names) {
  const humanId = `usr_report_${suffix}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [humanId]);
  const endpoints = {};
  for (const name of names) {
    const endpointId = `ep_${name}_${suffix}`;
    const keyId = `key_${name}_${suffix}`;
    const keys = crypto.generateKeyPairSync('ed25519');
    const kind = name.startsWith('web') || name === 'owner' ? 'human' : 'agent';
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $3, 'active', NOW())`,
      [endpointId, humanId, name, kind, `install_${endpointId}`],
    );
    await pool.query(
      `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
       VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`,
      [keyId, endpointId, keys.publicKey.export({ type: 'spki', format: 'der' })],
    );
    endpoints[name] = { endpointId, keyId, keys, kind };
  }
  const registered = new Map(Object.values(endpoints).map(({ endpointId, keyId, keys, kind }) => [endpointId, { owner_id: humanId, status: 'active', kind, key_id: keyId, public_key: keys.publicKey }]));
  return { humanId, endpoints, registered };
}

function roomEnvelope(world, conversationId, senderName, overrides = {}) {
  const sender = world.endpoints[senderName];
  const { body: bodyOverride, created_at, expires_at, ...rest } = overrides;
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: conversationId, message_type: 'room.message',
    sender: { endpoint_id: sender.endpointId, owner_id: world.humanId }, broadcast_scope: { conversation_id: conversationId },
    body: { text: 'report', ...(bodyOverride ?? {}) }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`,
    created_at: created_at ?? '2029-12-31T12:00:00.000Z', expires_at: expires_at ?? '2029-12-31T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: sender.keyId, value: '' },
    ...rest,
  };
  if (bodyOverride) envelope.body = { text: 'report', ...bodyOverride };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), sender.keys.privateKey).toString('base64url');
  return envelope;
}

function isoAt(ms) { return new Date(ms).toISOString(); }

async function postReport(world, repository, conversationId, senderName, { now = NOW, text = 'r', ...extra } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const envelope = roomEnvelope(world, conversationId, senderName, {
    body: { text },
    created_at: isoAt(nowMs - 60_000),
    expires_at: isoAt(nowMs + 3_600_000),
    ...extra,
  });
  const result = await acceptEnvelopeAsync(envelope, { repository, registered: world.registered, now });
  return { envelope, result };
}

test('postgres repository stores and restores report_only membership', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const world = await seed(pool, suffix, ['owner', 'reporter']);
  const repository = new PostgresRepository({ pool });
  const roomId = `room_report_${suffix}`;
  await repository.createRoom({
    conversationId: roomId,
    workspaceId: `ws_${world.humanId}`,
    name: `reports_${suffix}`,
    createdByHumanId: world.humanId,
    ownerEndpointId: world.endpoints.owner.endpointId,
  });

  const member = await repository.addRoomMember({
    conversationId: roomId,
    endpointId: world.endpoints.reporter.endpointId,
    role: 'member',
    responseMode: 'report_only',
    addedByHumanId: world.humanId,
  });
  assert.equal(member.response_mode, 'report_only');
  assert.equal((await repository.lookupRoomMember(roomId, world.endpoints.reporter.endpointId)).response_mode, 'report_only');

  await repository.removeRoomMember({ conversationId: roomId, endpointId: world.endpoints.reporter.endpointId });
  const restored = await repository.addRoomMember({
    conversationId: roomId,
    endpointId: world.endpoints.reporter.endpointId,
    role: 'member',
    responseMode: 'mentions_only',
    addedByHumanId: world.humanId,
  });
  assert.equal(restored.response_mode, 'mentions_only');
});

test('postgres report_only post path: marker, refusals, rate cap, membership, concurrency, receipts', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString, max: 20 });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const world = await seed(pool, suffix, ['owner', 'web2', 'reporter_a', 'reporter_b', 'claude']);
  const repository = new PostgresRepository({ pool });
  const roomId = `room_ro_${suffix}`;
  await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${world.humanId}`, name: `ro_${suffix}`, createdByHumanId: world.humanId, ownerEndpointId: world.endpoints.owner.endpointId, now: NOW });
  await repository.addRoomMember({ conversationId: roomId, endpointId: world.endpoints.web2.endpointId, role: 'member', responseMode: null, addedByHumanId: world.humanId, now: NOW });
  await repository.addRoomMember({ conversationId: roomId, endpointId: world.endpoints.reporter_a.endpointId, role: 'member', responseMode: 'report_only', addedByHumanId: world.humanId, now: NOW });
  await repository.addRoomMember({ conversationId: roomId, endpointId: world.endpoints.reporter_b.endpointId, role: 'member', responseMode: 'report_only', addedByHumanId: world.humanId, now: NOW });
  await repository.addRoomMember({ conversationId: roomId, endpointId: world.endpoints.claude.endpointId, role: 'member', responseMode: 'joins', addedByHumanId: world.humanId, now: NOW });

  const ok = await postReport(world, repository, roomId, 'reporter_a', { text: 'x'.repeat(100) });
  assert.equal(ok.result.status, 202);
  assert.equal((await repository.lookupRoomMessage(roomId, ok.envelope.message_id)).report_post, true);
  assert.equal((await repository.listRoomInvocations(roomId)).length, 0);

  for (const [overrides, code] of [
    [{ body: { text: 'hi', mentions: [world.endpoints.claude.endpointId] } }, 'REPORT_MENTIONS_FORBIDDEN'],
    [{ body: { text: 'hi', thread_root_id: 'msg_root' } }, 'REPORT_THREAD_FORBIDDEN'],
    [{ message_type: 'task.request', body: { task_id: 'task_1', instruction: 'do', assignee: world.endpoints.claude.endpointId } }, 'REPORT_MESSAGE_TYPE_FORBIDDEN'],
    [{ body: { text: 'x'.repeat(REPORT_TEXT_MAX + 1) } }, 'REPORT_TEXT_TOO_LONG'],
  ]) {
    const envelope = roomEnvelope(world, roomId, 'reporter_a', overrides);
    const result = await acceptEnvelopeAsync(envelope, { repository, registered: world.registered, now: NOW });
    assert.equal(result.body.code, code, code);
    assert.equal(result.status, 400, code);
  }

  const human = await acceptEnvelopeAsync(
    roomEnvelope(world, roomId, 'owner', { body: { text: 'human', mentions: [world.endpoints.claude.endpointId] } }),
    { repository, registered: world.registered, now: NOW },
  );
  assert.equal(human.status, 202);
  assert.equal((await repository.lookupRoomMessage(roomId, human.body.message_id)).report_post, false);
  const reply = await acceptEnvelopeAsync(
    roomEnvelope(world, roomId, 'claude', { body: { text: 'reply', thread_root_id: human.body.message_id } }),
    { repository, registered: world.registered, now: NOW },
  );
  assert.equal(reply.status, 202);
  assert.equal((await repository.lookupRoomMessage(roomId, reply.body.message_id)).report_post, false);

  // Fill remaining cap slots (1 already accepted above).
  for (let i = 0; i < REPORT_RATE_LIMIT - 1; i++) {
    const sender = i % 2 === 0 ? 'reporter_a' : 'reporter_b';
    const r = await postReport(world, repository, roomId, sender, { now: NOW, text: `fill${i}` });
    assert.equal(r.result.status, 202, `fill${i}`);
  }
  const limited = await postReport(world, repository, roomId, 'reporter_a', { now: NOW, text: 'over' });
  assert.equal(limited.result.status, 429);
  assert.equal(limited.result.body.code, 'REPORT_RATE_LIMITED');
  const dup = await acceptEnvelopeAsync(ok.envelope, { repository, registered: world.registered, now: NOW });
  assert.equal(dup.status, 202);
  assert.equal(dup.body.duplicate, true);

  await repository.removeRoomMember({ conversationId: roomId, endpointId: world.endpoints.reporter_a.endpointId });
  await repository.addRoomMember({ conversationId: roomId, endpointId: world.endpoints.reporter_a.endpointId, role: 'member', responseMode: 'mentions_only', addedByHumanId: world.humanId, now: NOW });
  const stillLimited = await postReport(world, repository, roomId, 'reporter_b', { now: NOW, text: 'member-change' });
  assert.equal(stillLimited.result.status, 429);

  const later = new Date(NOW.getTime() + REPORT_RATE_WINDOW_MS + 1000);
  const afterWindow = await postReport(world, repository, roomId, 'reporter_b', { now: later, text: 'window-ok' });
  assert.equal(afterWindow.result.status, 202);

  // Concurrency: 36 parallel posts into a fresh room, expect 30 accepted + 6 rate-limited.
  const room2 = `room_conc_${suffix}`;
  await repository.createRoom({ conversationId: room2, workspaceId: `ws_${world.humanId}`, name: `conc_${suffix}`, createdByHumanId: world.humanId, ownerEndpointId: world.endpoints.owner.endpointId, now: NOW });
  await repository.addRoomMember({ conversationId: room2, endpointId: world.endpoints.reporter_a.endpointId, role: 'member', responseMode: 'report_only', addedByHumanId: world.humanId, now: NOW });
  await repository.addRoomMember({ conversationId: room2, endpointId: world.endpoints.reporter_b.endpointId, role: 'member', responseMode: 'report_only', addedByHumanId: world.humanId, now: NOW });
  const envelopes = Array.from({ length: 36 }, (_, i) => roomEnvelope(world, room2, i % 2 === 0 ? 'reporter_a' : 'reporter_b', {
    body: { text: `c${i}` },
    created_at: isoAt(NOW.getTime() - 60_000),
    expires_at: isoAt(NOW.getTime() + 3_600_000),
  }));
  const results = await Promise.all(envelopes.map((envelope) => acceptEnvelopeAsync(envelope, { repository, registered: world.registered, now: NOW })));
  const accepted = results.filter((r) => r.status === 202);
  const refused = results.filter((r) => r.status === 429 && r.body.code === 'REPORT_RATE_LIMITED');
  assert.equal(accepted.length, 30, JSON.stringify(results.filter((r) => r.status !== 202 && r.status !== 429).map((r) => r.body)));
  assert.equal(refused.length, 6);
  const marked = await pool.query(`SELECT count(*)::int AS n FROM envelopes WHERE conversation_id = $1 AND report_post = true`, [room2]);
  assert.equal(marked.rows[0].n, 30);

  // Receipts for a real report_only sender.
  const principals = {
    'Bearer reporter': { endpoint_id: world.endpoints.reporter_b.endpointId, owner_id: world.humanId },
    'Bearer other': { endpoint_id: world.endpoints.owner.endpointId, owner_id: world.humanId },
  };
  const server = createRelayServer({
    registry: world.registered, repository, now: () => later,
    authenticate: async (request) => principals[request.headers.authorization] ?? null,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const get = (auth, messageId) => new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: `/v1/messages/${messageId}/receipts`, headers: { authorization: auth } }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      }).on('error', reject);
    });
    const asSender = await get('Bearer reporter', afterWindow.envelope.message_id);
    assert.equal(asSender.status, 200);
    assert.ok(Array.isArray(asSender.body.receipts));
    assert.equal((await get('Bearer other', afterWindow.envelope.message_id)).status, 404);
    assert.equal((await get('Bearer reporter', 'msg_missing')).body.code, 'MESSAGE_NOT_FOUND');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- Task 11: Ironbots poster against real report_only + Postgres ---
const quiet = { info() {}, warn() {}, error() {} };

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-report-pg-'));
  return path.join(dir, 'state.json');
}

async function startPosterWorld(pool, { clock, suffix = crypto.randomUUID().replaceAll('-', '_') } = {}) {
  const world = await seed(pool, suffix, ['owner', 'reporter']);
  const repository = new PostgresRepository({ pool });
  const roomId = `room_poster_${suffix}`;
  const now0 = () => (clock ? new Date(clock.now) : NOW);
  await repository.createRoom({
    conversationId: roomId,
    workspaceId: `ws_${world.humanId}`,
    name: `poster_${suffix}`,
    createdByHumanId: world.humanId,
    ownerEndpointId: world.endpoints.owner.endpointId,
    now: now0(),
  });
  await repository.addRoomMember({
    conversationId: roomId,
    endpointId: world.endpoints.reporter.endpointId,
    role: 'member',
    responseMode: 'report_only',
    addedByHumanId: world.humanId,
    now: now0(),
  });

  const reporter = world.endpoints.reporter;
  const principals = {
    'Bearer reporter': { endpoint_id: reporter.endpointId, owner_id: world.humanId },
    'Bearer other': { endpoint_id: world.endpoints.owner.endpointId, owner_id: world.humanId },
  };
  const server = createRelayServer({
    registry: world.registered,
    repository,
    now: now0,
    authenticate: async (request) => principals[request.headers.authorization] ?? null,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;
  const relay = new RelayClient({ baseUrl: relayUrl, token: 'reporter' });
  const outbox = new LocalOutbox({
    privateKey: reporter.keys.privateKey,
    endpoint: {
      owner_id: world.humanId,
      endpoint_id: reporter.endpointId,
      key_id: reporter.keyId,
      kind: 'agent',
    },
  });
  const identity = {
    owner_id: world.humanId,
    endpoint_id: reporter.endpointId,
    key_id: reporter.keyId,
    kind: 'agent',
  };
  return {
    world, repository, roomId, relay, outbox, identity, relayUrl, suffix,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function runIronbot(world, {
  statePath, report, now = () => NOW, relay, outbox, resendAsNew = false, httpTimeoutMs = 30_000, log = quiet,
} = {}) {
  const state = createReportState({ statePath, now });
  const policy = createReportPolicy({ state, now });
  return postIronbotReport({
    identity: world.identity,
    relay: relay ?? world.relay,
    outbox: outbox ?? world.outbox,
    roomId: world.roomId,
    report,
    policy,
    state,
    now,
    log,
    resendAsNew,
    httpTimeoutMs,
  });
}

function ironbotReport(overrides = {}) {
  return {
    bot: 'ironbot',
    status: 'degraded',
    timestamp: NOW.toISOString(),
    summary: 'pg-check',
    alerts: [],
    ...overrides,
  };
}

test('Task 11 pg (1) response-loss at +6m reconciles via receipts for report_only', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString, max: 10 });
  t.after(() => pool.end());
  const clock = { now: NOW };
  const world = await startPosterWorld(pool, { clock });
  t.after(() => world.stop());
  const statePath = tmpStatePath();
  const report = ironbotReport();

  let calls = 0;
  const realSend = world.relay.sendEnvelope.bind(world.relay);
  world.relay.sendEnvelope = async (envelope, requestId, options) => {
    calls += 1;
    if (calls === 1) {
      await realSend(envelope, requestId, options);
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    }
    throw new Error('should not resend in RECONCILE');
  };

  const first = await runIronbot(world, { statePath, report, now: () => clock.now });
  assert.equal(first.reason, 'transient');
  assert.equal((await createReportState({ statePath }).loadPending('ironbot')).state, 'sending');

  // Receipts route check for the accepted report (sender 200, other 404).
  const pending = await createReportState({ statePath }).loadPending('ironbot');
  const port = new URL(world.relayUrl).port;
  const getReceipts = (auth, messageId) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: `/v1/messages/${messageId}/receipts`, headers: { authorization: auth } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    }).on('error', reject);
  });
  assert.equal((await getReceipts('Bearer reporter', pending.message_id)).status, 200);
  assert.equal((await getReceipts('Bearer other', pending.message_id)).status, 404);

  clock.now = new Date(NOW.getTime() + FRESH_MS + 120_000);
  let sendCount = 0;
  world.relay.sendEnvelope = async (...args) => {
    sendCount += 1;
    return realSend(...args);
  };
  const reconciled = await runIronbot(world, { statePath, report, now: () => clock.now });
  assert.equal(sendCount, 0);
  assert.equal(reconciled.reason, 'reconciled');
  assert.equal(await createReportState({ statePath }).loadPending('ironbot'), null);
  assert.equal(
    (await createReportState({ statePath }).lastPosted('ironbot')).last_key,
    reportIdempotencyKey('ironbot', report.timestamp),
  );
  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM envelopes WHERE conversation_id = $1 AND report_post = true`,
    [world.roomId],
  );
  assert.equal(rows.rows[0].n, 1);
});

test('Task 11 pg (2) blocked-commit: no resend while held; reconcile after commit', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString, max: 10 });
  t.after(() => pool.end());
  const clock = { now: NOW };
  const world = await startPosterWorld(pool, { clock });
  t.after(() => world.stop());
  const statePath = tmpStatePath();
  const report = ironbotReport({ summary: 'blocked' });

  let releaseCommit;
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  const originalWithTx = world.repository.withTransaction.bind(world.repository);
  world.repository.withTransaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await commitGate;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    } finally {
      client.release();
    }
  };

  const firstPromise = runIronbot(world, {
    statePath,
    report,
    now: () => clock.now,
    httpTimeoutMs: 800,
  });
  // Give accept time to enter the gated transaction.
  await new Promise((r) => setTimeout(r, 200));
  const first = await firstPromise;
  assert.equal(first.posted, false);
  assert.ok(['transient', 'pending'].includes(first.reason), JSON.stringify(first));
  assert.ok(await createReportState({ statePath }).loadPending('ironbot'));

  clock.now = new Date(NOW.getTime() + FRESH_MS + 120_000);
  const mid = await runIronbot(world, { statePath, report, now: () => clock.now });
  assert.equal(mid.reason, 'pending');
  assert.ok(await createReportState({ statePath }).loadPending('ironbot'));
  const beforeRelease = await pool.query(
    `SELECT count(*)::int AS n FROM envelopes WHERE conversation_id = $1 AND report_post = true`,
    [world.roomId],
  );
  assert.equal(beforeRelease.rows[0].n, 0);

  releaseCommit();
  // Allow the gated accept to finish committing.
  await new Promise((r) => setTimeout(r, 300));
  world.repository.withTransaction = originalWithTx;

  const after = await pool.query(
    `SELECT count(*)::int AS n FROM envelopes WHERE conversation_id = $1 AND report_post = true`,
    [world.roomId],
  );
  assert.equal(after.rows[0].n, 1);

  clock.now = new Date(NOW.getTime() + FRESH_MS + 180_000);
  const reconciled = await runIronbot(world, { statePath, report, now: () => clock.now });
  assert.equal(reconciled.reason, 'reconciled');
  assert.equal(await createReportState({ statePath }).loadPending('ironbot'), null);
  assert.equal(
    (await createReportState({ statePath }).lastPosted('ironbot')).last_key,
    reportIdempotencyKey('ironbot', report.timestamp),
  );
  const finalCount = await pool.query(
    `SELECT count(*)::int AS n FROM envelopes WHERE conversation_id = $1 AND report_post = true`,
    [world.roomId],
  );
  assert.equal(finalCount.rows[0].n, 1);
});

test('Task 11 pg (3) skewed-clock FRESH retry while held keeps pending; reconciles after commit', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString, max: 10 });
  t.after(() => pool.end());
  const clock = { now: NOW };
  const world = await startPosterWorld(pool, { clock });
  t.after(() => world.stop());
  const statePath = tmpStatePath();
  const report = ironbotReport({ summary: 'skew-held' });

  let releaseCommit;
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  world.repository.withTransaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await commitGate;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    } finally {
      client.release();
    }
  };

  const firstPromise = runIronbot(world, {
    statePath,
    report,
    now: () => clock.now,
    httpTimeoutMs: 800,
  });
  await new Promise((r) => setTimeout(r, 200));
  const first = await firstPromise;
  assert.equal(first.posted, false);
  const pending0 = await createReportState({ statePath }).loadPending('ironbot');
  assert.equal(pending0.state, 'sending');

  // Poster still FRESH (+3m); relay clock +6m ahead of created_at → INVALID_ENVELOPE on retry.
  const posterNow = new Date(NOW.getTime() + 3 * 60_000);
  clock.now = new Date(NOW.getTime() + 6 * 60_000);
  const logs = [];
  const capturing = {
    info: (payload) => logs.push(payload),
    warn: (payload) => logs.push(payload),
    error: (payload) => logs.push(payload),
  };
  const retry = await runIronbot(world, {
    statePath,
    report,
    now: () => posterNow,
    log: capturing,
  });
  assert.equal(retry.reason, 'pending');
  assert.ok(await createReportState({ statePath }).loadPending('ironbot'));
  const unresolved = logs.find((entry) => entry?.event === 'report_pending_unresolved');
  assert.ok(unresolved, `expected report_pending_unresolved, got ${JSON.stringify(logs)}`);
  assert.equal(unresolved.detail, 'INVALID_ENVELOPE');

  // Same --report-at while still held: no rebuild / no DUPLICATE_MESSAGE loop.
  const again = await runIronbot(world, { statePath, report, now: () => posterNow });
  assert.equal(again.reason, 'pending');

  releaseCommit();
  await new Promise((r) => setTimeout(r, 300));

  clock.now = new Date(NOW.getTime() + 7 * 60_000);
  const reconciled = await runIronbot(world, {
    statePath,
    report,
    now: () => new Date(NOW.getTime() + 7 * 60_000),
  });
  // At +7m poster age from created_at (NOW) is 7m → RECONCILE → receipts 200.
  assert.equal(reconciled.reason, 'reconciled');
  assert.equal(await createReportState({ statePath }).loadPending('ironbot'), null);

  const already = await runIronbot(world, {
    statePath,
    report,
    now: () => new Date(NOW.getTime() + 8 * 60_000),
  });
  assert.equal(already.reason, 'already_posted');
  const finalCount = await pool.query(
    `SELECT count(*)::int AS n FROM envelopes WHERE conversation_id = $1 AND report_post = true`,
    [world.roomId],
  );
  assert.equal(finalCount.rows[0].n, 1);
});
