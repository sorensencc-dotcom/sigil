import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
