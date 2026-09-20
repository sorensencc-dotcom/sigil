import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSecretReference } from './agentmail-secret-reference.mjs';

test('parses secret references without exposing a value', () => {
  const reference = parseSecretReference('secret://sigil/agentmail/api-key');
  assert.deepEqual(reference, {
    scheme: 'secret', backend: 'sigil', path: 'agentmail/api-key', display: 'secret://sigil/agentmail/api-key',
  });
  assert.equal(Object.isFrozen(reference), true);
});

test('parses uppercase environment references', () => {
  assert.deepEqual(parseSecretReference('env://AGENTMAIL_API_KEY'), {
    scheme: 'env', backend: null, path: 'AGENTMAIL_API_KEY', display: 'env://AGENTMAIL_API_KEY',
  });
});

test('rejects malformed or value-bearing references', () => {
  for (const raw of [
    'http://sigil/key', 'secret://Sigil/path', 'secret://sigil/', 'secret:///path',
    'env://agentmail_key', 'env://AGENTMAIL-KEY', 'secret://sigil/path?value=bad',
    'secret://user:pass@sigil/path', 'env://AGENTMAIL_KEY#fragment',
  ]) assert.throws(() => parseSecretReference(raw), { code: 'SECRET_REF_INVALID' });
});
