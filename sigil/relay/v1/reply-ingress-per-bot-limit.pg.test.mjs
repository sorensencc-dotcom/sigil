import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { createIdentity, saveIdentity } from '../../cli/identity.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { freeDistinctPorts } from '../../scripts/test-free-ports.mjs';

const databaseUrl = process.env.SIGIL_TEST_DATABASE_URL;
const cliPath = fileURLToPath(new URL('../../cli/sigil.mjs', import.meta.url));
const run = promisify(execFile);
const botWrapKey = crypto.randomBytes(32).toString('base64');
const lowCeiling = 5;
const state = {};
const skip = !databaseUrl;

const random = () => crypto.randomBytes(16).toString('base64url');
const newToken = () => `fwr_${crypto.randomBytes(32).toString('base64url')}`;
const sha256 = (token) => crypto.createHash('sha256').update(token).digest();

async function cli(cwd, args) {
  return run(process.execPath, [cliPath, ...args], { cwd, env: { ...process.env, SIGIL_E2E_BOT_WRAP_KEY: botWrapKey } });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') await run('taskkill', ['/F', '/T', '/PID', String(child.pid)]).catch(() => {});
  else child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

function startRelay(cwd, args) {
  const child = spawn(process.execPath, [cliPath, 'relay', 'up', ...args], {
    cwd,
    env: { ...process.env, SIGIL_E2E_BOT_WRAP_KEY: botWrapKey },
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
      const ingress = output.match(/Reply ingress listener: 127\.0\.0\.1:(\d+)/)?.[1];
      if (/Sigil relay listening on http:\/\/127\.0\.0\.1:\d+/.test(output) && ingress) {
        clearTimeout(timer); clearInterval(poll);
        resolve(`http://127.0.0.1:${ingress}`);
      }
    }, 25);
    child.once('exit', (code) => {
      clearTimeout(timer); clearInterval(poll);
      reject(new Error(`relay exited (${code})`));
    });
  });
  return { child, ready };
}

async function launchRelay(extraArgs = []) {
  const systemPath = path.join(state.dir, 'system.identity.json');
  const [relayPort, streamPort, publicPort, ingressPort] = await freeDistinctPorts(4);
  const relay = startRelay(state.dir, [
    '--port', String(relayPort), '--stream-port', String(streamPort),
    '--public-port', String(publicPort), '--ingress-port', String(ingressPort),
    '--ingress-origin', 'https://test.invalid', '--database-url', databaseUrl,
    '--room-human-identity', path.join(state.dir, '.sigil', 'web.identity.json'),
    '--room-system-identity', systemPath, '--room-bot-key-wrap-key', 'SIGIL_E2E_BOT_WRAP_KEY', ...extraArgs,
  ]);
  state.children.push(relay.child);
  return relay.ready;
}

async function post(ingress, token) {
  const response = await fetch(`${ingress}/v1/rooms/room_limit_probe/replies`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const text = await response.text();
  return { status: response.status, retryAfter: response.headers.get('retry-after'), body: text ? JSON.parse(text) : null };
}

async function waitForEarlyMinute(burstSeconds = 25) {
  const seconds = new Date().getUTCSeconds() + new Date().getUTCMilliseconds() / 1000;
  if (seconds > burstSeconds) await new Promise((resolve) => setTimeout(resolve, (60 - seconds + 1) * 1000));
}

async function addBot(botId, endpointId, ownerHuman) {
  const token = newToken();
  await state.pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW()) ON CONFLICT DO NOTHING`, [ownerHuman]);
  await state.pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,kind,created_at) VALUES ($1,$2,'test',$3,$4,'active','agent',NOW())`,
    [endpointId, ownerHuman, `i_${endpointId}`, botId]);
  await state.pool.query(`INSERT INTO floor_warden_bots (bot_id,endpoint_id,display_name,status,created_at) VALUES ($1,$2,$3,'active',NOW())`, [botId, endpointId, botId]);
  await state.repository.insertReplyToken({ tokenId: `frt_${random()}`, botId, tokenSha256: sha256(token), status: 'active', createdAt: new Date(), expiresAt: null });
  return token;
}

test.before(async () => {
  if (skip) return;
  assertDisposableTestDatabase(databaseUrl);
  await applyMigrations(databaseUrl, { reset: true });
  state.children = [];
  state.pool = new pg.Pool({ connectionString: databaseUrl });
  state.repository = new PostgresRepository({ pool: state.pool });
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-per-bot-limit-'));
  await cli(state.dir, ['init', 'web', '--kind', 'human']);
  saveIdentity(path.join(state.dir, 'system.identity.json'), createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' }));
  state.tokenA = await addBot('bot_limit_a', 'ep_limit_a', 'h_limit_a');
  state.tokenB = await addBot('bot_limit_b', 'ep_limit_b', 'h_limit_b');
  state.ingress = await launchRelay();
  state.lowIngress = await launchRelay(['--ingress-rate-per-minute', String(lowCeiling)]);
}, { skip, timeout: 90_000 });

test.after(async () => {
  for (const child of state.children ?? []) await stop(child);
  await state.pool?.end();
  if (state.dir) fs.rmSync(state.dir, { recursive: true, force: true, maxRetries: 3 });
});

test('relay up limits one bot to 30 replies a minute and leaves another bot alone', { skip, timeout: 60_000 }, async () => {
  await waitForEarlyMinute();
  for (let i = 1; i <= 30; i += 1) {
    const result = await post(state.ingress, state.tokenA);
    assert.notEqual(result.status, 429, `request ${i} from bot A was rate limited`);
    assert.notEqual(result.status, 401, `request ${i} from bot A was unauthenticated`);
    assert.notEqual(result.status, 503, `request ${i} from bot A hit a server error`);
  }
  const blocked = await post(state.ingress, state.tokenA);
  assert.deepEqual([blocked.status, blocked.body.code, blocked.retryAfter], [429, 'RATE_LIMITED', '60']);

  const other = await post(state.ingress, state.tokenB);
  assert.notEqual(other.status, 429, 'bot B must not share bot A bucket');
  assert.notEqual(other.status, 401);
});

test('relay up still rejects an unknown token with 401 and the ingress ceiling applies before auth', { skip, timeout: 60_000 }, async () => {
  const unknown = await post(state.ingress, newToken());
  assert.deepEqual([unknown.status, unknown.body.code], [401, 'UNAUTHENTICATED']);

  await waitForEarlyMinute();
  for (let i = 1; i <= lowCeiling; i += 1) {
    const result = await post(state.lowIngress, state.tokenB);
    assert.notEqual(result.status, 429, `request ${i} was rate limited under the ceiling`);
  }
  const ceiling = await post(state.lowIngress, state.tokenB);
  assert.deepEqual([ceiling.status, ceiling.body.code, ceiling.retryAfter], [429, 'RATE_LIMITED', '60']);
  const anonymous = await post(state.lowIngress, newToken());
  assert.deepEqual([anonymous.status, anonymous.retryAfter], [429, '60']);
});
