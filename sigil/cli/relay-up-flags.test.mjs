import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

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
