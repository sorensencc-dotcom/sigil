import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

test('getOidcIssuerAllowlistEntry returns null for an unknown issuer', async () => {
  const repository = createMemoryRepository();
  assert.equal(await repository.getOidcIssuerAllowlistEntry('https://unknown.example'), null);
});

test('getOidcIssuerAllowlistEntry returns a seeded entry', async () => {
  const repository = createMemoryRepository();
  repository._debugSeedOidcIssuer({ issuer: 'https://idp.example', clientId: 'client_123' });
  const entry = await repository.getOidcIssuerAllowlistEntry('https://idp.example');
  assert.deepEqual(entry, { issuer: 'https://idp.example', clientId: 'client_123', enabled: true });
});

test('getOidcIssuerAllowlistEntry reflects enabled: false when seeded that way', async () => {
  const repository = createMemoryRepository();
  repository._debugSeedOidcIssuer({ issuer: 'https://idp.example', clientId: 'client_123', enabled: false });
  const entry = await repository.getOidcIssuerAllowlistEntry('https://idp.example');
  assert.equal(entry.enabled, false);
});

test('listOidcIssuerAllowlist returns an empty array when nothing is seeded', async () => {
  const repository = createMemoryRepository();
  assert.deepEqual(await repository.listOidcIssuerAllowlist(), []);
});

test('listOidcIssuerAllowlist returns only enabled issuers', async () => {
  const repository = createMemoryRepository();
  repository._debugSeedOidcIssuer({ issuer: 'https://enabled.example', clientId: 'client_1', enabled: true });
  repository._debugSeedOidcIssuer({ issuer: 'https://disabled.example', clientId: 'client_2', enabled: false });
  const entries = await repository.listOidcIssuerAllowlist();
  assert.deepEqual(entries, [{ issuer: 'https://enabled.example', clientId: 'client_1', enabled: true }]);
});

test('upsertOidcIssuerAllowlist adds a real issuer with a client_id that getOidcIssuerAllowlistEntry can read back', async () => {
  const repository = createMemoryRepository();
  await repository.upsertOidcIssuerAllowlist({ issuer: 'https://idp.example', clientId: 'sigil-client-1', displayLabel: 'Example IdP', assuranceLevel: 'standard' });
  const entry = await repository.getOidcIssuerAllowlistEntry('https://idp.example');
  assert.deepEqual(entry, { issuer: 'https://idp.example', clientId: 'sigil-client-1', enabled: true });
});

test('upsertOidcIssuerAllowlist overwrites an existing row for the same issuer', async () => {
  const repository = createMemoryRepository();
  await repository.upsertOidcIssuerAllowlist({ issuer: 'https://idp.example', clientId: 'old-client' });
  await repository.upsertOidcIssuerAllowlist({ issuer: 'https://idp.example', clientId: 'new-client' });
  const entry = await repository.getOidcIssuerAllowlistEntry('https://idp.example');
  assert.equal(entry.clientId, 'new-client');
});
