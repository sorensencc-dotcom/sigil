// Task 11: `sigil agent run --room-bridge floor-warden` with a receive-only
// identity. Fixtures only: no real Grok routine, no real webhook, no real
// relay. Identities are built in a temp directory; nothing under .sigil/ is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { createAgentDaemon } from './agent-daemon.mjs';
import { createIdentity, saveIdentity } from './identity.mjs';
import { createFloorWardenBridge } from '../bridges/v1/floor-warden-bridge.mjs';
import { createRedactingLogger } from './redacting-logger.mjs';
import { createSessionStore } from '../bridges/v1/session-store.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const ROOM = 'conv_test_room';
const TRIGGER = 'msg_test_trigger';
const BOT_EP = 'ep_test_bot';
const HUMAN_EP = 'ep_test_human';
const random = () => crypto.randomBytes(18).toString('base64url');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-fw-run-test-'));
}

// The shape `sigil bot add` writes: a relay token, a public key, no private key.
function receiveOnlyIdentity({ botId = 'bot_test_one' } = {}) {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const identity = {
    owner_id: 'hum_test_operator',
    endpoint_id: BOT_EP,
    key_id: `key_${crypto.randomBytes(8).toString('hex')}`,
    kind: 'agent',
    status: 'active',
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }),
    relay_token: random(),
    receive_only: true,
  };
  if (botId) identity.bot_id = botId;
  return identity;
}

function writeIdentity(dir, identity) {
  const file = path.join(dir, `${identity.endpoint_id}.json`);
  fs.writeFileSync(file, JSON.stringify(identity, null, 2));
  return file;
}

const roomEnvelope = () => ({
  protocol: 'sigil/1',
  message_id: TRIGGER,
  conversation_id: ROOM,
  message_type: 'room.message',
  sender: { owner_id: 'hum_test_operator', endpoint_id: HUMAN_EP },
  recipient: { owner_id: 'hum_test_operator', endpoint_id: BOT_EP },
  body: { text: 'hello @Test Bot' },
  created_at: new Date().toISOString(),
});

const taskEnvelope = () => ({
  protocol: 'sigil/1',
  message_id: 'msg_test_task',
  conversation_id: 'conv_test_task',
  message_type: 'task.request',
  sender: { owner_id: 'hum_test_operator', endpoint_id: HUMAN_EP },
  recipient: { owner_id: 'hum_test_operator', endpoint_id: BOT_EP },
  body: { task_id: 'task_1', instruction: 'do something' },
});

// One fake relay answering both the daemon (inbox, ack, processing) and the
// bridge (rooms, members, messages, invocations, fail). Records every call.
function fakeRelay({ inbox = [] } = {}) {
  const calls = [];
  let served = false;
  const route = (method, url, body) => {
    const u = new URL(url, 'http://relay.invalid');
    const p = u.pathname;
    calls.push({ method, path: p, body });
    if (p === '/v1/inbox') {
      const items = served ? [] : inbox;
      served = true;
      return { status: 200, json: { items, next_since: '' } };
    }
    if (p.endsWith('/ack') || p.endsWith('/processing')) return { status: 204, json: null };
    if (p === '/v1/envelopes') return { status: 202, json: { code: 'OK' } };
    if (p === '/v1/rooms') return { status: 200, json: { items: [{ conversation_id: ROOM, name: 'Test Room', max_agent_turns: 6 }] } };
    if (p === `/v1/rooms/${ROOM}/members`) {
      return { status: 200, json: { items: [
        { endpoint_id: BOT_EP, response_mode: 'mention', display_name: 'Test Bot' },
        { endpoint_id: HUMAN_EP, response_mode: null, display_name: 'Test Human' },
      ] } };
    }
    if (p === `/v1/rooms/${ROOM}/messages`) {
      return { status: 200, json: { items: [{ message_id: TRIGGER, room_seq: '5', envelope: roomEnvelope() }], next_after_seq: null } };
    }
    if (p === `/v1/rooms/${ROOM}/invocations/fail`) return { status: 200, json: { invocation: { invocation_id: 'inv_test_1', status: 'failed' } } };
    if (p === `/v1/rooms/${ROOM}/invocations`) {
      return { status: 200, json: { items: [{ invocation_id: 'inv_test_1', endpoint_id: BOT_EP, trigger_message_id: TRIGGER, thread_root_id: TRIGGER, decided_by: 'mention', status: 'running', started_at: new Date().toISOString() }] } };
    }
    return { status: 404, json: { code: 'NOT_FOUND', message: 'not found' } };
  };
  return { calls, route };
}

function asFetch(route) {
  return async (url, options = {}) => {
    const { status, json } = route(options.method ?? 'GET', String(url), options.body ? JSON.parse(options.body) : null);
    const text = json === null ? '' : JSON.stringify(json);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
}

function captureLogger() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 5 }))).join(' ')}`);
  return { lines, logger: { info: push('info'), log: push('log'), warn: push('warn'), error: push('error'), debug: push('debug') } };
}

async function withFetch(fetchImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

// ---- daemon: receive-only identity -------------------------------------------

test('daemon constructs with a receive-only identity and delivers room.message to onRoomMessage', async () => {
  const identity = receiveOnlyIdentity();
  const relay = fakeRelay({ inbox: [{ delivery_id: 'del_room_1', envelope: roomEnvelope() }] });
  const seen = [];
  await withFetch(asFetch(relay.route), async () => {
    const daemon = createAgentDaemon({
      identity,
      relayUrl: 'http://relay.invalid',
      logger: captureLogger().logger,
      onRoomMessage: async ({ deliveryId, envelope }) => { seen.push({ deliveryId, id: envelope.message_id }); return { outcome: 'forwarded' }; },
    });
    assert.equal(await daemon.poll(), 1);
  });
  assert.deepEqual(seen, [{ deliveryId: 'del_room_1', id: TRIGGER }]);
  assert.ok(relay.calls.some((c) => c.path === '/v1/deliveries/del_room_1/ack'));
});

test('daemon acks a task.request on a receive-only identity without a reply, a worker run, or a throw', async () => {
  const identity = receiveOnlyIdentity();
  const relay = fakeRelay({ inbox: [{ delivery_id: 'del_task_1', envelope: taskEnvelope() }] });
  const { logger } = captureLogger();
  let workerRan = false;
  await withFetch(asFetch(relay.route), async () => {
    const daemon = createAgentDaemon({
      identity,
      relayUrl: 'http://relay.invalid',
      logger,
      workerCommand: process.execPath,
      workerArgs: ['-e', 'process.exit(3)'],
      autoReply: true,
    });
    const realExecute = daemon.executeWorker;
    assert.equal(typeof realExecute, 'function');
    const result = await daemon.processItem({ delivery_id: 'del_task_1', envelope: taskEnvelope() });
    assert.equal(result.outcome, 'acknowledged');
    workerRan = relay.calls.some((c) => c.path.endsWith('/processing'));
  });
  assert.equal(workerRan, false, 'worker never ran');
  assert.ok(relay.calls.some((c) => c.path === '/v1/deliveries/del_task_1/ack'), 'delivery acked');
  assert.ok(!relay.calls.some((c) => c.path === '/v1/envelopes'), 'no reply sent');
});

test('daemon start calls onStart and stop calls onStop', async () => {
  const identity = receiveOnlyIdentity();
  const relay = fakeRelay();
  const events = [];
  await withFetch(asFetch(relay.route), async () => {
    const daemon = createAgentDaemon({
      identity,
      relayUrl: 'http://relay.invalid',
      logger: captureLogger().logger,
      pollIntervalMs: 60_000,
      onStart: async () => { events.push('start'); },
      onStop: () => { events.push('stop'); },
    });
    daemon.start();
    await new Promise((resolve) => setImmediate(resolve));
    daemon.stop();
  });
  assert.deepEqual(events, ['start', 'stop']);
});

test('daemon logs an onStart rejection and keeps running', async () => {
  const identity = receiveOnlyIdentity();
  const relay = fakeRelay();
  const { lines, logger } = captureLogger();
  await withFetch(asFetch(relay.route), async () => {
    const daemon = createAgentDaemon({
      identity, relayUrl: 'http://relay.invalid', logger, pollIntervalMs: 60_000,
      onStart: async () => { throw new Error('recover boom'); },
    });
    daemon.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    daemon.stop();
  });
  assert.ok(lines.some((l) => l.includes('recover boom')));
});

// ---- redaction: in-process daemon + bridge, logger captured -------------------

async function runBridgeOnce({ webhookFetch, logger }) {
  const identity = receiveOnlyIdentity();
  const relay = fakeRelay({ inbox: [{ delivery_id: 'del_room_1', envelope: roomEnvelope() }] });
  const relayFetch = asFetch(relay.route);
  const dir = tempDir();
  const bridge = createFloorWardenBridge({
    identity,
    bot: { bot_id: identity.bot_id },
    relay: new RelayClient({ baseUrl: 'http://relay.invalid', token: identity.relay_token, fetchImpl: relayFetch }),
    sessions: createSessionStore(path.join(dir, 'sessions.json')),
    fetchImpl: webhookFetch,
    webhook: webhookFetch.webhook,
    replyUrl: 'https://relay.example.test',
    pollIntervalMs: 60_000,
    sleep: async () => {},
    logger,
  });
  let result;
  await withFetch(relayFetch, async () => {
    const daemon = createAgentDaemon({
      identity, relayUrl: 'http://relay.invalid', logger, pollIntervalMs: 60_000,
      onRoomMessage: bridge.handle, onStart: () => bridge.recover(), onStop: () => bridge.close(),
    });
    result = await daemon.processItem({ delivery_id: 'del_room_1', envelope: roomEnvelope() });
    daemon.stop();
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { result, identity, relay };
}

function webhookFixture(respond) {
  const pathPart = `/hooks/${random()}`;
  const key = random();
  const url = `https://webhook.example.test${pathPart}`;
  const posts = [];
  const fetchImpl = async (target, options) => { posts.push({ target: String(target), headers: options.headers }); return respond({ url, key }); };
  fetchImpl.webhook = { url, key };
  return { url, key, pathPart, fetchImpl, posts };
}

function assertClean(text, { pathPart, key, relayToken }) {
  assert.ok(!text.includes(pathPart), 'webhook URL path leaked');
  assert.ok(!text.includes(pathPart.slice(1)), 'webhook URL path leaked (no slash)');
  assert.ok(!text.includes(key), 'webhook key leaked');
  assert.ok(!text.includes(relayToken), 'relay token leaked');
}

test('redaction: a 503 webhook logs the origin only and leaves the delivery unacked', async () => {
  const hook = webhookFixture(() => ({ ok: false, status: 503, text: async () => '' }));
  const { lines, logger } = captureLogger();
  const { result, identity } = await runBridgeOnce({ webhookFetch: hook.fetchImpl, logger });
  assert.equal(result.outcome, 'room_unacked');
  // One post plus the three in-bridge backoff retries (1s, 2s, 4s), then left for the next poll.
  assert.equal(hook.posts.length, 4);
  const text = lines.join('\n');
  assert.match(text, /webhook\.example\.test/);
  assertClean(text, { ...hook, relayToken: identity.relay_token });
});

test('redaction: a thrown fetch error naming the URL and key is scrubbed from every log line', async () => {
  const hook = webhookFixture(({ url, key }) => {
    throw Object.assign(new Error(`connect ECONNREFUSED ${url} (key ${key})`), { cause: new Error(`socket for ${url}`) });
  });
  const { lines, logger } = captureLogger();
  const { result, identity } = await runBridgeOnce({ webhookFetch: hook.fetchImpl, logger });
  assert.equal(result.outcome, 'room_unacked');
  const text = lines.join('\n');
  assert.ok(text.length > 0, 'something was logged');
  assertClean(text, { ...hook, relayToken: identity.relay_token });
});

test('redaction: a forwarded message logs the origin only', async () => {
  const hook = webhookFixture(() => ({ ok: true, status: 202, text: async () => '' }));
  const { lines, logger } = captureLogger();
  const { result, identity } = await runBridgeOnce({ webhookFetch: hook.fetchImpl, logger });
  assert.equal(result.outcome, 'room_forwarded');
  const text = lines.join('\n');
  assert.match(text, /forwarded inv_test_1 to https:\/\/webhook\.example\.test/);
  assertClean(text, { ...hook, relayToken: identity.relay_token });
});

// ---- CLI ------------------------------------------------------------------------

function runCli(args, { env = {}, cwd = tempDir() } = {}) {
  const result = spawnSync(process.execPath, [sigilCli, 'agent', 'run', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000, env: { ...process.env, SIGIL_IDENTITY: '', ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function floorWardenArgs(idFile, omit = [], replyUrl = 'https://relay.example.test') {
  const all = {
    '--floor-warden-url-env': 'SIGIL_TEST_FW_URL',
    '--floor-warden-key-env': 'SIGIL_TEST_FW_KEY',
    '--floor-warden-reply-url': replyUrl,
  };
  const args = ['--identity', idFile, '--relay-url', 'http://127.0.0.1:1', '--config', path.join(path.dirname(idFile), 'none.json'), '--room-bridge', 'floor-warden'];
  for (const [flag, value] of Object.entries(all)) if (!omit.includes(flag)) args.push(flag, value);
  return args;
}

const secretEnv = () => ({ SIGIL_TEST_FW_URL: `https://webhook.example.test/hooks/${random()}`, SIGIL_TEST_FW_KEY: random() });

function assertNoValues(out, env) {
  for (const value of Object.values(env)) {
    assert.ok(!out.includes(value), 'a secret value was printed');
    try { assert.ok(!out.includes(new URL(value).pathname), 'a URL path was printed'); } catch { /* not a URL */ }
  }
}

for (const flag of ['--floor-warden-url-env', '--floor-warden-key-env', '--floor-warden-reply-url']) {
  test(`agent run --room-bridge floor-warden without ${flag} fails fast naming it`, () => {
    const dir = tempDir();
    const env = secretEnv();
    const idFile = writeIdentity(dir, receiveOnlyIdentity());
    const { status, out } = runCli(floorWardenArgs(idFile, [flag]), { env, cwd: dir });
    assert.notEqual(status, 0);
    assert.ok(out.includes(flag), `error names ${flag}: ${out}`);
    assertNoValues(out, env);
  });
}

for (const [name, other] of [['SIGIL_TEST_FW_URL', 'SIGIL_TEST_FW_KEY'], ['SIGIL_TEST_FW_KEY', 'SIGIL_TEST_FW_URL']]) {
  test(`agent run --room-bridge floor-warden with ${name} unset fails naming the variable, never a value`, () => {
    const dir = tempDir();
    const all = secretEnv();
    const env = { [other]: all[other], [name]: '' };
    const idFile = writeIdentity(dir, receiveOnlyIdentity());
    const { status, out } = runCli(floorWardenArgs(idFile), { env, cwd: dir });
    assert.notEqual(status, 0);
    assert.ok(out.includes(name), `error names ${name}: ${out}`);
    assertNoValues(out, { v: all[other] });
  });
}

test('agent run --room-bridge floor-warden with a URL env that is not http(s) fails without printing it', () => {
  const dir = tempDir();
  const env = { SIGIL_TEST_FW_URL: `not a url ${random()}`, SIGIL_TEST_FW_KEY: random() };
  const idFile = writeIdentity(dir, receiveOnlyIdentity());
  const { status, out } = runCli(floorWardenArgs(idFile), { env, cwd: dir });
  assert.notEqual(status, 0);
  assert.match(out, /SIGIL_TEST_FW_URL/);
  assertNoValues(out, env);
});

test('agent run --room-bridge floor-warden accepts https and loopback http reply URLs', async () => {
  for (const replyUrl of ['https://relay.example.test/replies', 'http://127.0.0.1:8796/replies', 'http://localhost:8796/replies', 'http://[::1]:8796/replies']) {
    const dir = tempDir();
    const env = secretEnv();
    const idFile = writeIdentity(dir, receiveOnlyIdentity());
    const { status, out } = await spawnUntil(floorWardenArgs(idFile, [], replyUrl), { env, cwd: dir, until: /Room bridge: floor-warden/ });
    assert.equal(status, undefined, `${replyUrl}: ${out}`);
  }
});

test('agent run --room-bridge floor-warden refuses public http and malformed reply URLs without echoing values', () => {
  for (const replyUrl of [`http://relay.example.test/${random()}`, `not a url ${random()}`]) {
    const dir = tempDir();
    const env = secretEnv();
    const idFile = writeIdentity(dir, receiveOnlyIdentity());
    const { status, out } = runCli(floorWardenArgs(idFile, [], replyUrl), { env, cwd: dir });
    assert.notEqual(status, 0);
    assert.match(out, /--floor-warden-reply-url/);
    assert.ok(!out.includes(replyUrl));
  }
});

test('agent run --room-bridge floor-warden without a bot id in the identity or a flag fails naming both', () => {
  const dir = tempDir();
  const env = secretEnv();
  const idFile = writeIdentity(dir, receiveOnlyIdentity({ botId: null }));
  const { status, out } = runCli(floorWardenArgs(idFile), { env, cwd: dir });
  assert.notEqual(status, 0);
  assert.match(out, /bot_id/);
  assert.match(out, /--floor-warden-bot-id/);
  assertNoValues(out, env);
});

test('agent run --room-bridge rejects an unknown bridge and lists floor-warden', () => {
  const dir = tempDir();
  const idFile = writeIdentity(dir, receiveOnlyIdentity());
  const { status, out } = runCli(['--identity', idFile, '--relay-url', 'http://127.0.0.1:1', '--config', path.join(dir, 'none.json'), '--room-bridge', 'bogus'], { cwd: dir });
  assert.notEqual(status, 0);
  assert.match(out, /--room-bridge must be claude, codex, copilot, router, or floor-warden/);
});

test('agent run usage text lists floor-warden and its flags', () => {
  const dir = tempDir();
  const { status, out } = runCli(['--room-bridge', 'floor-warden', '--config', path.join(dir, 'none.json')], { cwd: dir });
  assert.notEqual(status, 0);
  assert.match(out, /usage: sigil agent run --identity/);
  assert.match(out, /claude\|codex\|copilot\|router\|floor-warden/);
  for (const flag of ['--floor-warden-url-env', '--floor-warden-key-env', '--floor-warden-key-header', '--floor-warden-reply-url', '--floor-warden-bot-id', '--reply-timeout-ms']) {
    assert.ok(out.includes(flag), `usage lists ${flag}`);
  }
});

test('agent run --room-bridge claude refuses a receive-only identity with a clear message', () => {
  const dir = tempDir();
  const idFile = writeIdentity(dir, receiveOnlyIdentity());
  const { status, out } = runCli(['--identity', idFile, '--relay-url', 'http://127.0.0.1:1', '--config', path.join(dir, 'none.json'), '--room-bridge', 'claude'], { cwd: dir });
  assert.notEqual(status, 0);
  assert.match(out, /receive-only/);
});

for (const bad of ['0', 'abc', '-1']) {
  test(`agent run --room-bridge floor-warden rejects --reply-timeout-ms ${bad}`, () => {
    const dir = tempDir();
    const env = secretEnv();
    const idFile = writeIdentity(dir, receiveOnlyIdentity());
    const { status, out } = runCli([...floorWardenArgs(idFile), `--reply-timeout-ms=${bad}`], { env, cwd: dir });
    assert.notEqual(status, 0);
    assert.match(out, /--reply-timeout-ms must be a positive integer/);
    assertNoValues(out, env);
  });
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
}

// Spawn the CLI until `until` matches its combined output, then kill it.
function spawnUntil(args, { env, cwd, until }) {
  const child = spawn(process.execPath, [sigilCli, 'agent', 'run', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIGIL_IDENTITY: '', ...env } });
  let stdout = '';
  let stderr = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { killTree(child); reject(new Error(`timed out: ${stdout}${stderr}`)); }, 15_000);
    const check = () => { if (until.test(`${stdout}${stderr}`)) { clearTimeout(timer); killTree(child); resolve({ stdout, stderr }); } };
    child.stdout.on('data', (d) => { stdout += d; check(); });
    child.stderr.on('data', (d) => { stderr += d; check(); });
    child.once('exit', () => { clearTimeout(timer); resolve({ stdout, stderr, exited: true }); });
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function relayServer(relay) {
  return listen((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const { status, json } = relay.route(req.method, req.url, raw ? JSON.parse(raw) : null);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(json === null ? '' : JSON.stringify(json));
    });
  });
}

async function cliRedactionRun(webhookOrigin, hookPath) {
  const dir = tempDir();
  const identity = receiveOnlyIdentity();
  const idFile = writeIdentity(dir, identity);
  const relay = fakeRelay({ inbox: [{ delivery_id: 'del_room_1', envelope: roomEnvelope() }] });
  const relaySrv = await relayServer(relay);
  const key = random();
  const env = { SIGIL_TEST_FW_URL: `${webhookOrigin}${hookPath}`, SIGIL_TEST_FW_KEY: key };
  try {
    const args = ['--identity', idFile, '--relay-url', `http://127.0.0.1:${relaySrv.address().port}`, '--config', path.join(dir, 'none.json'),
      '--room-bridge', 'floor-warden', '--floor-warden-url-env', 'SIGIL_TEST_FW_URL', '--floor-warden-key-env', 'SIGIL_TEST_FW_KEY',
      '--floor-warden-reply-url', 'https://relay.example.test', '--room-sessions', path.join(dir, 'sessions.json')];
    const out = await spawnUntil(args, { env, cwd: dir, until: /delivery left for the next poll/ });
    return { ...out, key, identity };
  } finally {
    relaySrv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('redaction: sigil agent run against a 503 webhook prints neither the URL path, the key, nor the relay token', async () => {
  const hookPath = `/hooks/${random()}`;
  let posted = 0;
  const hook = await listen((req, res) => { posted += 1; req.resume(); res.writeHead(503); res.end(); });
  const origin = `http://127.0.0.1:${hook.address().port}`;
  try {
    const { stdout, stderr, key, identity, exited } = await cliRedactionRun(origin, hookPath);
    assert.ok(!exited, `CLI exited early: ${stdout}${stderr}`);
    assert.equal(posted, 4, 'one post plus three in-bridge retries before leaving it for the next poll');
    assert.match(stdout, /Room bridge: floor-warden/);
    for (const text of [stdout, stderr]) assertClean(text, { pathPart: hookPath, key, relayToken: identity.relay_token });
    assert.ok(`${stdout}${stderr}`.includes(origin), 'origin may appear');
  } finally {
    hook.close();
  }
});

test('redaction: sigil agent run against an unreachable webhook prints neither the URL path, the key, nor the relay token', async () => {
  const closed = await listen(() => {});
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const hookPath = `/hooks/${random()}`;
  const { stdout, stderr, key, identity, exited } = await cliRedactionRun(`http://127.0.0.1:${port}`, hookPath);
  assert.ok(!exited, `CLI exited early: ${stdout}${stderr}`);
  for (const text of [stdout, stderr]) assertClean(text, { pathPart: hookPath, key, relayToken: identity.relay_token });
});

// ---- bridges still accepted, bot id sourcing, recover on start --------------------

for (const kind of ['claude', 'codex']) {
  test(`agent run --room-bridge ${kind} is still accepted`, async () => {
    const dir = tempDir();
    const idFile = path.join(dir, 'agent.json');
    saveIdentity(idFile, createIdentity({ ownerId: 'alice', endpointId: 'ep_alice_cli', kind: 'agent' }));
    const { stdout, stderr, exited } = await spawnUntil(['--identity', idFile, '--relay-url', 'http://127.0.0.1:1', '--config', path.join(dir, 'none.json'), '--room-bridge', kind, '--room-sessions', path.join(dir, 's.json')], { env: {}, cwd: dir, until: new RegExp(`Room bridge: ${kind}`) });
    assert.ok(!exited, `exited early: ${stdout}${stderr}`);
  });
}

async function announceFloorWarden(identity, extra = []) {
  const dir = tempDir();
  const idFile = writeIdentity(dir, identity);
  const env = secretEnv();
  const out = await spawnUntil([...floorWardenArgs(idFile), '--room-sessions', path.join(dir, 's.json'), ...extra], { env, cwd: dir, until: /Room bridge: floor-warden.*\n/ });
  assertNoValues(`${out.stdout}${out.stderr}`, env);
  return out;
}

test('agent run --room-bridge floor-warden takes the bot id from the identity file', async () => {
  const { stdout, exited } = await announceFloorWarden(receiveOnlyIdentity({ botId: 'bot_from_identity' }));
  assert.ok(!exited, stdout);
  assert.match(stdout, /Room bridge: floor-warden \(bot bot_from_identity, webhook https:\/\/webhook\.example\.test,/);
});

test('agent run --room-bridge floor-warden falls back to --floor-warden-bot-id when the identity lacks bot_id', async () => {
  const { stdout, exited } = await announceFloorWarden(receiveOnlyIdentity({ botId: null }), ['--floor-warden-bot-id', 'bot_from_flag']);
  assert.ok(!exited, stdout);
  assert.match(stdout, /Room bridge: floor-warden \(bot bot_from_flag,/);
});

test('agent run --room-bridge floor-warden refuses a --floor-warden-bot-id that contradicts the identity', () => {
  const dir = tempDir();
  const env = secretEnv();
  const idFile = writeIdentity(dir, receiveOnlyIdentity({ botId: 'bot_a' }));
  const { status, out } = runCli([...floorWardenArgs(idFile), '--floor-warden-bot-id', 'bot_b'], { env, cwd: dir });
  assert.notEqual(status, 0);
  assert.match(out, /--floor-warden-bot-id does not match the bot_id in the identity file/);
  assertNoValues(out, env);
});

test('daemon start runs the bridge recover() and stop closes it', async () => {
  const identity = receiveOnlyIdentity();
  const relay = fakeRelay();
  const relayFetch = asFetch(relay.route);
  const dir = tempDir();
  const hook = webhookFixture(() => ({ ok: true, status: 202, text: async () => '' }));
  const bridge = createFloorWardenBridge({
    identity, bot: { bot_id: identity.bot_id },
    relay: new RelayClient({ baseUrl: 'http://relay.invalid', token: identity.relay_token, fetchImpl: relayFetch }),
    sessions: createSessionStore(path.join(dir, 'sessions.json')),
    fetchImpl: hook.fetchImpl, webhook: hook.fetchImpl.webhook, replyUrl: 'https://relay.example.test',
    pollIntervalMs: 60_000, logger: captureLogger().logger,
  });
  let closed = 0;
  const realClose = bridge.close;
  await withFetch(relayFetch, async () => {
    const daemon = createAgentDaemon({
      identity, relayUrl: 'http://relay.invalid', logger: captureLogger().logger, pollIntervalMs: 60_000,
      onRoomMessage: bridge.handle, onStart: () => bridge.recover(), onStop: () => { closed += 1; realClose(); },
    });
    daemon.start();
    for (let i = 0; i < 50 && !relay.calls.some((c) => c.path === `/v1/rooms/${ROOM}/invocations`); i += 1) await new Promise((r) => setTimeout(r, 10));
    daemon.stop();
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(relay.calls.some((c) => c.path === '/v1/rooms'), 'recover listed rooms');
  assert.ok(relay.calls.some((c) => c.path === `/v1/rooms/${ROOM}/invocations`), 'recover read running invocations');
  assert.equal(closed, 1);
});

// ---- fix round 1 -------------------------------------------------------------------

test('daemon still throws at construction for a keyless identity that is not receive-only', () => {
  const identity = receiveOnlyIdentity();
  delete identity.receive_only;
  assert.throws(() => createAgentDaemon({ identity, relayUrl: 'http://relay.invalid', logger: captureLogger().logger }));
  const corrupt = { ...createIdentity({ ownerId: 'alice', endpointId: 'ep_alice_bad', kind: 'agent' }), private_key_pem: 'not a pem' };
  assert.throws(() => createAgentDaemon({ identity: corrupt, relayUrl: 'http://relay.invalid', logger: captureLogger().logger }));
  assert.doesNotThrow(() => createAgentDaemon({ identity: receiveOnlyIdentity(), relayUrl: 'http://relay.invalid', logger: captureLogger().logger }));
});

test('redacting logger scrubs a secret holding quote characters from errors, causes, nested objects and long strings', () => {
  const key = `k'e"y\`-${random()}`;
  const urlPath = `/hooks/it's-${random()}`;
  const lines = [];
  const sink = { log: (l) => lines.push(l), info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l), debug: (l) => lines.push(l) };
  const { logger } = createRedactingLogger({ secrets: [key, urlPath], sink });
  const err = Object.assign(new Error(`boom ${key}`), { detail: { url: `https://x.test${urlPath}` }, cause: new Error(`cause ${urlPath} ${key}`) });
  logger.error('failed:', err);
  logger.warn({ nested: { deep: [`a ${key} b`, { k: urlPath }] } });
  logger.info({ long: `${'x'.repeat(9_995)}${key}${'y'.repeat(50)}` });
  logger.log(`plain ${key}`);
  const text = lines.join('\n');
  assert.equal(lines.length, 4);
  assert.ok(!text.includes(key), 'key leaked');
  assert.ok(!text.includes(urlPath), 'path leaked');
  for (const fragment of [key.slice(0, 6), key.slice(7), urlPath.slice(8)]) assert.ok(!text.includes(fragment), `fragment leaked: ${fragment}`);
  assert.ok(!text.includes(util.inspect(key).slice(1, -1)), 'inspect-escaped key leaked');
  assert.match(text, /\[redacted\]/);
  assert.match(text, /boom/);
  assert.match(text, /cause/);
});
