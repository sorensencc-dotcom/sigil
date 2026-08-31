import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute } from './federation-router.mjs';

const envelope = (recipientEndpointId) => ({
  recipient: { endpoint_id: recipientEndpointId, owner_id: 'usr_chris@primary.example', kind: 'agent' },
  sender: { endpoint_id: 'ep_codex@a.example', owner_id: 'usr_chris@primary.example', kind: 'agent' },
});
const peers = new Map([['b.example', { domain: 'b.example', relayUrl: 'https://b.example/relay', keys: [{ kid: 'k1', alg: 'Ed25519', publicKey: 'AA' }], trustMode: 'tofu' }]]);
const getPeerByDomain = async (d) => peers.get(d) ?? null;

test('no relayDomain → local', async () => {
  assert.deepEqual(await decideRoute(envelope('ep_claude@b.example'), { relayDomain: undefined, federationMode: 'sync', getPeerByDomain }), { action: 'local' });
});
test('federationMode unset → delegates to checkRecipientLocality (foreign → throws RECIPIENT_NOT_LOCAL)', async () => {
  await assert.rejects(() => decideRoute(envelope('ep_claude@b.example'), { relayDomain: 'a.example', federationMode: undefined, getPeerByDomain }), (e) => e.code === 'RECIPIENT_NOT_LOCAL');
});
test('local-domain recipient → local', async () => {
  assert.deepEqual(await decideRoute(envelope('ep_x@a.example'), { relayDomain: 'a.example', federationMode: 'sync', getPeerByDomain }), { action: 'local' });
});
test('foreign recipient, unpinned → reject PEER_NOT_PINNED', async () => {
  const r = await decideRoute(envelope('ep_z@c.example'), { relayDomain: 'a.example', federationMode: 'sync', getPeerByDomain });
  assert.equal(r.action, 'reject'); assert.equal(r.code, 'PEER_NOT_PINNED'); assert.equal(r.details.recipientDomain, 'c.example');
});
test('foreign recipient, pinned → forward with peer', async () => {
  const r = await decideRoute(envelope('ep_claude@b.example'), { relayDomain: 'a.example', federationMode: 'sync', getPeerByDomain });
  assert.equal(r.action, 'forward'); assert.equal(r.peer.relayUrl, 'https://b.example/relay'); assert.equal(r.recipientDomain, 'b.example');
});
test('malformed federated recipient → MALFORMED_FEDERATED_ID', async () => {
  await assert.rejects(() => decideRoute(envelope('ep_claude_no_domain'), { relayDomain: 'a.example', federationMode: 'sync', getPeerByDomain }), (e) => e.code === 'MALFORMED_FEDERATED_ID');
});
test('stored federation_hop true → reject FEDERATION_HOP_EXCEEDED', async () => {
  const r = await decideRoute(envelope('ep_claude@b.example'), { relayDomain: 'a.example', federationMode: 'sync', getPeerByDomain, storedFederationHop: true });
  assert.equal(r.action, 'reject'); assert.equal(r.code, 'FEDERATION_HOP_EXCEEDED');
});
