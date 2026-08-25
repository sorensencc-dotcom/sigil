import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [sigilPath, ...args], {
      env: { ...process.env, ...env, SIGIL_DATABASE_URL: '' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code };
  }
}

test('sigil oidc-issuer list requires --database-url when SIGIL_DATABASE_URL is unset', async () => {
  const { stderr, exitCode } = await run(['oidc-issuer', 'list']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--database-url/);
});

test('sigil oidc-issuer remove requires an issuer argument', async () => {
  const { stderr, exitCode } = await run(['oidc-issuer', 'remove', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage/);
});

test('sigil oidc-issuer remove requires --database-url when SIGIL_DATABASE_URL is unset', async () => {
  const { stderr, exitCode } = await run(['oidc-issuer', 'remove', 'https://idp.example']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--database-url/);
});

test('sigil relay up rejects a non-numeric --oidc-issuer-refresh-interval-ms', async () => {
  const { stderr, exitCode } = await run(['relay', 'up', '--oidc-issuer-refresh-interval-ms', 'nope']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--oidc-issuer-refresh-interval-ms must be a positive integer/);
});

test('sigil relay up rejects a zero --oidc-issuer-refresh-interval-ms', async () => {
  const { stderr, exitCode } = await run(['relay', 'up', '--oidc-issuer-refresh-interval-ms', '0']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--oidc-issuer-refresh-interval-ms must be a positive integer/);
});

test('sigil relay up rejects a negative --oidc-issuer-refresh-interval-ms', async () => {
  const { stderr, exitCode } = await run(['relay', 'up', '--oidc-issuer-refresh-interval-ms=-5']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--oidc-issuer-refresh-interval-ms must be a positive integer/);
});
