import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from './identity.mjs';
import { checkKeypair, checkRelayConnectivity, findPackageRoot } from './doctor.mjs';

test('checkKeypair reports ok: true and the key_id for a valid identity, without leaking key material', () => {
  const identity = createIdentity({ ownerId: 'usr_test', endpointId: 'ep_test' });
  const result = checkKeypair(identity);
  assert.deepEqual(result, { ok: true, keyId: identity.key_id });
});

test('checkKeypair reports ok: false when key_id is missing', () => {
  const identity = createIdentity({ ownerId: 'usr_test', endpointId: 'ep_test' });
  delete identity.key_id;
  const result = checkKeypair(identity);
  assert.equal(result.ok, false);
  assert.match(result.error, /key_id/);
});

test('checkKeypair reports ok: false when the private key is corrupted', () => {
  const identity = createIdentity({ ownerId: 'usr_test', endpointId: 'ep_test' });
  identity.private_key_pem = identity.private_key_pem.replace('A', 'B');
  const result = checkKeypair(identity);
  assert.equal(result.ok, false);
  assert.equal(result.keyId, identity.key_id);
});

test('checkKeypair reports ok: false when the public key does not match the private key', () => {
  const other = createIdentity({ ownerId: 'usr_other', endpointId: 'ep_other' });
  const identity = createIdentity({ ownerId: 'usr_test', endpointId: 'ep_test' });
  identity.public_key_pem = other.public_key_pem;
  const result = checkKeypair(identity);
  assert.equal(result.ok, false);
  assert.equal(result.keyId, identity.key_id);
});

test('checkRelayConnectivity reports ok: true with a latency measurement when the relay health route responds', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const result = await checkRelayConnectivity(`http://127.0.0.1:${port}`);
    assert.equal(result.ok, true);
    assert.equal(typeof result.latencyMs, 'number');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('checkRelayConnectivity reports ok: false with the HTTP status when the relay responds with an error', async () => {
  const server = http.createServer((req, res) => { res.writeHead(503); res.end(); });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const result = await checkRelayConnectivity(`http://127.0.0.1:${port}`);
    assert.equal(result.ok, false);
    assert.match(result.error, /503/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('checkRelayConnectivity reports ok: false on timeout instead of hanging, and does not leave the timer open', async () => {
  const result = await checkRelayConnectivity('http://127.0.0.1:1', {
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /20ms/);
});

test('checkRelayConnectivity reports ok: false with the underlying error message on a network failure', async () => {
  const result = await checkRelayConnectivity('http://127.0.0.1:1', {
    fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
});

test('findPackageRoot resolves to the directory containing this module\'s nearest package.json, not process.cwd()', () => {
  const originalCwd = process.cwd();
  process.chdir(os.tmpdir());
  try {
    const root = findPackageRoot();
    assert.ok(fs.existsSync(path.join(root, 'package.json')));
    assert.notEqual(root, process.cwd());
  } finally {
    process.chdir(originalCwd);
  }
});
