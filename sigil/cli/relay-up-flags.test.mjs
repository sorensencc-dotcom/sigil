import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync, execSync, spawn } from 'node:child_process';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function run(args) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-flags-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'alice'], { cwd, encoding: 'utf8' });
  const result = spawnSync(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  return { result, out: `${result.stderr}${result.stdout}` };
}

test('relay up --public-origin requires --room-human-identity', () => {
  const { result, out } = run(['--public-origin', 'https://rooms.example']);
  assert.equal(result.status, 1, out);
  assert.match(out, /--public-origin requires --room-human-identity/);
});

test('relay up --reconcile-kind rejects a malformed spec', () => {
  const { result, out } = run(['--reconcile-kind', 'ep_a=wizard']);
  assert.equal(result.status, 1, out);
  assert.match(out, /--reconcile-kind expects <endpoint_id>=<human\|agent\|system>/);
});

test('relay up help documents --room-key-wrap-key and --reconcile-kind', () => {
  const help = spawnSync(process.execPath, [sigilCli, '--help'], { encoding: 'utf8', timeout: 20_000 });
  const out = `${help.stdout}${help.stderr}`;
  assert.match(out, /--room-key-wrap-key/);
  assert.match(out, /--reconcile-kind/);
});

test('relay up help documents the Floor Warden flags', () => {
  const help = spawnSync(process.execPath, [sigilCli, '--help'], { encoding: 'utf8', timeout: 20_000 });
  const out = `${help.stdout}${help.stderr}`;
  assert.match(out, /--floor-warden-reply-token-env/);
  assert.match(out, /--floor-warden-reply-token-next-env/);
  assert.match(out, /--room-bot-key-wrap-key/);
});

test('relay up refuses a missing reply token variable by name', () => {
  const { result, out } = run(['--floor-warden-reply-token-env', 'SIGIL_TEST_UNSET_FWT']);
  assert.equal(result.status, 1, out);
  assert.match(out, /FLOOR_WARDEN_TOKEN_UNSET/);
  assert.match(out, /SIGIL_TEST_UNSET_FWT/);
});

test('relay up wires the Floor Warden reply handler behind the reply token', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-flags-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'alice'], { cwd, encoding: 'utf8' });
  const token = 't'.repeat(40);
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--stream-port', '0', '--floor-warden-reply-token-env', 'SIGIL_TEST_FWT'], { cwd, env: { ...process.env, SIGIL_TEST_FWT: token } });
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`relay did not start: ${buf}`)), 15_000);
      child.stdout.on('data', (chunk) => { buf += chunk; const m = buf.match(/Sigil relay listening on http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
      child.stderr.on('data', (chunk) => { buf += chunk; });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`relay exited ${code}: ${buf}`)); });
    });
    const res = await fetch(`http://127.0.0.1:${port}/v1/rooms/room_x/replies`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ room_id: 'room_x', target_bot_id: 'bot_nobody', sender: 'ep_test_bot', in_reply_to: 'msg_x', text: 'hi', idempotency_key: 'k1' }),
    });
    const body = await res.json();
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(body.code, 'BOT_NOT_ON_ROSTER');
  } finally {
    if (process.platform === 'win32' && child.pid) { try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }); } catch {} } else child.kill('SIGTERM');
  }
});

test('relay up refuses one wrap key shared by the bot and room signers', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-flags-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'alice'], { cwd, encoding: 'utf8' });
  const key = Buffer.alloc(32, 7).toString('base64');
  const result = spawnSync(
    process.execPath,
    [sigilCli, 'relay', 'up', '--port', '0', '--room-human-identity', path.join(cwd, 'missing.json'), '--room-bot-key-wrap-key', 'SIGIL_TEST_BOT_WK', '--room-key-wrap-key', 'SIGIL_TEST_ROOM_WK'],
    { cwd, encoding: 'utf8', timeout: 20_000, env: { ...process.env, SIGIL_TEST_BOT_WK: key, SIGIL_TEST_ROOM_WK: key } },
  );
  const out = `${result.stderr}${result.stdout}`;
  assert.equal(result.status, 1, out);
  assert.match(out, /WRAP_KEY_REUSED/);
});
