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
