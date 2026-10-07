import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ACCEPT_OPTION_KEYS, createAcceptOptionsBuilder } from './accept-options.mjs';

const base = Object.fromEntries(ACCEPT_OPTION_KEYS.map((key) => [key, key === 'persist' ? true : `v_${key}`]));

test('builder returns every key and applies per-transport overrides', () => {
  const build = createAcceptOptionsBuilder(base);
  const options = build({ request_id: 'req_1' });
  for (const key of ACCEPT_OPTION_KEYS) assert.ok(key in options, key);
  assert.equal(options.request_id, 'req_1');
  assert.equal(options.systemIdentity, 'v_systemIdentity');
});

test('builder refuses a base that omits a shared option', () => {
  const { systemIdentity, ...partial } = base;
  assert.throws(() => createAcceptOptionsBuilder(partial), /systemIdentity/);
});

test('an explicit undefined is allowed: a relay without a system identity still passes the key', () => {
  assert.doesNotThrow(() => createAcceptOptionsBuilder({ ...base, systemIdentity: undefined }));
});

// Every acceptEnvelopeAsync call site must obtain its options from
// buildAcceptOptions(...) and must not pass a hand-built object literal.
// The human send route (room-routes.mjs) has no acceptEnvelopeAsync call yet;
// add it to this list when that route lands.
for (const file of ['relay/v1/http-server.mjs', 'relay/v1/transport-libp2p/p2p-data-protocol.mjs', 'ingress/v1/agentmail-adapter.mjs']) {
  test(`${file} gets accept options from the shared builder`, () => {
    const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.match(source, /acceptEnvelopeAsync\(envelope,/, 'acceptEnvelopeAsync call found');
    assert.match(source, /buildAcceptOptions\(/, 'options come from buildAcceptOptions(...)');
    assert.doesNotMatch(source, /acceptEnvelopeAsync\(envelope,\s*\{/, 'no hand-built options literal');
  });
}
