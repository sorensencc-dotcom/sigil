import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createIdentity, saveIdentity } from './identity.mjs';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

test('relay up --room-system-identity rejects an identity for the wrong endpoint', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-room-system-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'alice'], { cwd, encoding: 'utf8' });
  const wrong = path.join(cwd, 'wrong.json');
  saveIdentity(wrong, createIdentity({ ownerId: 'relay_system', endpointId: 'ep_not_system', kind: 'system' }));
  const result = spawnSync(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--room-system-identity', wrong], { cwd, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 1, `expected clean exit 1: ${result.stderr}`);
  assert.match(`${result.stderr}${result.stdout}`, /ep_relay_system/);
});
