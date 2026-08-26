import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [sigilPath, ...args], {
      env: { ...process.env, SIGIL_DATABASE_URL: '' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code };
  }
}

test('sigil peer resolve requires a domain', async () => {
  const { stderr, exitCode } = await run(['peer', 'resolve']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil peer resolve/);
});

test('sigil peer resolve requires --database-url when SIGIL_DATABASE_URL is unset', async () => {
  const { stderr, exitCode } = await run(['peer', 'resolve', 'relay.example.com']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--database-url/);
});

test('sigil peer add requires --relay-url/--public-key/--kid', async () => {
  const { stderr, exitCode } = await run(['peer', 'add', 'relay.example.com', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil peer add/);
});

test('sigil peer add requires --database-url when SIGIL_DATABASE_URL is unset', async () => {
  const { stderr, exitCode } = await run(['peer', 'add', 'relay.example.com', '--relay-url', 'https://relay.example.com/v1', '--public-key', 'pub-1', '--kid', 'k1']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--database-url/);
});

test('sigil peer rotate requires --confirm', async () => {
  const { stderr, exitCode } = await run(['peer', 'rotate', 'relay.example.com', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--confirm/);
});

test('sigil peer remove requires a domain', async () => {
  const { stderr, exitCode } = await run(['peer', 'remove']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil peer remove/);
});

test('sigil peer get requires a domain', async () => {
  const { stderr, exitCode } = await run(['peer', 'get']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil peer get/);
});

test('sigil peer add rejects a non-https --relay-url', async () => {
  const { stderr, exitCode } = await run(['peer', 'add', 'relay.example.com', '--relay-url', 'ftp://relay.example.com', '--public-key', 'pub-1', '--kid', 'k1', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--relay-url/);
});

test('sigil peer add rejects a malformed domain', async () => {
  const { stderr, exitCode } = await run(['peer', 'add', 'not a domain', '--relay-url', 'https://relay.example.com/v1', '--public-key', 'pub-1', '--kid', 'k1', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /INVALID_DOMAIN_SYNTAX/);
});

test('sigil peer resolve rejects a malformed domain without attempting a live database connection', async () => {
  const { stderr, exitCode } = await run(['peer', 'resolve', 'not a domain', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /INVALID_DOMAIN_SYNTAX/);
});

test('sigil peer rotate rejects a malformed domain without attempting a live database connection', async () => {
  const { stderr, exitCode } = await run(['peer', 'rotate', 'not a domain', '--confirm', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /INVALID_DOMAIN_SYNTAX/);
});

test('sigil peer validate-document accepts a well-formed file with no network/database access', async () => {
  const file = path.join(os.tmpdir(), `sigil-peer-doc-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify({
    domain: 'relay.example.com',
    relay: { endpoint: 'https://relay.example.com/v1' },
    keys: [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }],
  }));
  const { stdout, exitCode } = await run(['peer', 'validate-document', file]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /relay\.example\.com/);
  await fs.rm(file);
});

test('sigil peer validate-document rejects a malformed file with a clear error, not a stack trace', async () => {
  const file = path.join(os.tmpdir(), `sigil-peer-doc-bad-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify({ domain: 'relay.example.com', relay: { endpoint: 'https://relay.example.com/v1' }, keys: [] }));
  const { stderr, exitCode } = await run(['peer', 'validate-document', file]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /PEER_NO_KEYS/);
  await fs.rm(file);
});

test('sigil peer validate-document rejects a missing file with a clear error, not a stack trace', async () => {
  const { stderr, exitCode } = await run(['peer', 'validate-document', path.join(os.tmpdir(), 'does-not-exist-sigil-peer-doc.json')]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /cannot read/);
  assert.doesNotMatch(stderr, /at Object\.readFile/); // no raw Node stack trace
});

test('sigil peer validate-document rejects a malformed --domain before touching the file (path need not exist -- domain is validated first)', async () => {
  const { stderr, exitCode } = await run(['peer', 'validate-document', 'unused-nonexistent-path.json', '--domain', 'not a domain']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /INVALID_DOMAIN_SYNTAX/);
});

test('sigil peer validate-document requires a path', async () => {
  const { stderr, exitCode } = await run(['peer', 'validate-document']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil peer validate-document/);
});

test('sigil peer resolve --all requires --database-url when SIGIL_DATABASE_URL is unset', async () => {
  const { stderr, exitCode } = await run(['peer', 'resolve', '--all']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--database-url/);
});

test('freshness formats today, N days ago, and never resolved', async () => {
  const { freshness } = await import('./sigil.mjs');
  const now = new Date('2026-08-25T12:00:00Z');
  assert.equal(freshness('2026-08-25T01:00:00Z', now), 'resolved today');
  assert.equal(freshness('2026-08-22T12:00:00Z', now), 'resolved 3d ago');
  assert.equal(freshness(null, now), 'never resolved');
});
