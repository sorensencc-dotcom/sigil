import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VaultIsolationLayer, SecurityBoundaryError } from './vault-isolation-layer.mjs';

describe('VaultIsolationLayer (Security Containment & File Operations)', () => {
  let sandboxDir;
  let vaultDir;
  let externalSecretFile;
  let isolationLayer;

  before(async () => {
    sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sigil-vault-test-'));
    vaultDir = path.join(sandboxDir, 'vault');
    await fs.mkdir(vaultDir, { recursive: true });

    externalSecretFile = path.join(sandboxDir, 'secret_token.txt');
    await fs.writeFile(externalSecretFile, 'SIGIL_SUPER_SECRET_KEY=998877', 'utf8');

    isolationLayer = new VaultIsolationLayer(vaultDir);
  });

  after(async () => {
    if (existsSync(sandboxDir)) {
      await fs.rm(sandboxDir, { recursive: true, force: true });
    }
  });

  test('resolves and reads legitimate files inside the vault', async () => {
    await isolationLayer.writeFile('config/app.json', JSON.stringify({ active: true }));
    const content = await isolationLayer.readFile('config/app.json');
    assert.deepEqual(JSON.parse(content), { active: true });
  });

  test('atomic write replaces file cleanly without leaving temp files', async () => {
    await isolationLayer.writeFile('data.txt', 'initial-data');
    assert.equal(await isolationLayer.readFile('data.txt'), 'initial-data');

    await isolationLayer.writeFile('data.txt', 'updated-data');
    assert.equal(await isolationLayer.readFile('data.txt'), 'updated-data');

    const files = await isolationLayer.listDirectory('.');
    const tmpFiles = files.filter(f => f.name.includes('.tmp'));
    assert.equal(tmpFiles.length, 0);
  });

  test('blocks parent directory traversal attempts (../)', async () => {
    await assert.rejects(
      async () => isolationLayer.readFile('../secret_token.txt'),
      (err) => err instanceof SecurityBoundaryError && err.message.includes('escapes')
    );
  });

  test('blocks deep nested backtracking traversal', async () => {
    await assert.rejects(
      async () => isolationLayer.readFile('nested/dir/../../../secret_token.txt'),
      (err) => err instanceof SecurityBoundaryError && err.message.includes('escapes')
    );
  });

  test('blocks null-byte injection payloads', async () => {
    await assert.rejects(
      async () => isolationLayer.readFile('allowed.txt\0/../../secret_token.txt'),
      (err) => err instanceof SecurityBoundaryError && err.message.toLowerCase().includes('null byte')
    );
  });

  test('blocks URL-encoded traversal payloads (%2e%2e%2f)', async () => {
    await assert.rejects(
      async () => isolationLayer.readFile('%2e%2e%2fsecret_token.txt'),
      (err) => err instanceof SecurityBoundaryError && err.message.includes('escapes')
    );
  });

  test('blocks malicious symlinks pointing outside the vault', async () => {
    const symlinkTarget = path.join(vaultDir, 'symlink_leak.txt');
    try {
      symlinkSync(externalSecretFile, symlinkTarget);
      await assert.rejects(
        async () => isolationLayer.readFile('symlink_leak.txt'),
        (err) => err instanceof SecurityBoundaryError && err.message.includes('escapes')
      );
    } catch (symlinkErr) {
      if (symlinkErr.code !== 'EPERM') throw symlinkErr;
    }
  });

  test('blocks absolute path injection attempts', async () => {
    await assert.rejects(
      async () => isolationLayer.readFile(externalSecretFile),
      (err) => err instanceof SecurityBoundaryError && err.message.includes('escapes')
    );
  });

  test('lists directories safely with type flags', async () => {
    await isolationLayer.writeFile('docs/readme.txt', 'Sigil docs');
    const items = await isolationLayer.listDirectory('docs');
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'readme.txt');
    assert.equal(items[0].isFile, true);
  });

  test('unlinks files safely within boundary and prevents escape unlink', async () => {
    await isolationLayer.writeFile('temp_to_delete.txt', 'delete me');
    await isolationLayer.unlink('temp_to_delete.txt');

    await assert.rejects(
      async () => isolationLayer.stat('temp_to_delete.txt')
    );

    // Prevent unlinking outside vault
    await assert.rejects(
      async () => isolationLayer.unlink('../secret_token.txt'),
      (err) => err instanceof SecurityBoundaryError
    );
  });
});
