// sigil/relay/v1/room-system-identity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createIdentity, saveIdentity, identityKeys } from '../../cli/identity.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { loadRoomSystemIdentity, ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from './room-system-identity.mjs';

const NOW = new Date('2026-10-04T12:00:00.000Z');

function writeIdentity(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-sys-'));
  const file = path.join(dir, 'system.json');
  saveIdentity(file, { ...createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' }), ...overrides });
  return file;
}

test('loads an identity file for the relay system endpoint', () => {
  const identity = loadRoomSystemIdentity(writeIdentity());
  assert.equal(identity.endpoint_id, 'ep_relay_system');
});

test('refuses an identity file for any other endpoint', () => {
  assert.throws(() => loadRoomSystemIdentity(writeIdentity({ endpoint_id: 'ep_other' })), /ep_relay_system/);
  assert.throws(() => loadRoomSystemIdentity(writeIdentity({ owner_id: 'usr_chris' })), /relay_system/);
});

test('ensureRoomSystemEndpoint is idempotent and registers the signing key', async () => {
  const identity = loadRoomSystemIdentity(writeIdentity());
  const registry = new Map();
  const repository = createMemoryRepository({ registry });
  await repository.ensureRoomSystemEndpoint({ identity, now: NOW });
  await repository.ensureRoomSystemEndpoint({ identity, now: NOW });
  const entry = registry.get('ep_relay_system');
  assert.equal(entry.kind, 'system');
  assert.equal(entry.status, 'active');
  assert.deepEqual(entry.public_key.export({ type: 'spki', format: 'der' }), identityKeys(identity).publicKey.export({ type: 'spki', format: 'der' }));
});
