import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freeDistinctPorts } from '../scripts/test-free-ports.mjs';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const fakeDatabaseUrl = 'postgres://127.0.0.1:5432/sigil_fixture';
let initFixture;

function fixtureCwd() {
  if (!initFixture) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-ingress-test-'));
    execFileSync(process.execPath, [sigilCli, 'init', `test_${crypto.randomUUID().replaceAll('-', '')}`], { cwd, encoding: 'utf8' });
    initFixture = cwd;
  }
  return initFixture;
}

function run(args, env = {}) {
  const cwd = fixtureCwd();
  const result = spawnSync(process.execPath, [sigilCli, 'relay', 'up', ...args], {
    cwd,
    env: { ...process.env, ...env, SIGIL_DATABASE_URL: undefined },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { result, out: `${result.stderr}${result.stdout}` };
}

test('relay up help documents all ingress flags', () => {
  const result = spawnSync(process.execPath, [sigilCli, '--help'], { encoding: 'utf8', timeout: 20_000 });
  const out = `${result.stderr}${result.stdout}`;
  for (const flag of ['--ingress-origin', '--ingress-port', '--ingress-rate-per-minute', '--ingress-allow-global-token']) assert.match(out, new RegExp(flag));
});

test('relay up rejects every invalid ingress origin before binding', () => {
  for (const origin of ['http://relay.example', 'https://relay.example/path', 'https://relay.example?query=1', 'ftp://relay.example', 'not a url']) {
    const { result, out } = run(['--ingress-origin', origin, '--database-url', fakeDatabaseUrl, '--room-bot-key-wrap-key', 'SIGIL_TEST_BOT_WRAP']);
    assert.equal(result.status, 1, `${origin}\n${out}`);
    assert.match(out, /--ingress-origin/);
    assert.doesNotMatch(out, /sigil_fixture/);
  }
});

test('relay up requires database, bot wrap key, and a non-zero relay port for ingress', () => {
  for (const args of [
    ['--ingress-origin', 'https://relay.example'],
    ['--ingress-origin', 'https://relay.example', '--database-url', fakeDatabaseUrl],
    ['--port', '0', '--ingress-origin', 'https://relay.example', '--database-url', fakeDatabaseUrl, '--room-bot-key-wrap-key', 'SIGIL_TEST_BOT_WRAP'],
  ]) {
    const { result, out } = run(args);
    assert.equal(result.status, 1, out);
    assert.match(out, /--ingress-origin/);
  }
});

test('relay up rejects invalid ingress rates and overlapping ports', () => {
  for (const rate of ['0', '-1', '1.5', 'abc']) {
    const { result, out } = run(['--port', '8791', '--ingress-origin', 'https://relay.example', '--database-url', fakeDatabaseUrl, '--room-bot-key-wrap-key', 'SIGIL_TEST_BOT_WRAP', '--ingress-rate-per-minute', rate]);
    assert.equal(result.status, 1, `${rate}\n${out}`);
    assert.match(out, /--ingress-rate-per-minute/);
  }
  const { result, out } = run(['--port', '8791', '--stream-port', '8792', '--public-port', '8793', '--ingress-origin', 'https://relay.example', '--ingress-port', '8793', '--database-url', fakeDatabaseUrl, '--room-bot-key-wrap-key', 'SIGIL_TEST_BOT_WRAP']);
  assert.equal(result.status, 1, out);
  assert.match(out, /relay, stream, public and ingress ports must be distinct/);
  assert.match(out, /8793/);
});

test('relay up defaults ingress to relay port plus 5 before binding', () => {
  const { result, out } = run(['--port', '8791', '--stream-port', '8792', '--public-port', '8796', '--ingress-origin', 'https://relay.example', '--database-url', fakeDatabaseUrl, '--room-bot-key-wrap-key', 'SIGIL_TEST_BOT_WRAP']);
  assert.equal(result.status, 1, out);
  assert.match(out, /relay, stream, public and ingress ports must be distinct/);
  assert.match(out, /ingress=8796/);
});

test('relay up without ingress origin keeps the would-be ingress port closed', async () => {
  const [port, streamPort, publicPort] = await freeDistinctPorts(3);
  const cwd = fixtureCwd();
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', String(port), '--stream-port', String(streamPort), '--public-port', String(publicPort)], { cwd });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`relay did not start: ${output}`)), 15_000);
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes(`Sigil relay listening on http://127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.once('exit', (code) => reject(new Error(`relay exited ${code}: ${output}`)));
    });
    await assert.rejects(() => fetch(`http://127.0.0.1:${port + 5}`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    if (process.platform === 'win32' && child.pid) { try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }); } catch {} } else child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('relay up binds the ingress on loopback and warns only for the global-token flag', { skip: !process.env.SIGIL_TEST_DATABASE_URL, timeout: 90_000 }, async () => {
  const cwd = fixtureCwd();
  const [port, streamPort, publicPort, ingressPort] = await freeDistinctPorts(4);
  const env = { ...process.env, SIGIL_TEST_BOT_WRAP: Buffer.alloc(32, 7).toString('base64') };
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', String(port), '--stream-port', String(streamPort), '--public-port', String(publicPort), '--database-url', process.env.SIGIL_TEST_DATABASE_URL, '--room-bot-key-wrap-key', 'SIGIL_TEST_BOT_WRAP', '--ingress-origin', 'https://relay.example', '--ingress-port', String(ingressPort)], { cwd, env });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`relay did not start: ${output}`)), 60_000);
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes(`Reply ingress listener: 127.0.0.1:${ingressPort}`)) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.once('exit', (code) => reject(new Error(`relay exited ${code}: ${output}`)));
    });
    assert.match(output, /Reply ingress origin: https:\/\/relay\.example/);
    assert.doesNotMatch(output, /--ingress-allow-global-token enables/);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});
