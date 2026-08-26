import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const KEYS = [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }];

test('getPeerByDomain returns null for an unknown domain', async () => {
  const repository = createMemoryRepository();
  assert.equal(await repository.getPeerByDomain('relay.example.com'), null);
});

test('upsertPeer inserts a record that getPeerByDomain can read back', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-25T00:00:00Z');
  const record = await repository.upsertPeer({ domain: 'relay.example.com', relayUrl: 'https://relay.example.com/v1', wsUrl: null, keys: KEYS, trustMode: 'tofu', now });
  assert.equal(record.domain, 'relay.example.com');
  assert.equal(record.trustMode, 'tofu');
  assert.equal(record.discoveredAt, now.toISOString());
  assert.equal(record.updatedAt, now.toISOString());
  assert.deepEqual(await repository.getPeerByDomain('relay.example.com'), record);
});

test('upsertPeer preserves discoveredAt across a later update but bumps updatedAt/lastResolvedAt', async () => {
  const repository = createMemoryRepository();
  const first = new Date('2026-08-25T00:00:00Z');
  const second = new Date('2026-08-26T00:00:00Z');
  await repository.upsertPeer({ domain: 'relay.example.com', relayUrl: 'https://relay.example.com/v1', keys: KEYS, trustMode: 'tofu', now: first });
  const updated = await repository.upsertPeer({ domain: 'relay.example.com', relayUrl: 'https://relay.example.com/v2', keys: KEYS, trustMode: 'tofu', now: second });
  assert.equal(updated.discoveredAt, first.toISOString());
  assert.equal(updated.updatedAt, second.toISOString());
  assert.equal(updated.relayUrl, 'https://relay.example.com/v2');
});

test('listPeers returns all pinned peers', async () => {
  const repository = createMemoryRepository();
  await repository.upsertPeer({ domain: 'a.example.com', relayUrl: 'https://a.example.com/v1', keys: KEYS, trustMode: 'tofu' });
  await repository.upsertPeer({ domain: 'b.example.com', relayUrl: 'https://b.example.com/v1', keys: KEYS, trustMode: 'static' });
  const domains = (await repository.listPeers()).map((p) => p.domain).sort();
  assert.deepEqual(domains, ['a.example.com', 'b.example.com']);
});

test('removePeer deletes a pinned peer and returns true, false if nothing was there', async () => {
  const repository = createMemoryRepository();
  await repository.upsertPeer({ domain: 'relay.example.com', relayUrl: 'https://relay.example.com/v1', keys: KEYS, trustMode: 'tofu' });
  assert.equal(await repository.removePeer('relay.example.com'), true);
  assert.equal(await repository.getPeerByDomain('relay.example.com'), null);
  assert.equal(await repository.removePeer('relay.example.com'), false);
});
