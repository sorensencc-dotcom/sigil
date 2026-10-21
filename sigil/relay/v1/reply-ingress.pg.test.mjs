import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { freeDistinctPorts } from '../../test-support/free-ports.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { createIdentity, loadIdentity, saveIdentity } from '../../cli/identity.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { createReplyIngress } from './reply-ingress.mjs';
import { createPublicListener } from './oauth/public-listener.mjs';

const databaseUrl = process.env.SIGIL_TEST_DATABASE_URL;
const cliPath = fileURLToPath(new URL('../../cli/sigil.mjs', import.meta.url));
const run = promisify(execFile);
const botEndpoint = 'ep_test_bot';
const botId = 'bot_test';
const ownerId = 'usr_web@local';
const botWrapKey = crypto.randomBytes(32).toString('base64');
const globalToken = `fwr_${crypto.randomBytes(32).toString('base64url')}`;
const state = {};
const skip = !databaseUrl;

const random = () => crypto.randomBytes(16).toString('base64url');

async function cli(cwd, args, extraEnv = {}) {
  return run(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv, SIGIL_E2E_BOT_WRAP_KEY: botWrapKey },
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') await run('taskkill', ['/F', '/T', '/PID', String(child.pid)]).catch(() => {});
  else child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

function startRelay(cwd, args, env) {
  const child = spawn(process.execPath, [cliPath, 'relay', 'up', ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { output += chunk; });
  }
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start (${child.exitCode ?? 'running'})`)), 30_000);
    const poll = setInterval(() => {
      const relay = output.match(/Sigil relay listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      const ingress = output.match(/Reply ingress listener: 127\.0\.0\.1:(\d+)/)?.[1];
      if (relay && ingress) {
        clearTimeout(timer); clearInterval(poll);
        resolve({ relay, ingress: `http://127.0.0.1:${ingress}`, output: () => output });
      }
    }, 25);
    child.once('exit', (code) => {
      clearTimeout(timer); clearInterval(poll);
      reject(new Error(`relay exited (${code})`));
    });
  });
  return { child, ready };
}

async function request(url, token, body, method = 'POST') {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsedBody = text ? JSON.parse(text) : null;
  for (const secret of [state.token, state.otherToken, globalToken]) {
    if (secret) assert.equal(JSON.stringify(parsedBody).includes(secret), false, 'response leaked a reply token');
  }
  return { status: response.status, headers: response.headers, body: parsedBody };
}

async function newRoom(label) {
  const created = await request(`${state.relay}/v1/rooms`, state.web.relay_token, { name: `${label}-${random()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const roomId = created.body.room.conversation_id;
  const member = await request(`${state.relay}/v1/rooms/${roomId}/members`, state.web.relay_token, {
    endpoint_id: botEndpoint, response_mode: 'mentions_only',
  });
  assert.equal(member.status, 201, JSON.stringify(member.body));
  return roomId;
}

async function runningInvocation(roomId, label = 'trigger') {
  const message = await request(`${state.relay}/v1/rooms/${roomId}/messages`, state.web.relay_token, {
    text: `${label} @Test Bot`, mentions: [botEndpoint], idempotency_key: random(),
  });
  assert.equal(message.status, 201, JSON.stringify(message.body));
  return { roomId, messageId: message.body.message_id };
}

async function reply(invocation, token, overrides = {}) {
  return request(`${state.ingress}/v1/rooms/${invocation.roomId}/replies`, token, {
    room_id: invocation.roomId,
    target_bot_id: botId,
    sender: botEndpoint,
    in_reply_to: invocation.messageId,
    text: 'Answer from the test bot',
    idempotency_key: `${invocation.messageId}:${botId}`,
    ...overrides,
  });
}

test.before(async () => {
  if (skip) return;
  assertDisposableTestDatabase(databaseUrl);
  await applyMigrations(databaseUrl, { reset: true });
  state.pool = new pg.Pool({ connectionString: databaseUrl });
  state.repository = new PostgresRepository({ pool: state.pool });
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-reply-ingress-'));
  await cli(state.dir, ['init', 'web', '--kind', 'human']);
  await cli(state.dir, ['init', 'agent', '--owner', ownerId, '--kind', 'agent']);
  await state.pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW()) ON CONFLICT DO NOTHING`, [ownerId]);
  const botPath = path.join(state.dir, '.sigil', `${botEndpoint}.json`);
  await cli(state.dir, ['bot', 'add', '--bot-id', botId, '--endpoint', botEndpoint, '--name', 'Test Bot',
    '--identity', path.join(state.dir, '.sigil', 'web.identity.json'), '--config', path.join(state.dir, 'none.json'),
    '--out', botPath, '--registry', path.join(state.dir, '.sigil', 'registry.json'), '--database-url', databaseUrl,
    '--room-bot-key-wrap-key', 'SIGIL_E2E_BOT_WRAP_KEY']);
  state.bot = loadIdentity(botPath);
  const systemPath = path.join(state.dir, 'system.identity.json');
  saveIdentity(systemPath, createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' }));
  const issued = { token: `fwr_${crypto.randomBytes(32).toString('base64url')}`, tokenId: `frt_${random()}`, sha256: null };
  issued.sha256 = crypto.createHash('sha256').update(issued.token).digest();
  await state.repository.insertReplyToken({ tokenId: issued.tokenId, botId, tokenSha256: issued.sha256, status: 'active', createdAt: new Date(), expiresAt: null });
  state.token = issued.token;
  const other = { token: `fwr_${crypto.randomBytes(32).toString('base64url')}`, tokenId: `frt_${random()}`, sha256: null };
  other.sha256 = crypto.createHash('sha256').update(other.token).digest();
  await state.pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ('h_other','active',NOW())`);
  await state.pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,kind,created_at) VALUES ('ep_other','h_other','test','i_other','Other','active','agent',NOW())`);
  await state.pool.query(`INSERT INTO floor_warden_bots (bot_id,endpoint_id,display_name,status,created_at) VALUES ('bot_other','ep_other','Other','active',NOW())`);
  await state.repository.insertReplyToken({ tokenId: other.tokenId, botId: 'bot_other', tokenSha256: other.sha256, status: 'active', createdAt: new Date(), expiresAt: null });
  state.otherToken = other.token;
  const [port, streamPort, publicPort, ingressPort] = await freeDistinctPorts(4);
  const relay = startRelay(state.dir, ['--port', String(port), '--stream-port', String(streamPort), '--public-port', String(publicPort), '--ingress-port', String(ingressPort),
    '--ingress-origin', 'https://test.invalid', '--database-url', databaseUrl, '--room-human-identity', path.join(state.dir, '.sigil', 'web.identity.json'),
    '--room-system-identity', systemPath, '--room-bot-key-wrap-key', 'SIGIL_E2E_BOT_WRAP_KEY', '--floor-warden-reply-token-env', 'SIGIL_TEST_GLOBAL_TOKEN'],
  { SIGIL_TEST_GLOBAL_TOKEN: globalToken, SIGIL_E2E_BOT_WRAP_KEY: botWrapKey });
  const ready = await relay.ready;
  state.relayChild = relay.child;
  state.relay = ready.relay;
  state.ingress = ready.ingress;
  state.relayOutput = ready.output;
  state.web = loadIdentity(path.join(state.dir, '.sigil', 'web.identity.json'));
}, { skip, timeout: 90_000 });

test.after(async () => {
  await stop(state.relayChild);
  await stop(state.globalRelayChild);
  await state.pool?.end();
  if (state.dir) fs.rmSync(state.dir, { recursive: true, force: true, maxRetries: 3 });
});

test('real HTTP accepts a reply and makes the same idempotency key a duplicate', { skip, timeout: 60_000 }, async () => {
  const invocation = await runningInvocation(await newRoom('happy'));
  const first = await reply(invocation, state.token);
  const second = await reply(invocation, state.token, { text: 'changed' });
  assert.deepEqual([first.status, first.body.duplicate], [202, false]);
  assert.deepEqual([second.status, second.body.duplicate], [202, true]);
  assert.equal(first.headers.get('retry-after'), null);
});

test('real HTTP refuses wrong-bot, revoked, expired, and normal endpoint credentials', { skip, timeout: 60_000 }, async () => {
  const wrong = await runningInvocation(await newRoom('wrong-bot'));
  const wrongBot = await reply(wrong, state.otherToken, { idempotency_key: `${wrong.messageId}:wrong` });
  assert.deepEqual([wrongBot.status, wrongBot.body.code], [403, 'BOT_NOT_ON_ROSTER']);

  const revokedToken = `fwr_${crypto.randomBytes(32).toString('base64url')}`;
  const revokedId = `frt_${random()}`;
  await state.repository.insertReplyToken({ tokenId: revokedId, botId, tokenSha256: crypto.createHash('sha256').update(revokedToken).digest(), status: 'revoked', createdAt: new Date(), expiresAt: null });
  const revoked = await reply(await runningInvocation(await newRoom('revoked')), revokedToken);
  assert.deepEqual([revoked.status, revoked.body.code], [401, 'UNAUTHENTICATED']);

  const expiredToken = `fwr_${crypto.randomBytes(32).toString('base64url')}`;
  await state.repository.insertReplyToken({ tokenId: `frt_${random()}`, botId, tokenSha256: crypto.createHash('sha256').update(expiredToken).digest(), status: 'retired', createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 1_000) });
  const expired = await reply(await runningInvocation(await newRoom('expired')), expiredToken);
  assert.deepEqual([expired.status, expired.body.code], [401, 'UNAUTHENTICATED']);

  const endpoint = await request(`${state.ingress}/v1/rooms/room_missing/replies`, state.web.relay_token, {});
  assert.deepEqual([endpoint.status, endpoint.body.code], [401, 'UNAUTHENTICATED']);
});

test('retired token works inside its grace window and the global token stays refused by default', { skip, timeout: 60_000 }, async () => {
  const graceToken = `fwr_${crypto.randomBytes(32).toString('base64url')}`;
  await state.repository.insertReplyToken({ tokenId: `frt_${random()}`, botId, tokenSha256: crypto.createHash('sha256').update(graceToken).digest(), status: 'retired', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
  const grace = await reply(await runningInvocation(await newRoom('grace')), graceToken);
  assert.equal(grace.status, 202, JSON.stringify(grace.body));
  const global = await reply(await runningInvocation(await newRoom('global-refused')), globalToken);
  assert.deepEqual([global.status, global.body.code], [401, 'UNAUTHENTICATED']);
});

test('global token works only when allowGlobal is enabled', { skip, timeout: 60_000 }, async () => {
  const [port, streamPort, publicPort, ingressPort] = await freeDistinctPorts(4);
  const systemPath = path.join(state.dir, 'system.identity.json');
  const relay = startRelay(state.dir, ['--port', String(port), '--stream-port', String(streamPort), '--public-port', String(publicPort), '--ingress-port', String(ingressPort),
    '--ingress-origin', 'https://test.invalid', '--ingress-allow-global-token', '--database-url', databaseUrl,
    '--room-human-identity', path.join(state.dir, '.sigil', 'web.identity.json'), '--room-system-identity', systemPath,
    '--room-bot-key-wrap-key', 'SIGIL_E2E_BOT_WRAP_KEY', '--floor-warden-reply-token-env', 'SIGIL_TEST_GLOBAL_TOKEN'],
  { SIGIL_TEST_GLOBAL_TOKEN: globalToken, SIGIL_E2E_BOT_WRAP_KEY: botWrapKey });
  const ready = await relay.ready;
  state.globalRelayChild = relay.child;
  const invocation = await runningInvocation(await newRoom('global-allowed'));
  const allowed = await request(`${ready.ingress}/v1/rooms/${invocation.roomId}/replies`, globalToken, {
    room_id: invocation.roomId, target_bot_id: botId, sender: botEndpoint, in_reply_to: invocation.messageId,
    text: 'global answer', idempotency_key: `${invocation.messageId}:${botId}`,
  });
  assert.equal(allowed.status, 202, JSON.stringify(allowed.body));
});

test('real HTTP uses the fixed retry-after for ingress and bot rate limits', { skip, timeout: 60_000 }, async () => {
  const limiter = createReplyIngress({
    limiter: async () => ({ allowed: false }),
    gate: async () => { throw new Error('gate must not run'); },
  });
  const address = await limiter.listen(0);
  const blocked = await request(`http://127.0.0.1:${address.port}/v1/rooms/room_x/replies`, state.token, {});
  assert.deepEqual([blocked.status, blocked.body.code, blocked.headers.get('retry-after')], [429, 'RATE_LIMITED', '60']);
  await new Promise((resolve) => limiter.server.close(resolve));

  const botLimited = createReplyIngress({
    limiter: async () => ({ allowed: true }),
    match: async () => ({ kind: 'bot', botId }),
    perBotLimiter: async () => ({ allowed: false }),
    gate: async () => { throw new Error('gate must not run'); },
  });
  const botAddress = await botLimited.listen(0);
  const botBlocked = await request(`http://127.0.0.1:${botAddress.port}/v1/rooms/room_x/replies`, state.token, {});
  assert.deepEqual([botBlocked.status, botBlocked.body.code, botBlocked.headers.get('retry-after')], [429, 'RATE_LIMITED', '60']);
  await new Promise((resolve) => botLimited.server.close(resolve));
});

test('limiter and database failures return 503 without exposing secrets', { skip, timeout: 60_000 }, async () => {
  const failure = createReplyIngress({
    limiter: async () => { throw new Error('database failed'); },
    gate: async () => { throw new Error('gate must not run'); },
  });
  const address = await failure.listen(0);
  const result = await request(`http://127.0.0.1:${address.port}/v1/rooms/room_x/replies`, state.token, {});
  assert.deepEqual([result.status, result.body.code], [503, 'DATABASE_UNAVAILABLE']);
  assert.equal(JSON.stringify(result.body).includes(state.token), false);
  await new Promise((resolve) => failure.server.close(resolve));

  const audit = await state.pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(a)), '[]'::jsonb) AS rows FROM audit_events a WHERE a.event_type = 'room.floor_warden_reply'`);
  assert.equal(JSON.stringify(audit.rows[0].rows).includes(state.token), false);
  assert.equal(state.relayOutput().includes(state.token), false, 'relay log leaked a reply token');
});

test('stale and stopped invocations are refused, and the cookie listener does not accept bearer replies', { skip, timeout: 60_000 }, async () => {
  const staleRoom = await newRoom('stale');
  const old = await runningInvocation(staleRoom);
  assert.equal((await reply(old, state.token)).status, 202);
  const current = await runningInvocation(staleRoom);
  const stale = await reply(current, state.token, { in_reply_to: old.messageId, idempotency_key: `${old.messageId}:stale` });
  assert.deepEqual([stale.status, stale.body.code], [403, 'ROOM_NOT_INVOKED']);

  const stopped = await runningInvocation(await newRoom('stopped'));
  const stop = await request(`${state.relay}/v1/rooms/${stopped.roomId}/stop`, state.web.relay_token, {});
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const late = await reply(stopped, state.token);
  assert.deepEqual([late.status, late.body.code], [403, 'ROOM_NOT_INVOKED']);
  const cookieListener = createPublicListener({
    publicOrigin: 'https://rooms.example.com',
    authenticateCookie: async () => null,
    handleOAuthPublicRoute: async () => false,
    handleOAuthSessionRoute: async () => false,
    handleRoomRoute: async () => { throw new Error('cookie listener reached room handler'); },
  });
  await new Promise((resolve) => cookieListener.listen(0, '127.0.0.1', resolve));
  const cookie = await request(`http://127.0.0.1:${cookieListener.address().port}/v1/rooms/${stopped.roomId}/replies`, state.token, {});
  await new Promise((resolve) => cookieListener.close(resolve));
  assert.deepEqual([cookie.status, cookie.body.code], [401, 'UNAUTHENTICATED']);
});

test('database-backed matcher failure is a 503 and never reaches the handler', { skip, timeout: 60_000 }, async () => {
  let handlerCalls = 0;
  const ingress = createReplyIngress({
    match: async () => { throw new Error('database failed'); },
    gate: async () => { handlerCalls += 1; },
  });
  const address = await ingress.listen(0);
  const result = await request(`http://127.0.0.1:${address.port}/v1/rooms/room_x/replies`, state.token, {});
  assert.deepEqual([result.status, result.body.code, handlerCalls], [503, 'DATABASE_UNAVAILABLE', 0]);
  await new Promise((resolve) => ingress.server.close(resolve));
});
