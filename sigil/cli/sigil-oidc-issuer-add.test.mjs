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

test('sigil oidc-issuer add requires --client-id', async () => {
  const { stderr, exitCode } = await run(['oidc-issuer', 'add', 'https://idp.example', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--client-id/);
});

test('sigil oidc-issuer add requires --database-url when SIGIL_DATABASE_URL is unset', async () => {
  const { stderr, exitCode } = await run(['oidc-issuer', 'add', 'https://idp.example', '--client-id', 'sigil-client-1']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--database-url/);
});
