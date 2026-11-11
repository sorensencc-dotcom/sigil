import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveIdentity } from './identity.mjs';
import {
  PREFLIGHT_REQUIRED_FIELDS,
  preflightRegistry,
  preflightRegistryFile,
  saveRegistryFile,
  toRegistryMap,
} from './registry-store.mjs';

const pem = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });

test('toRegistryMap adds a keys Map, keeps legacy top-level key fields, and defaults kind to human', () => {
  const map = toRegistryMap({ endpoints: [{ endpoint_id: 'ep_a', owner_id: 'usr_a', key_id: 'key_a', public_key_pem: pem }] });
  const entry = map.get('ep_a');
  assert.equal(entry.keys.get('key_a').public_key, entry.public_key);
  assert.equal(entry.key_id, 'key_a');
  assert.equal(entry.kind, 'human');
  assert.equal(entry.status, 'active');
});

test('toRegistryMap keeps an explicit kind', () => {
  const map = toRegistryMap({ endpoints: [{ endpoint_id: 'ep_s', owner_id: 'usr_a', key_id: 'key_s', kind: 'system', public_key_pem: pem }] });
  assert.equal(map.get('ep_s').kind, 'system');
});

test('identity and registry files are written with owner-only permissions', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX file mode bits are not available on Windows');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-file-mode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const identityPath = path.join(dir, 'identity.json');
  const registryPath = path.join(dir, 'registry.json');
  saveIdentity(identityPath, { private_key_pem: 'private' });
  saveRegistryFile(registryPath, { endpoints: [{ relay_token: 'secret' }] });

  assert.equal(fs.statSync(identityPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(registryPath).mode & 0o777, 0o600);
});

test('preflightRegistry reports entries missing owner, key or kind without secret values', () => {
  assert.deepEqual(PREFLIGHT_REQUIRED_FIELDS, ['owner_id', 'key_id', 'kind']);
  assert.equal(Object.isFrozen(PREFLIGHT_REQUIRED_FIELDS), true);

  const fixture = {
    endpoints: [
      {
        endpoint_id: 'ep_complete@fixture.example',
        owner_id: 'usr_fixture_1',
        key_id: 'key_fixture_1',
        kind: 'agent',
        relay_token: 'SENTINEL_RELAY_TOKEN_1',
        public_key_pem: 'SENTINEL_PUBLIC_KEY_PEM_1',
        connector_token: 'SENTINEL_CONNECTOR_TOKEN_1',
      },
      {
        endpoint_id: 'ep_missing_owner@fixture.example',
        key_id: 'key_fixture_2',
        kind: 'agent',
        relay_token: 'SENTINEL_RELAY_TOKEN_2',
        public_key_pem: 'SENTINEL_PUBLIC_KEY_PEM_2',
      },
      {
        endpoint_id: 'ep_missing_key_kind@fixture.example',
        owner_id: 'usr_fixture_3',
        key_id: '   ',
        relay_token: 'SENTINEL_RELAY_TOKEN_3',
        public_key_pem: 'SENTINEL_PUBLIC_KEY_PEM_3',
      },
      {
        key_id: 'key_fixture_4',
        kind: 'human',
        relay_token: 'SENTINEL_RELAY_TOKEN_4',
        public_key_pem: 'SENTINEL_PUBLIC_KEY_PEM_4',
      },
    ],
  };

  const result = preflightRegistry(fixture);
  assert.deepEqual(result, {
    ok: false,
    gaps: [
      {
        index: 1,
        endpoint_id: 'ep_missing_owner@fixture.example',
        missing: ['owner_id'],
      },
      {
        index: 2,
        endpoint_id: 'ep_missing_key_kind@fixture.example',
        missing: ['key_id', 'kind'],
      },
      {
        index: 3,
        endpoint_id: null,
        missing: ['owner_id'],
      },
    ],
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.gaps), true);
  for (const gap of result.gaps) {
    assert.equal(Object.isFrozen(gap), true);
    assert.equal(Object.isFrozen(gap.missing), true);
  }

  const serialized = JSON.stringify(result);
  for (const secret of [
    'SENTINEL_RELAY_TOKEN_1',
    'SENTINEL_RELAY_TOKEN_2',
    'SENTINEL_RELAY_TOKEN_3',
    'SENTINEL_RELAY_TOKEN_4',
    'SENTINEL_PUBLIC_KEY_PEM_1',
    'SENTINEL_PUBLIC_KEY_PEM_2',
    'SENTINEL_PUBLIC_KEY_PEM_3',
    'SENTINEL_PUBLIC_KEY_PEM_4',
    'SENTINEL_CONNECTOR_TOKEN_1',
    'usr_fixture_1',
    'usr_fixture_3',
    'key_fixture_1',
    'key_fixture_2',
    'key_fixture_4',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }

  const noArray = preflightRegistry({});
  assert.deepEqual(noArray, {
    ok: false,
    gaps: [{ index: null, endpoint_id: null, missing: ['endpoints'] }],
  });
});

test('preflightRegistry passes a complete registry', () => {
  const result = preflightRegistry({
    endpoints: [
      {
        endpoint_id: 'ep_one@fixture.example',
        owner_id: 'usr_1',
        key_id: 'key_1',
        kind: 'agent',
        relay_token: 'SENTINEL_TOKEN',
        public_key_pem: pem,
      },
    ],
  });
  assert.deepEqual(result, { ok: true, gaps: [] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.gaps), true);
});

test('preflightRegistryFile is read-only and handles missing and invalid files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-preflight-reg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const missingDir = path.join(dir, 'nested-missing');
  const missingPath = path.join(missingDir, 'registry.json');
  const missingRes = preflightRegistryFile(missingPath);
  assert.deepEqual(missingRes, {
    ok: false,
    gaps: [{ index: null, endpoint_id: null, missing: ['file'] }],
  });
  assert.equal(fs.existsSync(missingPath), false);
  assert.equal(fs.existsSync(missingDir), false);

  const invalidPath = path.join(dir, 'invalid.json');
  const invalidContent = '{not valid json SENTINEL_INVALID_SECRET';
  fs.writeFileSync(invalidPath, invalidContent, 'utf8');
  const fixedTime = new Date('2026-01-01T00:00:00.000Z');
  fs.utimesSync(invalidPath, fixedTime, fixedTime);
  const mtimeBefore = fs.statSync(invalidPath).mtimeMs;

  const invalidRes = preflightRegistryFile(invalidPath);
  assert.deepEqual(invalidRes, {
    ok: false,
    gaps: [{ index: null, endpoint_id: null, missing: ['json'] }],
  });
  assert.equal(fs.readFileSync(invalidPath, 'utf8'), invalidContent);
  assert.equal(fs.statSync(invalidPath).mtimeMs, mtimeBefore);
  assert.equal(JSON.stringify(invalidRes).includes('SENTINEL_INVALID_SECRET'), false);

  const validPath = path.join(dir, 'valid.json');
  const validData = {
    endpoints: [
      {
        endpoint_id: 'ep_valid@fixture.example',
        owner_id: 'usr_v',
        key_id: 'key_v',
        kind: 'agent',
        relay_token: 'SENTINEL_VALID_SECRET',
        public_key_pem: pem,
      },
      {
        endpoint_id: 'ep_gap@fixture.example',
        owner_id: 'usr_v',
        key_id: 'key_v',
        relay_token: 'SENTINEL_GAP_SECRET',
        public_key_pem: pem,
      },
    ],
  };
  saveRegistryFile(validPath, validData);
  assert.deepEqual(preflightRegistryFile(validPath), preflightRegistry(validData));
});
