import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentity } from './identity.mjs';
import { addEndpointToRegistry } from './registry-store.mjs';

const SIGIL_CLI_PATH = fileURLToPath(new URL('./sigil.mjs', import.meta.url));

test('relay startup prints fixed PostgreSQL text and never the database URL', () => {
  const source = fs.readFileSync(new URL('./sigil.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes("'Connecting to PostgreSQL... Ctrl+C to stop.'"), true);
  assert.doesNotMatch(source, /Persisting to PostgreSQL database \(/);
  // databaseUrl may choose between fixed strings; it must never be interpolated or concatenated into output.
  assert.doesNotMatch(source, /(console\.(log|info|warn|error)|logger\??\.\w+\??\.?)\([^\n]*(\$\{[^}\n]*databaseUrl|databaseUrl\s*\.\s*replace|\+\s*databaseUrl\b|\bdatabaseUrl\s*\+)/);
});

test('relay up with an unreachable database never prints credentials', { timeout: 20000 }, async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-up-log-'));
  const registryPath = path.join(tmpDir, 'registry.json');

  const bot = createIdentity({
    ownerId: 'usr_fixture@fixture.example',
    endpointId: 'ep_fixture@fixture.example',
    kind: 'agent',
  });
  addEndpointToRegistry(registryPath, bot);

  const child = spawn(
    process.execPath,
    [
      SIGIL_CLI_PATH,
      'relay',
      'up',
      '--registry',
      registryPath,
      '--port',
      '0',
      '--database-url',
      'postgres://SENTINEL_USER:SENTINEL_PASS@127.0.0.1:1/SENTINEL_DB?password=SENTINEL_QUERY_PASS',
    ],
    {
      cwd: tmpDir,
      env: { ...process.env, SIGIL_DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const waitForExit = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let killTimer = null;
  const timeoutPromise = new Promise((resolve) => {
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      resolve();
    }, 15_000);
  });

  await Promise.race([waitForExit, timeoutPromise]);
  clearTimeout(killTimer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  await waitForExit;

  const combined = `${stdout}\n${stderr}`;
  for (const secret of [
    'SENTINEL_USER',
    'SENTINEL_PASS',
    'SENTINEL_DB',
    'SENTINEL_QUERY_PASS',
    'postgres://',
  ]) {
    assert.equal(combined.includes(secret), false, `output leaked ${secret}`);
  }
});
